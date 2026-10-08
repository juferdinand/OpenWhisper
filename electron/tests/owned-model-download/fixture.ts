import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer, type Server } from "node:https";
import { Socket } from "node:net";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ModelInventory } from "../../src/services/model-inventory.js";
import { ModelDownloadError, ModelDownloads, type DownloadedCatalogModel, type ModelDownloadHost } from "../../src/services/model-download.js";
import { createModelDownloadTransport } from "../../src/services/model-download-transport.js";
import { prepareDevelopmentProfile, resolveDevelopmentProfile } from "../../src/services/profiles.js";
import { modelDownloadURL, parseModelCatalog } from "../../src/core/model-catalog.js";
import { BODY_BYTES, BOUNDS, CASES, CHUNK_BYTES, HOME, IMAGE, NODE_VERSION, ORIGINAL, REDIRECT, FixtureError,
  bodyChunk, bodyHash, bounded, errorSchema, inputSchema, resultSchema, validatePreparedCache, validateSuite, type Case } from "./contracts.js";
import { OwnedHTTPSIO } from "./io.js";

const EVIDENCE = "/evidence";
const PAYLOAD = "/payload";
const hash = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
function gate(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void; const promise = new Promise<void>((yes) => { resolve = yes; }); return { promise, resolve };
}
async function record(name: "checkpoint" | "runtime" | "certificates" | "result", value: unknown): Promise<void> {
  await writeFile(join(EVIDENCE, `${name}.json`), JSON.stringify(value, null, 2), { mode: 0o600 });
}
async function privateDirectory(path: string): Promise<void> {
  const value = await lstat(path); assert.ok(value.isDirectory() && !value.isSymbolicLink());
  assert.equal(value.uid, 1000); assert.equal(value.mode & 0o7777, 0o700);
}
async function runtimePreflight(): Promise<unknown> {
  assert.equal(process.env.OPENWHISPER_OWNED_MODEL_TLS_TEST, "1");
  assert.equal(process.platform, "linux"); assert.equal(process.arch, "x64"); assert.equal(process.getuid?.(), 1000);
  assert.equal(process.versions.node, NODE_VERSION); assert.equal(process.execPath, "/opt/node/bin/node");
  assert.deepEqual(Object.keys(process.env).sort(), ["HOME", "LANG", "OPENWHISPER_OWNED_MODEL_TLS_TEST", "PATH", "TMPDIR",
    "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME"].sort());
  assert.equal(process.env.HOME, HOME); assert.equal(process.env.TMPDIR, join(HOME, "tmp"));
  assert.equal(process.env.PATH, "/opt/node/bin:/usr/bin:/bin");
  const status = await readFile("/proc/self/status", "utf8");
  assert.match(status, /^CapEff:\s+0+$/mu); assert.match(status, /^NoNewPrivs:\s+1$/mu);
  for (const [name, entries] of Object.entries(networkInterfaces())) {
    assert.equal(name, "lo"); for (const item of entries ?? []) assert.ok(item.internal);
  }
  const bytes = await readFile(join(PAYLOAD, "input.json")); assert.ok(bytes.length <= 256 * 1024);
  const input = inputSchema.parse(JSON.parse(bytes.toString("utf8")));
  assert.equal(hash(await readFile(fileURLToPath(import.meta.url))), input.fixtureSha256);
  assert.equal(hash(await readFile(join(PAYLOAD, "models.json"))), input.catalogSha256);
  assert.equal(hash(await readFile(join(PAYLOAD, "LICENSE-zod"))), input.zodLicenseSha256);
  // Expected executable bytes were passively streamed from the independently
  // checked official archive and matched in the retained owned image runtime.
  const executable = await lstat(process.execPath); assert.ok(executable.isFile() && !executable.isSymbolicLink());
  const nodeExecutableSha256 = hash(await readFile(process.execPath)); assert.equal(nodeExecutableSha256, input.nodeBinarySha256);
  const runtime = { node: process.versions.node, nodeExecutableSha256,
    image: IMAGE, nodeArchiveSha256: input.nodeArchiveSha256, fixtureSha256: input.fixtureSha256,
    uid: process.getuid(), loopbackOnly: true, constructedEnvironment: true, noProviderRequest: true };
  const evidence = await lstat(EVIDENCE); assert.ok(evidence.isDirectory() && !evidence.isSymbolicLink()); assert.equal(evidence.uid, 1000);
  await chmod(EVIDENCE, 0o700); await privateDirectory(EVIDENCE); await record("runtime", runtime); return runtime;
}

