/** Content-free diagnostics for the explicitly owned fixture, never app logging. */
import { AssertionError } from "node:assert";
import { z } from "zod";
import { addressSchema } from "./launch-contracts.js";

export const stageSchema = z.enum([
  "APP_READY", "RENDERER_SANDBOX_VALIDATED", "PRIVATE_BUS_READY", "UTILITY_FORKED",
  "READY_FRAME_VALIDATED", "BIRTH_ADMITTED", "REQUEST_POSTED", "RESULT_FRAME_RECEIVED",
  "RESULT_SCHEMA_VALIDATED", "OPERATION_ACCEPTED", "OPERATION_REFUSED",
  "CLEANUP_BEFORE_OBSERVATION", "KILL_REQUESTED", "CLEANUP_AFTER_OBSERVATION",
  "UTILITY_RETIRED", "UTILITY_RETIREMENT_REFUSED", "DAEMON_CLEANUP_STARTED",
  "DAEMON_RETIRED", "DAEMON_RETIREMENT_REFUSED", "READY_POSTED", "REQUEST_RECEIVED",
  "REQUEST_VALIDATED", "REQUEST_REFUSED", "NATIVE_LOAD_STARTED", "NATIVE_LOAD_COMPLETED",
  "NATIVE_LOAD_REFUSED", "SCENARIO_ENTERED", "SCENARIO_COMPLETED", "SCENARIO_REFUSED",
]);
export type Stage = z.infer<typeof stageSchema>;
export const categorySchema = z.enum(["INVALID_REQUEST", "DUPLICATE_REQUEST", "INVALID_RESULT",
  "INVALID_NATIVE_BINDING", "NATIVE_LOAD", "SCENARIO", "TIMEOUT", "PROCESS_OBSERVATION", "UNEXPECTED"]);
export type Category = z.infer<typeof categorySchema>;
export class DiagnosticRefusal extends Error {
  constructor(readonly category: Category) { super("Owned diagnostic operation refused."); }
}
export const codeSchema = z.enum(["ENOENT", "ESRCH", "EACCES", "EPERM", "ENOMEM", "ECONNREFUSED",
  "ETIMEDOUT", "ERR_DLOPEN_FAILED", "INVALID_FRAME", "CLOSED", "CANCELLED", "TIMEOUT",
  "REMOTE_ERROR", "TRANSPORT_FAILED", "TEARDOWN_FAILED", "EXPIRED", "DENIED", "UNRECOGNIZED"]);
export const witnessDetailSchema = z.strictObject({
  reason: z.enum(["READ_REFUSED", "STAT_INVALID", "STATUS_ABSENT_WITH_STAT_PRESENT", "UID_CHANGED",
    "TOPOLOGY_CHANGED", "BIRTH_CHANGED", "DEADLINE_EXPIRED", "LOOKUP_UNCONFIRMED", "ADMISSION_REFUSED"]),
  component: z.enum(["FIRST_STAT", "STATUS", "SECOND_STAT", "LOOKUP"]), ioCode: codeSchema.nullable(),
});
export const failureSchema = z.strictObject({ category: categorySchema,
  family: z.enum(["NODE_SYSTEM", "ZOD", "ASSERTION", "JAVASCRIPT", "OTHER"]), code: codeSchema.nullable(),
  witness: witnessDetailSchema.nullable() });
export type Failure = z.infer<typeof failureSchema>;

