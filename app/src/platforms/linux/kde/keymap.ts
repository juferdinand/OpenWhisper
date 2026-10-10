import { closeSync, fstatSync, readSync } from "node:fs";
import { createRequire } from "node:module";
import type { LibraryHandle } from "koffi";

export interface SafeSurrogates { readonly f19: boolean; readonly f24: boolean }
export interface KdeKeymapMonitor { readonly safe: SafeSurrogates; pump(): boolean; close(): void }
type NativeCall = (...args: unknown[]) => unknown;
type Koffi = typeof import("koffi");
const MAX_MAP_BYTES = 1024 * 1024;
const MAX_KEYCODE = 8192;
const MAX_LAYOUTS = 32;
const MAX_LEVELS = 32;
const UNVERIFIED = "Could not verify the desktop keyboard layout for a mouse trigger.";

function bind(library: LibraryHandle, definition: string): NativeCall {
  const call = library.func(definition); return (...args) => { const result: unknown = call(...args); return result; };
}
function number(value: unknown): number {
  const result = typeof value === "bigint" ? Number(value) : value;
  if (typeof result !== "number" || !Number.isSafeInteger(result)) throw new Error(UNVERIFIED);
  return result;
}
function pointer(value: unknown): bigint {
  if (typeof value !== "bigint" || value === 0n) throw new Error(UNVERIFIED);
  return value;
}

/** Reproduce the compositor's XKB lookup and reject key actions that alter key state. */
export function evaluateKdeSurrogates(text: string, imported?: Koffi): SafeSurrogates {
  if (text.length > MAX_MAP_BYTES || text.includes("\0")) throw new Error(UNVERIFIED);
  const ffi = imported ?? createRequire(import.meta.url)("koffi") as Koffi;
  const xkb = ffi.load("libxkbcommon.so.0");
  const f = {
    context: bind(xkb, "void *xkb_context_new(int flags)"), contextUnref: bind(xkb, "void xkb_context_unref(void *context)"),
    contextLog: bind(xkb, "void xkb_context_set_log_level(void *context, int level)"),
    keymap: bind(xkb, "void *xkb_keymap_new_from_string(void *context, const char *text, int format, int flags)"),
    keymapUnref: bind(xkb, "void xkb_keymap_unref(void *keymap)"),
    min: bind(xkb, "uint32_t xkb_keymap_min_keycode(void *keymap)"), max: bind(xkb, "uint32_t xkb_keymap_max_keycode(void *keymap)"),
    layouts: bind(xkb, "uint32_t xkb_keymap_num_layouts(void *keymap)"),
    levels: bind(xkb, "uint32_t xkb_keymap_num_levels_for_key(void *keymap, uint32_t key, uint32_t layout)"),
    symbols: bind(xkb, "int xkb_keymap_key_get_syms_by_level(void *keymap, uint32_t key, uint32_t layout, uint32_t level, _Out_ void **symbols)"),
    state: bind(xkb, "void *xkb_state_new(void *keymap)"), stateUnref: bind(xkb, "void xkb_state_unref(void *state)"),
    updateMask: bind(xkb, "uint32_t xkb_state_update_mask(void *state, uint32_t depressed, uint32_t latched, uint32_t locked, uint32_t depressed_layout, uint32_t latched_layout, uint32_t locked_layout)"),
    keySym: bind(xkb, "uint32_t xkb_state_key_get_one_sym(void *state, uint32_t key)"),
    mods: bind(xkb, "uint32_t xkb_state_serialize_mods(void *state, uint32_t components)"),
    group: bind(xkb, "uint32_t xkb_state_serialize_layout(void *state, uint32_t components)"),
    updateKey: bind(xkb, "uint32_t xkb_state_update_key(void *state, uint32_t key, int direction)"),
  };
  const context = pointer(f.context(0x1 | 0x2));
  f.contextLog(context, 10);
  let keymap: bigint | undefined;
  try {
    keymap = pointer(f.keymap(context, text, 1, 0));
    const max = number(f.max(keymap)), layouts = number(f.layouts(keymap));
    if (max > MAX_KEYCODE || layouts < 1 || layouts > MAX_LAYOUTS) throw new Error(UNVERIFIED);
    const firstCodes: (number | undefined)[] = [undefined, undefined];
    const targets = [0xffd0, 0xffd5];
    const safe = [true, true];
    for (let layout = 0; layout < layouts; layout++) {
      for (let candidate = 0; candidate < targets.length; candidate++) {
        let found: { code: number; level: number } | undefined;
        search: for (let code = number(f.min(keymap)); code < max; code++) {
          const levels = number(f.levels(keymap, code, layout));
          if (levels > MAX_LEVELS) throw new Error(UNVERIFIED);
          for (let level = 0; level < levels; level++) {
            const output: unknown[] = [0n]; const count = number(f.symbols(keymap, code, layout, level, output));
            if (count < 0 || count > 64) throw new Error(UNVERIFIED);
            const symbols = count === 0 ? [] : ffi.decode(pointer(output[0]), ffi.array("uint32_t", count)) as number[];
            if (symbols.length === 1 && symbols[0] === targets[candidate]) { found = { code, level }; break search; }
          }
        }
        if (!found || found.level !== 0 || firstCodes[candidate] !== undefined && firstCodes[candidate] !== found.code) {
          safe[candidate] = false; continue;
        }
        firstCodes[candidate] ??= found.code;
        const state = pointer(f.state(keymap));
        try {
          f.updateMask(state, 0, 0, 0, 0, 0, layout);
          const groups = [16, 32, 64, 128].map((component) => number(f.group(state, component)));
          const unchanged = (): boolean => number(f.keySym(state, found!.code)) === targets[candidate]! &&
            number(f.mods(state, 1 | 2 | 4 | 8)) === 0 &&
            [16, 32, 64, 128].every((component, index) => number(f.group(state, component)) === groups[index]);
          if (!unchanged()) safe[candidate] = false;
          f.updateKey(state, found.code, 1);
          if (!unchanged()) safe[candidate] = false;
          f.updateKey(state, found.code, 0);
          if (!unchanged()) safe[candidate] = false;
        } finally { f.stateUnref(state); }
      }
    }
    return { f19: safe[0]!, f24: safe[1]! };
  } finally { if (keymap) f.keymapUnref(keymap); f.contextUnref(context); }
}

/** Read a compositor-provided keymap fd without mapping or trusting an unbounded file. */
export function readKdeKeymapFd(fd: number, size: number): string {
  try {
    if (!Number.isInteger(fd) || fd < 0 || !Number.isInteger(size) || size < 2 || size > MAX_MAP_BYTES) throw new Error(UNVERIFIED);
    const stats = fstatSync(fd);
    if (!stats.isFile() || stats.size < size || stats.size > MAX_MAP_BYTES) throw new Error(UNVERIFIED);
    const bytes = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const count = readSync(fd, bytes, offset, size - offset, offset);
      if (count === 0) throw new Error(UNVERIFIED);
      offset += count;
    }
    if (bytes[size - 1] !== 0 || bytes.subarray(0, size - 1).includes(0)) throw new Error(UNVERIFIED);
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size - 1));
  } finally { try { closeSync(fd); } catch { /* The compositor may already have closed a malformed descriptor. */ } }
}
