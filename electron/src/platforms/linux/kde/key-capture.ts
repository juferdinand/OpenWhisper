import { kdeKeySchema } from "./keyboard.js";

export interface KeyboardInput { type: string; key: string; code: string; shift: boolean; control: boolean;
  alt: boolean; meta: boolean; isAutoRepeat?: boolean; isComposing?: boolean }
const special: Readonly<Record<string, number>> = { Tab: 0x01000001, Backspace: 0x01000003, Enter: 0x01000004,
  Insert: 0x01000006, Delete: 0x01000007, Pause: 0x01000008, PrintScreen: 0x01000009,
  Home: 0x01000010, End: 0x01000011, ArrowLeft: 0x01000012, ArrowUp: 0x01000013, ArrowRight: 0x01000014,
  ArrowDown: 0x01000015, PageUp: 0x01000016, PageDown: 0x01000017, Shift: 0x01000020, Control: 0x01000021,
  Meta: 0x01000022, Alt: 0x01000023, CapsLock: 0x01000024, NumLock: 0x01000025, ScrollLock: 0x01000026,
  ContextMenu: 0x01000055, AudioVolumeDown: 0x01000070, AudioVolumeMute: 0x01000071, AudioVolumeUp: 0x01000072,
  MediaPlayPause: 0x01000080, MediaStop: 0x01000081, MediaTrackPrevious: 0x01000082, MediaTrackNext: 0x01000083, " ": 0x20 };
function translated(input: KeyboardInput): number | undefined {
  if (input.isComposing || input.key === "Dead" || input.key === "Unidentified") return undefined;
  let base = special[input.key];
  if (base === undefined && /^F(?:[1-9]|[12][0-9]|3[0-5])$/u.test(input.key)) base = 0x01000030 + Number(input.key.slice(1)) - 1;
  if (base === undefined && [...input.key].length === 1) {
    const upper = input.key.toUpperCase(); base = ([...upper].length === 1 ? upper : input.key).codePointAt(0);
  }
  if (base === undefined) return undefined;
  let mask = (input.shift ? 0x02000000 : 0) | (input.control ? 0x04000000 : 0) |
    (input.alt ? 0x08000000 : 0) | (input.meta ? 0x10000000 : 0);
  if (base >= 0x01000020 && base <= 0x01000023) mask &= ~({ 0x01000020: 0x02000000,
    0x01000021: 0x04000000, 0x01000022: 0x10000000, 0x01000023: 0x08000000 }[base] ?? 0);
  if (input.code.startsWith("Numpad")) { mask |= 0x20000000; if (input.key === "Enter") base = 0x01000005; }
  const result = kdeKeySchema.safeParse(base | mask); return result.success ? result.data : undefined;
}
/** Input is consumed only during explicit setup; a key is committed on its matching release. */
export class KdeKeyCapture {
  private candidate: { code: string; key: number } | undefined;
  consume(input: KeyboardInput): { kind: "pending" | "cancel" | "unsupported" } | { kind: "key"; key: number } {
    if (input.key === "Escape" && input.type === "keyDown") return { kind: "cancel" };
    if (input.type === "keyDown" && !input.isAutoRepeat) {
      const key = translated(input);
      if (key === undefined) return { kind: "unsupported" };
      this.candidate = { code: input.code, key };
    } else if (input.type === "keyUp" && this.candidate?.code === input.code) {
      return { kind: "key", key: this.candidate.key };
    }
    return { kind: "pending" };
  }
}
