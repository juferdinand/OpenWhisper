import { z } from "zod";

export const IMAGE = "sha256:403f066a165681074f19f1977b2b46617d3dd7b072cb7037400dbe01676ed3cb";
export const RUNTIME_SHA = "10a14d05c6ff4f94075cfb3eeb6ed6571be33ebcc08cbd675b5ce9ff84706564";
export const RUNTIME_ARCHIVE_SHA = "3ae7d5bdad61c664486c6ab61361dd084d064c8c08af8d13a687096e18ce555a";
export const HEADER_SHA = "57c6bee2e30bbbee5bd51d6cc343eb992e174b56a2a1d0eab7a7510771c20ea2";
export const SECCOMP_SHA = "1efc4e2f5a192ffb8ce927268e7378156ded854c164c61584f7af9ceef4ff28f";
export const EXECUTION_MS = 45_000;
export const UTILITY_CLEANUP_MS = 8_000;
export const PARENT_CLEANUP_MS = 5_000;
export const profileSchema = z.enum(["opening", "cleanup", "legacy"]);
export type Profile = z.infer<typeof profileSchema>;
const sha = z.string().regex(/^[a-f0-9]{64}$/u);
const relative = z.string().min(1).max(256).refine((value) => !value.startsWith("/") &&
  !value.includes("\\") && !value.includes("\0") && value.split("/").every((part) => part !== "" && part !== "." && part !== ".."));
export const hashesSchema = z.record(relative, sha);
export const packageSchema = z.strictObject({ version: z.literal(1), image: z.literal(IMAGE),
  runtime: z.literal(RUNTIME_SHA), header: z.literal(HEADER_SHA), seccomp: z.literal(SECCOMP_SHA),
  source: hashesSchema, payload: hashesSchema, node: z.literal("24.21.0"), electron: z.literal("44.7.0"), napi: z.literal(8) });
