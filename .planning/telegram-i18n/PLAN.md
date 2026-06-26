# Telegram Ingestion + i18n + Translation — Analysis & Plan (scaletta)

**Status:** PLANNING COMPLETE → IMPLEMENTATION IN PROGRESS. This document is the resumable
source of truth. Check the boxes in §6 as work lands; each box = one atomic commit.
**Branch:** `base-mlshdev` (the detached modernized base). **Created:** 2026-06-26.

Scope confirmed with stakeholder:
- IMPLEMENT: Telegram **HTML-directory** parsing, **old/new JSON** hardening, **non-Western**
  (Russian + Chinese Traditional&Simplified) tokenization.
- RESEARCH/PLAN ONLY (no code this cycle): **content translation** (§5).
- Document in `.planning/` (this file). Commit + push as checkpoints; do not stop until done.

---

## 0. Test corpus (in `sample/`)
Three real OSINT chats, **each shipped in BOTH formats** (HTML export dir + `result.json`):

| Sample | Kind | Lang | HTML pages | JSON |
|---|---|---|---|---|
| `OSINT форум расследований` | group | **Russian** (Cyrillic) | 26 | `result.json` (+ `files/export.json`) |
| `cyberdetective-TG` | channel | English | 4 | `result.json` |
| `osintops news 260401` | channel | English | 4 | `result.json` |

Having JSON+HTML for the same chats enables **cross-validation**: parsing each format must yield
matching message counts, author sets, and date ranges. No Chinese sample exists → add a synthetic
Chinese fixture for CJK tests.

---

## 1. ANALYSIS — How extracted data is stored & the ontology applied

**Pipeline stages** (`pipeline/`):
`FileInput → Parser → (P* intermediate types) → MessageProcessor/DatabaseBuilder → IndexedMap/BigMap (dedup) → serialization (BitStream) → self-contained HTML report`.

**(a) Intermediate "ontology" emitted by parsers** (`pipeline/parse/Types.ts`) — platform-agnostic:
- `PGuild { id, name, avatar? }`
- `PChannel { id, guildId, name, type: "dm"|"group"|"text", avatar? }`
- `PAuthor { id, name, bot, avatar? }`
- `PMessage { id, authorId, channelId, timestamp, timestampEdit?, replyTo?, textContent?, attachments?: AttachmentType[], reactions?: [PEmoji,number][] }`
- `PCall { id, authorId, channelId, timestampStart, timestampEnd }`
- `PEmoji { id?, text }`
Parsers `emit("guild"|"channel"|"author"|"message"|"call", …)`. The model is deliberately minimal
and IDs are `RawID = string | number`.

**(b) Processing → indexed database** (`pipeline/process/`): `MessageProcessor.processGroupToIntermediate`
tokenizes `textContent` (NLP), detects language (fastText), computes sentiment, and **deduplicates**
authors / words / emojis / mentions / domains into global dictionaries via `IndexedMap`/`BigMap`.

**(c) Serialization = compact bit-packed binary** (`pipeline/serialization/`): `MessageSerialization`
+ `BitStream` store, per message, ONLY indices: `dayIndex`, `authorIndex`, `langIndex`, `sentiment`,
and **bag-of-words** `(wordIndex, count)` arrays (+ emoji/mention/domain/attachment indices, reply flag).
**Raw message text is NOT stored** — only references into the word dictionary. This binary blob is
embedded into the single output `report.html`.

**(d) Language ontology** (`pipeline/Languages.ts`): fastText `lid.176` → `LanguageCodes`/`LanguageNames`
(~187 ISO 639-2/3 codes; index 0 = "" = "Unreliable to detect"). Relevant: `ru`=Russian, `zh`=Chinese,
`wuu`=Wu, `yue`=Yue. (`als` is mis-assigned by fastText — known upstream bug.)

**Ontology summary:** Platform → Guild → Channel → Message, with deduplicated Authors, Words, Emojis,
Domains, Mentions, Attachments, Calls; per-message language + sentiment; everything index-encoded and
bit-packed. **Privacy by design: no verbatim text persisted.**

---

## 2. ANALYSIS — Telegram parser: current support & gaps

Current parser: `pipeline/parse/parsers/TelegramParser.ts` (+ `Telegram.d.ts`). **JSON only**, streamed
via `JSONStream`/`streamJSONFromFile` (handles huge exports).

