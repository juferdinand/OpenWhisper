import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateKdeSurrogates } from "../../../src/platforms/linux/kde/keymap.js";
import { kdeMouseLeaseSurrogateIsSafe } from "../../../src/platforms/linux/kde/mouse.js";

const map = (f19Action = ""): string => `xkb_keymap {
 xkb_keycodes "minimal" { minimum = 8; maximum = 255; <FK19> = 100; <FK24> = 101; <ABCD> = 200; };
 xkb_types "minimal" { type "ONE_LEVEL" { modifiers = None; map[None] = Level1; level_name[Level1] = "Any"; }; };
 xkb_compatibility "minimal" { };
 xkb_symbols "minimal" {
   key <FK19> { type = "ONE_LEVEL", [ F19 ]${f19Action} };
   key <FK24> { type = "ONE_LEVEL", [ F24 ] };
 };
};`;

test("KDE mouse surrogates require level-zero keys with inert XKB actions", () => {
  assert.deepEqual(evaluateKdeSurrogates(map()), { f19: true, f24: true });
  assert.deepEqual(evaluateKdeSurrogates(map(", actions[Group1] = [ SetMods(modifiers=Shift) ]")), { f19: false, f24: true });
  assert.throws(() => evaluateKdeSurrogates("not a keymap"));
});

test("a restored mouse lease is rejected when its assigned key is no longer safe", () => {
  assert.equal(kdeMouseLeaseSurrogateIsSafe("Key,F19", { f19: true, f24: false }), true);
  assert.equal(kdeMouseLeaseSurrogateIsSafe("Key,F19", { f19: false, f24: true }), false);
  assert.equal(kdeMouseLeaseSurrogateIsSafe("Key,F24", { f19: true, f24: false }), false);
});
