export type ControlCommand = "start" | "stop" | "toggle" | "cancel" | "status";
export type ControlAction = Exclude<ControlCommand, "status">;
export type LaunchSelection =
  | { readonly kind: "gui" }
  | { readonly kind: "control"; readonly command: ControlCommand }
  | { readonly kind: "invalid"; readonly code: "USAGE" };

/** The bootstrap derives this immutable layout from its own executable/module. */
export type TrustedArgumentLayout =
  | { readonly kind: "packaged"; readonly executable: string }
  | { readonly kind: "development"; readonly executable: string; readonly application: string };

export const CONTROL_USAGE = "Usage: openwhisper-desktop --control start|stop|toggle|cancel|status";
const MAX_ARGUMENTS = 32;
const MAX_ARGUMENT_BYTES = 8192;
const MAX_TOTAL_ARGUMENT_BYTES = 32768;

export function isControlCommand(value: unknown): value is ControlCommand {
  return value === "start" || value === "stop" || value === "toggle" || value === "cancel" || value === "status";
}

function argument(value: unknown): value is string {
  // Unicode mode sees a valid pair as one non-surrogate code point.
  return typeof value === "string" && value.length <= MAX_ARGUMENT_BYTES && !/[\uD800-\uDFFF]/u.test(value) && !value.includes("\0") &&
    Buffer.byteLength(value, "utf8") <= MAX_ARGUMENT_BYTES;
}

/** No heuristic prefix removal, shell parsing, native loading or bus access. */
export function parseLaunchArguments(input: unknown, layout: TrustedArgumentLayout): LaunchSelection {
  const invalid: LaunchSelection = Object.freeze({ kind: "invalid", code: "USAGE" });
  if (!Array.isArray(input) || input.length === 0 || input.length > MAX_ARGUMENTS || !argument(layout.executable)) return invalid;
  const values: string[] = [];
  let bytes = 0;
  for (const value of input) {
    if (!argument(value)) return invalid;
    bytes += Buffer.byteLength(value, "utf8");
    if (bytes > MAX_TOTAL_ARGUMENT_BYTES) return invalid;
    values.push(value);
  }
  if (values[0] !== layout.executable) return invalid;
  const prefix = layout.kind === "packaged" ? 1 : 2;
  if (layout.kind === "development" && (!argument(layout.application) || values[1] !== layout.application)) return invalid;
  const arguments_ = values.slice(prefix);
  if (!arguments_.includes("--control")) return Object.freeze({ kind: "gui" });
  const command = arguments_[1];
  if (arguments_.length !== 2 || arguments_[0] !== "--control" || !isControlCommand(command)) return invalid;
  return Object.freeze({ kind: "control", command });
}
