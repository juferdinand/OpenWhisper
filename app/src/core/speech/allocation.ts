import { z } from "zod";
import { SpeechWorkerError } from "../../services/speech/speech-client.js";

const epochSchema = z.string().uuid();
const tokenBrand: unique symbol = Symbol("speech-allocation-token");
export interface SpeechAllocationToken { readonly [tokenBrand]: true }
export type SpeechAllocationPhase = "free" | "opening" | "live" | "retiring" | "failed";

/** Pure continuing-owner kernel. One instance models one main process, not a
 * request or client. The production facade privately owns its only instance;
 * independent kernels exist solely for inert policy tests. There is no reset. */
export class SpeechAllocation {
  private phaseValue: SpeechAllocationPhase = "free";
  private token: SpeechAllocationToken | undefined;
  private refusal: SpeechWorkerError | undefined;
  private readonly retained = new Set<Promise<unknown>>();
  private readonly failedObligations = new Set<Promise<unknown>>();
  private owner: object | undefined;
  private retirement: Promise<void> | undefined;
  get phase(): SpeechAllocationPhase { return this.phaseValue; }

  check(): void { if (this.refusal) throw this.refusal; }
  reserve(epoch: unknown): SpeechAllocationToken {
    this.check();
    if (!epochSchema.safeParse(epoch).success) throw this.poison("INTEGRITY_FAILED");
    if (this.phaseValue !== "free") throw new SpeechWorkerError("BUSY");
    this.token = Object.freeze({ [tokenBrand]: true as const });
    this.phaseValue = "opening";
    return this.token;
  }
  private owned(token: SpeechAllocationToken): void {
    this.check();
    if (token !== this.token) throw this.poison("INTEGRITY_FAILED");
  }
  admit(token: SpeechAllocationToken): void {
    this.owned(token);
    if (this.phaseValue !== "opening") throw this.poison("INTEGRITY_FAILED");
    this.phaseValue = "live";
  }
  attach(token: SpeechAllocationToken, owner: object): void {
    this.owned(token);
    if (this.owner || this.phaseValue !== "opening") throw this.poison("INTEGRITY_FAILED");
    this.owner = owner;
  }
  retain<T>(operation: Promise<T>): Promise<T> {
    this.retained.add(operation);
    // Even after a deadline, retain and observe the original effect through its
    // real completion. A late rejection must not become unhandled or reset us.
    void operation.then(() => { this.retained.delete(operation); }, () => { this.retained.delete(operation); });
    return operation;
  }
  poison(code: "INTEGRITY_FAILED" | "TEARDOWN_FAILED", obligation?: Promise<unknown>): SpeechWorkerError {
    if (obligation) { this.failedObligations.add(obligation); this.retain(obligation); }
    this.refusal ??= new SpeechWorkerError(code);
    this.phaseValue = "failed";
    return this.refusal;
  }
  /** The service supplies its full OS-retirement AND descriptor-closure gate.
   * A generic exit or reader barrier alone is never a valid completion effect. */
  retire(token: SpeechAllocationToken, completion: () => Promise<void>): Promise<void> {
    try { this.owned(token); } catch (error: unknown) { return Promise.reject(error); }
    if (this.retirement) return this.retirement;
    this.phaseValue = "retiring";
    const operation = this.retain(Promise.resolve().then(completion));
    this.retirement = operation.then(() => {
      this.owned(token);
      this.token = undefined;
      this.owner = undefined;
      this.phaseValue = "free";
      this.retirement = undefined;
    }, () => {
      throw this.poison("TEARDOWN_FAILED", operation);
    });
    void this.retirement.catch(() => {}); return this.retirement;
  }
}
