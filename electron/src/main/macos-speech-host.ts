import { createRequire } from "node:module";
import { isAbsolute, resolve } from "node:path";
import { isMainThread } from "node:worker_threads";
import { z } from "zod";
import type { UtilityProcess } from "electron";
import { verifySpeechResource, type PreparedSpeechResources, type VerifiedSpeechResource } from "../services/speech-resources.js";
import { verifySpeechEntryGraph, type PreparedSpeechEntryGraph } from "../services/speech-entry-graph.js";
import { createProvisionalSpeechTransport, type OriginalSpeechPort } from "../services/speech-transport.js";
import { captureMacKernelRetirementNative, MacKernelRetirementBoundary } from "../services/macos-retirement-boundary.js";
import { developmentArtifactSchema, verifyDevelopmentMacRetirementArtifact } from "../services/development-artifact.js";
import type { DevelopmentArtifact } from "../services/development-artifact.js";
import { SpeechWorkerError } from "../services/speech-client.js";
import type { BackendBindings, ProvisionalBackendOwner, RetirementBoundary } from "../services/backend-supervisor.js";

const settingsSchema = z.strictObject({
  root: z.string().min(1).max(4096).refine((value) => isAbsolute(value) && resolve(value) === value && !value.includes("\0")),
  retirement: developmentArtifactSchema,
}).readonly();
export interface MacSpeechDevelopmentArtifacts { readonly root: string; readonly retirement: DevelopmentArtifact }
const resourceSchema = z.strictObject({ backend: z.enum(["cpu", "metal"]),
  path: z.string().min(1).max(4096).refine((value) => isAbsolute(value) && resolve(value) === value && value.endsWith(".node") && !value.includes("\0")),
  bytes: z.number().int().positive().max(512 * 1024 * 1024), sha256: z.string().regex(/^[a-f0-9]{64}$/u) });
const epochSchema = z.string().uuid();
function failure(code: "INTEGRITY_FAILED" | "TEARDOWN_FAILED"): SpeechWorkerError { return new SpeechWorkerError(code); }
function mainHost(): Readonly<{ uid: number; parentPid: number; architecture: "arm64" | "x64" }> {
  const uid = process.getuid?.();
  if (process.type !== "browser" || !isMainThread || process.platform !== "darwin" || uid === undefined || uid === 0 ||
      (process.arch !== "arm64" && process.arch !== "x64")) throw failure("INTEGRITY_FAILED");
  return Object.freeze({ uid, parentPid: process.pid, architecture: process.arch });
}
function safeFailure(error: unknown): SpeechWorkerError {
  return error instanceof Error && "code" in error && error.code === "TEARDOWN_FAILED"
    ? failure("TEARDOWN_FAILED") : failure("INTEGRITY_FAILED");
}

export interface MacChildRetirementAllocation {
  bind(signal: AbortSignal): Promise<RetirementBoundary>;
  /** Observer/query disposal only. It never establishes child retirement. */
  settleReads(): Promise<void>;
}
export interface MacChildRetirementAllocator {
  /** PID comes only from the original returned UtilityProcess spawn object. */
  prepare(pid: number, epoch: string): MacChildRetirementAllocation;
}

/** Inert composition seam. The already constructed production boundary owns its
 * opaque native owner before any bind await. Refusal cannot create a fresh bind. */
export function createMacChildRetirementAllocation(boundary: MacKernelRetirementBoundary): MacChildRetirementAllocation {
  let binding: Promise<RetirementBoundary> | undefined, closing: Promise<void> | undefined;
  return Object.freeze({
    bind(signal: AbortSignal) {
      if (binding) return binding;
      if (!(signal instanceof AbortSignal)) return Promise.reject(failure("INTEGRITY_FAILED"));
      binding = boundary.bind(signal).catch(() => { throw failure("TEARDOWN_FAILED"); });
      void binding.catch(() => {}); return binding;
    },
    settleReads() {
      // Closing must wake accepted native reads, rather than awaiting a held
      // bind first. The boundary retains both the query and original close.
      closing ??= boundary.settleReads().catch(() => { throw failure("TEARDOWN_FAILED"); });
      void closing.catch(() => {}); return closing;
    },
  });
}

