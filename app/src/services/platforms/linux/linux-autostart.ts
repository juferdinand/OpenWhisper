import { constants, linkSync, lstatSync, mkdirSync, renameSync, unlinkSync, type BigIntStats } from "node:fs";
import { open } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { buildIdentitySchema } from "../../../contracts/application/build-identity.js";

const appIds = ["io.github.whisperfree", "io.github.whisperfree.dev"] as const;
type LinuxApplicationId = typeof appIds[number];
const maximumBytes = 32 * 1024;
const pathSchema = z.string().min(1).max(4096).refine((value) => isAbsolute(value) && resolve(value) === value && !/[\p{Cc}]/u.test(value));
const optionsSchema = z.strictObject({ appId: z.enum(appIds), configHome: pathSchema,
  configDirs: z.array(pathSchema).max(32), executable: pathSchema,
  launchArguments: z.tuple([z.literal("--dev-profile"), pathSchema]).optional(),
  appImage: z.strictObject({ image: pathSchema, assertUnchanged: z.custom<() => void>((value) => typeof value === "function") }).optional() });
export interface LinuxAutostartOptions { readonly appId: string; readonly configHome: string;
  readonly configDirs: readonly string[]; readonly executable: string;
  /** Development launches are pinned to one explicitly selected, isolated profile. */
  readonly launchArguments?: readonly ["--dev-profile", string];
  /** The main process supplies an admitted permanent image and synchronous original-identity guard. */
  readonly appImage?: Readonly<{ image: string; assertUnchanged(): void }> }
export interface LinuxAutostartStatus { readonly requested: boolean }
export class LinuxAutostartError extends Error {
  constructor(readonly code: "UNAVAILABLE" | "UNSAFE_PATH" | "CONFLICT" | "SOURCE_CHANGED" | "CHANGE_FAILED") {
    super(code); this.name = "LinuxAutostartError";
  }
}
const fail = (code: LinuxAutostartError["code"]): never => { throw new LinuxAutostartError(code); };
function missing(error: unknown): boolean { return error instanceof Error && "code" in error && error.code === "ENOENT"; }
function optional(path: string): BigIntStats | undefined {
  try { return lstatSync(path, { bigint: true }); } catch (error: unknown) { if (missing(error)) return undefined; return fail("UNSAFE_PATH"); }
}
function same(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mode === right.mode &&
    left.uid === right.uid && left.nlink === right.nlink && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}
function ancestry(path: string): string[] {
  const result: string[] = [];
  for (let cursor = path;; cursor = dirname(cursor)) { result.push(cursor); if (dirname(cursor) === cursor) return result.reverse(); }
}

/** Only the currently assembled Debian layout establishes a permanent launch target. */
export function selectLinuxAutostartExecutable(input: { readonly build: unknown; readonly packaged: boolean;
  readonly executable: string; readonly appPath: string }): string | undefined {
  const identity = buildIdentitySchema.safeParse(input.build);
  return identity.success && identity.data.kind === "stable" && input.packaged === true &&
    input.executable === "/opt/openwhisper/openwhisper" && input.appPath === "/opt/openwhisper/resources/app"
    ? input.executable : undefined;
}

