import { randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { SpeechWorkerError, type SpeechChannel, type SpeechChannelFactory } from "../../src/services/speech/speech-client.js";
import { speechChallengeReplySchema, speechChallengeRequestSchema } from "../../src/workers/speech/speech-control.js";
import { speechReadySchema, speechRequestSchema } from "../../src/workers/speech/speech-protocol.js";

const ENTRY = "/owned-app/dist/workers/speech-entry.js";
const BINDING = "/owned-app/dist/native/openwhisper_speech.node";
const DEADLINE_MS = 8000;

export interface FixtureSpeechProcess {
  pid(): number | undefined;
  postMessage(input: unknown): void;
  kill(): void;
  onMessage(listener: (input: unknown) => void): () => void;
  onSpawn(listener: () => void): () => void;
  onError(listener: () => void): () => void;
  onExit(listener: () => void): void;
}

async function fixedFile(path: typeof ENTRY | typeof BINDING): Promise<string> {
  const [status, canonical] = await Promise.all([lstat(path), realpath(path)]);
  if (!status.isFile() || status.isSymbolicLink() || canonical !== path) throw new SpeechWorkerError("START_FAILED");
  return path;
}

/** Owned-container compatibility ONLY. Generic Electron exit is the historical
 * fixture cleanup signal, never supervisor OS admission or retirement proof. No
 * application main imports this helper, and it cannot select arbitrary code. */
export function createFixtureSpeechChannelFactory(): SpeechChannelFactory {
  return async (signal) => {
    const { app, session, utilityProcess } = await import("electron");
    if (!app.isReady() || process.getuid?.() !== 1000) throw new SpeechWorkerError("START_FAILED");
    if (signal.aborted) throw new SpeechWorkerError("CANCELLED");
    const [entry, binding] = await Promise.all([fixedFile(ENTRY), fixedFile(BINDING)]);
    if (signal.aborted) throw new SpeechWorkerError("CANCELLED");
    const env = { ...process.env };
    for (const key of ["NODE_OPTIONS", "NODE_PATH", "NODE_V8_COVERAGE", "ELECTRON_RUN_AS_NODE",
      "ELECTRON_OVERRIDE_DIST_PATH", "ELECTRON_NO_ASAR"]) delete env[key];
    const epoch = randomUUID();
    const child = utilityProcess.fork(entry, [binding, epoch], {
      serviceName: "OpenWhisper Speech", stdio: "ignore", execArgv: [],
      allowLoadingUnsignedLibraries: false, respondToAuthRequestsFromMainProcess: false,
      session: session.defaultSession, env,
    });
    return connectFixtureSpeechChannel({
      pid: () => child.pid,
      postMessage: (value) => { child.postMessage(value); },
      kill: () => { child.kill(); },
      onMessage: (listener) => { child.on("message", listener); return () => { child.off("message", listener); }; },
      onSpawn: (listener) => { child.on("spawn", listener); return () => { child.off("spawn", listener); }; },
      onError: (listener) => { child.on("error", listener); return () => { child.off("error", listener); }; },
      onExit: (listener) => { child.once("exit", listener); },
    }, epoch, signal);
  };
}

/** Inert test seam for the fixture's frame routing; never used by application main. */
export async function connectFixtureSpeechChannel(child: FixtureSpeechProcess, epoch: string, signal: AbortSignal): Promise<SpeechChannel> {
  const messages = new Set<(value: unknown) => void>(), exits = new Set<() => void>();
  let ended = false, closing = false, phase: "ready" | "control" | "ordinary" = "ready";
  let readyAccept: (() => void) | undefined, readyReject: ((error: SpeechWorkerError) => void) | undefined;
  let challengePending: { nonce: string; accept: () => void; reject: (error: SpeechWorkerError) => void } | undefined;
  let bufferedReady = true;
  let terminalFailure: SpeechWorkerError | undefined;
  let termination: Promise<void> | undefined, terminationAccept: (() => void) | undefined;
  let terminationTimer: NodeJS.Timeout | undefined;
  const terminate = (): Promise<void> => {
    if (termination) return termination;
    closing = true;
    if (ended) return Promise.resolve();
    termination = new Promise<void>((accept, reject) => {
      terminationAccept = accept;
      terminationTimer = setTimeout(() => { terminationAccept = undefined; reject(new SpeechWorkerError("TEARDOWN_FAILED")); }, DEADLINE_MS);
      child.kill();
    });
    void termination.catch(() => {});
    return termination;
  };
  const fail = (code: "CANCELLED" | "INVALID_REPLY" | "WORKER_FAILED"): void => {
    const error = new SpeechWorkerError(code);
    terminalFailure ??= error;
    readyReject?.(error); readyAccept = undefined; readyReject = undefined;
    challengePending?.reject(error); challengePending = undefined;
    void terminate().catch(() => {});
  };
  const receive = (input: unknown): void => {
    if (ended || closing) return;
    const control = speechChallengeReplySchema.safeParse(input);
    if (control.success) {
      const pending = challengePending;
      if (!pending || phase !== "control" || control.data.epoch !== epoch || control.data.nonce !== pending.nonce || control.data.pid !== child.pid()) {
        fail("INVALID_REPLY"); return;
      }
      challengePending = undefined; pending.accept(); return;
    }
    if (phase === "ready" && speechReadySchema.safeParse(input).success) {
      phase = "control"; readyAccept?.(); readyAccept = undefined; readyReject = undefined; return;
    }
    if (phase !== "ordinary" || speechReadySchema.safeParse(input).success) { fail("INVALID_REPLY"); return; }
    if (messages.size === 0) { fail("INVALID_REPLY"); return; }
    for (const listener of messages) listener(input);
  };
  const abort = (): void => { fail("CANCELLED"); };
  const spawned = (): void => { if (closing && !ended) child.kill(); };
  const detachMessage = child.onMessage(receive), detachSpawn = child.onSpawn(spawned);
  const detachError = child.onError(() => { fail("WORKER_FAILED"); });
  child.onExit(() => {
    ended = true;
    if (terminationTimer) clearTimeout(terminationTimer);
    signal.removeEventListener("abort", abort); detachMessage(); detachSpawn(); detachError();
    const error = new SpeechWorkerError("WORKER_FAILED"); readyReject?.(error); challengePending?.reject(error);
    terminalFailure ??= error;
    readyAccept = undefined; readyReject = undefined; challengePending = undefined;
    for (const listener of exits) listener(); exits.clear(); messages.clear(); terminationAccept?.(); terminationAccept = undefined;
  });
  signal.addEventListener("abort", abort, { once: true });
  const bounded = async (start: (accept: () => void, reject: (error: SpeechWorkerError) => void) => void): Promise<void> => {
    const deadline = performance.now() + DEADLINE_MS;
    let timer: NodeJS.Timeout | undefined;
    try {
      await new Promise<void>((accept, reject) => {
        timer = setTimeout(() => reject(new SpeechWorkerError("TIMEOUT")), DEADLINE_MS);
        start(accept, reject);
      });
      if (performance.now() >= deadline) throw new SpeechWorkerError("TIMEOUT");
      if (terminalFailure) throw terminalFailure;
    } finally { if (timer) clearTimeout(timer); }
  };
  try {
    await bounded((accept, reject) => {
      if (phase === "control") accept();
      else { readyAccept = accept; readyReject = reject; }
      if (signal.aborted) abort();
    });
    for (let i = 0; i < 2; i++) {
      if (terminalFailure) throw terminalFailure;
      await bounded((accept, reject) => {
        const nonce = randomUUID(); challengePending = { nonce, accept, reject };
        child.postMessage(speechChallengeRequestSchema.parse({ version: 1, type: "challenge", epoch, nonce }));
      });
    }
    phase = "ordinary";
    return Object.freeze({
      send(input) {
        if (closing || ended) throw new SpeechWorkerError("CLOSED");
        child.postMessage(speechRequestSchema.parse(input));
      },
      onMessage(listener) {
        messages.add(listener);
        if (bufferedReady) {
          bufferedReady = false;
          queueMicrotask(() => { if (!closing && !ended && messages.has(listener)) listener(speechReadySchema.parse({ version: 1, type: "ready" })); });
        }
        return () => { messages.delete(listener); };
      },
      onExit(listener) {
        exits.add(listener); if (ended) queueMicrotask(() => { if (exits.delete(listener)) listener(); });
        return () => { exits.delete(listener); };
      },
      terminate,
    } satisfies SpeechChannel);
  } catch (error: unknown) {
    await terminate(); throw error;
  }
}
