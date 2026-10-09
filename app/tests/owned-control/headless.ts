import { app } from "electron";

// Owned feasibility fixture: no BrowserWindow, bus, audio, Node mode or fallback.
if (process.env.OPENWHISPER_OWNED_CONTROL_TEST !== "1" || process.getuid?.() !== 1000) throw new Error("Owned control fixture required.");
process.stdout.write("HEADLESS_ENTRY_EXECUTED\n");
if (process.argv.includes("--entry-only")) app.exit(0);
void app.whenReady().then(() => { process.stdout.write("HEADLESS_READY\n"); app.quit(); });
