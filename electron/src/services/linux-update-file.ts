import type { FileHandle } from "node:fs/promises";
import { MAX_LINUX_UPDATE_BYTES, verifyLinuxUpdateStream } from "./linux-update-signature.js";
import { inspectOwnedUpdateFile, UpdateStagingError } from "./update-staging.js";

type Failure = "INVALID_INPUT" | "UNSAFE_STAGING" | "FILE_CHANGED" | "PAYLOAD_TOO_LARGE" | "READ_FAILED";
export class LinuxUpdateFileError extends Error {
  constructor(readonly code: Failure) { super(code); this.name = "LinuxUpdateFileError"; }
}
const fail = (code: Failure): never => { throw new LinuxUpdateFileError(code); };
export interface OwnedLinuxUpdateFile {
  /** Borrowed original handle, created exclusively with O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW. */
  readonly file: FileHandle;
  /** The host's settled, private stage; never renderer-selected. */
  readonly stageDirectory: string;
  readonly artifactName: "OpenWhisper-Linux-amd64.deb" | "OpenWhisper-Linux-x86_64.AppImage";
  readonly signature: unknown;
  readonly version: unknown;
  readonly maximumBytes?: number;
}
const stagingFailure = (error: UpdateStagingError): LinuxUpdateFileError =>
  new LinuxUpdateFileError(error.code === "CLEANUP_FAILED" ? "READ_FAILED" : error.code);

/** Verifies a borrowed, settled file. The caller retains its original close/cleanup obligation.
 * This observation never authorizes a later pathname reopen or an installation. Legacy Ed streaming refuses. */
export async function verifyOwnedLinuxUpdateFile(input: OwnedLinuxUpdateFile): Promise<Readonly<{ bytes: number; version: string }>> {
  const { file, stageDirectory, artifactName, signature, version } = input;
  const maximum = input.maximumBytes ?? MAX_LINUX_UPDATE_BYTES;
  if (process.platform !== "linux" ||
      !["OpenWhisper-Linux-amd64.deb", "OpenWhisper-Linux-x86_64.AppImage"].includes(artifactName) ||
      typeof version !== "string") return fail("INVALID_INPUT");
  const observed = await inspectOwnedUpdateFile({ file, stageDirectory, artifactName, maximumBytes: maximum })
    .catch((error: unknown) => { if (error instanceof UpdateStagingError) throw stagingFailure(error); throw error; });
  const size = observed.bytes;
  let readFailure: LinuxUpdateFileError | undefined;
  async function* chunks(): AsyncGenerator<Uint8Array> {
    const block = Buffer.alloc(64 * 1024);
    let position = 0;
    try {
      while (position < size) {
        const wanted = Math.min(block.length, size - position);
        const { bytesRead } = await file.read(block, 0, wanted, position).catch(() => fail("READ_FAILED"));
        if (!Number.isInteger(bytesRead) || bytesRead <= 0 || bytesRead > wanted) return fail("FILE_CHANGED");
        position += bytesRead;
        yield block.subarray(0, bytesRead);
      }
      const end = await file.read(block, 0, 1, position).catch(() => fail("READ_FAILED"));
      if (end.bytesRead !== 0) return fail("FILE_CHANGED");
      await observed.assertUnchanged();
    } catch (error: unknown) {
      // The stream primitive categorizes iterator failures. Preserve only this adapter's own safe category.
      readFailure = error instanceof LinuxUpdateFileError ? error : error instanceof UpdateStagingError ? stagingFailure(error) : new LinuxUpdateFileError("READ_FAILED");
      throw readFailure;
    }
  }
  try { await verifyLinuxUpdateStream(chunks(), signature, version, maximum); }
  catch (error: unknown) { if (readFailure) throw readFailure; throw error; }
  await observed.assertUnchanged().catch((error: unknown) => { if (error instanceof UpdateStagingError) throw stagingFailure(error); throw error; });
  return Object.freeze({ bytes: size, version });
}
