import { CONTROL_USAGE, isControlCommand, type ControlAction, type ControlCommand, type LaunchSelection } from "../../../cli/arguments.js";
import { InvalidControlStatus, parseControlStatus, serializeControlStatus, type ControlWireStatus } from "./control-status.js";
import { controlTarget, type ControlKind } from "./control-identity.js";

export const DEVELOPMENT_CONTROL_TARGET = controlTarget("development");
const DAEMON = "org.freedesktop.DBus";
export type ControlClientErrorCode = "INVALID_COMMAND" | "CLOSED" | "BUSY" | "CANCELLED" | "TIMEOUT" |
  "NO_SESSION_BUS" | "SESSION_UNAVAILABLE" | "NOT_RUNNING" | "OWNER_UNVERIFIED" | "FOREIGN_OWNER" |
  "CONTROL_UNAVAILABLE" | "CONTROL_FAILED" | "INVALID_RESPONSE" | "OWNER_CHANGED" | "DISPOSAL_FAILED";
export class ControlClientError extends Error {
  constructor(readonly code: ControlClientErrorCode) { super("OpenWhisper Dev control failed."); this.name = "ControlClientError"; }
}
export interface ControlOperationContext {
  readonly signal: AbortSignal;
  readonly expiresAtUs: string;
  readonly timeoutMs: number;
  readonly noAutoStart: true;
}
/** A trusted adapter implements only its fixed captured identity and daemon operations. */
export interface DevelopmentControlPort {
  readonly generation: string;
  readonly isClosed: boolean;
  watchDevelopmentOwner(handler: (event: unknown) => void, context: ControlOperationContext): Promise<() => Promise<void>>;
  resolveDevelopmentOwner(context: ControlOperationContext): Promise<unknown>;
  ownerUid(unique: string, context: ControlOperationContext): Promise<unknown>;
  readStatus(unique: string, context: ControlOperationContext): Promise<unknown>;
  executeAction(unique: string, action: ControlAction, context: ControlOperationContext): Promise<unknown>;
  /** Resolves only after all resources and pending work of this port are closed. */
  close(): Promise<void>;
}
/** A rejected factory must have disposed its own resources; late success is retained. */
export type DevelopmentControlFactory = (context: ControlOperationContext) => Promise<DevelopmentControlPort>;
export interface ControlClientOptions {
  readonly factory: DevelopmentControlFactory;
  readonly uid: number;
  readonly kind?: ControlKind;
  /** Test budgets may be smaller; production defaults remain five plus two seconds. */
  readonly operationMs?: number;
  readonly cleanupMs?: number;
}
interface Transaction {
  readonly cancellation: AbortController;
  readonly expires: bigint;
  failure: ControlClientError | undefined;
  operation: boolean;
}
function failure(error: unknown): ControlClientError {
  if (error instanceof ControlClientError) return error;
  return new ControlClientError(error instanceof InvalidControlStatus ? "INVALID_RESPONSE" : "CONTROL_FAILED");
}
function unique(value: unknown): value is string {
  return typeof value === "string" && value.length <= 255 && /^:[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+$/.test(value);
}
function generation(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
}
function fields(input: unknown, names: readonly string[]): boolean {
  return typeof input === "object" && input !== null && !Array.isArray(input) &&
    Object.keys(input).length === names.length && names.every((name) => Object.hasOwn(input, name));
}
function reply(input: unknown, epoch: string, sender: string): unknown {
  if (!fields(input, ["generation", "sender", "value"]) || typeof input !== "object" || input === null ||
    Reflect.get(input, "generation") !== epoch || Reflect.get(input, "sender") !== sender) throw new ControlClientError("INVALID_RESPONSE");
  const value: unknown = Reflect.get(input, "value"); return value;
}
function budget(value: number | undefined, maximum: number): number {
  const selected = value ?? maximum;
  if (!Number.isInteger(selected) || selected < 1 || selected > maximum) throw new RangeError("Invalid control timing budget.");
  return selected;
}
function completion() {
  let resolve = (): void => { throw new Error("Uninitialized control completion."); };
  let reject = (_error: ControlClientError): void => { throw new Error("Uninitialized control completion."); };
  const promise = new Promise<void>((accept, refuse) => { resolve = accept; reject = refuse; });
  return { promise, resolve, reject };
}
function within(task: Promise<void>, milliseconds: number): Promise<void> {
  return new Promise<void>((accept, reject) => {
    const timer = setTimeout(() => { reject(new ControlClientError("DISPOSAL_FAILED")); }, milliseconds);
    task.then(() => { clearTimeout(timer); accept(); }, () => { clearTimeout(timer); reject(new ControlClientError("DISPOSAL_FAILED")); });
  });
}

/** Single-use client: no retry, GUI activation or profile access; its factory owns native resources. */
export class DevelopmentControlClient {
  private readonly operationMs: number;
  private readonly cleanupMs: number;
  private readonly factory: DevelopmentControlFactory;
  private readonly uid: number;
  private readonly target: ReturnType<typeof controlTarget>;
  private readonly retired = completion();
  private transaction: Transaction | undefined;
  private used = false;
  private closing = false;
  private finished = false;
  /** Retained even after a bounded failure, so a late factory still disposes its owner. */
  private cleanup: Promise<void> | undefined;
  constructor(options: ControlClientOptions) {
    if (!Number.isInteger(options.uid) || options.uid < 0 || options.uid > 0xffff_ffff) throw new RangeError("Invalid control user identity.");
    if (typeof options.factory !== "function") throw new RangeError("Invalid control factory.");
    this.factory = options.factory; this.uid = options.uid;
    this.target = controlTarget(options.kind ?? "development");
    this.operationMs = budget(options.operationMs, 5000); this.cleanupMs = budget(options.cleanupMs, 2000);
    void this.retired.promise.catch(() => undefined);
  }
  private abort(transaction: Transaction, code: ControlClientErrorCode): void {
    if (!transaction.operation || transaction.cancellation.signal.aborted) return;
    transaction.failure = new ControlClientError(code); transaction.cancellation.abort();
  }
  private current(transaction: Transaction, port?: DevelopmentControlPort, epoch?: string): void {
    if (process.hrtime.bigint() / 1000n >= transaction.expires) this.abort(transaction, "TIMEOUT");
    if (transaction.cancellation.signal.aborted) throw transaction.failure ?? new ControlClientError("CANCELLED");
    if (port && (port.isClosed || port.generation !== epoch)) throw new ControlClientError("OWNER_CHANGED");
  }
  private context(transaction: Transaction): ControlOperationContext {
    this.current(transaction);
    const timeoutMs = Number((transaction.expires - process.hrtime.bigint() / 1000n + 999n) / 1000n);
    if (timeoutMs < 1) { this.abort(transaction, "TIMEOUT"); throw transaction.failure ?? new ControlClientError("TIMEOUT"); }
    return Object.freeze({ signal: transaction.cancellation.signal, expiresAtUs: transaction.expires.toString(),
      timeoutMs: Math.min(this.operationMs, timeoutMs), noAutoStart: true });
  }
  private step<T>(task: Promise<T>, transaction: Transaction, pending: Set<Promise<unknown>>): Promise<T> {
    pending.add(task);
    void task.then(() => { pending.delete(task); }, () => { pending.delete(task); });
    return new Promise<T>((accept, reject) => {
      const aborted = (): void => { reject(transaction.failure ?? new ControlClientError("CANCELLED")); };
      transaction.cancellation.signal.addEventListener("abort", aborted, { once: true });
      task.then((value) => {
        transaction.cancellation.signal.removeEventListener("abort", aborted);
        try { this.current(transaction); accept(value); } catch (error: unknown) { reject(failure(error)); }
      }, (error: unknown) => { transaction.cancellation.signal.removeEventListener("abort", aborted); reject(failure(error)); });
      if (transaction.cancellation.signal.aborted) aborted();
    });
  }
  execute(command: ControlCommand, signal?: AbortSignal): Promise<ControlWireStatus> {
    if (!isControlCommand(command)) return Promise.reject(new ControlClientError("INVALID_COMMAND"));
    if (this.closing || this.finished) return Promise.reject(new ControlClientError("CLOSED"));
    if (this.used) return Promise.reject(new ControlClientError("BUSY"));
    this.used = true;
    const transaction: Transaction = { cancellation: new AbortController(), expires: process.hrtime.bigint() / 1000n + BigInt(this.operationMs) * 1000n,
      failure: undefined, operation: true };
    this.transaction = transaction;
    return this.perform(command, transaction, signal);
  }
  private async perform(command: ControlCommand, transaction: Transaction, signal?: AbortSignal): Promise<ControlWireStatus> {
    const pending = new Set<Promise<unknown>>();
    let opening: Promise<DevelopmentControlPort> | undefined;
    let watching: Promise<() => Promise<void>> | undefined;
    let result: ControlWireStatus | undefined;
    let rejected: ControlClientError | undefined;
    const timeout = setTimeout(() => { this.abort(transaction, "TIMEOUT"); }, this.operationMs);
    const cancelled = (): void => { this.abort(transaction, "CANCELLED"); };
    signal?.addEventListener("abort", cancelled, { once: true });
    if (signal?.aborted) cancelled();
    try {
      this.current(transaction);
      opening = this.factory(this.context(transaction));
      const port = await this.step(opening, transaction, pending);
      const epoch = port.generation;
      if (!generation(epoch) || typeof port.isClosed !== "boolean") throw new ControlClientError("INVALID_RESPONSE");
      this.current(transaction, port, epoch);
      let owner: string | undefined;
      watching = port.watchDevelopmentOwner((input: unknown) => {
        if (!transaction.operation) return;
        try {
          if (!fields(input, ["generation", "name", "before", "after"]) || typeof input !== "object" || input === null) {
            this.abort(transaction, "INVALID_RESPONSE"); return;
          }
          const name: unknown = Reflect.get(input, "name"), before: unknown = Reflect.get(input, "before"), after: unknown = Reflect.get(input, "after");
          if (Reflect.get(input, "generation") !== epoch || !(name === this.target.name || unique(name)) ||
            !(before === "" || unique(before)) || !(after === "" || unique(after))) { this.abort(transaction, "INVALID_RESPONSE"); return; }
          if ((name === this.target.name && before !== after) ||
            (name === owner && before === owner && after === "")) this.abort(transaction, "OWNER_CHANGED");
        } catch { this.abort(transaction, "INVALID_RESPONSE"); }
      }, this.context(transaction));
      const unsubscribe = await this.step(watching, transaction, pending);
      if (typeof unsubscribe !== "function") throw new ControlClientError("INVALID_RESPONSE");
      this.current(transaction, port, epoch);
      const resolved = reply(await this.step(port.resolveDevelopmentOwner(this.context(transaction)), transaction, pending), epoch, DAEMON);
      this.current(transaction, port, epoch);
      if (!unique(resolved)) throw new ControlClientError("INVALID_RESPONSE");
      owner = resolved;
      const uid = reply(await this.step(port.ownerUid(owner, this.context(transaction)), transaction, pending), epoch, DAEMON);
      this.current(transaction, port, epoch);
      if (typeof uid !== "number" || !Number.isInteger(uid) || uid < 0 || uid > 0xffff_ffff) throw new ControlClientError("INVALID_RESPONSE");
      if (uid !== this.uid) throw new ControlClientError("FOREIGN_OWNER");
      this.current(transaction, port, epoch);
      const response = command === "status" ? port.readStatus(owner, this.context(transaction)) : port.executeAction(owner, command, this.context(transaction));
      const text = reply(await this.step(response, transaction, pending), epoch, owner);
      this.current(transaction, port, epoch);
      result = parseControlStatus(text);
    } catch (error: unknown) { rejected = failure(error); }
    finally {
      // A received status is point-in-time evidence. Closing never sends Cancel.
      transaction.operation = false; clearTimeout(timeout); signal?.removeEventListener("abort", cancelled);
      transaction.cancellation.abort();
      const acquired = opening?.then((port) => port, () => undefined) ?? Promise.resolve(undefined);
      this.cleanup = (async () => {
        const port = await acquired;
        const closure = port ? Promise.resolve().then(async () => {
          await port.close(); if (!port.isClosed) throw new ControlClientError("DISPOSAL_FAILED");
        }) : Promise.resolve();
        const unwatch = watching?.then(async (unsubscribe) => {
          if (typeof unsubscribe !== "function") throw new ControlClientError("DISPOSAL_FAILED");
          await unsubscribe();
        }).catch(() => undefined) ?? Promise.resolve();
        const settled = await Promise.allSettled([closure, unwatch, ...pending]);
        if (settled[0]?.status !== "fulfilled") throw new ControlClientError("DISPOSAL_FAILED");
      })();
      try { await within(this.cleanup, this.cleanupMs); this.retired.resolve(); }
      catch { rejected = new ControlClientError("DISPOSAL_FAILED"); this.retired.reject(rejected); }
      this.finished = true;
    }
    if (rejected) throw rejected;
    if (!result) throw new ControlClientError("INVALID_RESPONSE");
    return result;
  }
  close(): Promise<void> {
    this.closing = true;
    if (this.transaction) this.abort(this.transaction, "CLOSED");
    else { this.finished = true; this.retired.resolve(); }
    return this.retired.promise;
  }
}

const ERROR_MESSAGES: Readonly<Record<ControlClientErrorCode, string>> = Object.freeze({
  INVALID_COMMAND: "Invalid OpenWhisper Dev control command.", CLOSED: "OpenWhisper Dev control client is closed.",
  BUSY: "OpenWhisper Dev control request is already pending.", CANCELLED: "OpenWhisper Dev control request cancelled.",
  TIMEOUT: "Control request timed out.", NO_SESSION_BUS: "No session bus. Open OpenWhisper Dev in this desktop session first.",
  SESSION_UNAVAILABLE: "Session bus unavailable.", NOT_RUNNING: "OpenWhisper Dev is not running in this session. Open the app first.",
  OWNER_UNVERIFIED: "Could not verify OpenWhisper Dev owner.", FOREIGN_OWNER: "OpenWhisper Dev belongs to a different user.",
  CONTROL_UNAVAILABLE: "Control interface unavailable.", CONTROL_FAILED: "OpenWhisper Dev control request failed.",
  INVALID_RESPONSE: "Invalid control response.", OWNER_CHANGED: "OpenWhisper Dev control owner changed.",
  DISPOSAL_FAILED: "OpenWhisper Dev control cleanup could not be confirmed. Do not repeat the command automatically.",
});
export interface ControlCliOutput { readonly exitCode: 0 | 1 | 2; readonly stdout: string; readonly stderr: string }
export function controlFailureOutput(error: unknown, kind: ControlKind = "development"): ControlCliOutput {
  controlTarget(kind);
  const message = ERROR_MESSAGES[failure(error).code];
  return Object.freeze({ exitCode: 1, stdout: "", stderr: `${kind === "stable" ? message.replaceAll("OpenWhisper Dev", "OpenWhisper") : message}\n` });
}
/** Pure early routing. Invalid/GUI selections never invoke the supplied factory. */
export async function runApplicationControl(selection: LaunchSelection, options: ControlClientOptions): Promise<ControlCliOutput | undefined> {
  if (selection.kind === "gui") return undefined;
  if (selection.kind === "invalid") return Object.freeze({ exitCode: 2, stdout: "", stderr: `${CONTROL_USAGE}\n` });
  try {
    const result = await new DevelopmentControlClient(options).execute(selection.command);
    return Object.freeze({ exitCode: 0, stdout: `${serializeControlStatus(result)}\n`, stderr: "" });
  } catch (error: unknown) { return controlFailureOutput(error, options.kind); }
}
export const runDevelopmentControl = runApplicationControl;
