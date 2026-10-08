import { utilityProcess, type BrowserWindow, type NativeImage, type UtilityProcess } from "electron";
import {
  WIDTH, HEIGHT, MAX_PNG_BYTES, surfaceRegionsSchema, surfaceReplySchema,
  type SurfaceReply,
} from "../contracts/wayland-surface.js";

type SurfaceFailure = "startup-timeout" | "image-size" | "png-size" | "invalid-reply" | "frame-mismatch" |
  "frame-timeout" | "renderer-regions" | "helper-exit" | "helper-error" |
  "native-message" | "native-frame" | "native-visibility" | "native-pump" | "native-close";

// Read only the existing shared buttons. The surface receives pixels and regions,
// never preferences, transcripts, audio or additional renderer authority.
const CONTROL_REGIONS = `(() => ["record", "cancel"].flatMap((id) => {
  const button = document.getElementById(id);
  if (!(button instanceof HTMLButtonElement) || button.hidden || button.disabled ||
      getComputedStyle(button).visibility !== "visible") return [];
  const rect = button.getBoundingClientRect();
  const x = Math.max(0, Math.floor(rect.x)), y = Math.max(0, Math.floor(rect.y));
  const right = Math.min(360, Math.ceil(rect.right)), bottom = Math.min(64, Math.ceil(rect.bottom));
  return right > x && bottom > y ? [{x, y, width: right - x, height: bottom - y}] : [];
}))()`;

function within(completion: Promise<void>, milliseconds: number): Promise<boolean> {
  return new Promise((accept) => {
    const timer = setTimeout(() => accept(false), milliseconds);
    void completion.then(() => { clearTimeout(timer); accept(true); });
  });
}

/** One original utility owns the GTK surface; its Electron renderer stays unmapped. */
export class WaylandRecordingOverlay {
  private readonly child: UtilityProcess;
  private acceptExit!: () => void;
  private readonly exited = new Promise<void>((accept) => { this.acceptExit = accept; });
  private acceptReady!: (supported: boolean) => void;
  private readonly ready = new Promise<boolean>((accept) => { this.acceptReady = accept; });
  private supported = false;
  private exitObserved = false;
  private closing = false;
  private closeTask: Promise<void> | undefined;
  private visible = false;
  private sequence = 0;
  private applied = 0;
  private inFlight: number | undefined;
  private pending: Buffer | undefined;
  private readingRegions = false;
  private startupTimer: NodeJS.Timeout | undefined;
  private firstFrameTimer: NodeJS.Timeout | undefined;
  private frameTimer: NodeJS.Timeout | undefined;

  constructor(private readonly renderer: BrowserWindow, entry: string,
    private readonly unavailable: () => void) {
    // Renderer setup can fail synchronously; do it before allocating the helper.
    renderer.webContents.setFrameRate(15);
    renderer.webContents.stopPainting();
    this.child = utilityProcess.fork(entry, [], {
      serviceName: "OpenWhisper Wayland Recording Surface", execArgv: [], stdio: "ignore",
      allowLoadingUnsignedLibraries: false, respondToAuthRequestsFromMainProcess: false,
      env: { ...process.env, GDK_BACKEND: "wayland" },
    });
    this.child.once("exit", () => {
      this.exitObserved = true; this.acceptExit(); this.acceptReady(false);
      if (!this.closing) this.fail("helper-exit");
    });
    this.child.on("error", () => this.fail("helper-error"));
    this.child.on("message", (input: unknown) => {
      const reply = surfaceReplySchema.safeParse(input);
      if (!reply.success) { this.fail("invalid-reply"); return; }
      this.receive(reply.data);
    });
    renderer.webContents.on("paint", (_event, _dirty, image: NativeImage) => {
      if (!this.supported || !this.visible || this.closing) return;
      // Chromium can publish an empty initial paint while its offscreen view is
      // starting. Keep the surface unmapped until a real bounded frame arrives.
      if (image.isEmpty()) return;
      const size = image.getSize(1);
      if (size.width !== WIDTH || size.height !== HEIGHT) {
        if (Number.isSafeInteger(size.width) && Number.isSafeInteger(size.height) && size.width >= 0 && size.height >= 0 &&
            size.width <= 8192 && size.height <= 8192) {
          console.error(`OpenWhisper Wayland overlay image dimensions: ${size.width}x${size.height}`);
        }
        this.fail("image-size"); return;
      }
      const png = image.toPNG({ scaleFactor: 1 });
      if (png.byteLength === 0 || png.byteLength > MAX_PNG_BYTES) { this.fail("png-size"); return; }
      this.pending = png;
      void this.flush();
    });
  }

