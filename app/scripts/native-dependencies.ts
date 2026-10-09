import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { cp, lstat, mkdir, mkdtemp, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";

export const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const revisionSchema = z.string().regex(/^[a-f0-9]{40}$/);
const taggedPin = z.strictObject({ tag: z.string().min(1).max(100), revision: revisionSchema, sha256: digestSchema });
export const vulkanHeadersSchema = z.strictObject({ "Vulkan-Headers": taggedPin, "SPIRV-Headers": taggedPin });
export const shaderSourcesSchema = z.strictObject({
  shaderc: z.strictObject({ repository: z.literal("google/shaderc"), revision: revisionSchema, sha256: digestSchema }),
  glslang: z.strictObject({ repository: z.literal("KhronosGroup/glslang"), revision: revisionSchema, sha256: digestSchema }),
  "spirv-headers": z.strictObject({ repository: z.literal("KhronosGroup/SPIRV-Headers"), revision: revisionSchema, sha256: digestSchema }),
  "spirv-tools": z.strictObject({ repository: z.literal("KhronosGroup/SPIRV-Tools"), revision: revisionSchema, sha256: digestSchema }),
});

export async function fileSha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest("hex");
}

/** Build commands have fixed callers/argument vectors, never renderer input or a shell. */
export async function nativeTool(command: string, args: readonly string[], cwd: string, timeoutMs = 600_000): Promise<string> {
  return new Promise<string>((accept, reject) => {
    const child = spawn(command, args, { cwd, shell: false, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", timedOut = false, outputExceeded = false;
    let escalation: NodeJS.Timeout | undefined;
    const signal = (kind: "SIGTERM" | "SIGKILL"): void => {
      if (process.platform !== "win32" && child.pid) {
        try { process.kill(-child.pid, kind); }
        catch (error: unknown) { if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error; }
      } else child.kill(kind);
    };
    const stop = (): void => { signal("SIGTERM"); escalation ??= setTimeout(() => signal("SIGKILL"), 5000); };
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length + chunk.length > 4 * 1024 * 1024) { outputExceeded = true; stop(); }
      else stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => { if (stderr.length < 65536) stderr += chunk.toString().slice(0, 65536 - stderr.length); });
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    child.once("error", (error) => { clearTimeout(timer); if (escalation) clearTimeout(escalation); reject(error); });
    child.once("close", (code) => {
      clearTimeout(timer); if (escalation) clearTimeout(escalation);
      if (process.env["OPENWHISPER_CAPTURE_NATIVE_BUILD_LOG"] === "1" && command === "cmake" && args[0] === "--build") {
        process.stdout.write(`$ cmake ${args.join(" ")}\n${stdout}${stderr}`);
      }
      if (code !== 0 || timedOut || outputExceeded) {
        // Public build diagnostics only; no native inference requests/replies use this helper.
        reject(new Error(`Native build command failed (${command}). ${stderr}`));
      } else accept(stdout);
    });
  });
}

/** Validate final tar-listed member paths and types before a checksum-pinned archive is extracted.
 * Both GNU tar and macOS bsdtar list the final PAX/GNU-longname paths; no GNU-only flags are used. */
export function validateNativeArchive(names: readonly string[], verbose: readonly string[]): void {
  if (names.length === 0 || names.length > 50_000 || verbose.length !== names.length) throw new Error("Unsafe native archive inventory.");
  let prefix: string | undefined;
  const seen = new Set<string>();
  for (let i = 0; i < names.length; i++) {
    const name = names[i], details = verbose[i];
    if (!name || !details || name.length > 4096 || name.startsWith("/") || name.includes("\\") ||
        /[\u0000-\u001f\u007f]/u.test(name) || !["-", "d"].includes(details[0] ?? "")) throw new Error("Unsafe native archive member.");
    const components = name.split("/").filter(Boolean);
    const root = components[0];
    if (!root || components.includes("..") || components.includes(".") || seen.has(name)) throw new Error("Unsafe native archive path.");
    prefix ??= root;
    if (root !== prefix) throw new Error("Native archive must have one source root.");
    seen.add(name);
  }
}

