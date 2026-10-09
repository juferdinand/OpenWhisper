import assert from "node:assert/strict";
import { test } from "node:test";
import { parseRawHTTPHeaders, RawHTTPHeadersError } from "../../src/services/http/raw-http-headers.js";

const options = { maximumBytes: 16 * 1024, rejectDuplicates: ["content-length"], requireIdentityEncoding: true, strictStrings: true } as const;

test("raw HTTP headers normalize names and allow caller-approved duplicate fields", () => {
  assert.deepEqual([...parseRawHTTPHeaders(["X-Trace", "first", "x-trace", "last"], options)], [["x-trace", "last"]]);
  assert.deepEqual([...parseRawHTTPHeaders(["Content-Encoding", "identity"], options)], [["content-encoding", "identity"]]);
});

test("raw HTTP header syntax bounds bytes and rejects malformed fields and caller-sensitive duplicates", () => {
  for (const raw of [
    ["Content-Length", "1", "content-length", "1"],
    ["bad_name", "value"],
    ["x-value", "bad\u0000value"],
    ["x-value", "x".repeat(16 * 1024)],
    ["Content-Encoding", "gzip"],
    ["x-value"],
  ]) assert.throws(() => parseRawHTTPHeaders(raw, options), RawHTTPHeadersError);
});

test("strict callers reject malformed element types while legacy typed callers retain their runtime failure", () => {
  const malformed = ["x-value", 1] as unknown as readonly string[];
  assert.throws(() => parseRawHTTPHeaders(malformed, options), RawHTTPHeadersError);
  assert.throws(() => parseRawHTTPHeaders(malformed, { ...options, strictStrings: false }), TypeError);
});
