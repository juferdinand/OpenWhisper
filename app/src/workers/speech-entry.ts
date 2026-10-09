import type {} from "electron";
import { loadNativeSpeech } from "./native-speech.js";
import { createSpeechBootstrap } from "./speech-bootstrap.js";
import { speechBootstrapArgumentsSchema } from "./speech-control.js";

const args = speechBootstrapArgumentsSchema.safeParse(process.argv.slice(2));
if (!args.success || (!process.parentPort && !process.send)) process.exit(1);
const [binding, epoch] = args.data;
const bootstrap = createSpeechBootstrap({ binding, epoch, pid: process.pid, load: loadNativeSpeech });

const send = (value: unknown): void => {
  if (process.parentPort) process.parentPort.postMessage(value);
  else if (process.send) process.send(value);
  else process.exit(1);
};
const receive = (input: unknown): void => {
  try { send(bootstrap.receive(input)); }
  catch {
    // Malformed helper frames terminate this disposable worker without diagnostics.
    bootstrap.close();
    process.exit(1);
  }
};
if (process.parentPort) process.parentPort.on("message", (event) => {
  const input: unknown = event.data;
  receive(input);
});
else process.on("message", receive);
process.once("disconnect", () => { bootstrap.close(); process.exit(0); });
process.once("SIGTERM", () => { bootstrap.close(); process.exit(0); });
send(bootstrap.ready);
