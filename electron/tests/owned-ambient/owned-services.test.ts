import assert from "node:assert/strict";
import test from "node:test";
import { MetadataDecoder, type MessageMetadata } from "./message-metadata.js";
import { encodeOwnedBody, encodeOwnedMessage, fixedOwnedReply, readOwnedStrings } from "./owned-services.js";

test("fixed owner wire preserves fragmented correlation and bounded variant replies", () => {
  const response = encodeOwnedBody([{ type: "v", value: { type: "u", value: 3 } }]);
  assert.deepEqual([...response], [1, 117, 0, 0, 3, 0, 0, 0]);
  const input: MessageMetadata = { type: 2, flags: 0, serial: 12, bodyBytes: response.length,
    destination: ":1.3", replySerial: 8, signature: "v" };
  const wire = encodeOwnedMessage(input, response), seen: number[] = [];
  const decoder = new MetadataDecoder((metadata, body, little) => {
    assert.equal(little, true); assert.equal(metadata.replySerial, 8); assert.deepEqual(body, response); seen.push(metadata.serial);
  });
  assert.deepEqual(decoder.push(wire.subarray(0, 19)), []);
  assert.deepEqual(decoder.push(wire.subarray(19)), [input]); decoder.finish(); assert.deepEqual(seen, [12]);
});

test("fixed owned interfaces accept only exact paths, members, signatures and known properties", () => {
  const metadata: MessageMetadata = { type: 1, flags: 0, serial: 1, bodyBytes: 0, path: "/org/freedesktop/portal/desktop",
    interface: "org.freedesktop.DBus.Properties", member: "Get", signature: "ss" };
  const body = encodeOwnedBody([{ type: "s", value: "org.freedesktop.portal.FileChooser" }, { type: "s", value: "version" }]);
  assert.deepEqual(readOwnedStrings(body, true, 2), ["org.freedesktop.portal.FileChooser", "version"]);
  assert.deepEqual(fixedOwnedReply(metadata, body, true), { signature: "v", body: [{ type: "v", value: { type: "u", value: 3 } }] });
  assert.equal(fixedOwnedReply({ ...metadata, path: "/unowned" }, body, true), undefined);
  assert.equal(fixedOwnedReply({ ...metadata, signature: "s" }, body, true), undefined);
  const unknown = encodeOwnedBody([{ type: "s", value: "org.example.Secret" }, { type: "s", value: "private" }]);
  assert.equal(fixedOwnedReply(metadata, unknown, true), undefined);
  assert.throws(() => readOwnedStrings(Buffer.concat([body, Buffer.from([1])]), true, 2), /Unexpected/);
  assert.throws(() => encodeOwnedBody([{ type: "s", value: "\ud800" }]), /text/);
});
