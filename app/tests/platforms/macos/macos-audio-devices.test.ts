import assert from "node:assert/strict";
import test from "node:test";
import { macosAudioInputSources } from "../../../src/main/macos-audio-devices.js";

test("Mac input sources keep CoreAudio UIDs with inner spaces and skip unrepresentable devices", () => {
  const sources = macosAudioInputSources(() => [
    { uid: "AppleUSBAudioEngine:Vendor:Studio Mic:1234:1", name: "Synthetic studio microphone", isDefault: true },
    { uid: "BuiltInMicrophoneDevice", name: "Synthetic built-in microphone", isDefault: false },
    { uid: "BuiltInMicrophoneDevice", name: "Duplicate", isDefault: false },
    { uid: " leading-space", name: "Invalid", isDefault: false },
    { uid: "line\nbreak", name: "Invalid", isDefault: false },
    { uid: "x".repeat(256), name: "Too long", isDefault: false },
  ]);
  assert.deepEqual(sources.map((source) => source.id), ["AppleUSBAudioEngine:Vendor:Studio Mic:1234:1", "BuiltInMicrophoneDevice"]);
  assert.equal(sources[0]?.isDefault, true);
  assert.equal(sources[1]?.name, "Synthetic built-in microphone");
});

test("Mac input source discovery tolerates an empty CoreAudio list", () => {
  assert.deepEqual(macosAudioInputSources(() => []), []);
});
