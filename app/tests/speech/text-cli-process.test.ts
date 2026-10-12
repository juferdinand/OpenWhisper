import assert from "node:assert/strict";
import { dirname, delimiter, join } from "node:path";
import { test } from "node:test";
import { safeTextCliEnvironment } from "../../src/services/text/text-cli-process.js";

test("CLI child environment keeps absolute executable lookup paths and omits injection variables", () => {
  const environment = safeTextCliEnvironment({
    HOME: "/synthetic-home", PATH: `.:relative${delimiter}/opt/custom/bin`, CODEX_HOME: "/synthetic-codex-home",
    LD_PRELOAD: "/untrusted.so", NODE_OPTIONS: "--require /untrusted.js", GEMINI_API_KEY: "synthetic-secret",
  }, "/usr/local/bin/custom-cli");
  const paths = environment.PATH?.split(delimiter) ?? [];
  assert.deepEqual(paths, ["/opt/custom/bin", "/usr/local/bin", dirname(process.execPath),
    "/synthetic-home/.local/bin", "/synthetic-home/.claude/local", "/synthetic-home/.npm-global/bin",
    "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"].filter((path, index, values) => values.indexOf(path) === index));
  assert.equal(environment.CODEX_HOME, "/synthetic-codex-home");
  assert.equal(environment.HOME, "/synthetic-home");
  assert.equal(environment.LD_PRELOAD, undefined);
  assert.equal(environment.NODE_OPTIONS, undefined);
  assert.equal(environment.GEMINI_API_KEY, undefined);
  assert.ok(paths.includes(join("/synthetic-home", ".local/bin")));
});
