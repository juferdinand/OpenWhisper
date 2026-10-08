import { z } from "zod";
import { failureSchema, safeFailure } from "./diagnostics.js";
import { oldChecks } from "./launch-contracts.js";

export const operationSchema = z.enum(["NATIVE_LOAD", "NATIVE_UTF16_OPEN_REFUSAL", "DAEMON_READY", "NATIVE_IDENTITY_OPEN",
  "NATIVE_UTF16_CALL_REFUSAL", "NATIVE_IDENTITY_CLOSE", "FACADE_OPEN", "SERVICE_OWNER", "OWNER_UID", "ABSENT_OWNER", "ECHO",
  "WRONG_SIGNATURE", "CLOSE_WRONG_SIGNATURE", "REOPEN_WRONG_SIGNATURE", "FD_FILE_RECEIVE", "FD_EXTRA_RECEIVE", "FD_PIPE_RECEIVE",
  "FD_LARGE_RECEIVE", "FD_FILE_REFLECT", "FD_EXTRA_REFLECT", "FD_FILE_CONSUME", "FD_EXTRA_CONSUME", "FD_PIPE_REFUSE", "FD_LARGE_REFUSE",
  "FD_COUNT", "FD_BAD_SIGNATURE", "FD_BAD_CLOSE", "FD_BAD_REOPEN", "CANCELLED_HOLD", "EXPECTED_TIMEOUT", "SUBSCRIBE", "EMIT",
  "UNSUBSCRIBE", "EMIT_AFTER_UNSUBSCRIBE", "CONTROL_EXPORT", "CONTROL_STATUS", "CONTROL_INVALID", "CONTROL_UNANSWERED",
  "CONTROL_EXPIRED_AUTH", "EXPIRED_AUTH_OBSERVED", "FOREIGN_MARKER", "FOREIGN_WAIT", "STALE_SUBSCRIBE", "OWNER_REPLACEMENT",
  "OLD_OWNER_CALL", "NEW_OWNER_CALL", "BURST_SUBSCRIBE", "BURST_REFUSAL", "BURST_CLOSE_REOPEN", "HUGE_SUBSCRIBE", "HUGE_REFUSAL",
  "HUGE_REOPEN", "RETAINED_FD", "QUEUED_HOLD", "QUEUED_CLOSE", "FRESH_GENERATION", "IDLE_DAEMON_STOP", "IDLE_CLOSED",
  "REPLACEMENT_DAEMON_READY", "REPLACEMENT_FACADE"]);
type Operation = z.infer<typeof operationSchema>;
const activeSchema = z.strictObject({ operation: operationSchema, phase: z.enum(["entered", "completed"]) });
const cleanupSchema = z.strictObject({ operation: z.enum(["FINAL_BUS_CLOSE", "FINAL_CHILD_STOP"]), phase: z.enum(["entered", "completed"]) });
const prefixSchema = z.array(z.string()).max(19).refine((items) => items.every((item, index) => item === oldChecks[index]));
export const legacyDiagnosisSchema = z.strictObject({ transitions: z.int().min(0).max(256), active: activeSchema.nullable(),
  completedChecks: prefixSchema, cleaning: z.boolean(), cleanup: cleanupSchema.nullable(), failure: failureSchema.nullable() });
type Snapshot = z.infer<typeof legacyDiagnosisSchema>;
const fdModeSchema = z.enum(["file", "extra", "pipe", "large"]);
type FdStage = "receive" | "reflect" | "consume" | "refuse";
const fdOperations: Readonly<Record<z.infer<typeof fdModeSchema>, Readonly<Partial<Record<FdStage, Operation>>>>> = {
  file: { receive: "FD_FILE_RECEIVE", reflect: "FD_FILE_REFLECT", consume: "FD_FILE_CONSUME" },
  extra: { receive: "FD_EXTRA_RECEIVE", reflect: "FD_EXTRA_REFLECT", consume: "FD_EXTRA_CONSUME" },
  pipe: { receive: "FD_PIPE_RECEIVE", refuse: "FD_PIPE_REFUSE" }, large: { receive: "FD_LARGE_RECEIVE", refuse: "FD_LARGE_REFUSE" },
};
/** Owned test metadata only. No dynamic method, body, error text or PID fields. */
export class LegacyDiagnosis {
  private value: Snapshot = { transitions: 0, active: null, completedChecks: [], cleaning: false, cleanup: null, failure: null };
  constructor(private readonly persist: (snapshot: Snapshot) => void) {}
  enter(operation: Operation): void {
    if (this.value.cleaning) throw new Error("Original operation cannot replace final cleanup metadata.");
    this.value.active = { operation: operationSchema.parse(operation), phase: "entered" }; this.flush();
  }
  complete(operation: Operation): void {
    if (this.value.cleaning || this.value.active?.operation !== operation || this.value.active.phase !== "entered") throw new Error("Diagnostic operation ordering differs.");
    this.value.active.phase = "completed"; this.flush();
  }
  enterFd(stage: FdStage, mode: unknown): void { this.enter(this.fdOperation(stage, mode)); }
  completeFd(stage: FdStage, mode: unknown): void { this.complete(this.fdOperation(stage, mode)); }
  checks(value: unknown): void {
    const next = prefixSchema.parse(value);
    if (next.length !== this.value.completedChecks.length + 1) throw new Error("Diagnostic completed-check prefix differs.");
    this.value.completedChecks = [...next]; this.flush();
  }
  beginCleanup(): void { this.value.cleaning = true; this.flush(); }
  cleanupEnter(operation: z.infer<typeof cleanupSchema>["operation"]): void {
    if (!this.value.cleaning) throw new Error("Final cleanup has not started.");
    this.value.cleanup = cleanupSchema.parse({ operation, phase: "entered" }); this.flush();
  }
  cleanupComplete(operation: z.infer<typeof cleanupSchema>["operation"]): void {
    if (!this.value.cleaning || this.value.cleanup?.operation !== operation || this.value.cleanup.phase !== "entered") throw new Error("Final cleanup ordering differs.");
    this.value.cleanup.phase = "completed"; this.flush();
  }
  refuse(error: unknown): void { this.value.failure ??= safeFailure("SCENARIO", error); this.flush(); }
  snapshot(): Snapshot { return legacyDiagnosisSchema.parse(this.value); }
  private fdOperation(stage: FdStage, mode: unknown): Operation {
    const operation = fdOperations[fdModeSchema.parse(mode)][stage];
    if (!operation) throw new Error("Unexpected fixed FD diagnostic stage."); return operation;
  }
  private flush(): void {
    if (this.value.transitions >= 256) throw new Error("Owned diagnostic transition bound exceeded.");
    this.value.transitions += 1; this.persist(this.snapshot());
  }
}