/** Desktop Entry string escaping precedes quoted Exec argument parsing. */
export function linuxAutostartArgument(value: string): string {
  if (!pathSchema.safeParse(value).success || value.includes("=")) return fail("UNSAFE_PATH");
  return `"${value.replaceAll("%", "%%").replace(/["`$\\]/gu, (item) => `\\${item}`).replaceAll("\\", "\\\\")}"`;
}
function interpretedLaunch(value: string, appId: LinuxApplicationId): { executable: string; image?: string; launchArguments?: readonly ["--dev-profile", string] } {
  const prefix = "env APPIMAGE_EXTRACT_AND_RUN=1 ";
  const command = value.startsWith(prefix) ? value.slice(prefix.length) : value;
  // Recognize the native generator's two exact escape layers; never execute an entry.
  const quoted = command.replaceAll("\\\\", "\\");
  const paths: string[] = [], arguments_: string[] = []; let index = 0;
  while (index < quoted.length) {
    if (quoted.startsWith("--dev-profile ", index)) {
      if (appId !== "io.github.whisperfree.dev" || arguments_.length || paths.length !== 1) return fail("CONFLICT");
      arguments_.push("--dev-profile"); index += "--dev-profile ".length; continue;
    }
    if (paths.length === 2 || quoted[index++] !== '"') return fail("CONFLICT");
    let path = "", closed = false;
    while (index < quoted.length) {
      const char = quoted[index++]!;
      if (char === '"') { closed = true; break; }
      if (char === "\\") {
        const next = quoted[index++]; if (next === undefined || !['"', "`", "$", "\\"].includes(next)) return fail("CONFLICT"); path += next;
      } else if (char === "%") { if (quoted[index++] !== "%") return fail("CONFLICT"); path += "%"; }
      else { if (["`", "$"].includes(char)) return fail("CONFLICT"); path += char; }
    }
    if (!closed || !pathSchema.safeParse(path).success || path.includes("=")) return fail("CONFLICT");
    paths.push(path); if (index < quoted.length && quoted[index++] !== " ") return fail("CONFLICT");
  }
  const canonical = [linuxAutostartArgument(paths[0]!), ...(arguments_.length ? ["--dev-profile", linuxAutostartArgument(paths[1]!)] : paths.slice(1).map(linuxAutostartArgument))].join(" ");
  if (!paths.length || canonical !== command || (value.startsWith(prefix) && (paths.length !== 1 || arguments_.length > 0))) return fail("CONFLICT");
  const executable = paths[0]!;
  if (arguments_.length) {
    if (arguments_.length !== 1 || paths.length !== 2 || appId !== "io.github.whisperfree.dev") return fail("CONFLICT");
    return { executable, launchArguments: ["--dev-profile", paths[1]!] };
  }
  if (paths.length === 1) return { executable };
  const image = paths[1]!;
  if (appId !== "io.github.whisperfree" || basename(executable) !== "openwhisper-launch" || basename(image) !== "OpenWhisper.AppImage" || dirname(executable) !== dirname(image)) return fail("CONFLICT");
  return { executable, image };
}
interface Entry { readonly path: string; readonly stats: BigIntStats; readonly bytes: Buffer;
  readonly requested: boolean; readonly executable?: string; readonly image?: string; readonly launchArguments?: readonly ["--dev-profile", string] }
function interpret(bytes: Buffer, appId: LinuxApplicationId): { requested: boolean; executable?: string; image?: string; launchArguments?: readonly ["--dev-profile", string] } {
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return fail("CONFLICT"); }
  const lines = text.trimEnd().split("\n").map((line) => line.endsWith("\r") ? line.slice(0, -1) : line);
  if (lines.shift() !== "[Desktop Entry]") return fail("CONFLICT");
  const fields = new Map<string, string>();
  for (const line of lines) {
    const separator = line.indexOf("="); if (separator <= 0) return fail("CONFLICT");
    const key = line.slice(0, separator); if (fields.has(key)) return fail("CONFLICT"); fields.set(key, line.slice(separator + 1));
  }
  const productName = appId === "io.github.whisperfree.dev" ? "OpenWhisper Dev" : "OpenWhisper";
  if (fields.get("Type") !== "Application" || fields.get("Name") !== productName) return fail("CONFLICT");
  if (fields.size === 3 && fields.get("Hidden") === "true") return { requested: false };
  const fixed = { Comment: "Free, local dictation", Icon: appId, StartupWMClass: appId, Terminal: "false" };
  if (Object.entries(fixed).some(([key, value]) => fields.get(key) !== value) || !fields.has("Exec") ||
      [...fields.keys()].some((key) => !["Type", "Name", "Exec", ...Object.keys(fixed), "Hidden", "X-GNOME-Autostart-enabled"].includes(key))) return fail("CONFLICT");
  for (const key of ["Hidden", "X-GNOME-Autostart-enabled"]) if (fields.has(key) && !["true", "false"].includes(fields.get(key)!)) return fail("CONFLICT");
  return { requested: fields.get("Hidden") !== "true" && fields.get("X-GNOME-Autostart-enabled") !== "false",
    ...interpretedLaunch(fields.get("Exec")!, appId) };
}