/** Fixed main-only Dev loader shared by speech and capture. The supplied digest
 * is captured by the development build; it is not release authenticity. */
export async function createMacChildRetirementAllocator(input: MacSpeechDevelopmentArtifacts): Promise<MacChildRetirementAllocator> {
  const host = mainHost();
  let native: ReturnType<typeof captureMacKernelRetirementNative>;
  try {
    const settings = settingsSchema.parse(input);
    const path = await verifyDevelopmentMacRetirementArtifact(settings.root, settings.retirement);
    if (path !== resolve(settings.root, "dist/native/openwhisper_macos_retirement.node")) throw failure("INTEGRITY_FAILED");
    const raw: unknown = createRequire(import.meta.url)(path);
    native = captureMacKernelRetirementNative(raw);
    // Detect mutation across loading without presenting a digest as a file lease.
    if (await verifyDevelopmentMacRetirementArtifact(settings.root, settings.retirement) !== path) throw failure("INTEGRITY_FAILED");
  } catch (error: unknown) { throw safeFailure(error); }
  return Object.freeze({
    prepare(pid: number, epoch: string) {
      mainHost();
      try {
        const boundary = new MacKernelRetirementBoundary(native, { pid, epoch, uid: host.uid, parentPid: host.parentPid });
        return createMacChildRetirementAllocation(boundary);
      } catch { throw failure("TEARDOWN_FAILED"); }
    },
  });
}

export const MAC_SPEECH_EXCLUDED_ENVIRONMENT = Object.freeze(["NODE_OPTIONS", "NODE_PATH", "ELECTRON_RUN_AS_NODE", "ELECTRON_NO_ASAR",
  "ELECTRON_ENABLE_LOGGING", "ELECTRON_ENABLE_STACK_DUMPING", "LD_PRELOAD", "LD_LIBRARY_PATH", "LD_AUDIT", "GGML_VK_VISIBLE_DEVICES",
  "NODE_V8_COVERAGE", "ELECTRON_OVERRIDE_DIST_PATH", "GGML_METAL_PATH_RESOURCES"]);
export function macSpeechEnvironment(input: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result = { ...input };
  for (const key of Object.keys(result)) {
    if (MAC_SPEECH_EXCLUDED_ENVIRONMENT.includes(key) || key.startsWith("DYLD_") || key.startsWith("__XPC_DYLD_")) delete result[key];
  }
  return result;
}

export interface MacSpeechHostEffects {
  verifyEntry(): Promise<Readonly<{ entry: string }>>;
  verifyResource(backend: "cpu" | "metal"): Promise<VerifiedSpeechResource>;
  fork(entry: string, binding: string, epoch: string): OriginalSpeechPort;
  prepareRetirement(pid: number, epoch: string): MacChildRetirementAllocation;
}
function equal(left: VerifiedSpeechResource, right: VerifiedSpeechResource): boolean {
  return left.backend === right.backend && left.path === right.path && left.bytes === right.bytes && left.sha256 === right.sha256;
}

