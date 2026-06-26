import { Token, tokenize } from "@pipeline/process/nlp/Tokenizer";

const words = (s: string): string[] =>
    tokenize(s)
        .filter((t: Token) => t.tag === "word")
        .map((t: Token) => t.text);

// Non-Western tokenization. See .planning/telegram-i18n/PLAN.md §2.3 / §D.
describe("tokenize — non-Western scripts", () => {
    it("keeps Latin tokenization unchanged", () => {
        expect(words("hello world")).toEqual(["hello", "world"]);
    });

    it("tokenizes Russian (Cyrillic) into separate words", () => {
        expect(words("Привет мир как дела")).toEqual(["Привет", "мир", "как", "дела"]);
    });

    it("segments Simplified Chinese (no spaces) into multiple words, losslessly", () => {
        const w = words("我喜欢编程");
        expect(w.length).toBeGreaterThan(1); // not one giant token
        expect(w.join("")).toBe("我喜欢编程"); // segments concatenate back to the original
    });

    it("segments Traditional Chinese into multiple words, losslessly", () => {
        const w = words("我喜歡寫程式");
        expect(w.length).toBeGreaterThan(1);
        expect(w.join("")).toBe("我喜歡寫程式");
    });

    it("splits a mixed CJK + Latin run at the script boundary", () => {
        const w = words("你好world");
        expect(w).toContain("world");
        expect(w.some((x) => /[一-鿿]/.test(x))).toBe(true);
    });
});
