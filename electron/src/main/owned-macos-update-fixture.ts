import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import type { ModelDownloadExchange, ModelDownloadTransport } from "../services/model-download-transport.js";
import { downloadUpdateCandidate } from "../services/update-download.js";
import { MAX_UPDATE_STAGE_BYTES } from "../services/update-staging.js";
import { projectMacosUpdateRelease } from "../services/update-policy.js";
import type { MacosUpdateCoordinatorEffects } from "./macos-update-coordinator.js";

/** Main-only owned-CI fixture transport. Production extraction, self-signature, transaction and cleanup stay default. */
export function ownedMacosUpdateFixtureEffects(input: Readonly<{ archive: string; repository: string;
  currentVersion: string; expectedVersion: string }>): Partial<MacosUpdateCoordinatorEffects> {
  const candidate = projectMacosUpdateRelease({ repository: input.repository, currentVersion: input.currentVersion,
    release: { tag_name: `v${input.expectedVersion}`, html_url: `https://github.com/${input.repository}/releases/tag/v${input.expectedVersion}`,
      body: "Private same-source updater fixture", draft: false, prerelease: false,
      assets: [{ name: "OpenWhisper-macOS.zip", browser_download_url:
        `https://github.com/${input.repository}/releases/download/v${input.expectedVersion}/OpenWhisper-macOS.zip` }] } });
  const transport = (): ModelDownloadTransport => {
    let exchange: ModelDownloadExchange | undefined, closed = false;
    return {
      request(url, method, signal) {
        if (closed || exchange || method !== "GET" || url.href !== candidate.assetURL || signal.aborted) throw new Error("OWNED_FIXTURE_TRANSPORT_REFUSED");
        let file: Awaited<ReturnType<typeof open>> | undefined, complete = false, failed = false, closeTask: Promise<void> | undefined;
        const headers = (async () => {
          const value = await lstat(input.archive, { bigint: true });
          if (!value.isFile() || value.isSymbolicLink() || value.nlink !== 1n || value.uid !== BigInt(process.getuid?.() ?? -1) ||
            (value.mode & 0o7777n) !== 0o600n || value.size <= 0n || value.size > BigInt(MAX_UPDATE_STAGE_BYTES)) throw new Error("OWNED_FIXTURE_FILE_REFUSED");
          file = await open(input.archive, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
          const opened = await file.stat({ bigint: true });
          if (!opened.isFile() || opened.dev !== value.dev || opened.ino !== value.ino || opened.size !== value.size ||
              opened.uid !== value.uid || opened.nlink !== 1n || (opened.mode & 0o7777n) !== 0o600n) throw new Error("OWNED_FIXTURE_FILE_CHANGED");
          return { status: 200, raw: ["content-length", opened.size.toString(), "content-type", "application/zip"] };
        })();
        const body = (async function* (): AsyncGenerator<Uint8Array> {
          try {
            const response = await headers; void response;
            if (!file) throw new Error("OWNED_FIXTURE_FILE_UNAVAILABLE");
            const size = (await file.stat({ bigint: true })).size;
            for (let position = 0n; position < size;) {
              if (signal.aborted || closed) throw new Error("OWNED_FIXTURE_CANCELLED");
              const bytes = Buffer.allocUnsafe(Number(size - position > 65_536n ? 65_536n : size - position));
              const result = await file.read(bytes, 0, bytes.length, Number(position));
              if (result.bytesRead <= 0) throw new Error("OWNED_FIXTURE_FILE_CHANGED");
              position += BigInt(result.bytesRead); yield bytes.subarray(0, result.bytesRead);
            }
            complete = true;
          } catch (error: unknown) { failed = true; throw error; }
        })();
        exchange = { headers, body, completion: () => ({ complete, failed }), close: () => {
          closeTask ??= (async () => { try { await headers; } catch { /* A failed or aborted header open still owns cleanup. */ }
            if (file) await file.close(); })(); return closeTask;
        } };
        return exchange;
      },
      async close() { closed = true; await exchange?.close(); },
    };
  };
  return Object.freeze({ read: async () => candidate,
    download: async (download) => downloadUpdateCandidate(download, { transport }) });
}
