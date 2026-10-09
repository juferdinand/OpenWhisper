import { spawn } from "node:child_process";
import { cp, mkdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { pinnedNativeSource } from "./native-dependencies.js";

const root = resolve(fileURLToPath(new URL("../", import.meta.url)));
const pinSchema = z.strictObject({ version: z.literal("24.21.0"), napiVersion: z.literal(8),
  sha256: z.string().regex(/^[a-f0-9]{64}$/), source: z.literal("https://nodejs.org/download/release/v24.21.0/SHASUMS256.txt") });
async function run(command: string, args: string[]): Promise<void> {
  await new Promise<void>((accept, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: "inherit", shell: false });
    child.once("error", reject); child.once("close", (code) => { code === 0 ? accept() : reject(new Error("Linux bus native build failed.")); });
  });
}
/** Independent native target; it does not start a bus or mutate speech builds. */
export async function buildLinuxBus(): Promise<void> {
  if (process.platform !== "linux") throw new Error("The Linux bus target requires Linux.");
  const raw: unknown = JSON.parse(await readFile(join(root, "native/node-headers.json"), "utf8"));
  const pin = pinSchema.parse(raw);
  const output = join(root, "native/linux-bus/build"); await mkdir(output, { recursive: true });
  const headers = join(root, "vendor/node-headers");
  await pinnedNativeSource(`https://nodejs.org/download/release/v${pin.version}/node-v${pin.version}-headers.tar.gz`, pin.sha256, headers);
  await run("cmake", ["-S", join(root, "native/linux-bus"), "-B", output, "-G", "Ninja", "-DCMAKE_BUILD_TYPE=Release",
      "-DCMAKE_EXPORT_COMPILE_COMMANDS=ON", `-DNODE_HEADERS=${join(headers, "include/node")}`]);
  await run("cmake", ["--build", output, "--parallel", "4"]);
  const destination = join(root, "dist/native"); await mkdir(destination, { recursive: true });
  await cp(join(output, "openwhisper_linux_bus.node"), join(destination, "openwhisper_linux_bus.node"));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildLinuxBus();