/** Per-user fixed-name autostart. Opening and status reads have no registration effects. */
export class LinuxAutostart {
  private queue: Promise<void> = Promise.resolve();
  private readonly directories = new Map<string, BigIntStats>();
  private constructor(private readonly options: z.infer<typeof optionsSchema>, private readonly uid: bigint) {}
  static async open(input: LinuxAutostartOptions): Promise<LinuxAutostart> {
    if (process.platform !== "linux" || process.getuid?.() === undefined || process.getuid() === 0 || !(appIds as readonly string[]).includes(input.appId)) return fail("UNAVAILABLE");
    const parsed = optionsSchema.safeParse(input); if (!parsed.success) return fail("UNSAFE_PATH");
    if ((parsed.data.appId === "io.github.whisperfree.dev") !== (parsed.data.launchArguments !== undefined) || parsed.data.appImage && parsed.data.appId !== "io.github.whisperfree") return fail("UNAVAILABLE");
    linuxAutostartArgument(parsed.data.executable);
    if (parsed.data.launchArguments) linuxAutostartArgument(parsed.data.launchArguments[1]);
    if (parsed.data.appImage) {
      linuxAutostartArgument(parsed.data.appImage.image);
      if (basename(parsed.data.executable) !== "openwhisper-launch" || basename(parsed.data.appImage.image) !== "OpenWhisper.AppImage" ||
          dirname(parsed.data.executable) !== dirname(parsed.data.appImage.image)) return fail("UNSAFE_PATH");
    }
    const service = new LinuxAutostart(parsed.data, BigInt(process.getuid()));
    service.checkDirectories(dirname(parsed.data.executable));
    service.checkDirectories(join(parsed.data.configHome, "autostart"), parsed.data.configHome);
    for (const directory of parsed.data.configDirs) service.checkDirectories(join(directory, "autostart"));
    service.checkExecutable(); return service;
  }
  private checkDirectories(path: string, userBase?: string): void {
    for (const ancestor of ancestry(path)) {
      const current = optional(ancestor), captured = this.directories.get(ancestor);
      if (!current) { if (captured) return fail("SOURCE_CHANGED"); continue; }
      const mode = current.mode & 0o7777n, sticky = current.uid === 0n && (mode & 0o1000n) !== 0n;
      if (!current.isDirectory() || current.isSymbolicLink() || (current.uid !== this.uid && current.uid !== 0n) ||
          ((mode & 0o022n) !== 0n && !sticky) || (userBase && (ancestor === userBase || ancestor === path) && current.uid !== this.uid)) return fail("UNSAFE_PATH");
      if (captured && (captured.dev !== current.dev || captured.ino !== current.ino || captured.uid !== current.uid || captured.mode !== current.mode)) return fail("SOURCE_CHANGED");
      this.directories.set(ancestor, current);
    }
  }
  private checkExecutable(): void {
    this.checkDirectories(dirname(this.options.executable));
    const stats = optional(this.options.executable);
    if (!stats?.isFile() || stats.nlink !== 1n || (stats.uid !== this.uid && stats.uid !== 0n) ||
        (stats.mode & 0o022n) !== 0n || (stats.mode & 0o111n) === 0n) return fail("UNSAFE_PATH");
    try { this.options.appImage?.assertUnchanged(); } catch { return fail("SOURCE_CHANGED"); }
  }
  private filename(): string { return `${this.options.appId}.desktop`; }
  private productName(): string { return this.options.appId === "io.github.whisperfree.dev" ? "OpenWhisper Dev" : "OpenWhisper"; }
  private paths(): string[] { return [...new Set([this.options.configHome, ...this.options.configDirs])].map((base) => join(base, "autostart", this.filename())); }
  private async read(path: string): Promise<Entry | undefined> {
    this.checkDirectories(dirname(path), path === this.paths()[0] ? this.options.configHome : undefined);
    const stats = optional(path); if (!stats) return undefined;
    if (!stats.isFile() || stats.nlink !== 1n || (stats.uid !== this.uid && (path === this.paths()[0] || stats.uid !== 0n)) ||
        (stats.mode & 0o022n) !== 0n || stats.size > BigInt(maximumBytes)) return fail("UNSAFE_PATH");
    let file;
    try {
      file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      if (!same(stats, await file.stat({ bigint: true }))) return fail("SOURCE_CHANGED");
      const bytes = Buffer.alloc(Number(stats.size) + 1); let length = 0;
      while (length < bytes.length) { const result = await file.read(bytes, length, bytes.length - length, null);
        if (!result.bytesRead) break; length += result.bytesRead; }
      const current = optional(path);
      if (!current || length !== Number(stats.size) || !same(stats, await file.stat({ bigint: true })) || !same(stats, current)) return fail("SOURCE_CHANGED");
      this.checkDirectories(dirname(path), path === this.paths()[0] ? this.options.configHome : undefined);
      const data = bytes.subarray(0, length); return { path, stats, bytes: data, ...interpret(data, this.options.appId) };
    } catch (error: unknown) { if (error instanceof LinuxAutostartError) throw error; return fail("UNSAFE_PATH"); }
    finally { await file?.close(); }
  }
  private async snapshot(): Promise<{ readonly checked: readonly { path: string; entry: Entry | undefined }[]; readonly effective: Entry | undefined }> {
    const checked: { path: string; entry: Entry | undefined }[] = [];
    for (const path of this.paths()) { const entry = await this.read(path); checked.push({ path, entry }); if (entry) return { checked, effective: entry }; }
    return { checked, effective: undefined };
  }
  async status(): Promise<LinuxAutostartStatus> {
    this.checkExecutable(); const value = (await this.snapshot()).effective?.requested ?? false;
    this.checkExecutable(); return { requested: value };
  }
  set(requested: boolean): Promise<LinuxAutostartStatus> {
    if (typeof requested !== "boolean") return Promise.reject(new LinuxAutostartError("UNAVAILABLE"));
    const task = this.queue.then(async () => {
      this.checkExecutable(); const original = await this.snapshot(); this.checkExecutable();
      if ((!requested && !original.effective?.requested) || (requested && original.effective?.requested &&
          original.effective.executable === this.options.executable && original.effective.image === this.options.appImage?.image &&
          JSON.stringify(original.effective.launchArguments) === JSON.stringify(this.options.launchArguments))) return { requested };
      this.checkExecutable();
      const path = this.paths()[0]!, parent = dirname(path);
      for (const directory of ancestry(parent)) {
        this.checkDirectories(parent, this.options.configHome);
        if (!optional(directory)) { mkdirSync(directory, { mode: 0o700 }); this.checkDirectories(parent, this.options.configHome); }
      }
      const launch = [linuxAutostartArgument(this.options.executable), ...(this.options.launchArguments ? [this.options.launchArguments[0], linuxAutostartArgument(this.options.launchArguments[1])] : []),
        ...(this.options.appImage ? [linuxAutostartArgument(this.options.appImage.image)] : [])].join(" ");
      const content = requested ? ["[Desktop Entry]", "Type=Application", `Name=${this.productName()}`, "Comment=Free, local dictation",
        `Exec=${launch}`, `Icon=${this.options.appId}`, `StartupWMClass=${this.options.appId}`, "Terminal=false", ""].join("\n")
        : `[Desktop Entry]\nType=Application\nName=${this.productName()}\nHidden=true\n`;
      const filename = this.filename();
      const temporary = join(parent, `.${filename}.${randomUUID()}.tmp`); let owned: BigIntStats | undefined;
      try {
        const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try { owned = await file.stat({ bigint: true }); await file.writeFile(content, "utf8"); await file.sync();
          owned = await file.stat({ bigint: true }); } finally { await file.close(); }
        this.checkExecutable(); this.checkDirectories(parent, this.options.configHome);
        // No awaited operation lies between the original identity checks and publication.
        // This detects ordinary concurrent edits; it is not an external-process CAS.
        for (const source of original.checked) { const current = optional(source.path);
          if (source.entry ? !current || !same(source.entry.stats, current) : current !== undefined) return fail("SOURCE_CHANGED"); }
        const staged = optional(temporary);
        if (!staged?.isFile() || !same(staged, owned) || staged.nlink !== 1n ||
            staged.uid !== this.uid || (staged.mode & 0o7777n) !== 0o600n || staged.size !== BigInt(Buffer.byteLength(content))) return fail("SOURCE_CHANGED");
        if (original.checked[0]?.entry) renameSync(temporary, path);
        else { linkSync(temporary, path); unlinkSync(temporary); }
        const directory = await open(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        try { await directory.sync(); } finally { await directory.close(); }
        const result = await this.status(); if (result.requested !== requested) return fail("CHANGE_FAILED"); return result;
      } catch (error: unknown) { if (error instanceof LinuxAutostartError) throw error; return fail("CHANGE_FAILED"); }
      finally {
        // A replaced parent makes cleanup uncertain even if an alias reaches our old inode.
        let safe = false;
        try { this.checkDirectories(parent, this.options.configHome); safe = true; } catch { /* Preserve the original staged bytes. */ }
        if (safe) { const current = optional(temporary); if (owned && current?.isFile() && same(current, owned) && current.nlink === 1n) unlinkSync(temporary); }
      }
    });
    this.queue = task.then(() => {}, () => {}); return task;
  }
}
