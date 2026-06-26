type TelegramChannelType =
    | "bot_chat"
    | "personal_chat"
    | "private_channel"
    | "private_group"
    | "private_supergroup"
    | "public_group"
    | "public_supergroup"
    | "saved_messages"
    | string;

// some available keys: id, type, date, actor, actor_id, action, title, text, text_entities, from, from_id,
// reply_to_message_id, reply_to_peer_id, file, thumbnail, media_type, sticker_emoji, width, height, photo,
// via_bot, mime_type, duration_seconds, edited, inviter, forwarded_from, forwarded_from_id, message_id,
// members, performer, game_*, score, place_name, address, location_information, poll, saved_from, author, duration
//
// COMPATIBILITY NOTE (old vs new Telegram Desktop exports — see .planning/telegram-i18n/PLAN.md §2.1/§3.2):
// - `date_unixtime`/`edited_unixtime` (UTC epoch, quoted strings) were added in the 2.x era; older exports
//   only have `date`/`edited` (LOCAL-time ISO, no offset). We prefer *_unixtime when present.
// - `from_id`/`actor_id` became 64-bit prefixed strings ("user123"/"channel123"/"chat123") in tdesktop 3.0
//   (2021); older exports use bare integers. Both are accepted (we only need a stable author key).
// - `text` can be a plain string OR a mixed (string | entity)[] array. `text_entities` (objects-only) was
//   added later and duplicates the same content — we prefer it when present.
interface TelegramMessage {
    action?: "phone_call" | string;
    actor?: string | null;
    actor_id?: string | number;
    // In some cases the information is present in unix format (UTC) and sometimes as a full local datetime
    date?: string;
    date_unixtime?: string;
    duration_seconds?: number;
    edited?: string;
    edited_unixtime?: string;
    from_id?: string | number;
    from?: string | null; // sometimes from is null
    forwarded_from?: string | null;
    forwarded_from_id?: string | number;
    saved_from?: string | null;
    id: number;
    location_information?: any;
    media_type?: "sticker" | "animation" | "video_file" | "voice_message" | "video_message" | "audio_file" | string;
    mime_type?: string;
    photo?: string; // path, or a "(File not included...)" placeholder in excluded-media exports
    file?: string; // same: path or placeholder
    poll?: { question: string };
    reply_to_message_id?: number;
    reply_to_peer_id?: string | number;
    text?: string | (string | TextArray)[]; // Telegram emits "" for media-only messages; absent on some service msgs
    text_entities?: TextArray[];
    type: "message" | "service" | "call" | string;
}

// A styled-text entity. `type` is an OPEN set (Telegram keeps adding entity kinds, e.g. custom_emoji,
// spoiler, blockquote) — always handle unknown types via a default branch that keeps `.text`.
// NOTE: a bare URL is type "link" (NOT "url"); a labelled hyperlink is "text_link" with an `href`.
interface TextArray {
    type:
        | "plain"
        | "bold"
        | "bot_command"
        | "cashtag"
        | "code"
        | "custom_emoji"
        | "email"
        | "hashtag"
        | "italic"
        | "link"
        | "mention"
        | "mention_name"
        | "phone"
        | "pre"
        | "spoiler"
        | "strikethrough"
        | "text_link"
        | "underline"
        | string;
    text: string;
    href?: string; // text_link
    user_id?: string | number; // mention_name
    document_id?: string | number; // custom_emoji
    language?: string; // pre
}
