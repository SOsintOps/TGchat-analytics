import "jest-extended";

import { AttachmentType } from "@pipeline/Attachments";
import { TelegramParser } from "@pipeline/parse/parsers/TelegramParser";

import { runParserFromString } from "@tests/parse/Parse";

// Tests for Telegram Desktop HTML-export parsing (directory format).
// See .planning/telegram-i18n/PLAN.md §2.2 / §C.

const HTML = `<!DOCTYPE html><html><body><div class="page_wrap">
  <div class="page_header"><div class="content"><div class="text bold">
    My Channel
  </div></div></div>
  <div class="page_body chat_page"><div class="history">

    <div class="message service" id="message-1">
      <div class="body details">Channel "My Channel" created</div>
    </div>

    <div class="message default clearfix" id="message5">
      <div class="body">
        <div class="pull_right date details" title="12.08.2021 12:58:00 UTC+01:00">12:58</div>
        <div class="from_name">Alice</div>
        <div class="text">hello <a href="https://x.com">link</a></div>
      </div>
    </div>

    <div class="message default clearfix joined" id="message6">
      <div class="body">
        <div class="pull_right date details" title="12.08.2021 12:59:30 UTC+01:00">12:59</div>
        <div class="media_wrap clearfix">
          <a class="photo_wrap clearfix pull_left" href="photos/photo_1.jpg"><img class="photo"/></a>
        </div>
        <div class="text">with a photo</div>
      </div>
    </div>

    <div class="message default clearfix joined" id="message7">
      <div class="body">
        <div class="pull_right date details" title="12.08.2021 13:00:00 UTC+01:00">13:00</div>
        <div class="reply_to details">In reply to <a href="messages.html#go_to_message5">this message</a></div>
        <div class="text">a reply</div>
      </div>
    </div>

  </div></div></div></body></html>`;

describe("TelegramParser — HTML export (directory) parsing", () => {
    it("parses an HTML page: channel header, joined-author carry-forward, dates, media, replies", async () => {
        const parsed = await runParserFromString(TelegramParser, [HTML]);

        // Channel keyed off the page header name (HTML has no numeric id / chat type)
        expect(parsed.channels).toIncludeAllPartialMembers([
            { id: "tg-html:My Channel", name: "My Channel", type: "group" },
        ]);

        // Only one author: message5 declares "Alice"; messages 6 & 7 are "joined" → reuse Alice
        expect(parsed.authors).toIncludeAllPartialMembers([{ id: "tg-html:Alice", name: "Alice", bot: false }]);

        // The service message ("Channel created") must be skipped → exactly 3 real messages
        expect(parsed.messages).toHaveLength(3);

        expect(parsed.messages).toIncludeAllPartialMembers([
            {
                id: "5",
                authorId: "tg-html:Alice",
                textContent: "hello link",
                // shown time is LOCAL (UTC+01:00) → convert to UTC by subtracting the offset
                timestamp: Date.UTC(2021, 7, 12, 12, 58, 0) - 3600000,
            },
            {
                id: "6",
                authorId: "tg-html:Alice",
                textContent: "with a photo",
                attachments: [AttachmentType.Image],
                timestamp: Date.UTC(2021, 7, 12, 12, 59, 30) - 3600000,
            },
            {
                id: "7",
                authorId: "tg-html:Alice",
                textContent: "a reply",
                replyTo: "5",
                timestamp: Date.UTC(2021, 7, 12, 13, 0, 0) - 3600000,
            },
        ]);
    });

    it("skips non-message files (css/js/binary) without emitting anything", async () => {
        const css = await runParserFromString(TelegramParser, ["body { color: red; }\n.message { display:none; }"]);
        // a stylesheet must not be mistaken for an export
        expect(css.messages).toHaveLength(0);
        expect(css.channels).toHaveLength(0);
    });
});
