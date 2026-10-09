/** Parses Node's alternating raw-header list without applying endpoint policy. */
export class RawHTTPHeadersError extends Error {
  constructor() { super("INVALID_RAW_HTTP_HEADERS"); this.name = "RawHTTPHeadersError"; }
}

export interface RawHTTPHeaderOptions {
  readonly maximumBytes: number;
  readonly rejectDuplicates: readonly string[];
  readonly requireIdentityEncoding: boolean;
  /** One legacy reader relies on Node's typed rawHeaders contract and lets malformed values throw. */
  readonly strictStrings: boolean;
}

export function parseRawHTTPHeaders(raw: readonly string[], options: RawHTTPHeaderOptions): Map<string, string> {
  if (raw.length % 2 !== 0) throw new RawHTTPHeadersError();
  const result = new Map<string, string>(); let bytes = 0;
  for (let index = 0; index < raw.length; index += 2) {
    const name = raw[index], value = raw[index + 1];
    if (options.strictStrings && (typeof name !== "string" || typeof value !== "string")) throw new RawHTTPHeadersError();
    if (!name || value === undefined || !/^[a-z0-9-]+$/iu.test(name) || /[\u0000-\u001f\u007f]/u.test(value)) {
      throw new RawHTTPHeadersError();
    }
    bytes += Buffer.byteLength(name) + Buffer.byteLength(value);
    if (bytes > options.maximumBytes) throw new RawHTTPHeadersError();
    const key = name.toLowerCase();
    if (result.has(key) && options.rejectDuplicates.includes(key)) throw new RawHTTPHeadersError();
    result.set(key, value);
  }
  const encoding = result.get("content-encoding");
  if (options.requireIdentityEncoding && encoding !== undefined && encoding.toLowerCase() !== "identity") {
    throw new RawHTTPHeadersError();
  }
  return result;
}
