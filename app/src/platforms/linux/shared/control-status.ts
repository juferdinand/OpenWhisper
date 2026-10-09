import type { ControlWireStatus, RecordingStatus } from "../../../core/recording/control.js";
export type { ControlWireStatus, RecordingStatus } from "../../../core/recording/control.js";

const MAX_CONTROL_STATUS_BYTES = 4096;
export const MAX_CONTROL_ELAPSED = (1n << 64n) - 1n;
export class InvalidControlStatus extends Error {
  constructor() { super("Invalid control status response."); this.name = "InvalidControlStatus"; }
}

function status(value: unknown): value is RecordingStatus {
  return value === "idle" || value === "recording" || value === "transcribing" || value === "done" || value === "error";
}

/** Closed JSON grammar keeps uint64 numbers exact; it never normalizes user text. */
export function parseControlStatus(input: unknown): ControlWireStatus {
  if (typeof input !== "string" || input.length > MAX_CONTROL_STATUS_BYTES || /[\uD800-\uDFFF]/u.test(input) ||
    Buffer.byteLength(input, "utf8") > MAX_CONTROL_STATUS_BYTES) throw new InvalidControlStatus();
  let offset = 0;
  let state: RecordingStatus | undefined;
  let elapsed: bigint | undefined;
  let recovery: boolean | undefined;
  const whitespace = (): void => { while (/^[ \t\r\n]$/.test(input[offset] ?? "")) offset++; };
  const token = (expected: string): void => {
    whitespace(); if (!input.startsWith(expected, offset)) throw new InvalidControlStatus(); offset += expected.length;
  };
  token("{");
  for (let field = 0; field < 3; field++) {
    if (field > 0) token(",");
    whitespace();
    const key = /^"(status|elapsed|recovery_available)"/.exec(input.slice(offset));
    if (!key) throw new InvalidControlStatus();
    offset += key[0].length; token(":"); whitespace();
    if (key[1] === "status") {
      if (state !== undefined) throw new InvalidControlStatus();
      const match = /^"(idle|recording|transcribing|done|error)"/.exec(input.slice(offset));
      const value = match?.[1];
      if (!match || !status(value)) throw new InvalidControlStatus();
      state = value; offset += match[0].length;
    } else if (key[1] === "elapsed") {
      if (elapsed !== undefined) throw new InvalidControlStatus();
      const match = /^(0|[1-9][0-9]*)/.exec(input.slice(offset));
      if (!match || match[0].length > 20) throw new InvalidControlStatus();
      elapsed = BigInt(match[0]);
      if (elapsed > MAX_CONTROL_ELAPSED) throw new InvalidControlStatus();
      offset += match[0].length;
    } else if (key[1] === "recovery_available") {
      if (recovery !== undefined) throw new InvalidControlStatus();
      const match = /^(true|false)/.exec(input.slice(offset));
      if (!match) throw new InvalidControlStatus();
      recovery = match[0] === "true"; offset += match[0].length;
    } else throw new InvalidControlStatus();
  }
  token("}"); whitespace();
  if (offset !== input.length || state === undefined || elapsed === undefined || recovery === undefined) throw new InvalidControlStatus();
  return Object.freeze({ status: state, elapsed, recovery_available: recovery });
}

export function serializeControlStatus(value: ControlWireStatus): string {
  if (!status(value.status) || typeof value.elapsed !== "bigint" || value.elapsed < 0n || value.elapsed > MAX_CONTROL_ELAPSED ||
    typeof value.recovery_available !== "boolean") throw new InvalidControlStatus();
  return `{"status":"${value.status}","elapsed":${value.elapsed},"recovery_available":${value.recovery_available}}`;
}
import { z } from "zod";


/** RPC transports the exact closed JSON grammar without rounding uint64 values. */
export const controlWireStatusTextSchema = z.string().max(MAX_CONTROL_STATUS_BYTES).refine((value) => {
  try { parseControlStatus(value); return true; } catch { return false; }
});
