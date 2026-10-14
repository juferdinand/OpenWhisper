import { parseArgs } from "node:util";
import { z } from "zod";
import { defaultTextRevisionSettings, cliTextModelSchema, textReasoningEffortSchema } from "../src/contracts/text/connections.js";
import { compileTextRevisionPrompt } from "../src/core/text/text-revision-prompt.js";
import { applyTextRevisionEdits, MIN_TEXT_REVISION_EDIT_BYTES } from "../src/core/text/text-revision-edits.js";
import { CodexTextError, runCodexText } from "../src/services/text/codex.js";
import { ClaudeTextError, runClaudeCodeText } from "../src/services/text/claude-code.js";
import { resolveTextCliExecutable } from "../src/services/text/connections.js";
import { revisionQualityCases } from "../tests/fixtures/text/revision-quality.js";

const usage = "Usage: benchmark-text-revision.ts --provider codex|claude_code --model MODEL [--reasoning-effort LEVEL] [--rounds 1..5] [--case CASE_ID]";

async function main(): Promise<void> {
  const { values } = parseArgs({ options: {
    provider: { type: "string" }, model: { type: "string" }, "reasoning-effort": { type: "string" },
    rounds: { type: "string", default: "1" }, case: { type: "string" }, help: { type: "boolean" },
  } });
  if (values.help) { console.log(usage); return; }
  const provider = z.enum(["codex", "claude_code"]).parse(values.provider);
  const model = cliTextModelSchema.parse(values.model);
  if (!model) throw new Error(usage);
  const reasoning = values["reasoning-effort"] === undefined ? undefined : textReasoningEffortSchema.parse(values["reasoning-effort"]);
  const rounds = z.coerce.number().int().min(1).max(5).parse(values.rounds);
  const cases = revisionQualityCases.filter((entry) => values.case === undefined || entry.id === values.case);
  if (cases.length === 0) throw new Error(usage);
  const executable = await resolveTextCliExecutable(provider === "codex" ? "codex" : "claude");
  if (!executable) throw new Error("The selected CLI is unavailable.");
  const run = provider === "codex" ? runCodexText : runClaudeCodeText;
  const measurements: Array<{ variant: "baseline" | "candidate"; elapsed_ms: number; correct: boolean }> = [];
  console.log(JSON.stringify({ provider, model, reasoning_effort: reasoning ?? "provider default", rounds, cases: cases.length,
    evidence: "Synthetic text, live CLI/account; no audio or desktop acceptance." }));
  for (let round = 0; round < rounds; round += 1) {
    for (const [index, fixture] of cases.entries()) {
      const variants = (round + index) % 2 === 0 ? ["baseline", "candidate"] as const : ["candidate", "baseline"] as const;
      for (const variant of variants) {
        const replyFormat = variant === "candidate" && Buffer.byteLength(fixture.source) >= MIN_TEXT_REVISION_EDIT_BYTES ? "edits" : "text";
        const revision = { ...defaultTextRevisionSettings(), enabled: true,
          ...(fixture.builtins ? { builtins: fixture.builtins } : {}) };
        const instruction = compileTextRevisionPrompt(revision, replyFormat)!;
        const started = performance.now();
        try {
          const response = await run({ executable, instruction, text: fixture.source, model,
            ...(reasoning ? { reasoning_effort: reasoning } : {}), signal: new AbortController().signal });
          const result = replyFormat === "edits" ? applyTextRevisionEdits(fixture.source, response) : response;
          const elapsed_ms = Math.round(performance.now() - started), correct = result === fixture.expected;
          measurements.push({ variant, elapsed_ms, correct });
          console.log(JSON.stringify({ case: fixture.id, round: round + 1, variant, reply_format: replyFormat, elapsed_ms, correct,
            input_bytes: Buffer.byteLength(fixture.source), reply_bytes: Buffer.byteLength(response) }));
        } catch (error: unknown) {
          const elapsed_ms = Math.round(performance.now() - started);
          measurements.push({ variant, elapsed_ms, correct: false });
          console.log(JSON.stringify({ case: fixture.id, round: round + 1, variant, elapsed_ms, correct: false, error: "REQUEST_OR_EDITS_FAILED" }));
          if ((error instanceof CodexTextError || error instanceof ClaudeTextError) && error.code !== "INVALID_RESPONSE") {
            console.error("The selected CLI could not complete the benchmark; remaining account calls were skipped.");
            process.exitCode = 1;
            return;
          }
        }
      }
    }
  }
  for (const variant of ["baseline", "candidate"] as const) {
    const selected = measurements.filter((entry) => entry.variant === variant);
    console.log(JSON.stringify({ variant, correct: selected.filter((entry) => entry.correct).length, total: selected.length }));
  }
  if (measurements.some((entry) => !entry.correct)) process.exitCode = 1;
}

main().catch(() => { console.error(usage); process.exitCode = 1; });
