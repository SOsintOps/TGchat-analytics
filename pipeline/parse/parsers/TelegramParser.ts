import { HTMLElement, parse as parseHtml } from "node-html-parser";

import { AttachmentType, getAttachmentTypeFromFileName, getAttachmentTypeFromMimeType } from "@pipeline/Attachments";
import { Progress } from "@pipeline/Progress";
import { Timestamp } from "@pipeline/Types";
import { FileInput, streamJSONFromFile, tryToFindTimestampAtEnd } from "@pipeline/parse/File";
import { JSONStream } from "@pipeline/parse/JSONStream";
import { Parser } from "@pipeline/parse/Parser";
import { PAuthor, PCall, PChannel, PGuild, PMessage, RawID } from "@pipeline/parse/Types";

export class TelegramParser extends Parser {
    private lastChannelName?: string;
    private lastChannelType?: TelegramChannelType;
    private lastChannelID?: RawID;
    private lastMessageTimestampInFile?: Timestamp;
    /** Used to detect DST */
    private lastEmittedMessageTimestamp?: Timestamp;

    /**
     * Regex to find the timestamp of the last message in a Telegram export file.
     * We use the timestamp of the last message as the `at` value (see @Parser)
     */
    static readonly TS_MSG_REGEX = /"date(?:_unixtime)?": ?"(.+?)"/gi;

    async *parse(file: FileInput, progress?: Progress) {
        // Telegram Desktop can export as JSON (result.json) or as an HTML directory
        // (messages.html, messages2.html, ... + css/js/media). The UI hands us every selected
        // file, so we detect the format from the head and silently skip non-message files
        // (css/js/photos/...). See .planning/telegram-i18n/PLAN.md §2.2/§C.
        const head = new TextDecoder("utf-8").decode(await file.slice(0, Math.min(file.size, 4096))).trimStart();
        const isHtml =
            /\.html?$/i.test(file.name) ||
            head.startsWith("<!DOCTYPE") ||
            head.startsWith("<html") ||
            head.includes('class="message');
        const isJson = head.startsWith("{") || head.startsWith("[");

        if (isHtml) {
            yield* this.parseHtmlFile(file, progress);
        } else if (isJson) {
            yield* this.parseJsonFile(file, progress);
        }
        // else: not a Telegram message file (css/js/media/etc.) — skip

        this.lastChannelName = undefined;
        this.lastChannelID = undefined;
        this.lastEmittedMessageTimestamp = undefined;
    }

    private async *parseJsonFile(file: FileInput, progress?: Progress) {
        this.lastMessageTimestampInFile = await tryToFindTimestampAtEnd(TelegramParser.TS_MSG_REGEX, file);

        const stream = new JSONStream()
            .onObject<string>("name", this.onChannelName.bind(this))
            .onObject<TelegramChannelType>("type", this.onChannelType.bind(this))
            .onObject<RawID>("id", this.onChannelId.bind(this))
            .onArrayItem<TelegramMessage>("messages", this.parseMessage.bind(this));

        yield* streamJSONFromFile(stream, file, progress);
    }

    private onChannelName(channelName: string) {
        this.lastChannelName = channelName;
    }

    private onChannelType(channelType: TelegramChannelType) {
        this.lastChannelType = channelType;
    }

    private onChannelId(rawChannelId: RawID) {
        this.lastChannelID = rawChannelId;

        const pguild: PGuild = {
            id: 0,
            name: "Telegram Chats",
        };
        const pchannel: PChannel = {
            id: rawChannelId,
            guildId: 0,
            name: this.lastChannelName || "Telegram chat",
            type: ["personal_chat", "bot_chat"].includes(this.lastChannelType || "") ? "dm" : "group",
        };

        this.emit("guild", pguild, this.lastMessageTimestampInFile);
        this.emit("channel", pchannel, this.lastMessageTimestampInFile);
    }