async function regular(path: string): Promise<boolean> {
  try { const stats = await lstat(path); return stats.isFile() && !stats.isSymbolicLink(); }
  catch (error: unknown) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return false; throw error; }
}
async function sourceTree(root: string): Promise<void> {
  let bytes = 0, count = 0;
  const walk = async (path: string): Promise<void> => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (++count > 100_000 || entry.isSymbolicLink() || !(entry.isFile() || entry.isDirectory())) throw new Error("Unsafe extracted native source.");
      const member = join(path, entry.name);
      if (entry.isDirectory()) await walk(member);
      else { bytes += (await lstat(member)).size; if (bytes > 1024 * 1024 * 1024) throw new Error("Expanded native source exceeded its limit."); }
    }
  };
  await walk(root);
}

export async function pinnedNativeSource(url: string, expectedSha: string, destination: string): Promise<void> {
  digestSchema.parse(expectedSha);
  const origin = new URL(url);
  if (origin.protocol !== "https:" || origin.username || origin.password || origin.search || origin.hash || origin.port ||
      !["codeload.github.com", "nodejs.org"].includes(origin.hostname)) throw new Error("Unsupported native source origin.");
  const marker = join(destination, ".verified-archive");
  if (await regular(marker) && (await readFile(marker, "utf8")).trim() === expectedSha) {
    const status = await lstat(destination);
    if (!status.isDirectory() || status.isSymbolicLink()) throw new Error("Unsafe native source cache.");
    return;
  }
  const parent = dirname(destination);
  await mkdir(parent, { recursive: true });
  const temporary = await mkdtemp(join(parent, ".native-source-"));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  try {
    const fetched = await fetch(url, { redirect: "error", signal: controller.signal });
    if (!fetched.ok || !fetched.body) throw new Error("Pinned native source unavailable.");
    const archive = join(temporary, "archive.tar.gz");
    const output = await open(archive, "wx", 0o600);
    const hash = createHash("sha256");
    let count = 0;
    try {
      for await (const bytes of fetched.body) {
        count += bytes.byteLength;
        if (count > 128 * 1024 * 1024) { controller.abort(); throw new Error("Native source archive exceeded its limit."); }
        hash.update(bytes);
        let offset = 0;
        while (offset < bytes.byteLength) {
          const written = await output.write(bytes, offset, bytes.byteLength - offset);
          if (!written.bytesWritten) throw new Error("Incomplete native source write.");
          offset += written.bytesWritten;
        }
      }
      await output.sync();
    } finally { await output.close(); }
    if (hash.digest("hex") !== expectedSha) throw new Error("Native source checksum mismatch.");
    const names = (await nativeTool("tar", ["-tzf", archive], temporary, 60_000)).trimEnd().split("\n");
    const details = (await nativeTool("tar", ["-tvzf", archive], temporary, 60_000)).trimEnd().split("\n");
    validateNativeArchive(names, details);
    const unpacked = join(temporary, "source");
    await mkdir(unpacked);
    await nativeTool("tar", ["-xzf", archive, "-C", unpacked, "--strip-components=1", "--no-same-owner"], temporary, 60_000);
    await sourceTree(unpacked);
    await writeFile(join(unpacked, ".verified-archive"), `${expectedSha}\n`);
    await rm(destination, { recursive: true, force: true });
    await rename(unpacked, destination);
  } finally { clearTimeout(timer); await rm(temporary, { recursive: true, force: true }); }
}

const toolchainSchema = z.strictObject({ version: z.literal(1), fingerprint: digestSchema,
  compilerSha256: digestSchema, headerSha256: digestSchema });
async function treeSha256(root: string): Promise<string> {
  const hash = createHash("sha256");
  const walk = async (path: string, relative: string): Promise<void> => {
    const entries = await readdir(path, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name, "en"));
    for (const entry of entries) {
      const next = join(path, entry.name), name = join(relative, entry.name);
      if (entry.isSymbolicLink()) throw new Error("Unexpected toolchain link.");
      if (entry.isDirectory()) await walk(next, name);
      else if (entry.isFile()) hash.update(name).update("\0").update(await fileSha256(next)).update("\n");
      else throw new Error("Unsafe toolchain member.");
    }
  };
  await walk(root, ""); return hash.digest("hex");
}

