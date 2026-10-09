import { z } from "zod";

export const controlKindSchema = z.enum(["development", "stable"]);
export type ControlKind = z.infer<typeof controlKindSchema>;
const targets = Object.freeze({
  development: Object.freeze({ name: "io.github.whisperfree.dev.Control", path: "/io/github/whisperfree/dev/Control", interface: "io.github.whisperfree.Control1" }),
  stable: Object.freeze({ name: "io.github.whisperfree.Control", path: "/io/github/whisperfree/Control", interface: "io.github.whisperfree.Control1" }),
});
/** Only captured build identities can select one of these fixed endpoints. */
export function controlTarget(kind: ControlKind) { return targets[controlKindSchema.parse(kind)]; }