    private parseMessage(message: TelegramMessage) {
        if (this.lastChannelID === undefined) throw new Error("Missing channel ID");

        const rawId: RawID = message.id + "";
        const rawAuthorId: RawID = (message.from_id || message.actor_id) + "";
        const rawReplyToId: RawID | undefined = message.reply_to_message_id
            ? message.reply_to_message_id + ""
            : undefined;

        // read from unix timestamp (UTC, newer exports) or full local datetime (older exports)
        let timestamp = message.date_unixtime ? parseInt(message.date_unixtime) * 1000 : Date.parse(message.date ?? "");
        if (Number.isNaN(timestamp)) {
            // unparseable/missing date — fall back to the last known timestamp to preserve ordering
            timestamp = this.lastEmittedMessageTimestamp ?? this.lastMessageTimestampInFile ?? 0;
        }
        let timestampEdit = message.edited_unixtime
            ? parseInt(message.edited_unixtime) * 1000
            : message.edited
            ? Date.parse(message.edited)
            : undefined;
        if (timestampEdit !== undefined && Number.isNaN(timestampEdit)) timestampEdit = undefined;

        if (message.type === "message") {
            const pauthor: PAuthor = {
                id: rawAuthorId,
                // use the ID as name if no nickname is available
                name: message.from || rawId,
                // NOTE: I can't find a reliable way to detect if an author is a bot :(
                bot: false,
            };
            this.emit("author", pauthor, this.lastMessageTimestampInFile);

            // Prefer the newer `text_entities` (objects-only) when present; fall back to legacy `text`
            // (which may be a plain string or a mixed (string | entity)[] array). Both carry equivalent content.
            let textContent = this.parseTextArray(message.text_entities ?? message.text);
            let attachment: AttachmentType | undefined;

            // determinate attachment type
            if (message.media_type === "sticker") attachment = AttachmentType.Sticker;
            if (message.mime_type) attachment = getAttachmentTypeFromMimeType(message.mime_type);
            if (message.location_information !== undefined) attachment = AttachmentType.Other;

            if (textContent.length === 0 && attachment === undefined) {
                // sometimes messages do not include the "mime_type" but "photo"
                if (message.photo) attachment = AttachmentType.Image;
                // polls
                if (message.poll) {
                    // put the question as the message content
                    textContent = message.poll.question;
                }
                // NOTE: also :dart: emoji appears as empty content
            }

            const pmessage: PMessage = {
                id: rawId,
                replyTo: rawReplyToId,
                authorId: rawAuthorId,
                channelId: this.lastChannelID,
                timestamp,
                timestampEdit,
                textContent,
                attachments: attachment === undefined ? [] : [attachment],
                // NOTE: as of now, Telegram doesn't export reactions :(
                // reactions: [],
            };

            // before emitting, check if it's out of order
            if (this.lastEmittedMessageTimestamp !== undefined && timestamp < this.lastEmittedMessageTimestamp) {
                // we assume DST
                this.emit("out-of-order");
            }

            this.emit("message", pmessage, this.lastMessageTimestampInFile);
            this.lastEmittedMessageTimestamp = timestamp;
        } else if (message.type === "service" && message.action === "phone_call") {
            const pcall: PCall = {
                id: rawId,
                authorId: rawAuthorId,
                channelId: this.lastChannelID,
                timestampStart: timestamp,
                timestampEnd: timestamp + (message.duration_seconds || 0) * 1000,
            };

            this.emit("call", pcall);
        }
    }

    private parseTextArray(input: string | TextArray | (string | TextArray)[] | undefined | null): string {
        if (input === undefined || input === null) return "";
        if (typeof input === "string") return input;
        if (Array.isArray(input)) return input.map((i) => this.parseTextArray(i)).join("");
        switch (input.type) {
            // remove slash and split potential @
            // examples:
            // /command → command
            // /command@bot → command @bot
            case "bot_command":
                return input.text.replace("/", "").replace("@", " @");

            // remove #
            case "hashtag":
                return input.text.replace("#", "");

            // add redundant spaces to the sides to make sure it will be tokenized correctly
            case "link":
            case "mention":
            case "text_link":
                return ` ${input.text} `;

            // emails are removed
            case "email":
                return "";

            // by default just return the text
            default:
                return input.text;
        }
    }

    // ───────────────────────── HTML export (directory) support ─────────────────────────
    // The pipeline runs in a Web Worker where DOMParser is unavailable, so we use the
    // worker-safe `node-html-parser`. HTML exports lack from_id / numeric chat id / chat type /
    // reactions / edit-times, so we key authors & channel off display names. See PLAN §2.2/§C.

