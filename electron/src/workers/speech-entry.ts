import type {} from "electron";
import { loadNativeSpeech } from "./native-speech.js";
import { executeSpeechRequest, speechReadySchema } from "./speech-protocol.js";

const binding = process.argv[2];
if (!binding || (!process.parentPort && !process.send)) process.exit(1);
const native = loadNativeSpeech(binding);

const send = (value: unknown): void => {
  if (process.parentPort) process.parentPort.postMessage(value);
  else if (process.send) process.send(value);
  else process.exit(1);
};
const receive = (input: unknown): void => {
  try { send(executeSpeechRequest(native, input)); }
  catch {
    // Malformed helper frames terminate this disposable worker without diagnostics.
    native.shutdown();
    process.exit(1);
  }
};
if (process.parentPort) process.parentPort.on("message", (event) => {
  const input: unknown = event.data;
  receive(input);
});
else process.on("message", receive);
process.once("disconnect", () => { native.shutdown(); process.exit(0); });
process.once("SIGTERM", () => { native.shutdown(); process.exit(0); });
send(speechReadySchema.parse({ version: 1, type: "ready" }));
