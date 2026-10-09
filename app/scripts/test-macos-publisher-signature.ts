import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { readMacosPublisherRequirement, verifyMacosPublisherCandidate } from "./macos-publisher-signature.js";

async function main(): Promise<void> {
  const [mode, ...args] = process.argv.slice(2);
  const option = (name: string): string => {
    const index = args.indexOf(name), value = args[index + 1];
    if (index < 0 || !value || args.indexOf(name, index + 1) >= 0) throw new Error("Invalid publisher signature test arguments.");
    return value;
  };
  if (mode === "extract") {
    if (args.length !== 2 || args[0] !== "--original") throw new Error("Usage: test-macos-publisher-signature.ts extract --original /owned/OpenWhisper.app");
    process.stdout.write(`${JSON.stringify({ status: "PASS", originalSignature: "ACCEPTED", ...readMacosPublisherRequirement(option("--original")) })}\n`);
  } else if (mode === "verify") {
    if (args.length !== 4 || args[0] !== "--original" || args[2] !== "--candidate") throw new Error("Usage: test-macos-publisher-signature.ts verify --original /owned/OpenWhisper.app --candidate /owned/OpenWhisper.app");
    process.stdout.write(`${JSON.stringify(await verifyMacosPublisherCandidate(option("--original"), option("--candidate")))}\n`);
  } else throw new Error("Unknown publisher signature test mode.");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
