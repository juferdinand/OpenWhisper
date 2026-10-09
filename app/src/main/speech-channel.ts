import { app, session, utilityProcess } from "electron";
import type { UtilityProcess } from "electron";
import { lstat, realpath } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { SpeechWorkerError } from "../services/speech/speech-client.js";
import type { SpeechChannel, SpeechChannelFactory } from "../services/speech/speech-client.js";
import { speechRequestSchema } from "../workers/speech-protocol.js";

const distribution = dirname(dirname(fileURLToPath(import.meta.url)));
const TERMINATION_DEADLINE_MS = 8000;

async function packagedFile(parts: readonly string[]): Promise<string> {
  const root = await realpath(distribution);
  const path = join(root, ...parts);
  const [stats, resolved] = await Promise.all([lstat(path), realpath(path)]);
  if (!stats.isFile() || stats.isSymbolicLink() || !resolved.startsWith(`${root}${sep}`)) {
    throw new SpeechWorkerError("START_FAILED");
  }
  return resolved;
}

async function ready(signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new SpeechWorkerError("CANCELLED");
  await new Promise<void>((accept, reject) => {
    const abort = () => { reject(new SpeechWorkerError("CANCELLED")); };
    signal.addEventListener("abort", abort, { once: true });
    void app.whenReady().then(accept, () => reject(new SpeechWorkerError("START_FAILED")))
      .finally(() => { signal.removeEventListener("abort", abort); });
  });
  if (signal.aborted) throw new SpeechWorkerError("CANCELLED");
}

/** Fixed packaged code only. Neither renderer input nor a model path selects code. */
export function createUtilitySpeechChannelFactory(): SpeechChannelFactory {
  return async (signal) => {
    await ready(signal);
    let worker: string;
    let binding: string;
    try {
      [worker, binding] = await Promise.all([
        packagedFile(["workers", "speech-entry.js"]), packagedFile(["native", "openwhisper_speech.node"]),
      ]);
    } catch { throw new SpeechWorkerError("START_FAILED"); }
    if (signal.aborted) throw new SpeechWorkerError("CANCELLED");
    const environment = { ...process.env };
    for (const key of ["NODE_OPTIONS", "NODE_PATH", "NODE_V8_COVERAGE", "ELECTRON_RUN_AS_NODE",
      "ELECTRON_OVERRIDE_DIST_PATH", "ELECTRON_NO_ASAR"]) delete environment[key];
    const child = utilityProcess.fork(worker, [binding], {
      serviceName: "OpenWhisper Speech", stdio: "ignore", execArgv: [],
      allowLoadingUnsignedLibraries: false, respondToAuthRequestsFromMainProcess: false,
      session: session.defaultSession,
      env: environment,
    });
    return channel(child, signal);
  };
}

function channel(child: UtilityProcess, signal: AbortSignal): SpeechChannel {
  const messages = new Set<(value: unknown) => void>();
  const exits = new Set<() => void>();
  let ended = false;
  let closing = false;
  let buffered: unknown;
  let hasBuffered = false;
  let termination: Promise<void> | undefined;
  let acceptTermination: (() => void) | undefined;
  let terminationTimer: NodeJS.Timeout | undefined;

  const finish = (): void => {
    if (ended) return;
    ended = true;
    hasBuffered = false;
    buffered = undefined;
    if (terminationTimer) clearTimeout(terminationTimer);
    signal.removeEventListener("abort", abort);
    child.off("message", receive);
    child.off("spawn", spawned);
    for (const listener of exits) listener();
    exits.clear();
    messages.clear();
    acceptTermination?.();
    acceptTermination = undefined;
  };
  const spawned = (): void => { if (closing && !ended) child.kill(); };
  const receive = (value: unknown): void => {
    if (ended || closing) return;
    if (messages.size > 0) {
      for (const listener of messages) listener(value);
    } else if (!hasBuffered) {
      // A ready frame can precede the factory promise's consumer subscription.
      buffered = value;
      hasBuffered = true;
    } else {
      // Never accumulate unconsumed helper frames or sensitive reply history.
      void terminate().catch(() => {});
    }
  };
  const terminate = (): Promise<void> => {
    if (termination) return termination;
    closing = true;
    hasBuffered = false;
    buffered = undefined;
    if (ended) return Promise.resolve();
    termination = new Promise<void>((accept, reject) => {
      acceptTermination = accept;
      terminationTimer = setTimeout(() => {
        // Electron kill() performs SIGTERM plus its owned-process reap/force-kill
        // escalation. A missing exit confirmation blocks retry instead of spawning
        // a second owner. No raw PID signaling or request/reply logging is used.
        acceptTermination = undefined;
        reject(new SpeechWorkerError("WORKER_FAILED"));
      }, TERMINATION_DEADLINE_MS);
      child.kill();
    });
    return termination;
  };
  const abort = (): void => { void terminate().catch(() => {}); };
  child.on("message", receive);
  child.once("exit", finish);
  child.on("spawn", spawned);
  // Do not consume or forward experimental native diagnostic reports.
  child.on("error", () => { void terminate().catch(() => {}); });
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();

  return Object.freeze({
    send(input) {
      if (closing || ended) throw new SpeechWorkerError("CLOSED");
      child.postMessage(speechRequestSchema.parse(input));
    },
    onMessage(listener) {
      messages.add(listener);
      if (hasBuffered) {
        const value = buffered;
        buffered = undefined;
        hasBuffered = false;
        queueMicrotask(() => { if (!ended && !closing && messages.has(listener)) listener(value); });
      }
      return () => { messages.delete(listener); };
    },
    onExit(listener) {
      exits.add(listener);
      if (ended) queueMicrotask(() => { if (exits.delete(listener)) listener(); });
      return () => { exits.delete(listener); };
    },
    terminate,
  } satisfies SpeechChannel);
}
