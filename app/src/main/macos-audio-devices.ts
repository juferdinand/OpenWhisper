import { createRequire } from "node:module";
import type { LibraryHandle, TypeObject } from "koffi";
import { recordingSourceSchema, type RecordingSource } from "../workers/recording/recording-host-protocol.js";

interface MacosAudioInputDevice { readonly uid: string; readonly name: string; readonly isDefault: boolean }
export type MacosAudioDeviceReader = () => readonly MacosAudioInputDevice[];

/**
 * Lists CoreAudio devices that have input streams. Only stable device UIDs and display names are
 * returned; no audio is opened. Devices whose UID cannot be represented as a recording source are
 * skipped, so the selection stays within the one shared source grammar.
 */
export function macosAudioInputSources(reader: MacosAudioDeviceReader = readCoreAudioInputDevices): readonly RecordingSource[] {
  const sources: RecordingSource[] = [];
  for (const device of reader()) {
    const parsed = recordingSourceSchema.safeParse({ id: device.uid, name: device.name, isDefault: device.isDefault });
    if (parsed.success && !sources.some((source) => source.id === parsed.data.id)) sources.push(parsed.data);
    if (sources.length >= 128) break;
  }
  return sources;
}

const fourCC = (value: string): number => value.split("").reduce((code, char) => (code << 8) | char.charCodeAt(0), 0) >>> 0;
const kAudioObjectSystemObject = 1, kAudioObjectPropertyElementMain = 0;
const kAudioHardwarePropertyDevices = fourCC("dev#"), kAudioHardwarePropertyDefaultInputDevice = fourCC("dIn ");
const kAudioDevicePropertyStreams = fourCC("stm#"), kAudioDevicePropertyDeviceUID = fourCC("uid ");
const kAudioObjectPropertyName = fourCC("lnam");
const kAudioObjectPropertyScopeGlobal = fourCC("glob"), kAudioDevicePropertyScopeInput = fourCC("inpt");
const kCFStringEncodingUTF8 = 0x08000100;
// koffi type names are process-global; declare the address struct only once.
let addressType: TypeObject | undefined;

function readCoreAudioInputDevices(): readonly MacosAudioInputDevice[] {
  if (process.platform !== "darwin") return [];
  const koffi = createRequire(import.meta.url)("koffi") as typeof import("koffi");
  const libraries: LibraryHandle[] = [];
  try {
    const audio = koffi.load("/System/Library/Frameworks/CoreAudio.framework/CoreAudio"); libraries.push(audio);
    const cf = koffi.load("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation"); libraries.push(cf);
    addressType ??= koffi.struct("OpenWhisperAudioPropertyAddress", { mSelector: "uint32_t", mScope: "uint32_t", mElement: "uint32_t" });
    const size = audio.func("int32_t AudioObjectGetPropertyDataSize(uint32_t object, OpenWhisperAudioPropertyAddress *address, uint32_t qualifierSize, void *qualifier, _Out_ uint32_t *size)");
    const data = audio.func("int32_t AudioObjectGetPropertyData(uint32_t object, OpenWhisperAudioPropertyAddress *address, uint32_t qualifierSize, void *qualifier, _Inout_ uint32_t *size, void *out)");
    const stringData = audio.func("int32_t AudioObjectGetPropertyData(uint32_t object, OpenWhisperAudioPropertyAddress *address, uint32_t qualifierSize, void *qualifier, _Inout_ uint32_t *size, _Out_ void **out)");
    const toCString = cf.func("bool CFStringGetCString(void *text, _Out_ uint8_t *buffer, long size, uint32_t encoding)");
    const release = cf.func("void CFRelease(void *reference)");
    const address = (selector: number, scope = kAudioObjectPropertyScopeGlobal) =>
      ({ mSelector: selector, mScope: scope, mElement: kAudioObjectPropertyElementMain });
    const byteSize = (object: number, selector: number, scope?: number): number => {
      const out = [0]; return size(object, address(selector, scope), 0, null, out) === 0 ? Number(out[0]) : 0;
    };
    const identifiers = (object: number, selector: number): number[] => {
      const bytes = byteSize(object, selector);
      if (bytes <= 0 || bytes % 4 || bytes > 4 * 1024) return [];
      const buffer = Buffer.alloc(bytes), io = [bytes];
      if (data(object, address(selector), 0, null, io, buffer) !== 0) return [];
      return Array.from({ length: Number(io[0]) / 4 }, (_, index) => buffer.readUInt32LE(index * 4));
    };
    const text = (object: number, selector: number): string | undefined => {
      const io = [8], out: unknown[] = [null];
      if (stringData(object, address(selector), 0, null, io, out) !== 0 || !out[0]) return undefined;
      try {
        const buffer = Buffer.alloc(1024);
        if (!toCString(out[0], buffer, buffer.length, kCFStringEncodingUTF8)) return undefined;
        const end = buffer.indexOf(0); return buffer.subarray(0, end < 0 ? buffer.length : end).toString("utf8");
      } finally { release(out[0]); }
    };
    const defaultInput = identifiers(kAudioObjectSystemObject, kAudioHardwarePropertyDefaultInputDevice)[0];
    const devices: MacosAudioInputDevice[] = [];
    for (const device of identifiers(kAudioObjectSystemObject, kAudioHardwarePropertyDevices)) {
      if (byteSize(device, kAudioDevicePropertyStreams, kAudioDevicePropertyScopeInput) <= 0) continue;
      const uid = text(device, kAudioDevicePropertyDeviceUID), name = text(device, kAudioObjectPropertyName);
      if (uid) devices.push({ uid, name: name ?? uid, isDefault: device === defaultInput });
    }
    return devices;
  } catch { return []; }
  finally { for (const library of libraries.reverse()) { try { library.unload(); } catch { /* Best effort. */ } } }
}
