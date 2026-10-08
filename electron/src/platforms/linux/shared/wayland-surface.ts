import { createRequire } from "node:module";
import type { LibraryHandle } from "koffi";
import { kdeRecordingSurfaceNamespace } from "../kde/recording-surface.js";
import { HEIGHT, WIDTH, surfaceHostMessageSchema, surfaceReplySchema,
  type SurfaceRegion, type SurfaceReply } from "../../../contracts/wayland-surface.js";

export type SurfacePointer = Extract<SurfaceReply, { type: "pointer" }>;
type FailureStage = Extract<SurfaceReply, { type: "failed" }>["stage"];
export interface SurfaceNative {
  applyFrame(png: Uint8Array, regions: SurfaceRegion[]): void;
  setVisible(visible: boolean): void;
  pump(): void;
  close(): void;
}
export type SurfaceNativeFactory = (pointer: (event: Omit<SurfacePointer, "type" | "sequence">) => void) => SurfaceNative | null;

// This seam keeps IPC/lifetime tests inert; the default factory only runs inside
// the dedicated utility entry, never in the Electron main process.
export class WaylandSurface {
  private native: SurfaceNative | null;
  private sequence: number | undefined;
  private requestedVisible = false;
  private visible = false;
  private closed = false;
  private failed = false;

  constructor(private readonly reply: (message: SurfaceReply) => void, factory: SurfaceNativeFactory = createNativeSurface) {
    this.native = factory((event) => {
      if (!this.closed && this.visible && this.sequence !== undefined) {
        const message = surfaceReplySchema.parse({ type: "pointer", sequence: this.sequence, ...event });
        this.reply(message);
      }
    });
    this.reply({ type: "ready", supported: this.native !== null });
  }

  get isClosed(): boolean { return this.closed; }
  get isSupported(): boolean { return this.native !== null && !this.closed; }

  receive(value: unknown): void {
    if (this.closed) return;
    let stage: FailureStage = "message";
    try {
      const message = surfaceHostMessageSchema.parse(value);
      if (message.type === "close") { this.close(); return; }
      if (!this.native) return;
      if (message.type === "frame") {
        stage = "frame";
        if (this.sequence !== undefined && message.sequence <= this.sequence) throw new Error("Surface frame unavailable.");
        this.native.applyFrame(message.png, message.regions);
        this.sequence = message.sequence;
      } else this.requestedVisible = message.visible;
      stage = "visibility";
      this.visible = this.requestedVisible && this.sequence !== undefined;
      this.native.setVisible(this.visible);
      if (message.type === "frame") this.reply({ type: "painted", sequence: message.sequence, visible: this.visible });
    } catch { this.fail(stage); }
  }

  pump(): void {
    if (this.closed || !this.native) return;
    try { this.native.pump(); } catch { this.fail("pump"); }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true; this.visible = false;
    const native = this.native; this.native = null;
    try { native?.close(); }
    catch { this.failed = true; this.reply({ type: "failed", stage: "close" }); return; }
    this.reply({ type: "closed" });
  }

  private fail(stage: FailureStage): void {
    if (this.failed || this.closed) return;
    this.failed = true;
    this.reply({ type: "failed", stage });
    this.close();
  }
}

type NativeCall = (...args: unknown[]) => unknown;
type Koffi = typeof import("koffi");
function bind(library: LibraryHandle, definition: string): NativeCall {
  const fn = library.func(definition);
  return (...args) => { const result: unknown = fn(...args); return result; };
}
function pointer(value: unknown): bigint {
  if (typeof value !== "bigint" || value === 0n) throw new Error("Surface native object unavailable.");
  return value;
}
function integer(value: unknown): number {
  const number = typeof value === "bigint" ? Number(value) : value;
  if (typeof number !== "number" || !Number.isSafeInteger(number)) throw new Error("Surface native result unavailable.");
  return number;
}
function loadKoffi(): Koffi {
  const value: unknown = createRequire(import.meta.url)("koffi");
  if (typeof value !== "object" || value === null ||
      !["load", "struct", "pointer", "proto", "register", "unregister"].every((name) => typeof Reflect.get(value, name) === "function")) {
    throw new Error("Surface native binding unavailable.");
  }
  return value as Koffi;
}

