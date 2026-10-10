import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateKdeSurrogates } from "../../../src/platforms/linux/kde/keymap.js";

const oneLevel = `xkb_types "minimal" {
 type "ONE_LEVEL" {
   modifiers = None;
   map[None] = Level1;
   level_name[Level1] = "Any";
 };
};`;
const twoLevel = `xkb_types "minimal" {
 type "ONE_LEVEL" {
   modifiers = None;
   map[None] = Level1;
   level_name[Level1] = "Any";
 };
 type "TWO_LEVEL" {
   modifiers = Shift;
   map[None] = Level1;
   map[Shift] = Level2;
   level_name[Level1] = "Base";
   level_name[Level2] = "Shift";
 };
};`;
const basicKeycodes = (maximum = 255) => `xkb_keycodes "minimal" {
 minimum = 8;
 maximum = ${maximum};
 <FK19> = 100;
 <FK24> = 101;
 <ABCD> = 200;
 <EFGH> = 90;
};`;
const keymap = (parts: {
  readonly keycodes?: string;
  readonly types?: string;
  readonly symbols: string;
}): string => `xkb_keymap {
 ${parts.keycodes ?? basicKeycodes()}
 ${parts.types ?? oneLevel}
 xkb_compatibility "minimal" { };
 ${parts.symbols}
};`;
const normalSymbols = (f19 = "F19", f24 = "F24") => `xkb_symbols "minimal" {
 key <FK19> { type = "ONE_LEVEL", [ ${f19} ] };
 key <FK24> { type = "ONE_LEVEL", [ ${f24} ] };
};`;

test("known inert level-zero F19 and F24 surrogates are accepted", { skip: process.platform !== "linux" }, () => {
  assert.deepEqual(
    evaluateKdeSurrogates(keymap({ symbols: normalSymbols() })),
    { f19: true, f24: true },
  );
});

test("an absent surrogate is rejected independently of the other key", { skip: process.platform !== "linux" }, () => {
  assert.deepEqual(
    evaluateKdeSurrogates(keymap({ symbols: normalSymbols("NoSymbol") })),
    { f19: false, f24: true },
  );
  assert.deepEqual(
    evaluateKdeSurrogates(keymap({ symbols: normalSymbols("F19", "NoSymbol") })),
    { f19: true, f24: false },
  );
});

test("an earlier shifted duplicate prevents using the later base-level key", { skip: process.platform !== "linux" }, () => {
  const symbols = `xkb_symbols "minimal" {
    key <EFGH> { type = "TWO_LEVEL", [ a, F19 ] };
    key <ABCD> { type = "ONE_LEVEL", [ NoSymbol ] };
    key <FK19> { type = "ONE_LEVEL", [ F19 ] };
    key <FK24> { type = "ONE_LEVEL", [ F24 ] };
  };`;
  assert.deepEqual(
    evaluateKdeSurrogates(keymap({ types: twoLevel, symbols })),
    { f19: false, f24: true },
  );
});

test("a surrogate with multiple keysyms on level zero is rejected", { skip: process.platform !== "linux" }, () => {
  const symbols = `xkb_symbols "minimal" {
    key <FK19> { type = "ONE_LEVEL", [ { F19, a } ] };
    key <FK24> { type = "ONE_LEVEL", [ F24 ] };
  };`;
  assert.deepEqual(
    evaluateKdeSurrogates(keymap({ symbols })),
    { f19: false, f24: true },
  );
});

test("the first surrogate keycode must stay the same in every layout", { skip: process.platform !== "linux" }, () => {
  const symbols = `xkb_symbols "minimal" {
    name[Group1] = "English";
    name[Group2] = "German";
    key <FK19> { symbols[Group1] = [ F19 ], symbols[Group2] = [ NoSymbol ] };
    key <EFGH> { symbols[Group1] = [ NoSymbol ], symbols[Group2] = [ F19 ] };
    key <ABCD> { symbols[Group1] = [ NoSymbol ], symbols[Group2] = [ NoSymbol ] };
    key <FK24> { symbols[Group1] = [ F24 ], symbols[Group2] = [ F24 ] };
  };`;
  assert.deepEqual(
    evaluateKdeSurrogates(keymap({ symbols })),
    { f19: false, f24: true },
  );
});

for (const action of [
  "SetMods(modifiers=Shift)",
  "LockMods(modifiers=Shift)",
  "SetGroup(group=2)",
  "LockGroup(group=2)",
]) {
  test(`an F19 ${action} action is rejected`, { skip: process.platform !== "linux" }, () => {
    const symbols = `xkb_symbols "minimal" {
      name[Group1] = "English";
      name[Group2] = "German";
      key <FK19> { symbols[Group1] = [ F19 ], symbols[Group2] = [ F19 ], actions[Group1] = [ ${action} ] };
      key <FK24> { symbols[Group1] = [ F24 ], symbols[Group2] = [ F24 ] };
    };`;
    assert.deepEqual(
      evaluateKdeSurrogates(keymap({ symbols })),
      { f19: false, f24: true },
    );
  });
}

test("a symbol only at the keymap maximum is excluded", { skip: process.platform !== "linux" }, () => {
  const symbols = `xkb_symbols "minimal" {
    key <FK19> { type = "ONE_LEVEL", [ NoSymbol ] };
    key <FK24> { type = "ONE_LEVEL", [ F24 ] };
  };`;
  const keycodes = `xkb_keycodes "minimal" {
    minimum = 8;
    maximum = 101;
    <FK19> = 100;
    <FK24> = 101;
  };`;
  assert.deepEqual(
    evaluateKdeSurrogates(keymap({ keycodes, symbols })),
    { f19: false, f24: false },
  );
});