/** Inspect a data property only. Arbitrary accessors/messages/frames are never read. */
export function safeFailure(category: Category, error: unknown): Failure {
  let code: z.infer<typeof codeSchema> | null = null;
  let witness: z.infer<typeof witnessDetailSchema> | null = null;
  if (typeof error === "object" && error !== null) {
    try {
      const field: unknown = Object.getOwnPropertyDescriptor(error, "code")?.value;
      if (field !== undefined) { const parsed = codeSchema.safeParse(field); code = parsed.success ? parsed.data : "UNRECOGNIZED"; }
      const detail = witnessDetailSchema.safeParse({ reason: Object.getOwnPropertyDescriptor(error, "reason")?.value,
        component: Object.getOwnPropertyDescriptor(error, "component")?.value, ioCode: Object.getOwnPropertyDescriptor(error, "ioCode")?.value });
      if (detail.success) witness = detail.data;
    } catch { code = "UNRECOGNIZED"; }
  }
  let family: Failure["family"] = "OTHER";
  try { family = error instanceof z.ZodError ? "ZOD" : error instanceof AssertionError ? "ASSERTION" :
    error instanceof Error ? code !== null ? "NODE_SYSTEM" : "JAVASCRIPT" : "OTHER"; }
  catch { /* Unknown error prototypes cannot bypass the closed diagnostic. */ }
  return failureSchema.parse({ category, family, code, witness });
}
const elapsedSchema = z.number().finite().nonnegative();
export const diagnosisSchema = z.strictObject({
  stages: z.array(z.strictObject({ stage: stageSchema, elapsedMs: elapsedSchema })).max(32),
  operationFailure: failureSchema.nullable(), cleanupFailure: failureSchema.nullable(),
  utilityExitCode: z.int().min(-2147483648).max(2147483647).nullable(),
});
export class Diagnosis {
  private readonly start = performance.now();
  private readonly stages: Array<Readonly<{ stage: Stage; elapsedMs: number }>> = [];
  private operationFailure: Failure | null = null;
  private cleanupFailure: Failure | null = null;
  private utilityExitCode: number | null = null;
  constructor(private readonly persist: (value: z.infer<typeof diagnosisSchema>) => void) {}
  mark(stage: Stage): void {
    if (this.stages.length >= 32) throw new Error("Owned diagnostic stage bound exceeded.");
    this.stages.push({ stage: stageSchema.parse(stage), elapsedMs: performance.now() - this.start }); this.flush();
  }
  refuseOperation(category: Category, error: unknown): void {
    this.operationFailure ??= safeFailure(category, error); this.flush();
  }
  refuseCleanup(error: unknown): void { this.cleanupFailure ??= safeFailure("PROCESS_OBSERVATION", error); this.flush(); }
  exit(code: unknown): void {
    const parsed = diagnosisSchema.shape.utilityExitCode.safeParse(code); this.utilityExitCode = parsed.success ? parsed.data : null; this.flush();
  }
  snapshot(): z.infer<typeof diagnosisSchema> { return diagnosisSchema.parse({ stages: this.stages,
    operationFailure: this.operationFailure, cleanupFailure: this.cleanupFailure, utilityExitCode: this.utilityExitCode }); }
  private flush(): void { this.persist(this.snapshot()); }
}

export const fixtureRequestSchema = z.strictObject({ version: z.literal(1), id: z.uuid(),
  command: z.enum(["run", "cleanup"]), address: addressSchema });
type Request = z.infer<typeof fixtureRequestSchema>;
export type EntryOutcome = Readonly<{ ok: true; id: string; result: unknown }> |
  Readonly<{ ok: false; id: string | null; category: "INVALID_REQUEST" | "DUPLICATE_REQUEST" | "NATIVE_LOAD" | "SCENARIO" }>;
/** Injected ports make the error ordering testable without loading a native addon. */
export class EntryRequestHandler {
  private used = false;
  constructor(private readonly diagnosis: Diagnosis, private readonly load: () => unknown,
    private readonly run: (request: Request, binding: unknown) => Promise<unknown>) {}
  async handle(input: unknown): Promise<EntryOutcome> {
    this.diagnosis.mark("REQUEST_RECEIVED");
    const parsed = fixtureRequestSchema.safeParse(input);
    if (this.used || !parsed.success) {
      const category = this.used ? "DUPLICATE_REQUEST" : "INVALID_REQUEST";
      this.diagnosis.refuseOperation(category, parsed.success ? undefined : parsed.error);
      this.diagnosis.mark("REQUEST_REFUSED"); return { ok: false, id: null, category };
    }
    this.used = true; this.diagnosis.mark("REQUEST_VALIDATED");
    let binding: unknown;
    this.diagnosis.mark("NATIVE_LOAD_STARTED");
    try { binding = this.load(); this.diagnosis.mark("NATIVE_LOAD_COMPLETED"); }
    catch (error: unknown) {
      this.diagnosis.refuseOperation("NATIVE_LOAD", error); this.diagnosis.mark("NATIVE_LOAD_REFUSED");
      return { ok: false, id: parsed.data.id, category: "NATIVE_LOAD" };
    }
    this.diagnosis.mark("SCENARIO_ENTERED");
    try { const result = await this.run(parsed.data, binding); this.diagnosis.mark("SCENARIO_COMPLETED");
      return { ok: true, id: parsed.data.id, result }; }
    catch (error: unknown) {
      this.diagnosis.refuseOperation("SCENARIO", error); this.diagnosis.mark("SCENARIO_REFUSED");
      return { ok: false, id: parsed.data.id, category: "SCENARIO" };
    }
  }
}