export function createNativeSurface(emitPointer: Parameters<SurfaceNativeFactory>[0]): SurfaceNative | null {
  let closePartial: (() => void) | undefined;
  try {
    const ffi = loadKoffi();
    const gtk = ffi.load("libgtk-3.so.0"), gdk = ffi.load("libgdk-3.so.0");
    const layer = ffi.load("libgtk-layer-shell.so.0"), pixbuf = ffi.load("libgdk_pixbuf-2.0.so.0");
    const cairo = ffi.load("libcairo.so.2"), object = ffi.load("libgobject-2.0.so.0"), glib = ffi.load("libglib-2.0.so.0");
    const f = {
      init: bind(gtk, "int gtk_init_check(void *argc, void *argv)"),
      supported: bind(layer, "int gtk_layer_is_supported(void)"),
      newWindow: bind(gtk, "void *gtk_window_new(int type)"),
      layerInit: bind(layer, "void gtk_layer_init_for_window(void *window)"),
      namespace: bind(layer, "void gtk_layer_set_namespace(void *window, const char *name)"),
      layer: bind(layer, "void gtk_layer_set_layer(void *window, int layer)"),
      anchor: bind(layer, "void gtk_layer_set_anchor(void *window, int edge, int enabled)"),
      margin: bind(layer, "void gtk_layer_set_margin(void *window, int edge, int margin)"),
      exclusive: bind(layer, "void gtk_layer_set_exclusive_zone(void *window, int zone)"),
      keyboard: bind(layer, "void gtk_layer_set_keyboard_mode(void *window, int mode)"),
      screen: bind(gdk, "void *gdk_screen_get_default(void)"),
      rgba: bind(gdk, "void *gdk_screen_get_rgba_visual(void *screen)"),
      visual: bind(gtk, "void gtk_widget_set_visual(void *widget, void *visual)"),
      paintable: bind(gtk, "void gtk_widget_set_app_paintable(void *widget, int enabled)"),
      decorated: bind(gtk, "void gtk_window_set_decorated(void *window, int enabled)"),
      resizable: bind(gtk, "void gtk_window_set_resizable(void *window, int enabled)"),
      acceptFocus: bind(gtk, "void gtk_window_set_accept_focus(void *window, int enabled)"),
      focusOnMap: bind(gtk, "void gtk_window_set_focus_on_map(void *window, int enabled)"),
      size: bind(gtk, "void gtk_widget_set_size_request(void *widget, int width, int height)"),
      resize: bind(gtk, "void gtk_window_resize(void *window, int width, int height)"),
      events: bind(gtk, "void gtk_widget_add_events(void *widget, int mask)"),
      realize: bind(gtk, "void gtk_widget_realize(void *widget)"),
      show: bind(gtk, "void gtk_widget_show(void *widget)"),
      hide: bind(gtk, "void gtk_widget_hide(void *widget)"),
      window: bind(gtk, "void *gtk_widget_get_window(void *widget)"),
      queueDraw: bind(gtk, "void gtk_widget_queue_draw(void *widget)"),
      destroy: bind(gtk, "void gtk_widget_destroy(void *widget)"),
      ref: bind(object, "void *g_object_ref(void *object)"),
      refSink: bind(object, "void *g_object_ref_sink(void *object)"),
      unref: bind(object, "void g_object_unref(void *object)"),
      signal: bind(object, "unsigned long g_signal_connect_data(void *object, const char *name, void *callback, void *data, void *notify, int flags)"),
      disconnect: bind(object, "void g_signal_handler_disconnect(void *object, unsigned long id)"),
      iterate: bind(glib, "int g_main_context_iteration(void *context, int may_block)"),
      errorFree: bind(glib, "void g_error_free(void *error)"),
      loader: bind(pixbuf, "void *gdk_pixbuf_loader_new_with_type(const char *type, _Out_ void **error)"),
      write: bind(pixbuf, "int gdk_pixbuf_loader_write(void *loader, const uint8_t *bytes, size_t count, _Out_ void **error)"),
      finish: bind(pixbuf, "int gdk_pixbuf_loader_close(void *loader, _Out_ void **error)"),
      image: bind(pixbuf, "void *gdk_pixbuf_loader_get_pixbuf(void *loader)"),
      width: bind(pixbuf, "int gdk_pixbuf_get_width(void *image)"),
      height: bind(pixbuf, "int gdk_pixbuf_get_height(void *image)"),
      source: bind(gdk, "void gdk_cairo_set_source_pixbuf(void *context, void *image, double x, double y)"),
      coords: bind(gdk, "int gdk_event_get_coords(void *event, _Out_ double *x, _Out_ double *y)"),
      button: bind(gdk, "int gdk_event_get_button(void *event, _Out_ unsigned int *button)"),
      shape: bind(gdk, "void gdk_window_input_shape_combine_region(void *window, void *region, int x, int y)"),
      emptyRegion: bind(cairo, "void *cairo_region_create(void)"),
      destroyRegion: bind(cairo, "void cairo_region_destroy(void *region)"),
      save: bind(cairo, "void cairo_save(void *context)"),
      restore: bind(cairo, "void cairo_restore(void *context)"),
      operator: bind(cairo, "void cairo_set_operator(void *context, int operation)"),
      paint: bind(cairo, "void cairo_paint(void *context)"),
    };
    const rectangle = ffi.struct({ x: "int", y: "int", width: "int", height: "int" });
    const regionCall = cairo.func("cairo_region_create_rectangles", "void *", [ffi.pointer(rectangle), "int"]);
    const makeRegion: NativeCall = (...args) => { const result: unknown = regionCall(...args); return result; };
    if (!integer(f.init(null, null)) || !integer(f.supported())) return null;

    const window = pointer(f.newWindow(0));
    f.refSink(window);
    let currentImage: bigint | null = null;
    let regions: SurfaceRegion[] = [];
    let visible = false, closed = false, callbackFailed = false;
    const callbacks: { callback: bigint; signal: number }[] = [];
    const guarded = (fn: (...args: unknown[]) => number | void) => (...args: unknown[]): number => {
      try { return fn(...args) ?? 0; } catch { callbackFailed = true; return 0; }
    };
    function connect(name: string, result: "int" | "void", args: string[], fn: (...args: unknown[]) => number | void): void {
      const callback = ffi.register(guarded(fn), ffi.pointer(ffi.proto(result, args)));
      try { callbacks.push({ callback, signal: integer(f.signal(window, name, callback, null, null, 0)) }); }
      catch { ffi.unregister(callback); throw new Error("Surface callback unavailable."); }
    }
    function applyShape(): void {
      const nativeWindow: unknown = f.window(window);
      if (nativeWindow === null || nativeWindow === 0n) return;
      const active = visible ? regions : [];
      const region = pointer(active.length ? makeRegion(active, active.length) : f.emptyRegion());
      try { f.shape(pointer(nativeWindow), region, 0, 0); } finally { f.destroyRegion(region); }
    }
    function close(): void {
      if (closed) return;
      closed = true; visible = false;
      for (const { signal } of callbacks) f.disconnect(window, signal);
      f.destroy(window);
      for (const { callback } of callbacks) ffi.unregister(callback);
      callbacks.length = 0;
      if (currentImage) { f.unref(currentImage); currentImage = null; }
      f.unref(window);
    }
    closePartial = close;
    f.layerInit(window);
    f.namespace(window, kdeRecordingSurfaceNamespace(process.env["XDG_CURRENT_DESKTOP"]) ?? "openwhisper-recording");
    f.layer(window, 3); f.keyboard(window, 0); f.exclusive(window, 0);
    for (const edge of [0, 1, 2, 3]) f.anchor(window, edge, edge === 3 ? 1 : 0);
    f.margin(window, 3, 24);
    f.visual(window, pointer(f.rgba(pointer(f.screen()))));
    f.paintable(window, 1); f.decorated(window, 0); f.resizable(window, 0);
    f.acceptFocus(window, 0); f.focusOnMap(window, 0);
    f.size(window, WIDTH, HEIGHT); f.resize(window, WIDTH, HEIGHT);
    f.events(window, (1 << 2) | (1 << 8) | (1 << 9) | (1 << 13));
    connect("draw", "int", ["void *", "void *", "void *"], (_widget, context) => {
      const cr = pointer(context);
      f.save(cr);
      try {
        f.operator(cr, 0); f.paint(cr); // CAIRO_OPERATOR_CLEAR
        if (currentImage) { f.operator(cr, 1); f.source(cr, currentImage, 0, 0); f.paint(cr); }
      } finally { f.restore(cr); }
      return 1;
    });
    connect("realize", "void", ["void *", "void *"], applyShape);
    connect("map", "void", ["void *", "void *"], applyShape);
    connect("destroy", "void", ["void *", "void *"], () => { if (!closed) callbackFailed = true; });
    for (const [signal, action] of [["motion-notify-event", "move"], ["button-press-event", "down"],
      ["button-release-event", "up"], ["leave-notify-event", "leave"]] as const) {
      connect(signal, "int", ["void *", "void *", "void *"], (_widget, rawEvent) => {
        if (closed || !visible) return 0;
        const event = pointer(rawEvent);
        if (action === "down" || action === "up") {
          const button: unknown[] = [null];
          if (!integer(f.button(event, button)) || button[0] !== 1) return 0;
        }
        const x: unknown[] = [null], y: unknown[] = [null];
        if (!integer(f.coords(event, x, y)) || typeof x[0] !== "number" || typeof y[0] !== "number" ||
            !Number.isFinite(x[0]) || !Number.isFinite(y[0])) return 0;
        emitPointer({ action, x: Math.min(WIDTH, Math.max(0, x[0])), y: Math.min(HEIGHT, Math.max(0, y[0])) });
        return 1;
      });
    }
    const decode = (png: Uint8Array): bigint => {
      const error: unknown[] = [null];
      let loader: bigint | undefined;
      try {
        loader = pointer(f.loader("png", error));
        if (!integer(f.write(loader, png, png.byteLength, error)) || !integer(f.finish(loader, error))) throw new Error("Surface image unavailable.");
        const image = pointer(f.image(loader));
        if (integer(f.width(image)) !== WIDTH || integer(f.height(image)) !== HEIGHT) throw new Error("Surface image unavailable.");
        return pointer(f.ref(image));
      } finally {
        if (loader) f.unref(loader);
        if (typeof error[0] === "bigint" && error[0] !== 0n) f.errorFree(error[0]);
      }
    };
    return {
      applyFrame(png, inputRegions) {
        if (closed) throw new Error("Surface closed.");
        const next = decode(png), previous = currentImage;
        currentImage = next; regions = inputRegions;
        if (previous) f.unref(previous);
        applyShape(); f.queueDraw(window);
      },
      setVisible(next) {
        if (closed) throw new Error("Surface closed.");
        visible = next;
        if (next) { f.realize(window); applyShape(); f.show(window); }
        else { applyShape(); f.hide(window); }
        applyShape();
      },
      pump() {
        if (closed) return;
        for (let count = 0; count < 64 && integer(f.iterate(null, 0)); count++) { /* Yield to Node after a bounded batch. */ }
        if (callbackFailed) throw new Error("Surface callback unavailable.");
      },
      close,
    };
  } catch {
    try { closePartial?.(); } catch { /* Original utility exit remains the final cleanup boundary. */ }
    return null;
  }
}
