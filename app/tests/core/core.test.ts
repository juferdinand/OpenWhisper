import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { z } from "zod";
import { cleanTranscript } from "../../src/core/text/transcript-cleaner.js";
import { correctVocabulary, normalizeVocabularyKey, parseVocabulary, vocabularySimilarity, vocabularyThreshold } from "../../src/core/text/vocabulary-corrector.js";
import { expandSnippets, processTranscript } from "../../src/core/text/snippet-expander.js";
import { catalogSchema, detectModelFamily, ModelCatalog, modelDownloadURL, modelVendor, parseModelCatalog, recommendationsFor } from "../../src/core/models/catalog.js";

const textCase = z.strictObject({ name: z.string(), input: z.string(), expected: z.string() });
const vectorsSchema = z.strictObject({
  $comment: z.string().optional(),
  cleaner: z.array(textCase),
  vocabulary: z.strictObject({ terms: z.string(), cases: z.array(textCase) }),
  snippets: z.strictObject({
    snippets: z.array(z.strictObject({ trigger: z.string(), expansion: z.string(), enabled: z.boolean() })),
    cases: z.array(textCase),
  }),
});
const rawVectors: unknown = JSON.parse(await readFile(new URL("../../data/test-vectors.json", import.meta.url), "utf8"));
const vectors = vectorsSchema.parse(rawVectors);
const rawCatalog: unknown = JSON.parse(await readFile(new URL("../../data/models.json", import.meta.url), "utf8"));
const catalog = new ModelCatalog(rawCatalog);

for (const fixture of vectors.cleaner) test(`shared cleaner: ${fixture.name}`, () => {
  assert.equal(cleanTranscript(fixture.input), fixture.expected);
});
for (const fixture of vectors.vocabulary.cases) test(`shared vocabulary: ${fixture.name}`, () => {
  assert.equal(correctVocabulary(fixture.input, parseVocabulary(vectors.vocabulary.terms)), fixture.expected);
});
for (const fixture of vectors.snippets.cases) test(`shared snippets: ${fixture.name}`, () => {
  assert.equal(expandSnippets(fixture.input, vectors.snippets.snippets), fixture.expected);
});

test("cleaner preserves multilingual content and symbols while removing the native markers", () => {
  assert.equal(cleanTranscript("[Music] (APPLAUSE) *laughs* Hello\u0085世界\tالعربية 👩‍💻"), "Hello 世界 العربية 👩‍💻");
  assert.equal(cleanTranscript("Untertitelung von Amara.org. Hallo Subtitles by the Amara.org community."), "Hallo");
  assert.equal(cleanTranscript("… — ."), "");
  assert.equal(cleanTranscript("$ + 👩‍💻"), "$ + 👩‍💻");
  assert.equal(cleanTranscript("  (ordinary words) déjà vu  "), "(ordinary words) déjà vu");
  assert.equal(cleanTranscript("\ufeff日本語\ufeff"), "\ufeff日本語\ufeff");
  assert.equal(cleanTranscript(""), "");
});

test("vocabulary parsing and comparison preserve term spelling and Unicode scalar behavior", () => {
  assert.deepEqual(parseVocabulary("  Café; Kubernetes\r\n Jira, UI;  世界語  "), ["Café", "Kubernetes", "Jira", "世界語"]);
  assert.equal(normalizeVocabularyKey("Ｃａｆé"), "cafe");
  assert.equal(normalizeVocabularyKey("İSTANBUL"), "istanbul");
  assert.equal(normalizeVocabularyKey("ΟΣ"), "οσ");
  assert.equal(normalizeVocabularyKey("Straße"), "straße");
  assert.equal(normalizeVocabularyKey("한글"), "한글");
  assert.deepEqual(parseVocabulary("한글; Alpha\u2028Beta"), ["한글", "Alpha\u2028Beta"]);
  assert.equal(correctVocabulary("STRASSE", ["Straße"]), "STRASSE");
  assert.equal(correctVocabulary("ΟΣΑ", ["οσα"]), "οσα");
  assert.equal(correctVocabulary("Use cafe and ＫＵＢＥＲＮＥＴＥＳ.", ["Café", "Kubernetes"]), "Use Café and Kubernetes.");
  assert.equal(correctVocabulary("👩‍💻, jira!", ["Jira"]), "👩‍💻, Jira!");
  assert.equal(correctVocabulary("العربية\u200f 日本語", []), "العربية\u200f 日本語");
});

test("vocabulary thresholds, ties, overlapping windows and original offsets match the native algorithm", () => {
  assert.equal(vocabularySimilarity("", "abc"), 0);
  assert.equal(vocabularySimilarity("cafe", "cafe"), 1);
  assert.equal(vocabularySimilarity("abcdefg", "abcxefg"), 1 - 1 / 7);
  assert.equal(vocabularyThreshold(4), 1);
  assert.equal(vocabularyThreshold(5), 0.84);
  assert.equal(vocabularyThreshold(8), 0.8);
  assert.equal(correctVocabulary("abcxef", ["abcdef"]), "abcxef");
  assert.equal(correctVocabulary("abcxefg", ["abcdefg"]), "abcdefg");
  assert.equal(correctVocabulary("alpha beta, alpha beta.", ["ALPHA", "AlphaBeta"]), "AlphaBeta, AlphaBeta.");
  assert.equal(correctVocabulary("alpha beta gamma", ["AlphaBeta", "BetaGamma"]), "AlphaBeta gamma");
  assert.equal(correctVocabulary("alpha", ["ALPHA", "Alpha"]), "ALPHA");
  assert.equal(correctVocabulary("same text", ["", "!!!"]), "same text");
});