export async function prepareVulkanToolchain(root: string): Promise<{ prefix: string; compiler: string; fingerprint: string }> {
  const headers = vulkanHeadersSchema.parse(JSON.parse(await readFile(join(root, "native/vulkan-headers.json"), "utf8")));
  const shaders = shaderSourcesSchema.parse(JSON.parse(await readFile(join(root, "native/shaderc-source.json"), "utf8")));
  const fingerprint = createHash("sha256").update(JSON.stringify({ headers, shaders, platform: process.platform,
    architecture: process.arch, builder: await fileSha256(join(root, "scripts/native-dependencies.ts")) })).digest("hex");
  const cache = join(root, "vendor/native-vulkan", fingerprint);
  const prefix = join(cache, "headers"), compiler = join(cache, "bin/glslc");
  const marker = join(cache, "toolchain.json");
  if (await regular(marker)) {
    const previous = toolchainSchema.parse(JSON.parse(await readFile(marker, "utf8")));
    if (previous.fingerprint !== fingerprint || !await regular(compiler) ||
        await fileSha256(compiler) !== previous.compilerSha256 || await treeSha256(prefix) !== previous.headerSha256) {
      throw new Error("Cached Vulkan toolchain did not match its manifest.");
    }
    return { prefix, compiler, fingerprint };
  }
  await mkdir(dirname(cache), { recursive: true });
  const stage = await mkdtemp(join(dirname(cache), ".toolchain-"));
  try {
    const installed = join(stage, "headers");
    for (const [name, pin] of Object.entries(headers)) {
      const source = join(root, "vendor/native-sources", pin.sha256);
      await pinnedNativeSource(`https://codeload.github.com/KhronosGroup/${name}/tar.gz/${pin.revision}`, pin.sha256, source);
      const output = join(stage, `build-${name}`);
      await nativeTool("cmake", ["-S", source, "-B", output, `-DCMAKE_INSTALL_PREFIX=${installed}`, "-DBUILD_TESTING=OFF"], root);
      await nativeTool("cmake", ["--install", output], root);
    }
    const source = join(stage, "shader-source");
    for (const [name, pin] of Object.entries(shaders)) {
      const fetched = join(root, "vendor/native-sources", pin.sha256);
      await pinnedNativeSource(`https://codeload.github.com/${pin.repository}/tar.gz/${pin.revision}`, pin.sha256, fetched);
      await cp(fetched, name === "shaderc" ? source : join(source, "third_party", name), { recursive: true });
    }
    const output = join(stage, "build-shaderc");
    await nativeTool("cmake", ["-S", source, "-B", output, "-G", "Ninja", "-DCMAKE_BUILD_TYPE=Release", "-DSHADERC_SKIP_TESTS=ON",
      "-DSHADERC_SKIP_EXAMPLES=ON", "-DSHADERC_SKIP_COPYRIGHT_CHECK=ON", "-DSHADERC_ENABLE_WERROR_COMPILE=OFF", "-DBUILD_SHARED_LIBS=OFF"], root);
    await nativeTool("cmake", ["--build", output, "--target", "glslc_exe", "--parallel", "4"], root);
    await mkdir(join(stage, "bin"));
    await cp(join(output, "glslc/glslc"), join(stage, "bin/glslc"));
    const version = await nativeTool(join(stage, "bin/glslc"), ["--version"], root, 10_000);
    const manifest = toolchainSchema.parse({ version: 1, fingerprint, compilerSha256: await fileSha256(join(stage, "bin/glslc")),
      headerSha256: await treeSha256(installed) });
    await writeFile(join(stage, "toolchain.json"), JSON.stringify(manifest, null, 2));
    await writeFile(join(stage, "compiler-version.txt"), version);
    for (const path of ["shader-source", "build-shaderc", "build-Vulkan-Headers", "build-SPIRV-Headers"]) await rm(join(stage, path), { recursive: true, force: true });
    await rename(stage, cache);
    return { prefix, compiler, fingerprint };
  } finally { await rm(stage, { recursive: true, force: true }); }
}
