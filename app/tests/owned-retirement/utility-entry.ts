import type {} from "electron";
import { startFixtureChild } from "./fixture-child.js";
import { FixtureError } from "./contract.js";
const port = process.parentPort;
if (!port) throw new FixtureError();
startFixtureChild({ send: async (reply) => { port.postMessage(reply); },
  listen: (listener) => { port.on("message", (event) => { const input: unknown = event.data; listener(input); }); } }, process.argv.slice(2));
