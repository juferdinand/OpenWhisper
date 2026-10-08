import { startFixtureChild } from "./fixture-child.js";
import { FixtureError } from "./contract.js";
if (!process.send || !process.connected) throw new FixtureError();
startFixtureChild({ send: (reply) => new Promise<void>((accept, reject) => {
  if (!process.send) { reject(new FixtureError()); return; }
  process.send(reply, (error: Error | null) => { if (error) reject(new FixtureError()); else accept(); });
}), listen: (listener) => { process.on("message", (input: unknown) => { listener(input); }); } }, process.argv.slice(2));
