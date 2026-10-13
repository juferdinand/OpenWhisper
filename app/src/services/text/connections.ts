import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { access, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { Agent, request } from "node:http";
import { delimiter, join } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";
import {
  defaultTextConnectionAvailability, defaultTextConnectionSettings, textConnectionAvailabilityListSchema, textConnectionAvailabilitySchema,
  type CustomCliConnection, type TextConnectionAvailability, type TextConnectionSettings, type TextProvider,
} from "../../contracts/text/connections.js";
import { checkCodexTextCapabilities } from "./codex.js";
import { discoverClaudeModels, discoverCodexModels } from "./cli-models.js";

const MAX_DISCOVERY_BYTES = 1024 * 1024;
const DISCOVERY_TIMEOUT_MS = 1800;
const modelName = z.string().min(1).max(256).refine((value) => !/[\u0000-\u001f\u007f-\u009f]/u.test(value));
const ollamaModels = z.object({ models: z.array(z.object({ name: modelName })).max(128) });
const lmStudioModels = z.object({ models: z.array(z.object({ key: modelName, type: z.string().min(1).max(32) })).max(128) });

const localServer = Object.freeze({
  ollama: { hostname: "127.0.0.1", port: 11434, path: "/api/tags" },
  lm_studio: { hostname: "127.0.0.1", port: 1234, path: "/api/v1/models" },
});

/** Validate only newly enabled providers and model changes, so offline saved choices can still be edited or disabled. */
export function validateTextConnectionChanges(previous: TextConnectionSettings, next: TextConnectionSettings,
  availability: readonly TextConnectionAvailability[]): void {
  for (const connection of next.connections) {
    if (!connection.enabled) continue;
    const old = previous.connections.find((entry) => entry.provider === connection.provider);
    if (old?.enabled && JSON.stringify(old) === JSON.stringify(connection)) continue;
    const current = availability.find((entry) => entry.provider === connection.provider);
    if (!current?.usable) throw new Error("Scan connections and choose an available provider before enabling it.");
    if ((connection.provider === "ollama" || connection.provider === "lm_studio") &&
        (!connection.model || !current.models.includes(connection.model))) {
      throw new Error("Scan connections and choose an available model before enabling it.");
    }
  }
}

interface LocalScanResult { readonly detected: boolean; readonly models: readonly string[]; readonly failed: boolean }

function readLocalModels(provider: "ollama" | "lm_studio", endpoint = localServer[provider]): Promise<LocalScanResult> {
  return new Promise((resolve) => {
    const agent = new Agent({ keepAlive: false, maxSockets: 1, proxyEnv: {} });
    let requestHandle: ReturnType<typeof request> | undefined;
    let settled = false;
    const finish = (result: LocalScanResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      requestHandle?.destroy();
      agent.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => finish({ detected: false, models: [], failed: false }), DISCOVERY_TIMEOUT_MS);
    try {
      requestHandle = request({
        protocol: "http:", hostname: endpoint.hostname, port: endpoint.port, path: endpoint.path,
        method: "GET", agent, family: 4, maxHeaderSize: 16 * 1024, insecureHTTPParser: false,
        lookup: (_hostname, _options, callback) => callback(new Error("DNS is not permitted"), "", 4),
        headers: { "Accept-Encoding": "identity" },
      }, (response) => {
        if (settled || response.statusCode !== 200) { finish({ detected: true, models: [], failed: true }); return; }
        const length = response.headers["content-length"];
        if (length !== undefined && (typeof length !== "string" || !/^[0-9]+$/u.test(length) ||
            !Number.isSafeInteger(Number(length)) || Number(length) > MAX_DISCOVERY_BYTES)) {
          finish({ detected: true, models: [], failed: true }); return;
        }
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on("data", (chunk: unknown) => {
          if (settled) return;
          if (!Buffer.isBuffer(chunk) || (bytes += chunk.byteLength) > MAX_DISCOVERY_BYTES) {
            finish({ detected: true, models: [], failed: true }); return;
          }
          chunks.push(chunk);
        });
        response.on("error", () => finish({ detected: true, models: [], failed: true }));
        response.on("aborted", () => finish({ detected: true, models: [], failed: true }));
        response.on("end", () => {
          if (settled || !response.complete) { finish({ detected: true, models: [], failed: true }); return; }
          try {
            const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, bytes)));
            const models = provider === "ollama" ? ollamaModels.parse(value).models.map(({ name }) => name)
              : lmStudioModels.parse(value).models.filter(({ type }) => type === "llm").map(({ key }) => key);
            finish({ detected: true, models: [...new Set(models)].slice(0, 128), failed: false });
          } catch { finish({ detected: true, models: [], failed: true }); }
        });
      });
      requestHandle.on("error", () => finish({ detected: false, models: [], failed: false }));
      requestHandle.on("upgrade", (_response, socket) => { socket.destroy(); finish({ detected: true, models: [], failed: true }); });
      requestHandle.on("connect", (_response, socket) => { socket.destroy(); finish({ detected: true, models: [], failed: true }); });
      requestHandle.end();
    } catch { finish({ detected: false, models: [], failed: false }); }
  });
}

