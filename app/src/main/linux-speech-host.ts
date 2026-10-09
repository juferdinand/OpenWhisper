import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainThread } from "node:worker_threads";
import { z } from "zod";
import type { UtilityProcess } from "electron";
import { verifySpeechResource, type PreparedSpeechResources, type VerifiedSpeechResource } from "../services/speech/speech-resources.js";
import { verifySpeechEntryGraph, type PreparedSpeechEntryGraph } from "../services/speech/speech-entry-graph.js";
import { createProvisionalSpeechTransport, type OriginalSpeechPort } from "../services/speech/speech-transport.js";
import { prepareLinuxSpeechRetirement, type LinuxSpeechRetirementAllocation } from "../services/speech/linux-speech-retirement.js";
import { SpeechWorkerError } from "../services/speech/speech-client.js";
import type { BackendBindings, ProvisionalBackendOwner } from "../services/speech/backend-supervisor.js";

export const SPEECH_EXCLUDED_ENVIRONMENT = Object.freeze(["NODE_OPTIONS", "NODE_PATH", "ELECTRON_RUN_AS_NODE", "ELECTRON_NO_ASAR",
  "ELECTRON_ENABLE_LOGGING", "ELECTRON_ENABLE_STACK_DUMPING", "LD_PRELOAD", "LD_LIBRARY_PATH", "LD_AUDIT", "GGML_VK_VISIBLE_DEVICES",
  "NODE_V8_COVERAGE", "ELECTRON_OVERRIDE_DIST_PATH"]);
export function speechEnvironment(input: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result = { ...input }; for (const key of SPEECH_EXCLUDED_ENVIRONMENT) delete result[key]; return result;
}
const resource = z.strictObject({ backend: z.enum(["cpu", "vulkan"]), path: z.string().min(1).max(4096).refine((value) => isAbsolute(value) && value.endsWith(".node") && !value.includes("\0")),
  bytes: z.number().int().positive().max(512 * 1024 * 1024), sha256: z.string().regex(/^[a-f0-9]{64}$/u) });
function equal(left: VerifiedSpeechResource, right: VerifiedSpeechResource): boolean {
  return left.backend === right.backend && left.path === right.path && left.bytes === right.bytes && left.sha256 === right.sha256;
}
export interface LinuxSpeechHostEffects {
  verifyEntry(): Promise<Readonly<{ entry: string }>>;
  verifyResource(backend: "cpu" | "vulkan"): Promise<VerifiedSpeechResource>;
  fork(entry: string, binding: string, epoch: string): OriginalSpeechPort;
  prepareRetirement(pid: number, epoch: string): LinuxSpeechRetirementAllocation;
}

/** Host-only inert constructor seam. It returns effects, never a resettable
 * supervisor. Production captures fixed destinations and opaque catalogs below. */
export function createLinuxSpeechHostEffects(effects: LinuxSpeechHostEffects): BackendBindings["effects"] {
  // An uncertain fork/late spawn must retain its exact original object even
  // when open rejects. Successful return transfers that reference to supervisor.
  const uncertain = new Set<object>();
  return Object.freeze({
    verify: async (backend) => {
      if (backend !== "cpu" && backend !== "vulkan") throw new SpeechWorkerError("INTEGRITY_FAILED");
      return effects.verifyResource(backend);
    },
    async open(input, inputEpoch, signal) {
      const parsed = resource.safeParse(input), epoch = z.string().uuid().safeParse(inputEpoch);
      if (!parsed.success || !epoch.success || !(signal instanceof AbortSignal)) throw new SpeechWorkerError("INTEGRITY_FAILED");
      const [selected, code] = await Promise.all([effects.verifyResource(parsed.data.backend), effects.verifyEntry()]);
      if (!equal(selected, parsed.data) || selected.backend !== parsed.data.backend) throw new SpeechWorkerError("INTEGRITY_FAILED");
      if (signal.aborted) return { kind: "not-created", code: "START_FAILED" };
      let port: OriginalSpeechPort;
      try { port = effects.fork(code.entry, selected.path, epoch.data); }
      catch (cause: unknown) {
        // No throw after fork invocation proves that no OS owner was created.
        const creation = Promise.reject(cause); void creation.catch(() => {}); uncertain.add(creation);
        throw new SpeechWorkerError("TEARDOWN_FAILED");
      }
      uncertain.add(port);
      const transport = createProvisionalSpeechTransport(port, epoch.data); uncertain.add(transport);
      // Never abort creation or kill from this signal. The supervisor returns
      // promptly while this exact transaction eventually transfers a late owner.
      const pid = await transport.started;
      // The holder owns accepted bind/read operations before any bind await,
      // including a witness whose subsequent boundary conversion refuses.
      const retirement = effects.prepareRetirement(pid, epoch.data);
      const owner: ProvisionalBackendOwner = Object.freeze({ pid, channel: transport.channel,
        challenge: (nonce, challengedEpoch, cleanup) => transport.challenge(nonce, challengedEpoch, cleanup),
        bindRetirement(challengedEpoch) {
          if (challengedEpoch !== epoch.data) return Promise.reject(new SpeechWorkerError("INTEGRITY_FAILED"));
          return retirement.bind();
        },
      } satisfies ProvisionalBackendOwner);
      uncertain.delete(port); uncertain.delete(transport); return { kind: "owner", owner };
    },
  } satisfies BackendBindings["effects"]);
}