test("snippets preserve literal expansions, Unicode boundaries, empty drafts and matching order", () => {
  const snippets = [
    { trigger: "mail", expansion: "$& $1 $` $' \\ 日本語 👩‍💻", enabled: true },
    { trigger: "  \n - ", expansion: "never", enabled: true },
    { trigger: "mail", expansion: "disabled", enabled: false },
  ];
  const expansion = snippets[0]?.expansion;
  assert.equal(expandSnippets("...MAIL!", snippets), expansion);
  assert.equal(expandSnippets("Send mail now.", snippets), `Send ${expansion} now.`);
  assert.equal(expandSnippets("mailbox mail漢 mail٣", snippets), "mailbox mail漢 mail٣");
  assert.equal(expandSnippets("mail\u05b0", snippets), "mail\u05b0");
  assert.equal(expandSnippets("𠀀mail mail𠀀", snippets), "𠀀mail mail𠀀");
  assert.equal(expandSnippets("👩‍💻mail🚀", snippets), `👩‍💻${expansion}🚀`);
  assert.equal(expandSnippets("unchanged", [{ trigger: "", expansion: "not inserted", enabled: true }]), "unchanged");
  assert.equal(expandSnippets("C++", [{ trigger: "C++", expansion: "literal", enabled: true }]), "literal");
  const cascading = [{ trigger: "one", expansion: "two", enabled: true }, { trigger: "two", expansion: "three", enabled: true }];
  assert.equal(expandSnippets("one.", cascading), "two");
  assert.equal(expandSnippets("Say one now", cascading), "Say three now");
});

test("processing retains cleaner then vocabulary then snippet order", () => {
  assert.equal(processTranscript("[BLANK_AUDIO]  kubernetis. ", "Kubernetes", [
    { trigger: "Kubernetes", expansion: "$10\n日本語", enabled: true },
  ]), "$10\n日本語");
});

test("catalog preserves shared metadata, safe downloads and hardware/language ordering", () => {
  assert.equal(catalog.models.length, 9);
  assert.equal(new Set(catalog.models.map((model) => model.id)).size, catalog.models.length);
  for (const tier of ["strong", "weak", "cpuOnly"] as const) {
    const german = catalog.recommendations(tier, "de"), japanese = catalog.recommendations(tier, "ja");
    assert.equal(german.length, 2);
    assert.equal(german[0]?.family, "parakeet");
    assert.equal(japanese[0]?.family, "whisper");
    assert.equal(catalog.recommendations(tier, "auto")[0]?.family, "whisper");
  }
  for (const model of catalog.models) {
    assert.equal(detectModelFamily(model.file), model.family);
    assert.equal(modelDownloadURL(model), `https://huggingface.co/${model.repository}/resolve/main/${model.file}`);
    assert.equal(modelVendor(model), model.family === "parakeet" ? "NVIDIA Parakeet" : "OpenAI Whisper");
    assert.equal(Object.isFrozen(model), true);
  }
  assert.equal(detectModelFamily("IMPORTED-PARAKEET.bin"), "parakeet");
  assert.equal(catalog.model("unknown"), undefined);
  const imported = catalog.models[0];
  assert.ok(imported);
  assert.equal(modelDownloadURL({ ...imported, repository: "" }), undefined);
  const custom = parseModelCatalog({ ...catalog.data, models: [{ ...imported, id: "voice..custom", file: "voice..custom.bin", repository: "" }] });
  assert.equal(custom.models[0]?.file, "voice..custom.bin");
  assert.deepEqual(recommendationsFor(parseModelCatalog({ ...catalog.data, recommendations: {} }), "strong", "de"), []);
  assert.deepEqual(recommendationsFor(parseModelCatalog({ ...catalog.data, recommendations: { strong: { parakeet: "missing", whisper: "base" } } }), "strong", "de"), []);
});

test("runtime catalog and fixture validation reject malformed input without coercion", () => {
  const first = catalog.models[0];
  assert.ok(first);
  for (const file of ["../model.bin", "directory/model.bin", "directory\\model.bin", "model\0.bin"]) {
    assert.equal(catalogSchema.safeParse({ ...catalog.data, models: [{ ...first, file }] }).success, false);
  }
  for (const repository of ["https://example.com/model", "../../model", "owner/repo?query", "owner/repo/extra"]) {
    assert.equal(catalogSchema.safeParse({ ...catalog.data, models: [{ ...first, repository }] }).success, false);
  }
  assert.equal(catalogSchema.safeParse({ ...catalog.data, models: [first, first] }).success, false);
  assert.equal(catalogSchema.safeParse({ ...catalog.data, recommendations: { strong: { whisper: true, parakeet: "base" } } }).success, false);
  assert.equal(catalogSchema.safeParse({ ...catalog.data, unknown: true }).success, false);
  assert.equal(vectorsSchema.safeParse({ ...vectors, snippets: { ...vectors.snippets, snippets: [{ trigger: "", expansion: "", enabled: "true" }] } }).success, false);
});
