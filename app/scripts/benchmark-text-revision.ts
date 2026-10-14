import { parseArgs } from "node:util";
import { z } from "zod";
import { defaultTextRevisionSettings, cliTextModelSchema, textReasoningEffortSchema } from "../src/contracts/text/connections.js";
import { compileTextRevisionPrompt } from "../src/core/text/text-revision-prompt.js";
import { CodexTextError, parseCodexJsonl, runCodexText } from "../src/services/text/codex.js";
import { ClaudeTextError, runClaudeCodeText } from "../src/services/text/claude-code.js";
import { resolveTextCliExecutable } from "../src/services/text/connections.js";
import { runTextCliProcess } from "../src/services/text/text-cli-process.js";
import { buildTextPrompt } from "../src/services/text/text-prompt.js";
import { revisionQualityCases } from "../tests/fixtures/text/revision-quality.js";

const usage = "Usage: benchmark-text-revision.ts --provider codex|claude_code --model MODEL [--reasoning-effort LEVEL] [--rounds 1..5] [--case CASE_ID] [--compare-baseline]";

async function main(): Promise<void> {
  const { values } = parseArgs({ options: {
    provider: { type: "string" }, model: { type: "string" }, "reasoning-effort": { type: "string" },
    rounds: { type: "string", default: "1" }, case: { type: "string" }, "compare-baseline": { type: "boolean" }, help: { type: "boolean" },
  } });
  if (values.help) { console.log(usage); return; }
  const provider = z.enum(["codex", "claude_code"]).parse(values.provider);
  const model = cliTextModelSchema.parse(values.model);
  if (!model || values["compare-baseline"] && provider !== "codex") throw new Error(usage);
  const reasoning = values["reasoning-effort"] === undefined ? undefined : textReasoningEffortSchema.parse(values["reasoning-effort"]);
  const rounds = z.coerce.number().int().min(1).max(5).parse(values.rounds);
  const cases = revisionQualityCases.filter((entry) => values.case === undefined || entry.id === values.case);
  if (cases.length === 0) throw new Error(usage);
  const executable = await resolveTextCliExecutable(provider === "codex" ? "codex" : "claude");
  if (!executable) throw new Error("The selected CLI is unavailable.");
  const run = provider === "codex" ? runCodexText : runClaudeCodeText;
  const measurements: Array<{ variant: string; elapsed_ms: number; correct: boolean }> = [];
  console.log(JSON.stringify({ provider, model, reasoning_effort: reasoning ?? "provider default", rounds, cases: cases.length,
    evidence: "Synthetic text, live CLI/account; no audio or desktop acceptance." }));
  for (let round = 0; round < rounds; round += 1) {
    for (const [index, fixture] of cases.entries()) {
      const variants = !values["compare-baseline"] ? ["app"]
        : (round + index) % 2 === 0 ? ["baseline", "candidate"] : ["candidate", "baseline"];
      for (const variant of variants) {
        const revision = { ...defaultTextRevisionSettings(), enabled: true,
          ...(fixture.builtins ? { builtins: fixture.builtins } : {}) };
        const instruction = compileTextRevisionPrompt(revision)!;
        const started = performance.now();
        try {
          let response: string;
          if (variant === "baseline") {
            // Preserve the former exec transport as an independent comparison when the app changes.
            response = parseCodexJsonl(await runTextCliProcess({ executable,
              args: ["-a", "never", "exec", "--sandbox", "read-only", "--skip-git-repo-check", "--ephemeral", "--json", "--color", "never",
                ...(reasoning ? ["--config", `model_reasoning_effort="${reasoning}"`] : []), "--model", model, "-"],
              input: buildTextPrompt(instruction, fixture.source), signal: new AbortController().signal, timeoutMs: 120_000 }));
          } else response = await run({ executable, instruction, text: fixture.source, model,
            ...(reasoning ? { reasoning_effort: reasoning } : {}), signal: new AbortController().signal });
          const elapsed_ms = Math.round(performance.now() - started), correct = response === fixture.expected;
          measurements.push({ variant, elapsed_ms, correct });
          console.log(JSON.stringify({ case: fixture.id, round: round + 1, variant, elapsed_ms, correct,
            input_bytes: Buffer.byteLength(fixture.source), reply_bytes: Buffer.byteLength(response) }));
        } catch (error: unknown) {
          const elapsed_ms = Math.round(performance.now() - started);
          measurements.push({ variant, elapsed_ms, correct: false });
          console.log(JSON.stringify({ case: fixture.id, round: round + 1, variant, elapsed_ms, correct: false, error: "REQUEST_FAILED" }));
          if ((error instanceof CodexTextError || error instanceof ClaudeTextError) && error.code !== "INVALID_RESPONSE") {
            console.error("The selected CLI could not complete the benchmark; remaining account calls were skipped.");
            process.exitCode = 1;
            return;
          }
        }
      }
    }
  }
  for (const variant of ["app", "baseline", "candidate"]) {
    const selected = measurements.filter((entry) => entry.variant === variant);
    if (selected.length > 0) console.log(JSON.stringify({ variant, correct: selected.filter((entry) => entry.correct).length, total: selected.length }));
  }
  if (measurements.some((entry) => !entry.correct)) process.exitCode = 1;
}

main().catch(() => { console.error(usage); process.exitCode = 1; });