export async function resolveTextCliExecutable(name: "claude" | "codex", pathValue = process.env["PATH"] ?? "",
                                               home = process.env["HOME"] ?? homedir()): Promise<string | undefined> {
  return resolveCliExecutable(name, pathValue, home);
}

async function resolveCliExecutable(name: string, pathValue: string, home: string): Promise<string | undefined> {
  const directories = [...pathValue.split(delimiter).filter((item) => item.length > 0 && item.startsWith("/")),
    join(home, ".local/bin"), join(home, ".claude/local"), join(home, ".npm-global/bin"),
    "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];
  for (const directory of [...new Set(directories)]) {
    const candidate = join(directory, name);
    try {
      await access(candidate, constants.X_OK);
      const resolved = await realpath(candidate);
      const metadata = await stat(resolved);
      if (metadata.isFile() && (metadata.mode & 0o111) !== 0) return resolved;
    } catch { /* Continue through PATH; do not invoke shell lookup. */ }
  }
  return undefined;
}

/** Resolve a configured executable without running it or interpreting a shell command. */
export async function resolveCustomTextCliExecutable(connection: Pick<CustomCliConnection, "command">,
  pathValue = process.env["PATH"] ?? "", home = process.env["HOME"] ?? homedir()): Promise<string | undefined> {
  if (connection.command.startsWith("/")) {
    try {
      await access(connection.command, constants.X_OK);
      const resolved = await realpath(connection.command);
      const metadata = await stat(resolved);
      return metadata.isFile() && (metadata.mode & 0o111) !== 0 ? resolved : undefined;
    } catch { return undefined; }
  }
  return resolveCliExecutable(connection.command, pathValue, home);
}

function supportedClaudeVersion(executable: string, environment: NodeJS.ProcessEnv): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(executable, ["--version"], {
      shell: false, windowsHide: true, detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "ignore"], env: {
        ...(environment["PATH"] === undefined ? {} : { PATH: environment["PATH"] }),
        ...(environment["HOME"] === undefined ? {} : { HOME: environment["HOME"] }),
        ...(environment["LANG"] === undefined ? {} : { LANG: environment["LANG"] }),
      },
    });
    let output = "", bytes = 0, done = false;
    const finish = (supported: boolean): void => {
      if (done) return;
      done = true; clearTimeout(timer); resolve(supported);
    };
    const terminate = (): void => {
      try { if (child.pid !== undefined && process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL"); } catch { child.kill("SIGKILL"); }
    };
    const timer = setTimeout(() => { terminate(); finish(false); }, 1500);
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > 1024) { terminate(); finish(false); return; }
      output += chunk.toString("utf8");
    });
    child.on("error", () => finish(false));
    child.on("close", (code) => {
      if (code !== 0) { finish(false); return; }
      const match = /(?:^|\s)([0-9]+)\.([0-9]+)\.([0-9]+)(?:\s|$)/u.exec(output.trim());
      const version = match?.slice(1).map(Number);
      finish(version !== undefined && (version[0]! > 2 || version[0] === 2 &&
        (version[1]! > 1 || version[1] === 1 && version[2]! >= 259)));
    });
  });
}

/** LM Studio installs its CLI here; it can start the app's local API server on request. */
export async function resolveLmStudioCli(home = process.env["HOME"] ?? homedir()): Promise<string | undefined> {
  const candidate = join(home, ".lmstudio/bin/lms");
  try {
    await access(candidate, constants.X_OK);
    const resolved = await realpath(candidate);
    const metadata = await stat(resolved);
    const uid = process.getuid?.();
    if (!metadata.isFile() || (metadata.mode & 0o111) === 0 || (metadata.mode & 0o022) !== 0 ||
        (uid !== undefined && metadata.uid !== uid && metadata.uid !== 0)) return undefined;
    return resolved;
  } catch { return undefined; }
}

const LM_STUDIO_START_TIMEOUT_MS = 30_000;
/**
 * Starts LM Studio's local API server after an explicit user action. Runs the fixed CLI without a
 * shell; its output is discarded so model names or paths never reach OpenWhisper logs.
 */
export async function startLmStudioServer(home = process.env["HOME"] ?? homedir(),
  timeoutMs = LM_STUDIO_START_TIMEOUT_MS): Promise<void> {
  const cli = await resolveLmStudioCli(home);
  if (!cli) throw new Error("LM Studio is not installed.");
  await new Promise<void>((resolve, reject) => {
    const child = spawn(cli, ["server", "start"], { shell: false, stdio: "ignore",
      env: { HOME: home, PATH: "/usr/bin:/bin" } });
    const timer = setTimeout(() => { child.kill("SIGTERM"); reject(new Error("LM Studio did not start its server in time.")); }, timeoutMs);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(); else reject(new Error("LM Studio could not start its server."));
    });
  });
}