    private async *parseHtmlFile(file: FileInput, progress?: Progress) {
        const html = new TextDecoder("utf-8").decode(await file.slice(0, file.size));
        const root = parseHtml(html);

        const name = root.querySelector(".page_header .text.bold")?.text.trim() || this.lastChannelName || "Telegram chat";
        this.lastChannelName = name;
        // HTML has no numeric id or chat type → key the channel off its name, default type "group"
        const channelId: RawID = "tg-html:" + name;

        this.emit("guild", { id: 0, name: "Telegram Chats" });
        this.emit("channel", { id: channelId, guildId: 0, name, type: "group" });

        let lastAuthorName: string | undefined;
        const messages = root.querySelectorAll(".message");

        let processed = 0;
        for (const el of messages) {
            // Service messages (date dividers, joins, pins, "channel created", calls) carry no
            // machine-readable author/action → skip and reset the joined-author run.
            if (el.classList.contains("service")) {
                lastAuthorName = undefined;
                continue;
            }

            // "joined" messages omit the userpic + from_name: reuse the last author of the run.
            const fromName = el.querySelector(".from_name")?.text.trim();
            if (fromName) lastAuthorName = fromName;
            const authorName = lastAuthorName || "Unknown";
            const authorId: RawID = "tg-html:" + authorName; // HTML has no from_id → identity is the display name

            const rawId: RawID = (el.getAttribute("id") || "").replace("message", "") || processed + "";

            // Full datetime is in the `title` attr (LOCAL time + explicit UTC offset), not the visible text.
            const title = el.querySelector(".pull_right.date.details")?.getAttribute("title");
            const timestamp = this.parseHtmlDate(title);

            const textContent = el.querySelector(".text")?.text.trim() ?? "";

            const replyHref = el.querySelector(".reply_to a")?.getAttribute("href");
            const replyTo = replyHref?.match(/#go_to_message(\d+)/)?.[1];

            const attachment = this.detectHtmlAttachment(el);

            this.emit("author", { id: authorId, name: authorName, bot: false });

            if (this.lastEmittedMessageTimestamp !== undefined && timestamp < this.lastEmittedMessageTimestamp) {
                this.emit("out-of-order");
            }

            this.emit("message", {
                id: rawId,
                replyTo,
                authorId,
                channelId,
                timestamp,
                textContent,
                attachments: attachment === undefined ? [] : [attachment],
            });
            this.lastEmittedMessageTimestamp = timestamp;

            if (++processed % 500 === 0) {
                progress?.progress("number", processed, messages.length);
                yield;
            }
        }
        yield;
    }

    /** Parses a Telegram HTML date title "dd.mm.yyyy HH:MM:SS UTC±HH:MM" into a UTC epoch (ms). */
    private parseHtmlDate(title?: string | null): Timestamp {
        if (title) {
            const m = title.match(/(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2}):(\d{2})(?:\s*UTC([+-]\d{2}):(\d{2}))?/);
            if (m) {
                const [, dd, MM, yyyy, HH, mm, ss, offH, offM] = m;
                // The shown time is LOCAL; convert to UTC using the explicit offset (UTC = local − offset).
                let ts = Date.UTC(+yyyy, +MM - 1, +dd, +HH, +mm, +ss);
                if (offH !== undefined && offM !== undefined) {
                    const sign = offH.startsWith("-") ? -1 : 1;
                    ts -= sign * (Math.abs(+offH) * 3600 + +offM * 60) * 1000;
                }
                if (!Number.isNaN(ts)) return ts;
            }
        }
        return this.lastEmittedMessageTimestamp ?? this.lastMessageTimestampInFile ?? 0;
    }

    /** Infers an AttachmentType from the media-wrapper classes of an HTML message element. */
    private detectHtmlAttachment(el: HTMLElement): AttachmentType | undefined {
        if (!el.querySelector(".media_wrap")) return undefined;
        if (el.querySelector(".sticker_wrap")) return AttachmentType.Sticker;
        if (el.querySelector(".animated_wrap")) return AttachmentType.ImageAnimated;
        if (el.querySelector(".video_file_wrap")) return AttachmentType.Video;
        if (el.querySelector(".photo_wrap")) return AttachmentType.Image;
        if (el.querySelector(".media_voice_message")) return AttachmentType.Audio;
        if (el.querySelector(".media_poll")) return undefined; // poll, not a file attachment
        const fileEl = el.querySelector(".media_file");
        if (fileEl) {
            const href = fileEl.getAttribute("href") || "";
            return href ? getAttachmentTypeFromFileName(href) : AttachmentType.Document;
        }
        // link previews, calls, contacts, locations → not counted as a file attachment
        return undefined;
    }
}