interface Certificate { readonly key: Buffer; readonly cert: Buffer }
interface Certificates { readonly ca: Buffer; readonly trusted: Certificate; readonly wrong: Certificate; readonly untrusted: Certificate }
async function openssl(arguments_: readonly string[]): Promise<void> {
  const child = spawn("/usr/bin/openssl", [...arguments_], { shell: false, stdio: ["ignore", "pipe", "pipe"],
    env: { PATH: "/usr/bin:/bin", HOME, LANG: "C.UTF-8" } });
  let bytes = 0, overflow = false;
  const count = (chunk: Buffer): void => { bytes += chunk.length; if (bytes > 64 * 1024) { overflow = true; child.kill("SIGKILL"); } };
  child.stdout.on("data", count); child.stderr.on("data", count);
  const completion = new Promise<void>((yes, no) => {
    child.once("error", () => { no(new FixtureError()); });
    child.once("close", (code) => { code === 0 && !overflow ? yes() : no(new FixtureError()); });
  });
  try { await bounded(completion, BOUNDS.toolMs); }
  catch { child.kill("SIGKILL"); await bounded(completion.catch(() => {}), 500); throw new FixtureError(); }
}
async function certificates(): Promise<Certificates> {
  const root = join(HOME, "certificates"); await mkdir(root, { mode: 0o700 }); await privateDirectory(root);
  const path = (name: string): string => join(root, name);
  for (const name of ["a", "b"] as const) await openssl(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-subj", `/CN=OpenWhisper owned ${name}`, "-keyout", path(`${name}.key`), "-out", path(`${name}.pem`)]);
  for (const [name, ca, dns] of [["trusted", "a", "DNS:huggingface.co,DNS:us.aws.cdn.hf.co"],
    ["wrong", "a", "DNS:owned.invalid"], ["untrusted", "b", "DNS:huggingface.co,DNS:us.aws.cdn.hf.co"]] as const) {
    await writeFile(path(`${name}.ext`), `basicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=${dns}\n`, { mode: 0o600 });
    await openssl(["req", "-new", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=OpenWhisper owned leaf", "-keyout", path(`${name}.key`), "-out", path(`${name}.csr`)]);
    await openssl(["x509", "-req", "-days", "1", "-in", path(`${name}.csr`), "-CA", path(`${ca}.pem`), "-CAkey", path(`${ca}.key`),
      "-set_serial", name === "trusted" ? "11" : name === "wrong" ? "12" : "13", "-extfile", path(`${name}.ext`), "-out", path(`${name}.pem`)]);
  }
  const load = async (name: string): Promise<Certificate> => {
    const key = path(`${name}.key`), stats = await lstat(key);
    assert.ok(stats.isFile() && !stats.isSymbolicLink()); assert.equal(stats.uid, 1000); assert.equal(stats.mode & 0o7777, 0o600);
    return { key: await readFile(key), cert: await readFile(path(`${name}.pem`)) };
  };
  const output = { ca: await readFile(path("a.pem")), trusted: await load("trusted"), wrong: await load("wrong"), untrusted: await load("untrusted") };
  await record("certificates", { privateKeysRetainedOnlyInsideOwnedNamespace: true, operations: 8,
    caSha256: hash(output.ca), trustedSha256: hash(output.trusted.cert), wrongSha256: hash(output.wrong.cert), untrustedSha256: hash(output.untrusted.cert) });
  return output;
}

class OwnedServer {
  readonly headersReached = gate(); readonly bodyReached = gate();
  readonly server: Server; readonly sockets = new Map<Socket, { closed: boolean; close: Promise<void> }>();
  private readonly timers = new Set<NodeJS.Timeout>(); private readonly handlers = new Set<Promise<void>>();
  requestCount = 0; failed = false; closeObserved = false; closing: Promise<void> | undefined;
  readonly routes: string[] = [];
  constructor(private readonly scenario: Case, certificate: Certificate) {
    this.server = createServer({ ...certificate, minVersion: "TLSv1.2" }, (request, response) => {
      const work = this.reply(request, response).catch(() => {
        // A peer's cancellation may reject a pending owned server write. It is
        // counted by the actual closure witnesses, not a parser fixture defect.
        if (!response.destroyed && !this.closing) this.failed = true;
        response.destroy();
      });
      this.handlers.add(work); void work.finally(() => { this.handlers.delete(work); });
    });
    this.server.on("error", () => { this.failed = true; });
    this.server.on("tlsClientError", () => {});
    this.server.on("connection", (socket) => {
      if (!(socket instanceof Socket) || this.sockets.has(socket) || this.sockets.size >= 16) { this.failed = true; socket.destroy(); return; }
      let resolve!: () => void; const state = { closed: false, close: new Promise<void>((yes) => { resolve = yes; }) };
      this.sockets.set(socket, state); socket.on("error", () => {});
      socket.once("close", () => { state.closed = true; resolve(); });
    });
  }
  async listen(): Promise<number> {
    await new Promise<void>((yes, no) => {
      this.server.once("error", no); this.server.listen(0, "127.0.0.1", () => { this.server.removeListener("error", no); yes(); });
    });
    const address = this.server.address(); if (!address || typeof address === "string" || address.address !== "127.0.0.1") throw new FixtureError();
    return address.port;
  }
  private async reply(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (++this.requestCount > 7 || request.headers.authorization || request.headers.cookie || request.headers["proxy-authorization"] ||
      request.headers["x-hf-token"]) throw new FixtureError();
    assert.equal(request.headers["accept-encoding"], "identity");
    const host = request.headers.host;
    // Physical port belongs to this one captured server; paths and logical
    // authority remain exact. No URL from a header is ever used for routing.
    assert.ok(host === `huggingface.co:${(this.server.address() as { port: number }).port}` ||
      host === `us.aws.cdn.hf.co:${(this.server.address() as { port: number }).port}`);
    if (request.method === "HEAD" && request.url === new URL(ORIGINAL).pathname) {
      this.routes.push("HEAD-resolve"); this.headersReached.resolve();
      if (this.scenario === "cancel-headers" || this.scenario === "deadline-headers") return;
      response.writeHead(302, { "x-linked-etag": `"${bodyHash()}"`, "x-linked-size": BODY_BYTES,
        "Content-Length": 1135, Location: REDIRECT }); response.end(); return;
    }
    if (request.method === "GET" && request.url === new URL(ORIGINAL).pathname) {
      this.routes.push("GET-resolve"); response.writeHead(302, { Location: REDIRECT, "Content-Length": 0 }); response.end(); return;
    }
    assert.equal(request.method, "GET"); assert.equal(request.url, new URL(REDIRECT).pathname);
    assert.ok(host?.startsWith("us.aws.cdn.hf.co:")); this.routes.push("GET-payload");
    response.writeHead(200, { "Content-Length": BODY_BYTES });
    for (let position = 0; position < BODY_BYTES;) {
      if (response.destroyed || this.closing) return;
      const bytes = bodyChunk(position, this.scenario === "deadline-total" ? 512 : CHUNK_BYTES);
      await new Promise<void>((yes, no) => { response.write(bytes, (error) => { error ? no(new FixtureError()) : yes(); }); });
      position += bytes.length; this.bodyReached.resolve();
      if (this.scenario === "truncated") { response.socket?.end(); return; }
      if (this.scenario === "cancel-body" || this.scenario === "deadline-idle") return;
      if (this.scenario === "deadline-total") await new Promise<void>((yes) => {
        const timer = setTimeout(() => { this.timers.delete(timer); yes(); }, 40); this.timers.add(timer);
      });
    }
    response.end();
  }
  /** Existing handlers remain owned until they settle; socket destroy is a
   * failure cleanup action, never proof of earlier client cleanup. */
  close(force: boolean): Promise<void> {
    if (force) for (const socket of this.sockets.keys()) socket.destroy();
    this.closing ??= (async () => {
      await new Promise<void>((yes, no) => { this.server.close((error) => { if (error) no(new FixtureError()); else { this.closeObserved = true; yes(); } }); });
      await Promise.all([...this.sockets.values()].map((item) => item.close));
      await Promise.all([...this.handlers]);
      for (const timer of this.timers) clearTimeout(timer);
      assert.equal(await new Promise<number>((yes, no) => { this.server.getConnections((error, count) => { error ? no(error) : yes(count); }); }), 0);
    })(); return this.closing;
  }
}
async function installedDigest(path: string): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW), digest = createHash("sha256");
  try {
    const stats = await file.stat(); assert.equal(stats.size, BODY_BYTES); assert.equal(stats.mode & 0o7777, 0o600); assert.equal(stats.uid, 1000);
    const buffer = Buffer.alloc(65_536); let position = 0;
    for (;;) { const result = await file.read(buffer, 0, buffer.length, position); if (!result.bytesRead) break;
      digest.update(buffer.subarray(0, result.bytesRead)); position += result.bytesRead; }
    assert.equal(position, BODY_BYTES); return digest.digest("hex");
  } finally { await file.close(); }
}
async function runCase(scenario: Case, cert: Certificates, catalog: unknown): Promise<ReturnType<typeof resultSchema.parse>> {
  const started = performance.now(), controller = new AbortController();
  const home = join(HOME, scenario); await mkdir(home, { mode: 0o700 });
  const profile = resolveDevelopmentProfile({ home }); prepareDevelopmentProfile(profile);
  assert.ok(Object.values(profile.flags).every((value) => value === false));
  const inventory = await ModelInventory.open(profile, catalog);
  const server = new OwnedServer(scenario, scenario === "wrong-san" ? cert.wrong : scenario === "untrusted-ca" ? cert.untrusted : cert.trusted);
  let io: OwnedHTTPSIO | undefined, downloads: ModelDownloads | undefined, download: Promise<DownloadedCatalogModel> | undefined;
  let maximumChunkBytes = 0, finalized = false, passed = false;
  const wrote = gate(); let outcome: "installed" | ReturnType<typeof errorSchema.parse> | undefined;
  const hostile = scenario === "wrong-san" || scenario === "untrusted-ca";
  // Only fixed inert values are added to an otherwise empty constructed env.
  if (hostile) Object.assign(process.env, { NODE_TLS_REJECT_UNAUTHORIZED: "0", NODE_USE_ENV_PROXY: "1",
    HTTPS_PROXY: "http://inert:inert@127.0.0.1:9", ALL_PROXY: "http://inert:inert@127.0.0.1:9", HF_TOKEN: "inert-owned-only" });
  try {
    await bounded((async () => {
      io = new OwnedHTTPSIO(await server.listen(), cert.ca, scenario);
      const host: ModelDownloadHost = { transport: () => createModelDownloadTransport(io),
        limits: { headersMs: scenario === "deadline-headers" ? 180 : 1500,
          idleMs: scenario === "deadline-idle" ? 180 : 800, totalMs: scenario === "deadline-total" ? 500 : 4000, cleanupMs: 250 },
        io: { async write(file, bytes) {
          assert.ok(bytes.length > 0 && bytes.length <= 65_536); maximumChunkBytes = Math.max(maximumChunkBytes, bytes.length);
          let offset = 0; while (offset < bytes.length) { const result = await file.write(bytes, offset, bytes.length - offset, null);
            if (!result.bytesWritten) throw new FixtureError(); offset += result.bytesWritten; } wrote.resolve();
        } } };
      downloads = await ModelDownloads.open(profile, inventory, host);
      download = downloads.download("tiny", controller.signal); void download.catch(() => {});
      if (scenario === "cancel-headers") { await server.headersReached.promise; controller.abort(); }
      if (scenario === "cancel-body") { await wrote.promise; controller.abort(); }
      try {
        const value = await download; assert.equal(scenario, "success"); assert.equal(value.cleanupPending, false);
        assert.equal(value.integrity.bytes, BODY_BYTES); assert.equal(value.integrity.sha256, bodyHash()); outcome = "installed";
      } catch (error: unknown) {
        if (!(error instanceof ModelDownloadError)) throw new FixtureError(); outcome = errorSchema.parse(error.code);
        const expected = scenario.startsWith("held-") ? "CLEANUP_FAILED" : scenario.startsWith("cancel-") ? "CANCELLED" :
          scenario.startsWith("deadline-") ? "TIMEOUT" : "TRANSPORT_FAILED";
        assert.equal(outcome, expected);
      }
      await record("checkpoint", { phase: "download-settled", case: scenario, outcome, maximumChunkBytes,
        request: io.witness.snapshot("request"), response: io.witness.snapshot("response"), socket: io.witness.snapshot("socket") });
      if (io.held) {
        await io.witness.closed(); assert.equal(io.gate.observed, true);
        const count = io.requestCount;
        const another = await ModelDownloads.open(profile, inventory, host);
        await assert.rejects(another.download("tiny"), (error: unknown) => error instanceof ModelDownloadError && error.code === "BUSY");
        assert.equal(io.requestCount, count); io.gate.release();
      }
      const requests = io.requestCount; await downloads.finalize(); finalized = true; assert.equal(io.requestCount, requests);
      await record("checkpoint", { phase: "finalize-complete", case: scenario });
      // Finalize waits the retained driver/request receipts first, so no later
      // response/socket acquisition can escape this independent snapshot.
      await io.witness.closed();
      await record("checkpoint", { phase: "receipts-closed", case: scenario });
      const installed = await inventory.installed();
      if (scenario === "success") {
        assert.equal(installed.length, 1); assert.equal(installed[0]?.model.id, "tiny");
      } else assert.equal(installed.length, 0);
      await record("checkpoint", { phase: "inventory-verified", case: scenario });
      if (scenario === "success") {
        assert.equal(await installedDigest(join(profile.paths.models, "ggml-tiny.bin")), bodyHash());
      }
      await record("checkpoint", { phase: "installed-digest-verified", case: scenario, applicable: scenario === "success" });
      if (scenario === "success") {
        assert.deepEqual(server.routes, ["HEAD-resolve", "GET-resolve", "GET-payload"]); assert.ok(maximumChunkBytes > 0);
      }
      await record("checkpoint", { phase: "routes-verified", case: scenario, applicable: scenario === "success" });
      await validatePreparedCache(profile.paths.cache, 1000);
      await record("checkpoint", { phase: "cache-verified", case: scenario });
      if (hostile) assert.equal(server.requestCount, 0);
      if (scenario === "truncated") assert.equal(io.parserIncompleteObserved, true);
      if (scenario === "late-local-error") { assert.equal(io.apparentEOFObserved, true); assert.equal(io.localErrorObserved, true); }
      await server.close(false);
      await record("checkpoint", { phase: "server-closed", case: scenario }); passed = true;
    })(), BOUNDS.caseMs);
  } finally {
    controller.abort(); io?.gate.release();
    if (hostile) for (const key of ["NODE_TLS_REJECT_UNAUTHORIZED", "NODE_USE_ENV_PROXY", "HTTPS_PROXY", "ALL_PROXY", "HF_TOKEN"]) delete process.env[key];
    await bounded((async () => {
      if (download) await download.catch(() => {});
      if (downloads && !finalized) { await downloads.finalize(); finalized = true; }
      if (io) await io.witness.closed();
      await server.close(!passed);
    })(), BOUNDS.cleanupMs);
  }
  if (!passed || !outcome || !io || !finalized || server.failed) throw new FixtureError();
  return resultSchema.parse({ case: scenario, status: "PASS", outcome, bodyBytes: BODY_BYTES, bodySha256: bodyHash(), maximumChunkBytes,
    requestCount: io.requestCount, serverRequestCount: server.requestCount, request: io.witness.snapshot("request"),
    response: io.witness.snapshot("response"), socket: io.witness.snapshot("socket"), serverAcquired: server.sockets.size,
    serverClosed: [...server.sockets.values()].filter((item) => item.closed).length, serverCloseObserved: server.closeObserved,
    serverConnections: 0, cleanupFinalized: finalized, notificationBarrier: io.held ?? "none", notificationOnly: io.held !== undefined,
    apparentEOFObserved: io.apparentEOFObserved, localErrorObserved: io.localErrorObserved,
    parserIncompleteObserved: io.parserIncompleteObserved, elapsedMilliseconds: performance.now() - started });
}

async function main(): Promise<void> {
  process.umask(0o077); await runtimePreflight();
  await mkdir(HOME, { mode: 0o700 }); await privateDirectory(HOME);
  for (const name of ["tmp", "config", "data", "cache"]) await mkdir(join(HOME, name), { mode: 0o700 });
  await record("checkpoint", { phase: "preflight-passed", casesCompleted: 0 });
  const cert = await certificates(), catalog = parseModelCatalog(JSON.parse(await readFile(join(PAYLOAD, "models.json"), "utf8")));
  assert.equal(modelDownloadURL(catalog.models.find((model) => model.id === "tiny")!), ORIGINAL);
  const cases: ReturnType<typeof resultSchema.parse>[] = [];
  for (const scenario of CASES) {
    await record("checkpoint", { phase: "case-start", case: scenario, casesCompleted: cases.length });
    cases.push(await bounded(runCase(scenario, cert, catalog), BOUNDS.caseMs + BOUNDS.cleanupMs));
    await record("checkpoint", { phase: "case-complete", case: scenario, casesCompleted: cases.length, cases });
  }
  await record("result", validateSuite({ scope: "owned-loopback-tls-with-fixture-routing-and-ca", node: NODE_VERSION, image: IMAGE, cases,
    noProductionTrustOverride: true, noProviderDownload: true, noElectronRuntime: true, privateProfileOnly: true }));
}
// This entry is bundled but never imported by the inert contract tests. A fixed
// environment gate still refuses accidental standalone execution.
if (process.argv[1] === fileURLToPath(import.meta.url) && process.env.OPENWHISPER_OWNED_MODEL_TLS_TEST === "1") {
  const timer = setTimeout(() => { process.exit(1); }, BOUNDS.fixtureMs);
  void main().then(() => { clearTimeout(timer); }, async () => {
    // Preserve the last content-free checkpoint; no arbitrary error string.
    process.exitCode = 1;
    await writeFile(join(EVIDENCE, "failure.json"), JSON.stringify({ code: "OWNED_TLS_FAILED" }), { mode: 0o600 }).catch(() => {});
    clearTimeout(timer);
    process.exit(1);
  });
} else if (process.argv[1] === fileURLToPath(import.meta.url)) { process.exitCode = 1; }