/** Host-only inert constructor seam; no supervisor reset or native loading. */
export function createMacSpeechHostEffects(effects: MacSpeechHostEffects): BackendBindings["effects"] {
  const uncertain = new Set<object>();
  return Object.freeze({
    async verify(backend) {
      if (backend !== "cpu" && backend !== "metal") throw failure("INTEGRITY_FAILED");
      try {
        const selected = resourceSchema.parse(await effects.verifyResource(backend));
        if (selected.backend !== backend) throw failure("INTEGRITY_FAILED"); return Object.freeze(selected);
      } catch (error: unknown) { throw safeFailure(error); }
    },
    async open(input, inputEpoch, signal) {
      const parsed = resourceSchema.safeParse(input), epoch = epochSchema.safeParse(inputEpoch);
      if (!parsed.success || !epoch.success || !(signal instanceof AbortSignal)) throw failure("INTEGRITY_FAILED");
      let selected: VerifiedSpeechResource, code: Readonly<{ entry: string }>;
      try {
        [selected, code] = await Promise.all([effects.verifyResource(parsed.data.backend), effects.verifyEntry()]);
        resourceSchema.parse(selected);
        if (!equal(selected, parsed.data)) throw failure("INTEGRITY_FAILED");
      } catch (error: unknown) { throw safeFailure(error); }
      if (signal.aborted) return { kind: "not-created", code: "START_FAILED" };
      let port: OriginalSpeechPort;
      try { port = effects.fork(code.entry, selected.path, epoch.data); }
      catch (cause: unknown) {
        // A throwing fork does not prove that no original child was created.
        const creation = Promise.reject(cause); void creation.catch(() => {}); uncertain.add(creation);
        throw failure("TEARDOWN_FAILED");
      }
      uncertain.add(port);
      const transport = createProvisionalSpeechTransport(port, epoch.data); uncertain.add(transport);
      // Cancellation never forgets pending creation or signals from this edge.
      const pid = await transport.started;
      const retirement = effects.prepareRetirement(pid, epoch.data); uncertain.add(retirement);
      const owner: ProvisionalBackendOwner = Object.freeze({ pid, channel: transport.channel,
        challenge: (nonce, challengedEpoch, cleanup) => transport.challenge(nonce, challengedEpoch, cleanup),
        bindRetirement(challengedEpoch, cleanup) {
          if (challengedEpoch !== epoch.data) return Promise.reject(failure("INTEGRITY_FAILED"));
          return retirement.bind(cleanup);
        },
      } satisfies ProvisionalBackendOwner);
      uncertain.delete(port); uncertain.delete(transport); uncertain.delete(retirement);
      return { kind: "owner", owner };
    },
  } satisfies BackendBindings["effects"]);
}

/** Continuing supervisor bindings for ordinary Mac Dev recording. CPU is the
 * initial supervisor policy; Metal resources remain a capability, not a claim
 * that accelerated selection or physical GPU execution has been validated. */
export async function createMacSpeechBindings(catalog: PreparedSpeechResources, graph: PreparedSpeechEntryGraph,
  input: MacSpeechDevelopmentArtifacts): Promise<BackendBindings> {
  const host = mainHost();
  let settings: z.infer<typeof settingsSchema>;
  try { settings = settingsSchema.parse(input); } catch { throw failure("INTEGRITY_FAILED"); }
  const allocator = await createMacChildRetirementAllocator(settings);
  const { app, session, utilityProcess } = await import("electron");
  const expectedEntry = resolve(settings.root, "dist/workers/speech-entry.js");
  const effects = createMacSpeechHostEffects({
    async verifyResource(backend) {
      const selected = await verifySpeechResource(catalog, backend);
      if (selected.path !== resolve(settings.root, "dist/native/speech", backend, "openwhisper_speech.node")) throw failure("INTEGRITY_FAILED");
      return selected;
    },
    async verifyEntry() {
      const code = await verifySpeechEntryGraph(graph);
      if (code.entry !== expectedEntry) throw failure("INTEGRITY_FAILED"); return code;
    },
    prepareRetirement: (pid, epoch) => allocator.prepare(pid, epoch),
    fork(entry, binding, epoch) {
      if (!app.isReady()) throw failure("TEARDOWN_FAILED");
      const child = utilityProcess.fork(entry, [binding, epoch], { serviceName: "OpenWhisper Speech", stdio: "ignore", execArgv: [],
        allowLoadingUnsignedLibraries: false, respondToAuthRequestsFromMainProcess: false,
        session: session.defaultSession, env: macSpeechEnvironment(process.env) });
      return originalPort(child);
    },
  });
  return Object.freeze({ host: { platform: "darwin", architecture: host.architecture, uid: host.uid, parentPid: host.parentPid },
    catalog, effects } satisfies BackendBindings);
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
        if (!exited && !child.kill()) throw failure("TEARDOWN_FAILED"); return exit;
      });
      void termination.catch(() => {}); return termination;
    },
  } satisfies OriginalSpeechPort);
}
