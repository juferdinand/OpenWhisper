import { z } from "zod";

export const SAMPLE_COUNT = 528_017;
export const MODEL = "/fixtures/ggml-tiny.bin";
export const EXPANSION = "OWNED-FIXTURE\n$10 日本語 👩‍💻";
export const modeSchema = z.enum(["capture-fail", "restore-drop", "restore-confirm"]);
export type FixtureMode = z.infer<typeof modeSchema>;
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const sha = z.string().regex(/^[a-f0-9]{64}$/);

export const phaseSchema = z.discriminatedUnion("phase", [
  z.strictObject({ fixture: z.literal("recording-phase"), phase: z.literal("prepared"),
    sampleCount: z.literal(SAMPLE_COUNT), chunkSamples: z.literal(SAMPLE_COUNT), sha256: sha,
    afterStopAck: z.literal(true), fenced: z.literal(true) }),
  z.strictObject({ fixture: z.literal("recording-phase"), phase: z.literal("recovery"),
    token: z.string().uuid(), sha256: sha, samples: z.literal(SAMPLE_COUNT), bytes: z.literal(SAMPLE_COUNT * 4 + 44),
    fileMode: z.literal(0o600), directoryMode: z.literal(0o700), restored: z.boolean(), captureCreates: count }),
  z.strictObject({ fixture: z.literal("recording-phase"), phase: z.literal("window"), start: count,
    end: count, samples: count }),
  z.strictObject({ fixture: z.literal("recording-phase"), phase: z.literal("overbacked-source"),
    backingBytes: z.literal(16 * 1024 * 1024), byteOffset: z.literal(128), samples: count,
    samplesCopiedExactly: z.literal(true) }),
  z.strictObject({ fixture: z.literal("recording-phase"), phase: z.literal("progress"), completedSamples: count }),
  z.strictObject({ fixture: z.literal("recording-phase"), phase: z.literal("processed"),
    sha256: sha, characters: count, vocabularyThenSnippet: z.literal(true), cleanupApplied: z.literal(true) }),
]);
export type FixturePhase = z.infer<typeof phaseSchema>;
export const resultSchema = z.strictObject({ fixture: z.literal("recording-result"), mode: modeSchema,
  pid: z.number().int().positive(), phase: z.enum(["done", "error"]), error: z.enum(["DELIVERY_FAILED"]).nullable(),
  recoveryAvailable: z.boolean(), captureCreates: count, sampleCount: z.literal(SAMPLE_COUNT),
  nativeCaptureLoaded: z.boolean(), nativeSpeechLoaded: z.literal(false), stopAckBeforePrepare: z.boolean(),
  rawLedgerReleased: z.boolean(), transcriptSha256: sha, transcriptCharacters: count });
export type FixtureResult = z.infer<typeof resultSchema>;
export const readySchema = z.strictObject({ fixture: z.literal("recording-ready"), pid: z.number().int().positive() });
export const runSchema = z.strictObject({ fixture: z.literal("run") });

export const probeResultSchema = z.strictObject({
  epochs: z.array(z.strictObject({ mode: modeSchema, epoch: z.string().uuid(), pid: z.number().int().positive(),
    reaped: z.literal(true), phases: z.array(phaseSchema), result: resultSchema.nullable(),
    inferenceWindows: z.array(z.number().int().positive().max(480_000)).min(2), coverage: z.literal(SAMPLE_COUNT),
    recoveryBeforeEveryInference: z.literal(true), confirmedReplyDropped: z.boolean(),
    wireBuffersExclusive: z.literal(true), malformedMainViewsRejected: z.literal(true) })).length(3),
  deliveryCalls: z.literal(2), clipboardCommits: z.literal(1), clipboardExact: z.literal(true),
  clipboardSha256: sha, clipboardCharacters: count, stableToken: z.string().uuid(),
  recoveryRemovedAfterConfirmation: z.literal(true), restoredCaptureCreates: z.literal(0),
  mainNativeCaptureLoaded: z.literal(false), mainNativeSpeechLoaded: z.literal(false),
  mainAlive: z.literal(true), runningMainCacheOnly: z.literal(true), speechHelpersReaped: z.literal(true),
});
export type ProbeResult = z.infer<typeof probeResultSchema>;