/** Main-only Linux edge, imported by no ordinary application wiring yet. */
export async function createLinuxSpeechBindings(catalog: PreparedSpeechResources, graph: PreparedSpeechEntryGraph): Promise<BackendBindings> {
  const uid = process.getuid?.();
  if (process.type !== "browser" || !isMainThread || uid === undefined || uid === 0 ||
    process.platform !== "linux" || (process.arch !== "x64" && process.arch !== "arm64")) {
    throw new SpeechWorkerError("INTEGRITY_FAILED");
  }
  const { app, session, utilityProcess } = await import("electron");
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../.."), expectedEntry = resolve(packageRoot, "dist/workers/speech-entry.js");
  const effects = createLinuxSpeechHostEffects({
    verifyResource: (backend) => verifySpeechResource(catalog, backend),
    verifyEntry: async () => {
      const code = await verifySpeechEntryGraph(graph);
      if (code.entry !== expectedEntry) throw new SpeechWorkerError("INTEGRITY_FAILED"); return code;
    },
    prepareRetirement: prepareLinuxSpeechRetirement,
    fork(entry, binding, epoch) {
      if (!app.isReady()) throw new SpeechWorkerError("TEARDOWN_FAILED");
      const child = utilityProcess.fork(entry, [binding, epoch], { serviceName: "OpenWhisper Speech", stdio: "ignore", execArgv: [],
        allowLoadingUnsignedLibraries: false, respondToAuthRequestsFromMainProcess: false,
        session: session.defaultSession, env: speechEnvironment(process.env) });
      return originalPort(child);
    },
  });
  return Object.freeze({ host: { platform: "linux", architecture: process.arch, uid, parentPid: process.pid }, catalog, effects } satisfies BackendBindings);
}

function originalPort(child: UtilityProcess): OriginalSpeechPort {
  let exited = false, acceptExit!: () => void;
  const exit = new Promise<void>((accept) => { acceptExit = accept; });
  child.once("exit", () => { exited = true; acceptExit(); });
  let termination: Promise<void> | undefined;
  return Object.freeze({
    onSpawn(listener) { const spawned = () => { listener(child.pid); }; child.on("spawn", spawned); return () => { child.off("spawn", spawned); }; },
    onMessage(listener) { child.on("message", listener); return () => { child.off("message", listener); }; },
    onError(listener) { child.on("error", listener); return () => { child.off("error", listener); }; },
    onExit(listener) { child.once("exit", listener); return () => { child.off("exit", listener); }; },
    postMessage(input) { child.postMessage(input); },
    terminate() {
      termination ??= Promise.resolve().then(() => {
        if (!exited && !child.kill()) throw new SpeechWorkerError("TEARDOWN_FAILED");
        return exit;
      });
      void termination.catch(() => {}); return termination;
    },
  } satisfies OriginalSpeechPort);
}