export const frozenCore: Readonly<Record<string, string>> = Object.freeze({
  "native/linux-bus/binding.cpp": "1228b0212b1c5ff44b01a91af5d627e5567afbe62f00be226fa3d5fdc190fc7f",
  "native/linux-bus/CMakeLists.txt": "b2dd61bd046222c01b368c8ed233ee9c3b8fa026d550d8e3f84542997f93ed29",
  "native/linux-bus/codec.cpp": "76fc603ba5908ae76c897c10e58061da105fd03f3e698284aa1b8b37b11d0f64",
  "native/linux-bus/codec.hpp": "273188a37018b2dd02ac082b040f5c29e8abde073f8e268a570198f088b28727",
  "src/platforms/linux/shared/bus.ts": "a39b35c2eaa50ec43277557294403aad12695799cd215df8632e711c8a417741",
  "src/platforms/linux/shared/bus-values.ts": "593ee9ce90ca60d35fb4231b528f217e93819611f5882a77a927bf7b2fa67834",
  "tests/platforms/linux/linux-bus-opening.test.ts": "61eab85f3d746057b73971a3852eab0738b4dc0c1af4486e9988fb6d2c05c7e3",
  "tests/owned-bus-opening/scenarios.ts": "bd51fc8737032b895fa60bd290afb880219a139970283411ff3cfdacd5f8c376",
  "tests/owned-bus-opening/entry.ts": "84b97f7903bc951e56fd9ea877051b514164e0681af4ecd8458abf90274b13df",
  "tests/owned-bus-opening/README.md": "0373d15377903a9c62cb2721f57e3b039468d387b2c4ff743e7732d41a187632",
  "tests/owned-bus/service.cpp": "6f122f6c3bcb831979ac9eb07256261297d902966b78bba6837bbdfaae116451",
  "tests/owned-bus/entry.ts": "d63ab3e3a04b020d7b3a4e5dc70e5080a7b67331902ce0923a3d6ac32b12ec75",
});
/** The complete pre-start check is deliberately stronger than a nominal image tag. */
export function validateContainer(value: unknown, seccompBody: string): void {
  const inspect = z.array(z.object({ Image: z.literal(IMAGE), State: z.object({ Running: z.literal(false) }),
    Config: z.object({ User: z.literal("1000:1000"), Entrypoint: z.tuple([z.literal("/bin/sleep")]), Cmd: z.tuple([z.literal("1800")]),
      Env: z.array(z.string()), Volumes: z.null() }),
    HostConfig: z.object({ NetworkMode: z.literal("none"), Privileged: z.literal(false), CapAdd: z.null(),
      CapDrop: z.tuple([z.literal("ALL")]), Devices: z.array(z.unknown()).length(0), DeviceRequests: z.null(),
      Binds: z.null(), VolumesFrom: z.null(), PidMode: z.literal(""), IpcMode: z.literal("private"),
      Init: z.literal(true), UsernsMode: z.literal(""), CgroupnsMode: z.literal("private"), GroupAdd: z.null(),
      Ulimits: z.tuple([z.strictObject({ Name: z.literal("core"), Soft: z.literal(0), Hard: z.literal(0) })]),
      SecurityOpt: z.tuple([z.literal(`seccomp=${seccompBody}`)]), PidsLimit: z.literal(256),
      Memory: z.literal(3 * 1024 * 1024 * 1024), ShmSize: z.literal(256 * 1024 * 1024) }),
    Mounts: z.array(z.unknown()).length(0) })).length(1).parse(value)[0];
  if (!inspect) throw new Error("Missing owned container inspection.");
  const allowed = new Map([["PATH", "/opt/node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"]]);
  for (const item of inspect.Config.Env) {
    const split = item.indexOf("="), key = item.slice(0, split), body = item.slice(split + 1);
    if (split <= 0 || allowed.get(key) !== body) throw new Error("Unexpected pre-start container environment.");
    allowed.delete(key);
  }
  if (allowed.size !== 0) throw new Error("Missing fixed container environment.");
}
export function sameHashes(actual: Readonly<Record<string, string>>, expected: Readonly<Record<string, string>>): void {
  const keys = Object.keys(actual).sort(), names = Object.keys(expected).sort();
  if (keys.length !== names.length || keys.some((key, index) => key !== names[index] || actual[key] !== expected[key])) {
    throw new Error("Frozen input bytes changed.");
  }
}
export function baselineAbi(text: string): Readonly<Record<string, readonly string[]>> {
  const result: Record<string, string[]> = {};
  for (const [family, maximum] of Object.entries({ GLIBC: "2.35", GLIBCXX: "3.4.30", CXXABI: "1.3.13" })) {
    const versions = [...new Set([...text.matchAll(new RegExp(`\\b${family}_([0-9]+(?:\\.[0-9]+)+)\\b`, "gu"))].map((match) => match[1]))];
    const parsed = z.array(z.string()).parse(versions); if (parsed.length === 0) throw new Error("Missing native ABI requirements.");
    const ceiling = maximum.split(".").map(Number);
    for (const version of parsed) {
      const numbers = version.split(".").map(Number);
      for (let index = 0; index < Math.max(numbers.length, ceiling.length); index++) {
        const actual = numbers[index] ?? 0, allowed = ceiling[index] ?? 0;
        if (actual > allowed) throw new Error("Native artifact exceeds Ubuntu22 ABI ceiling.");
        if (actual < allowed) break;
      }
    }
    result[family] = parsed;
  }
  return result;
}
export const addressSchema = z.string().max(1024).regex(/^unix:path=\/tmp\/openwhisper-owned-bus(?:,guid=[a-f0-9]{32})?$/u);
export const foreignSchema = z.strictObject({ address: addressSchema, owner: z.string().regex(/^:[0-9]+\.[0-9]+$/u) });
export const oldChecks = Object.freeze([
  "actual native UTF16 surrogate rejection before method dispatch", "real unique owner and same UID", "absent service NoAutoStart",
  "actual widths dictionary variant tuple roundtrip", "actual mismatched output signature refused and owner disposed",
  "actual FD receive reflect consume unused malformed pipe oversize cleanup", "actual GCancellable and finite native deadline",
  "actual unique sender subscription and unsubscribe", "actual fixed Dev control export real UID checked and safe refusal",
  "actual unanswered exported invocation expires natively", "actual expired monotonic authorization never reaches control action",
  "actual UID1001 caller denied before control action", "actual owner replacement old destination and signals stay fenced",
  "actual native signal queue overflow closes owner", "actual oversized signal refused before application callback",
  "close cancels full bounded request queue and disposes unconsumed FD holder", "confirmed close permits clean connection generation",
  "actual idle daemon loss invalidates and disposes without another call", "actual daemon replacement establishes fresh transport generation",
]);
