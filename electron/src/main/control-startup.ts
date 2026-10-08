import { parseLaunchArguments, CONTROL_USAGE, type TrustedArgumentLayout } from "../cli/arguments.js";
import { buildIdentitySchema, type BuildIdentity } from "../contracts/build-identity.js";
import { controlFailureOutput, runApplicationControl, type ControlClientOptions, type ControlCliOutput } from "../platforms/linux/shared/control-client.js";

/** Early routing never prepares application storage, permissions, capture or GUI. */
export async function routeControlStartup(options: { readonly argv: unknown; readonly layout: TrustedArgumentLayout;
  readonly platform: string; readonly build: unknown;
  readonly prepare: (identity: BuildIdentity) => Promise<Omit<ControlClientOptions, "kind">> }): Promise<ControlCliOutput | undefined> {
  const selection = parseLaunchArguments(options.argv, options.layout);
  if (selection.kind === "gui") return undefined;
  if (selection.kind === "invalid") return Object.freeze({ exitCode: 2, stdout: "", stderr: `${CONTROL_USAGE}\n` });
  if (options.platform !== "linux") return Object.freeze({ exitCode: 1, stdout: "", stderr: "Command control is available only on Linux.\n" });
  const parsed = buildIdentitySchema.safeParse(options.build);
  if (!parsed.success) return Object.freeze({ exitCode: 1, stdout: "", stderr: "The command control build identity is unavailable.\n" });
  const identity = parsed.data;
  try {
    return await runApplicationControl(selection, { ...await options.prepare(identity), kind: identity.kind });
  } catch (error: unknown) { return controlFailureOutput(error, identity.kind); }
}