/** Read-only local discovery. Never starts servers, reads CLI settings or invokes a model. */
export class LocalTextConnectionScanner {
  constructor(private readonly environment: NodeJS.ProcessEnv = process.env,
              private readonly ports: Partial<Record<"ollama" | "lm_studio", number>> = {}) {}

  async scan(settings: TextConnectionSettings = defaultTextConnectionSettings()): Promise<TextConnectionAvailability[]> {
    const ollamaEndpoint = { ...localServer.ollama, ...(this.ports.ollama === undefined ? {} : { port: this.ports.ollama }) };
    const lmStudioEndpoint = { ...localServer.lm_studio, ...(this.ports.lm_studio === undefined ? {} : { port: this.ports.lm_studio }) };
    const [ollama, lmStudio, lmStudioCli, claude, codex, ...customExecutables] = await Promise.all([
      readLocalModels("ollama", ollamaEndpoint),
      readLocalModels("lm_studio", lmStudioEndpoint),
      resolveLmStudioCli(this.environment["HOME"]),
      resolveTextCliExecutable("claude", this.environment["PATH"], this.environment["HOME"]),
      resolveTextCliExecutable("codex", this.environment["PATH"], this.environment["HOME"]),
      ...settings.connections.filter((connection): connection is CustomCliConnection => "command" in connection)
        .map((connection) => resolveCustomTextCliExecutable(connection, this.environment["PATH"], this.environment["HOME"])),
    ]);
    const [claudeSupported, codexSupported] = await Promise.all([
      claude === undefined ? false : supportedClaudeVersion(claude, this.environment),
      codex === undefined ? false : checkCodexTextCapabilities(codex),
    ]);
    const [claudeDiscovery, codexModels] = await Promise.all([
      claudeSupported && claude !== undefined ? discoverClaudeModels(claude) : { models: [], model_options: [] },
      codexSupported && codex !== undefined ? discoverCodexModels(codex) : { models: [], model_options: [] },
    ]);
    const result: TextConnectionAvailability[] = [
      { provider: "ollama", detected: ollama.detected, usable: ollama.models.length > 0, models: [...ollama.models],
        reason: ollama.failed ? "scan_failed" : ollama.models.length > 0 ? null : ollama.detected ? "no_models" : "not_running" },
      { provider: "lm_studio", detected: lmStudio.detected, usable: lmStudio.models.length > 0, models: [...lmStudio.models],
        reason: lmStudio.failed ? "scan_failed" : lmStudio.models.length > 0 ? null : lmStudio.detected ? "no_models"
          : lmStudioCli !== undefined ? "server_stopped" : "not_running" },
      { provider: "claude_code", detected: claude !== undefined, usable: claudeSupported, models: [...claudeDiscovery.models],
        ...(claudeDiscovery.model_options.length > 0 ? { model_options: [...claudeDiscovery.model_options] } : {}),
        reason: claude === undefined ? "not_installed" : claudeSupported ? null : "unsupported" },
      { provider: "codex", detected: codex !== undefined, usable: codexSupported, models: [...codexModels.models],
        ...(codexModels.model_options.length > 0 ? { model_options: [...codexModels.model_options] } : {}),
        reason: codex === undefined ? "not_installed" : codexSupported ? null : "unsupported" },
      ...settings.connections.filter((connection): connection is CustomCliConnection => "command" in connection)
        .map((connection, index): TextConnectionAvailability => ({ provider: connection.provider,
          detected: customExecutables[index] !== undefined, usable: customExecutables[index] !== undefined, models: [],
          reason: customExecutables[index] !== undefined ? null : "not_installed" })),
    ];
    return result.map((entry) => textConnectionAvailabilitySchema.parse(entry));
  }
}

export function safeAvailabilityFallback(): TextConnectionAvailability[] {
  return defaultTextConnectionAvailability().map((entry) =>
    textConnectionAvailabilitySchema.parse({ ...entry,
      reason: entry.provider === "ollama" || entry.provider === "lm_studio" ? "scan_failed" : entry.reason }));
}

/** Refresh stale startup availability before an explicitly enabled provider is used. */
export async function ensureTextProviderAvailability(provider: TextProvider,
  current: readonly TextConnectionAvailability[], scan: () => Promise<unknown>): Promise<TextConnectionAvailability[]> {
  if (current.some((entry) => entry.provider === provider && entry.usable)) return [...current];
  try { return textConnectionAvailabilityListSchema.parse(await scan()); }
  catch { return safeAvailabilityFallback(); }
}
