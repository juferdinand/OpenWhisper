import { performance } from "node:perf_hooks";
import { z } from "zod";
import { SpeechWorkerError, type SpeechChannel } from "./speech-client.js";
import { speechChallengeReplySchema, speechChallengeRequestSchema, MAX_SPEECH_CHALLENGES } from "../../workers/speech/speech-control.js";
import { speechReadySchema, speechReplySchema, speechRequestSchema } from "../../workers/speech/speech-protocol.js";

/** Host-only original child port. Never constructed from IPC or a worker frame. */
export interface OriginalSpeechPort {
  onSpawn(listener: (pid: unknown) => void): () => void;
  onMessage(listener: (input: unknown) => void): () => void;
  onExit(listener: () => void): () => void;
  onError(listener: () => void): () => void;
  postMessage(input: unknown): void;
  terminate(): Promise<void>;
}
const optionsSchema = z.strictObject({ deadlineMs: z.number().int().min(1).max(8000).default(8000) });
const pidSchema = z.number().int().positive().max(0x7fff_ffff);
export interface ProvisionalSpeechTransport {
  /** Resolves only the original spawn PID. Cancellation never ends creation. */
  readonly started: Promise<number>;
  readonly channel: SpeechChannel;
  challenge(nonce: string, epoch: string, signal: AbortSignal): Promise<unknown>;
}
function error(code: "INTEGRITY_FAILED" | "TEARDOWN_FAILED" | "CANCELLED"): SpeechWorkerError { return new SpeechWorkerError(code); }

/** No signal/kill policy here. The supervisor owns admission and termination.
 * Generic exit merely settles original transport operations, never OS retirement. */
