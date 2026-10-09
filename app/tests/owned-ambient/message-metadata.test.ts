import assert from "node:assert/strict";
import test from "node:test";
import { MetadataDecoder, ownedServiceCategory, type MessageMetadata } from "./message-metadata.js";

function frame(little: boolean, flags: number): Buffer {
  const result = Buffer.alloc(36);
  result[0] = little ? 0x6c : 0x42; result[1] = 1; result[2] = flags; result[3] = 1;
  const put = (value: number, offset: number): void => { if (little) result.writeUInt32LE(value, offset); else result.writeUInt32BE(value, offset); };
  put(4, 4); put(7, 8); put(14, 12);
  result[16] = 3; result[17] = 1; result[18] = 0x73; result[19] = 0;
  put(5, 20); result.write("GetId", 24, "ascii"); result[29] = 0;
  result.write("body", 32, "ascii"); return result;
}

test("header metadata preserves flags and endian while discarding fragmented bodies", () => {
  for (const little of [true, false]) {
    const decoder = new MetadataDecoder(), input = frame(little, 2);
    assert.deepEqual(decoder.push(input.subarray(0, 21)), []);
    const result = decoder.push(input.subarray(21));
    assert.deepEqual(result, [{ type: 1, flags: 2, serial: 7, bodyBytes: 4, member: "GetId" }]);
    decoder.finish();
    assert.equal(JSON.stringify(result).includes("body"), true); // Only the fixed byte count is retained.
    assert.equal(JSON.stringify(result).includes('"body"'), false);
  }
});

test("owned daemon service observation retains only exact fixed categories", () => {
  const metadata: MessageMetadata = { type: 1, flags: 0, serial: 1, bodyBytes: 0,
    destination: "org.freedesktop.DBus", interface: "org.freedesktop.DBus", member: "GetNameOwner", signature: "s" };
  for (const [name, expected] of [["org.freedesktop.login1", "login-manager"], ["org.freedesktop.systemd1", "user-service-manager"],
    ["org.freedesktop.portal.Desktop", "desktop-portal"], ["org.example.private", "other-unretained"]]) {
    assert.ok(name && expected);
    for (const little of [true, false]) {
      const bytes = Buffer.from(name), body = Buffer.alloc(bytes.length + 5);
      if (little) body.writeUInt32LE(bytes.length, 0); else body.writeUInt32BE(bytes.length, 0);
      bytes.copy(body, 4); assert.equal(ownedServiceCategory(metadata, body, little), expected);
      assert.equal(ownedServiceCategory({ ...metadata, destination: "org.example.Owned" }, body, little), undefined);
    }
  }
  const malformed = Buffer.alloc(5); malformed.writeUInt32LE(512, 0);
  assert.throws(() => ownedServiceCategory(metadata, malformed, true), /Invalid/);
});

test("malformed header text, oversize frame and incomplete final stream fail closed", () => {
  const bad = frame(true, 0); bad[25] = 0;
  assert.throws(() => new MetadataDecoder().push(bad), /header text/);
  const large = frame(true, 0); large.writeUInt32LE(1048577, 4);
  assert.throws(() => new MetadataDecoder().push(large), /bound/);
  const partial = new MetadataDecoder(); partial.push(Buffer.from([0x6c])); assert.throws(() => partial.finish(), /Incomplete/);
});
