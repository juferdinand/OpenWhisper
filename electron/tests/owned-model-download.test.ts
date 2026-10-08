import test from "node:test";
import { runOwnedTLS } from "./owned-model-download/run.js";
import { BOUNDS, REVIEW_TOKEN } from "./owned-model-download/contracts.js";

test("reviewed owned local TLS transport and catalog publication acceptance", {
  skip: process.env.OPENWHISPER_RUN_REVIEWED_OWNED_MODEL_TLS !== "1", timeout: BOUNDS.outerMs + 5000,
}, async () => { await runOwnedTLS(REVIEW_TOKEN, {
  directory: process.env.OPENWHISPER_OWNED_MODEL_TLS_BUNDLE ?? "", inputSha256: process.env.OPENWHISPER_OWNED_MODEL_TLS_INPUT_SHA256 ?? "",
}); });