export function createProvisionalSpeechTransport(port: OriginalSpeechPort, inputEpoch: unknown, inputOptions: unknown = {}): ProvisionalSpeechTransport {
  const epoch = z.string().uuid().parse(inputEpoch), { deadlineMs } = optionsSchema.parse(inputOptions);
  let failed: SpeechWorkerError | undefined, ended = false, closing = false, pid: number | undefined;
  let ready = false, readyDelivered = false, successfulChallenges = 0;
  let messageListener: ((input: unknown) => void) | undefined, exitListener: (() => void) | undefined;
  let ordinary: { id: string; command: "discover" | "transcribe" | "shutdown" } | undefined;
  const nonces = new Set<string>();
  let queue: Promise<void> = Promise.resolve();
  let control: { nonce: string; accept: (value: unknown) => void; reject: (value: SpeechWorkerError) => void } | undefined;
  const originalOperations = new Set<Promise<unknown>>();
  let termination: Promise<void> | undefined;
  let rejectFailure!: (failure: SpeechWorkerError) => void;
  const terminalFailure = new Promise<never>((_accept, reject) => { rejectFailure = reject; });
  void terminalFailure.catch(() => {});
  let acceptSpawn!: (pid: number) => void, rejectSpawn!: (failure: SpeechWorkerError) => void;
  const originalSpawn = new Promise<number>((accept, reject) => { acceptSpawn = accept; rejectSpawn = reject; });
  let acceptReady!: () => void, rejectReady!: (failure: SpeechWorkerError) => void;
  const originalReady = new Promise<void>((accept, reject) => { acceptReady = accept; rejectReady = reject; });
  const retain = <T>(operation: Promise<T>): Promise<T> => {
    originalOperations.add(operation);
    void operation.then(() => { originalOperations.delete(operation); }, () => { originalOperations.delete(operation); });
    return operation;
  };
  const poison = (code: "INTEGRITY_FAILED" | "TEARDOWN_FAILED"): SpeechWorkerError => {
    if (!failed) {
      failed = error(code); rejectFailure(failed);
      // Client failure notification only, never a claim of OS death/reap.
      const notify = exitListener; exitListener = undefined; messageListener = undefined;
      if (notify) queueMicrotask(notify);
    }
    return failed;
  };
  const bounded = <T>(operation: Promise<T>): Promise<T> => {
    const until = performance.now() + deadlineMs;
    return new Promise<T>((accept, reject) => {
      const timer = setTimeout(() => { reject(poison("TEARDOWN_FAILED")); }, deadlineMs);
      void Promise.race([operation, terminalFailure]).then((value) => {
        clearTimeout(timer);
        if (failed) reject(failed);
        else if (performance.now() >= until) reject(poison("TEARDOWN_FAILED"));
        else accept(value);
      }, () => { clearTimeout(timer); reject(poison("TEARDOWN_FAILED")); });
    });
  };
  const boundedTermination = (operation: Promise<void>): Promise<void> => {
    const until = performance.now() + deadlineMs;
    return new Promise<void>((accept, reject) => {
      // Explicit cleanup authority belongs to the supervisor. An existing
      // frame failure cannot short-circuit the original termination/ACK wait.
      const timer = setTimeout(() => { reject(poison("TEARDOWN_FAILED")); }, deadlineMs);
      void operation.then(() => {
        clearTimeout(timer);
        if (performance.now() >= until) reject(poison("TEARDOWN_FAILED"));
        else if (failed) reject(failed);
        else accept();
      }, () => { clearTimeout(timer); reject(poison("TEARDOWN_FAILED")); });
    });
  };
  const started = bounded(retain(originalSpawn)); void started.catch(() => {});
  const available = bounded(retain(originalReady)); void available.catch(() => {});
  const deliverReady = (): void => {
    if (ready && !readyDelivered && messageListener && !failed && !ended && !closing) {
      readyDelivered = true; messageListener(speechReadySchema.parse({ version: 1, type: "ready" }));
    }
  };
  const receive = (input: unknown): void => {
    try {
      if (ended) return;
      const privateReply = speechChallengeReplySchema.safeParse(input);
      if (failed || closing) {
        // Late matching original replies close their actual operation only;
        // terminal refusal and the allocation remain unchanged.
        if (privateReply.success && control && privateReply.data.pid === pid && privateReply.data.epoch === epoch && privateReply.data.nonce === control.nonce) {
          const pending = control; control = undefined; pending.accept(privateReply.data);
        } else if (!ready && speechReadySchema.safeParse(input).success) { ready = true; acceptReady(); }
        return;
      }
      if (privateReply.success) {
        const pending = control;
        if (!pending || !pid || privateReply.data.pid !== pid || privateReply.data.epoch !== epoch || privateReply.data.nonce !== pending.nonce) {
          poison("INTEGRITY_FAILED"); return;
        }
        control = undefined; pending.accept(privateReply.data); return;
      }
      if (speechReadySchema.safeParse(input).success) {
        if (ready || ordinary || successfulChallenges > 0) { poison("INTEGRITY_FAILED"); return; }
        ready = true; acceptReady(); queueMicrotask(deliverReady); return;
      }
      const reply = speechReplySchema.safeParse(input), pending = ordinary;
      if (!reply.success || !pending || !messageListener || reply.data.id !== pending.id ||
        (reply.data.ok && reply.data.value.command !== pending.command)) { poison("INTEGRITY_FAILED"); return; }
      ordinary = undefined; messageListener(reply.data);
    } catch { poison("INTEGRITY_FAILED"); }
  };
  // Attach to the exact original object before any asynchronous spawn/readiness.
  port.onMessage(receive);
  port.onSpawn((input) => {
    const parsed = pidSchema.safeParse(input);
    if (!parsed.success || pid !== undefined || ended) { poison("TEARDOWN_FAILED"); return; }
    pid = parsed.data; acceptSpawn(pid);
  });
  port.onError(() => { poison("TEARDOWN_FAILED"); });
  port.onExit(() => {
    ended = true; ordinary = undefined;
    rejectSpawn(error("TEARDOWN_FAILED")); rejectReady(error("TEARDOWN_FAILED")); control?.reject(error("TEARDOWN_FAILED")); control = undefined;
    exitListener?.(); exitListener = undefined; messageListener = undefined;
  });
  const cancelled = <T>(operation: Promise<T>, signal: AbortSignal): Promise<T> => new Promise<T>((accept, reject) => {
    const abort = (): void => { reject(error("CANCELLED")); };
    signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort();
    void operation.then(accept, reject).finally(() => { signal.removeEventListener("abort", abort); });
  });
  return Object.freeze({ started,
    challenge(nonce: string, challengedEpoch: string, signal: AbortSignal): Promise<unknown> {
      if (!(signal instanceof AbortSignal) || !speechChallengeRequestSchema.safeParse({ version: 1, type: "challenge", epoch: challengedEpoch, nonce }).success ||
        challengedEpoch !== epoch || nonces.has(nonce) || nonces.size >= MAX_SPEECH_CHALLENGES) return Promise.reject(poison("INTEGRITY_FAILED"));
      if (signal.aborted) return Promise.reject(error("CANCELLED"));
      nonces.add(nonce);
      const transaction = queue.then(async () => {
        if (failed) throw failed; if (signal.aborted) throw error("CANCELLED");
        await Promise.all([started, available]);
        if (failed) throw failed; if (ended || closing || !ready) throw poison("TEARDOWN_FAILED");
        const original = retain(new Promise<unknown>((accept, reject) => { control = { nonce, accept, reject }; }));
        const waiting = bounded(original);
        try { port.postMessage(speechChallengeRequestSchema.parse({ version: 1, type: "challenge", epoch, nonce })); }
        catch { control?.reject(poison("TEARDOWN_FAILED")); }
        const reply = await waiting; successfulChallenges++; return reply;
      });
      queue = transaction.then(() => {}, () => {});
      // Cancellation only rejects this caller. The exact original operation and
      // serial transaction remain retained until actual reply/exit or sticky failure.
      void transaction.catch(() => {});
      return cancelled(transaction, signal);
    },
    channel: Object.freeze({
      send(input) {
        if (failed) throw failed;
        if (ended || closing) throw error("TEARDOWN_FAILED");
        const request = speechRequestSchema.safeParse(input);
        if (!request.success || !readyDelivered || successfulChallenges < 2 || ordinary || control) throw poison("INTEGRITY_FAILED");
        ordinary = { id: request.data.id, command: request.data.command };
        try { port.postMessage(request.data); } catch { throw poison("TEARDOWN_FAILED"); }
      },
      onMessage(listener) {
        if (messageListener) throw poison("INTEGRITY_FAILED"); messageListener = listener; queueMicrotask(deliverReady);
        return () => { if (messageListener === listener) messageListener = undefined; };
      },
      onExit(listener) {
        if (exitListener) throw poison("INTEGRITY_FAILED"); exitListener = listener;
        if (ended) queueMicrotask(() => { if (exitListener === listener) { exitListener = undefined; listener(); } });
        return () => { if (exitListener === listener) exitListener = undefined; };
      },
      terminate() {
        if (termination) return termination;
        closing = true;
        termination = boundedTermination(retain(Promise.resolve().then(() => port.terminate())));
        void termination.catch(() => {}); return termination;
      },
    } satisfies SpeechChannel),
  } satisfies ProvisionalSpeechTransport);
}