  get available(): boolean { return this.supported && !this.closing && !this.exitObserved; }

  async start(): Promise<boolean> {
    this.startupTimer = setTimeout(() => { this.acceptReady(false); this.fail("startup-timeout"); }, 3000);
    const supported = await this.ready;
    clearTimeout(this.startupTimer); this.startupTimer = undefined;
    if (!supported) await this.close();
    return this.available;
  }

  setVisible(visible: boolean): void {
    if (!this.available || this.renderer.isDestroyed()) return;
    if (visible === this.visible) return;
    this.visible = visible;
    this.child.postMessage({ type: "visibility", visible });
    if (visible) {
      this.firstFrameTimer = setTimeout(() => this.fail("frame-timeout"), 3000);
      this.renderer.webContents.startPainting(); this.renderer.webContents.invalidate();
    } else {
      if (this.firstFrameTimer) clearTimeout(this.firstFrameTimer);
      this.firstFrameTimer = undefined;
      this.pending = undefined; this.renderer.webContents.stopPainting();
    }
  }

  private receive(reply: SurfaceReply): void {
    if (reply.type === "ready") {
      if (this.closing) return;
      this.supported = reply.supported; this.acceptReady(reply.supported); return;
    }
    if (reply.type === "failed") { this.fail(`native-${reply.stage}`); return; }
    if (reply.type === "closed") return; // Only original exit confirms retirement.
    if (this.closing || !this.supported) return;
    if (reply.type === "painted") {
      if (reply.sequence !== this.inFlight) { this.fail("frame-mismatch"); return; }
      if (this.frameTimer) clearTimeout(this.frameTimer);
      this.frameTimer = undefined;
      this.applied = reply.sequence; this.inFlight = undefined; void this.flush(); return;
    }
    if (!this.visible || reply.sequence !== this.applied || this.renderer.isDestroyed()) return;
    const type = { move: "mouseMove", down: "mouseDown", up: "mouseUp", leave: "mouseLeave" } as const;
    this.renderer.webContents.sendInputEvent({ type: type[reply.action],
      x: reply.x, y: reply.y, button: "left", clickCount: reply.action === "down" || reply.action === "up" ? 1 : 0 });
  }

  private async flush(): Promise<void> {
    if (!this.pending || this.readingRegions || this.inFlight !== undefined || !this.available || !this.visible) return;
    const png = this.pending; this.pending = undefined; this.readingRegions = true;
    try {
      const regions = surfaceRegionsSchema.parse(await this.renderer.webContents.executeJavaScript(CONTROL_REGIONS));
      if (!this.available || !this.visible || this.renderer.isDestroyed()) return;
      const sequence = ++this.sequence; this.inFlight = sequence;
      if (this.firstFrameTimer) clearTimeout(this.firstFrameTimer);
      this.firstFrameTimer = undefined;
      this.frameTimer = setTimeout(() => this.fail("frame-timeout"), 3000);
      this.child.postMessage({ type: "frame", sequence, png, regions });
    } catch { if (!this.closing) this.fail("renderer-regions"); }
    finally { this.readingRegions = false; }
  }

  private fail(code: SurfaceFailure): void {
    if (this.closing) return;
    console.error(`OpenWhisper Wayland overlay failed: ${code}`);
    this.supported = false; this.pending = undefined; this.acceptReady(false);
    if (!this.renderer.isDestroyed()) this.renderer.webContents.stopPainting();
    this.unavailable();
    // Retain this same owner if cleanup fails; main cannot quit past that failure.
    void this.close().catch(() => {});
  }

  close(): Promise<void> {
    if (this.closeTask) return this.closeTask;
    this.closing = true; this.supported = false; this.pending = undefined; this.acceptReady(false);
    if (this.startupTimer) clearTimeout(this.startupTimer);
    if (this.firstFrameTimer) clearTimeout(this.firstFrameTimer);
    if (this.frameTimer) clearTimeout(this.frameTimer);
    if (!this.renderer.isDestroyed()) this.renderer.webContents.stopPainting();
    this.closeTask = (async () => {
      if (this.exitObserved) return;
      try { this.child.postMessage({ type: "close" }); } catch {}
      if (await within(this.exited, 3000)) return;
      this.child.kill();
      if (!await within(this.exited, 3000)) throw new Error("Wayland recording surface cleanup did not finish.");
    })();
    void this.closeTask.catch(() => {});
    return this.closeTask;
  }
}
