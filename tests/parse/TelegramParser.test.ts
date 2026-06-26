import "jest-extended";

import { TelegramParser } from "@pipeline/parse/parsers/TelegramParser";

import { runParserFromString } from "@tests/parse/Parse";

// Compatibility tests for the Telegram JSON parser across export eras.
// See .planning/telegram-i18n/PLAN.md §2.1 / §B for the old-vs-new field matrix.

describe("TelegramParser — JSON format compatibility (old vs new)", () => {
    it("parses OLD-format exports (no *_unixtime, integer from_id, legacy text/array)", async () => {
        const json = JSON.stringify({
            name: "Old Chat",
            type: "personal_chat",
            id: 111,
            messages: [
                { id: 1, type: "message", date: "2019-07-12T16:55:32", from: "Alice", from_id: 300, text: "hello" },
                {
                    id: 2,
                    type: "message",
                    date: "2019-07-12T16:56:00",
                    from: "Bob",
                    from_id: 700,
                    // legacy mixed array (string + entity), bare URL entity type is "link"
                    text: ["check ", { type: "link", text: "https://x.com" }],
                },
            ],
        });

        const parsed = await runParserFromString(TelegramParser, [json]);

        expect(parsed.channels).toIncludeAllPartialMembers([{ id: 111, type: "dm" }]);
        expect(parsed.authors).toIncludeAllPartialMembers([
            { id: "300", name: "Alice", bot: false },
            { id: "700", name: "Bob", bot: false },
        ]);
        expect(parsed.messages).toIncludeAllPartialMembers([
            { id: "1", authorId: "300", textContent: "hello", timestamp: Date.parse("2019-07-12T16:55:32") },
            // link entity is padded with spaces so it tokenizes correctly
            { id: "2", authorId: "700", textContent: "check  https://x.com " },
        ]);
    });

    it("parses NEW-format exports (date_unixtime, prefixed from_id, text_entities, custom_emoji, Cyrillic)", async () => {
        const json = JSON.stringify({
            name: "New Supergroup",
            type: "private_supergroup",
            id: 222,
            messages: [
                {
                    id: 10,
                    type: "message",
                    date: "2023-01-01T00:00:00",
                    date_unixtime: "1672531200",
                    from: "Карл", // Cyrillic display name must be preserved verbatim
                    from_id: "user555", // 64-bit prefixed peer id (tdesktop 3.0+)
                    text: "мир",
                    text_entities: [{ type: "plain", text: "мир" }],
                },
                {
                    id: 11,
                    type: "message",
                    date: "2023-01-01T00:01:00",
                    date_unixtime: "1672531260",
                    from: "Eve",
                    from_id: "user999",
                    // text_entities-only message: labelled hyperlink + custom_emoji (unknown-ish type kept via .text)
                    text_entities: [
                        { type: "plain", text: "see " },
                        { type: "text_link", text: "here", href: "https://y.com" },
                        { type: "custom_emoji", text: "🔥", document_id: "123" },
                    ],
                },
            ],
        });

        const parsed = await runParserFromString(TelegramParser, [json]);

        expect(parsed.channels).toIncludeAllPartialMembers([{ id: 222, type: "group" }]);
        expect(parsed.authors).toIncludeAllPartialMembers([
            { id: "user555", name: "Карл", bot: false },
            { id: "user999", name: "Eve", bot: false },
        ]);
        expect(parsed.messages).toIncludeAllPartialMembers([
            { id: "10", authorId: "user555", textContent: "мир", timestamp: 1672531200 * 1000 },
            // "see " + " here " (padded text_link) + "🔥" (custom_emoji)
            { id: "11", authorId: "user999", textContent: "see  here 🔥", timestamp: 1672531260 * 1000 },
        ]);
    });

    it("is resilient to a malformed/missing date (does not throw, still emits the message)", async () => {
        const json = JSON.stringify({
            name: "X",
            type: "personal_chat",
            id: 1,
            messages: [
                { id: 1, type: "message", date_unixtime: "1672531200", from: "A", from_id: 1, text: "ok" },
                { id: 2, type: "message", date: "not-a-date", from: "A", from_id: 1, text: "still here" },
            ],
        });

        const parsed = await runParserFromString(TelegramParser, [json]);

        expect(parsed.messages).toIncludeAllPartialMembers([
            { id: "1", textContent: "ok" },
            { id: "2", textContent: "still here" },
        ]);
    });
});