### 2.1 Old vs new JSON — current behaviour
- ✅ Timestamps: reads `date_unixtime` (new) **and** falls back to `date` (old). `edited_unixtime`/`edited` likewise.
- ✅ Text: `parseTextArray` handles `string` **and** the mixed `(string|entity)[]` array, with per-entity-type rules.
- ⚠️ **Gaps to harden** (from tdesktop-source research):
  - Does NOT read the newer `text_entities` array (only legacy `text`). Fine today (they duplicate), but document.
  - `from_id`/`actor_id`: stringified naively (`(from_id||actor_id)+""`). Works for a stable author key, but
    does not strip the `user`/`channel`/`chat` prefix (64-bit peer migration, tdesktop 3.0). Acceptable for
    analytics (id only needs to be stable) — note it.
  - `action` set is closed to `phone_call` only (fine — others aren't needed), but service messages otherwise dropped.
  - Media placeholders: `photo`/`file` may be the literal string "(File not included…)" in some exports — treat as no-path.
  - 64-bit `id` as JS number could lose precision (BigInt-safe not required for analytics keys, but note).
  - Custom-emoji builds (tdesktop #24961/#24984) can emit invalid JSON → ingestion should fail gracefully per-file.

### 2.2 HTML directory — NOT supported (net-new)
No HTML path. Telegram Desktop HTML export = a **directory**: `messages.html`, `messages2.html`…
(no `messages1.html`), `css/`, `photos/`, `files/`, `video_files/`, `voice_messages/`, `stickers/`.
Authoritative markup from tdesktop `export_output_html.cpp`. Key rules:
- Messages: `div.message.default`; **joined** runs add class `joined` and OMIT `from_name`/userpic →
  must **carry the last author name forward**.
- Service messages: `div.message.service` (date dividers, joins, pins, calls) — no machine-readable `action`.
- Author identity is **display name only** (no `from_id`) → name collisions possible; derive `PAuthor.id` from normalized name.
- Date: in the **`title` attr** of `.pull_right.date.details` as `dd.mm.yyyy HH:MM:SS UTC±HH:MM` (LOCAL time +
  explicit offset) — parse the offset to recover UTC. Visible `.date` text is time-only.
- Media: infer `AttachmentType` from wrapper class (`.photo_wrap`→Image, `.video_file_wrap`/`.media_video`→Video,
  `.sticker_wrap`→Sticker, `.media_voice_message`→Audio, `.media_file`→by ext/Other). No byte resolution needed for stats.
- Reply: `.reply_to a[href]` → `#go_to_messageNNN`. No reactions / edit-time / bot flag in HTML.
- Pagination: glob+sort `messages*.html` numerically; concatenate message streams in order.

### 2.3 Non-Western characters — partial
Tokenizer `pipeline/process/nlp/Tokenizer.ts` is regex-based; word matcher `[\p{L}'0-9-]*` (u-flag).
- ✅ **Russian/Cyrillic works** (space-delimited, `\p{L}` covers Cyrillic). Only stopword coverage to verify (`ru` is in stopwords-iso).
- ❌ **CJK (Chinese/Japanese/Thai) broken**: no inter-word spaces → an entire Han run becomes ONE token → word stats meaningless.

---

## 3. EXISTING SOLUTIONS found (with URLs)

### 3.1 Telegram HTML export parsers (prior art)
- **EmerickGrimm/Telegram-Chat-Export-Reader** — JS/React, in-browser `DOMParser`, `webkitdirectory`, full media/reply/service handling. *Best reference.* https://github.com/EmerickGrimm/Telegram-Chat-Export-Reader
- **craftamap/telegram-export-parser** — Python/BeautifulSoup; cleanest joined-message + `.date[title]` logic. https://github.com/craftamap/telegram-export-parser
- mrtj gist (minimal) https://gist.github.com/mrtj/049024345d37ed625e923abb267dc396 · Devbluid/telegram-html-to-markdown https://github.com/Devbluid/telegram-html-to-markdown
- Authoritative markup generator: tdesktop `export_output_html.cpp` https://github.com/telegramdesktop/tdesktop/blob/dev/Telegram/SourceFiles/export/output/export_output_html.cpp
- **No existing chat-analytics fork adds HTML import → net-new.**

### 3.2 Telegram JSON schema (old vs new)
- Authoritative: tdesktop `export_output_json.cpp` + `export_data_types.cpp` (dev). Official: https://core.telegram.org/import-export , entities https://core.telegram.org/api/entities
- Breaking changes: 64-bit prefixed `from_id` (`user…`/`channel…`/`chat…`, tdesktop 3.0, 2021); `*_unixtime` & `text_entities` added ~2.x; entity bare-URL type is `link` (not `url`), href on `text_link`; `custom_emoji` (2022); open/growing `action` set. Invalid-JSON bug #24961/#24984.
- TS types reference: innerdvations/telegram-chat-parser https://github.com/innerdvations/telegram-chat-parser

### 3.3 Non-Western tokenization
- **kisasara fork** (Traditional Chinese): adds `pipeline/process/nlp/ChineseSegmenter.ts` using **`jieba-wasm`** (`cut(text,true)`), a `cjk-chunk` Unicode-range matcher in `Tokenizer.ts` (makes `tokenize()` async), `AFINN-zh.json` + ~21.8k Chinese stopwords, `prepare-chinese-assets.js`. Deps `jieba-wasm`, `opencc-js`. https://github.com/mlomb/chat-analytics/compare/main...kisasara:main
  - **Weakness:** feeds Traditional straight into jieba (Simplified-trained) and uses a hand-rolled ~50-char S→T map instead of opencc → degraded Traditional accuracy. **Our fix: proper opencc T→S normalization for the lookup key.**
- Libraries: `Intl.Segmenter {granularity:"word"}` (native, zero-bundle, Baseline 2024-04, CJK+Thai), `jieba-wasm` (quality), `opencc-js` (T/S convert), TinySegmenter/kuromoji (JP), stopwords-iso (ru/zh).

### 3.4 Translation (see §5)
- Cloud: DeepL/Google/Azure/Anthropic. Local: LibreTranslate, Argos, NLLB-200, Opus-MT, transformers.js (browser WASM/WebGPU).

---

## 4. KEY ARCHITECTURAL DECISIONS
1. **HTML parser reuses the same `P*` intermediate model** and `emit()` calls as the JSON parser → all downstream aggregation unchanged. Implement as a sibling `TelegramHtmlParser` (or a directory-aware branch), selected when the input is an HTML export dir.
2. **Directory input** needs a new input shape: current `FileInput` is single-file. Add directory-aware collection of `messages*.html` (media files not read — only `AttachmentType` matters).
3. **CJK:** range-detect → **opencc-js T→S normalize** (lookup key) → segment (`Intl.Segmenter` default; `jieba-wasm` optional quality) → Simplified stopwords/AFINN. Keep original surface for display. `tokenize()` becomes async.
4. **Russian:** no segmentation change; just verify `ru` stopwords.
5. **Translation (research only):** the ONLY clean hook is **parse-time, before tokenization** (replace `PMessage.textContent` with English; no report-format change, no bloat because text isn't stored). On-demand in-report is blocked (no stored text). Default to a **local/private** engine; cloud opt-in only.

---

## 5. TRANSLATION — research & recommendation (PLAN ONLY, no code this cycle)
Integration point: `pipeline/process/MessageProcessor.ts` `processGroupToIntermediate` (~lines 36-70),
translate `msg.textContent` BEFORE `tokenize(normalizeText(...))`. Gains: word clouds/top-words/sentiment
become English automatically; `langIndex` still records original language; output stays one offline HTML.

| Route | Privacy | Quality RU/ZH | Scale | Cost @1M msg | Verdict |
|---|---|---|---|---|---|
| transformers.js in-browser (NLLB-600M q8 / Opus-MT, WASM) | ★ best (never leaves browser) | ok / good | small chats only (2-5 s/sentence) | $0 | small-chat opt-in |
| Local **LibreTranslate** (Docker localhost) / Opus-MT | ★ stays on machine | decent | millions | $0 | **recommended default** |
| Cloud **Claude Haiku Batch** | breaks privacy | best, idiom-aware | millions, ≤24h async | ~$40-80 | opt-in fallback (cheapest+best) |
| Azure Translator | breaks privacy | strong | millions | ~$400 (2M/mo free) | opt-in, cheapest dedicated MT |
| DeepL / Google | breaks privacy | RU excel / broad | millions | ~$800-1000 | opt-in |

Caching: persistent `hash(text+langpair)→translation`; **skip messages already `en`** via `langIndex`;
batch aggressively; incremental for growing OSINT feeds. **Recommendation:** parse-time hook + pluggable
engine, default local (LibreTranslate/Opus-MT), transformers.js for small fully-offline chats, Claude
Batch as opt-in cloud fallback behind an explicit consent gate. AVOID on-demand-in-report (forces raw-text
storage, bloats file, breaks privacy). Verify Claude model IDs/pricing via the `claude-api` skill before any build.

---

## 6. SCALETTA — ordered actions & tests (check off = atomic commit)

### Phase A — Baseline & fixtures
- [x] A1. HTML covered by a deterministic handcrafted fixture in `tests/parse/TelegramHtmlParser.test.ts` (cleaner than slicing the big `sample/` pages).
- [ ] A2. Add a synthetic **Chinese (T+S)** message fixture for CJK tokenizer tests. (Phase D)
- [x] A3. Cross-validation done (script, not committed): parsed `sample` JSON vs HTML for all 3 chats. **Message counts & date ranges match** (cyberdetective 3350=3350; osintops 3600=3600; OSINT форум 31545 vs 31546 = Δ1/31k; date ranges identical). Author counts differ by design (HTML name-based identity — see §2.2): channels over-count (signed/forwarded posts), groups under-count (name collisions).

### Phase B — JSON hardening (old/new) ✅ DONE (commit)
- [x] B1. Extended `Telegram.d.ts`: `text_entities?`, open `action`/`type`, `from_id: string|number` (+prefixed-id note), media placeholders (`photo`/`file`), `forwarded_from(_id)`, `reply_to_peer_id`, `saved_from`, richer `TextArray` (plain/custom_emoji/spoiler/href/document_id…). `text` made optional.
- [x] B2. `TelegramParser` prefers `text_entities ?? text`; `parseTextArray` widened to `string | (string|TextArray)[]` + undefined guard; unknown entity types fall through to `.text` (custom_emoji etc.).
- [x] B3. `Date.parse` NaN guard (falls back to last-known ts to preserve ordering); `edited` NaN→undefined. (Per-file invalid-JSON try/catch deferred — handled at the generate-orchestration layer; noted.)
- [x] B4. `tests/parse/TelegramParser.test.ts`: OLD fixture (no `_unixtime`, integer `from_id`, legacy array), NEW fixture (prefixed id, `text_entities`, custom_emoji, **Cyrillic name**), malformed-date resilience. **21/21 pass** (incl. existing sample test).

### Phase C — HTML directory parser (net-new) ✅ DONE (commit)
- [x] C1. Multi-file handled by the existing `<input multiple>` flow (each `messages*.html` is parsed independently; per-message timestamps make global file ordering unnecessary). Non-message files (css/js/photos) are skipped via head detection. (`webkitdirectory` folder-picker = optional UI nicety, deferred.)
- [x] C2. `parseHtmlFile` in `TelegramParser` using **worker-safe `node-html-parser`** (NOT DOMParser — pipeline runs in a Web Worker): `.message` iteration; `joined`-class author carry-forward; `.from_name`; date from `.pull_right.date.details[title]` `dd.mm.yyyy HH:MM:SS UTC±HH:MM` → UTC (offset-aware); reply `#go_to_messageNNN`; media type from wrapper class (`photo_wrap`/`sticker_wrap`/`animated_wrap`/`video_file_wrap`/poll); `service` skip. Emits the same `P*` model. Channel/author keyed by display name (HTML has no numeric id / from_id).
- [x] C3. Format auto-detection inside `parse()` (HTML vs JSON vs skip). No `createParser` change needed — `createParser("telegram")` handles both formats transparently. Added `transformIgnorePatterns` so jest transforms node-html-parser's ESM `entities` dep.
- [x] C4. `tests/parse/TelegramHtmlParser.test.ts` (2/2 pass) + real-sample cross-validation (A3).

### Phase D — Non-Western tokenization ✅ DONE (commit) — CJK seg + Russian verified
- [x] D1. Russian verified: `\p{L}` already covers Cyrillic; test asserts "Привет мир как дела" → 4 separate words. (Full `ru`-stopword check happens downstream via the existing stopwords-iso `ru` list — unchanged.)
- [x] D2/D3. CJK support added in `Tokenizer.ts` via **native `Intl.Segmenter`** (sync, zero-dependency, ICU dictionary, Baseline 2024) — chosen over the kisasara jieba-wasm route to avoid an async ripple + WASM asset loading in the worker. `expandCJKWords` re-segments any CJK-containing "word" token (lazy per-script `zh`/`ja` segmenters; graceful fallback if `Intl.Segmenter` absent). ICU handles BOTH Simplified and Traditional natively, sidestepping kisasara's Traditional-via-Simplified-jieba gap. **Deferred refinement:** `opencc-js` T→S normalization purely for stopword/AFINN *lookup keys* (segmentation already works) — see §3.3.
- [x] D4. `tests/process/Tokenizer.test.ts` (5/5): Latin unchanged, Russian Cyrillic, Simplified + Traditional Chinese (lossless multi-word), mixed CJK+Latin boundary split.

### Phase E — Translation
- [ ] E1. (DONE here) Documented research + recommendation (§5). No code. Future phase: implement parse-time pluggable translator.

### Phase F — Verify & ship
- [ ] F1. `bun run test` green (except pre-existing Plausible telemetry failures, tracked separately).
- [ ] F2. `bun run build:web` succeeds; smoke-generate a report from a `sample` chat.
- [ ] F3. Update this PLAN's checkboxes; final commit + push.

---

## 7. RESUME NOTES
- Work on branch `base-mlshdev`. Commit per checkbox; push after each phase.
- Research agents (reusable via SendMessage): HTML `a9aab588ddf4974e4`, JSON `ab7ca0b54d6218ae8`, CJK `a15fa12ab6071e72d`, translation `a93c8c88d8d5cc4d8`.
- Pre-existing test failures unrelated to this work: `tests/Plausible.test.ts` (6, Jest-30 mocking). Do not block on them.
- Telemetry (Plausible) likely to be removed from the independent product — revisit separately.
