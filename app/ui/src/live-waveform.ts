// Adapted from ElevenLabs LiveWaveform, apps/www/registry/elevenlabs-ui/ui/live-waveform.tsx
// at 23c31bd3088814215a8b5d0bfb56b327cad1a578. Copyright 2025 Eleven Labs Inc., MIT.

const MAX_HISTORY = 512;
const BAR_WIDTH = 2.5;
const BAR_STEP = 4;
const BAR_BASE = 4;
const EDGE_FADE_WIDTH = 10;
const SCROLL_PIXELS_PER_SECOND = 64;
const COLUMN_INTERVAL_MS = (BAR_STEP / SCROLL_PIXELS_PER_SECOND) * 1000;
const STALE_AFTER_MS = 500;

export interface LiveWaveformOptions {
  readonly mode: "scrolling" | "static";
}

interface Column {
  readonly level: number;
  readonly at: number;
}

/** Draws admitted recording telemetry only; it never opens an audio device. */
export class LiveWaveform {
  readonly canvas: HTMLCanvasElement;

  private readonly options: LiveWaveformOptions;
  private readonly context: CanvasRenderingContext2D | null;
  private readonly resizeObserver: ResizeObserver | undefined;
  private readonly reducedMotion: MediaQueryList | undefined;
  private readonly onVisibilityChange = () => {
    if (!document.hidden) {
      this.lastFrameAt = undefined;
      this.lastColumnAt = performance.now();
      this.draw(performance.now());
    }
    this.syncAnimation();
  };
  private readonly onMotionChange = () => {
    this.lastFrameAt = undefined;
    if (this.reducedMotion?.matches) this.scheduleStaleClear();
    else this.cancelStaleTimer();
    this.draw(performance.now());
    this.syncAnimation();
  };
  private columns: Column[] = [];
  private active = false;
  private generation: number | undefined;
  private targetLevel = 0;
  private displayedLevel = 0;
  private lastInputAt: number | undefined;
  private lastFrameAt: number | undefined;
  private lastColumnAt: number | undefined;
  private animationFrame: number | undefined;
  private staleTimer: ReturnType<typeof setTimeout> | undefined;
  private width = 0;
  private height = 0;
  private pixelRatio = 1;
  private fadeGradient: CanvasGradient | undefined;
  private destroyed = false;

  constructor(canvas: HTMLCanvasElement, options: LiveWaveformOptions) {
    this.canvas = canvas;
    this.options = options;
    this.context = canvas.getContext("2d");
    this.reducedMotion = window.matchMedia?.(
      "(prefers-reduced-motion: reduce)",
    );
    this.resizeObserver =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(() => this.resize());
    this.resizeObserver?.observe(canvas);
    window.addEventListener("resize", this.resize);
    document.addEventListener("visibilitychange", this.onVisibilityChange);
    this.reducedMotion?.addEventListener("change", this.onMotionChange);
    this.resize();
  }

  /** Returns true only when this call starts a fresh recording generation. */
  setRecording(active: boolean, generation?: number): boolean {
    if (this.destroyed) return false;
    if (!active || generation === undefined) {
      if (!this.active) return false;
      this.active = false;
      this.generation = undefined;
      this.clear();
      this.syncAnimation();
      return false;
    }
    if (this.active && this.generation === generation) return false;
    this.active = true;
    this.generation = generation;
    this.columns = [];
    this.targetLevel = 0;
    this.displayedLevel = 0;
    this.lastInputAt = undefined;
    this.lastFrameAt = undefined;
    this.lastColumnAt = undefined;
    this.cancelStaleTimer();
    this.draw(performance.now());
    this.syncAnimation();
    return true;
  }

  push(generation: number, level: number, at: number): void {
    if (
      this.destroyed ||
      !this.active ||
      generation !== this.generation ||
      !Number.isFinite(level) ||
      level < 0 ||
      level > 1 ||
      !Number.isFinite(at) ||
      (this.lastInputAt !== undefined && at < this.lastInputAt)
    )
      return;

    this.lastInputAt = at;
    this.targetLevel = level;
    this.scheduleStaleClear();
    if (this.reducedMotion?.matches) {
      this.displayedLevel = level;
      this.lastFrameAt = at;
      this.columns.push({ level, at });
      if (this.columns.length > MAX_HISTORY) this.columns.shift();
      this.draw(at);
    } else {
      this.syncAnimation();
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.active = false;
    this.cancelAnimation();
    this.cancelStaleTimer();
    this.resizeObserver?.disconnect();
    window.removeEventListener("resize", this.resize);
    document.removeEventListener("visibilitychange", this.onVisibilityChange);
    this.reducedMotion?.removeEventListener("change", this.onMotionChange);
    this.columns = [];
    this.context?.clearRect(0, 0, this.width, this.height);
  }

  private readonly resize = (): void => {
    if (this.destroyed) return;
    const bounds = this.canvas.getBoundingClientRect();
    const ratio = Math.max(1, window.devicePixelRatio || 1);
    this.width = Math.max(0, bounds.width);
    this.height = Math.max(0, bounds.height);
    this.pixelRatio = ratio;
    const pixelWidth = Math.max(1, Math.round(this.width * ratio));
    const pixelHeight = Math.max(1, Math.round(this.height * ratio));
    if (this.canvas.width !== pixelWidth) this.canvas.width = pixelWidth;
    if (this.canvas.height !== pixelHeight) this.canvas.height = pixelHeight;
    this.context?.setTransform(ratio, 0, 0, ratio, 0, 0);
    this.fadeGradient = undefined;
    this.draw(performance.now());
  };

  private syncAnimation(): void {
    if (
      this.destroyed ||
      !this.active ||
      !this.canvas.isConnected ||
      document.hidden ||
      this.reducedMotion?.matches
    ) {
      this.cancelAnimation();
      return;
    }
    if (this.animationFrame === undefined)
      this.animationFrame = requestAnimationFrame(this.tick);
  }

  private readonly tick = (at: number): void => {
    this.animationFrame = undefined;
    if (
      this.destroyed ||
      !this.active ||
      !this.canvas.isConnected ||
      document.hidden ||
      this.reducedMotion?.matches
    ) {
      this.syncAnimation();
      return;
    }
    const ratio = Math.max(1, window.devicePixelRatio || 1);
    if (ratio !== this.pixelRatio) this.resize();
    this.advanceEnvelope(at);
    if (this.lastColumnAt === undefined) {
      this.columns.push({ level: this.displayedLevel, at });
      if (this.columns.length > MAX_HISTORY) this.columns.shift();
      this.lastColumnAt = at;
    } else {
      const due = Math.floor((at - this.lastColumnAt) / COLUMN_INTERVAL_MS);
      const count = Math.min(due, 2);
      for (let index = 0; index < count; index++) {
        this.lastColumnAt += COLUMN_INTERVAL_MS;
        this.columns.push({
          level: this.displayedLevel,
          at: this.lastColumnAt,
        });
        if (this.columns.length > MAX_HISTORY) this.columns.shift();
      }
      if (due > 2) this.lastColumnAt = at;
    }
    this.draw(at, false);
    this.syncAnimation();
  };

  private draw(at: number, advance = true): void {
    const context = this.context;
    if (
      !context ||
      !this.canvas.isConnected ||
      this.width <= 0 ||
      this.height <= 0
    )
      return;
    context.clearRect(0, 0, this.width, this.height);
    const color = getComputedStyle(this.canvas).color || "#ffffff";
    const center = this.height / 2;
    if (!this.active) {
      if (this.options.mode === "scrolling") {
        for (let x = 0; x + BAR_WIDTH <= this.width; x += BAR_STEP)
          this.drawColumn(context, x, center, BAR_BASE, color, 0.42);
        this.applyEdgeFade(context);
      }
      return;
    }

    if (advance) this.advanceEnvelope(at);
    const staticLayout =
      this.options.mode === "static" || this.reducedMotion?.matches === true;
    for (let index = 0; index < this.columns.length; index++) {
      const column = this.columns[index]!;
      const x = staticLayout
        ? this.width - (this.columns.length - index) * BAR_STEP
        : this.width -
          ((at - column.at) * SCROLL_PIXELS_PER_SECOND) / 1000 -
          BAR_WIDTH;
      if (x + BAR_WIDTH < 0 || x > this.width) continue;
      this.drawColumn(
        context,
        x,
        center,
        this.barHeight(column.level),
        color,
        0.42 + column.level * 0.45,
      );
    }
    this.applyEdgeFade(context);
  }

  private advanceEnvelope(at: number): void {
    const previous = this.lastFrameAt;
    this.lastFrameAt = at;
    if (previous === undefined) return;
    const elapsed = Math.max(0, at - previous);
    if (elapsed > 500) {
      if (
        this.lastInputAt === undefined ||
        at - this.lastInputAt > STALE_AFTER_MS
      ) {
        this.displayedLevel = 0;
        this.targetLevel = 0;
      }
      return;
    }
    const target =
      this.lastInputAt !== undefined && at - this.lastInputAt > STALE_AFTER_MS
        ? 0
        : this.targetLevel;
    const timeConstant = target > this.displayedLevel ? 40 : 140;
    const fraction = 1 - Math.exp(-elapsed / timeConstant);
    this.displayedLevel += (target - this.displayedLevel) * fraction;
  }

  private barHeight(level: number): number {
    const maximum = this.height * 0.94;
    return Math.min(
      maximum,
      BAR_BASE + Math.sqrt(level) * Math.max(0, maximum - BAR_BASE),
    );
  }

  private drawColumn(
    context: CanvasRenderingContext2D,
    x: number,
    center: number,
    height: number,
    color: string,
    alpha: number,
  ): void {
    const y = center - height / 2;
    context.fillStyle = color;
    context.globalAlpha = alpha;
    context.beginPath();
    context.roundRect(x, y, BAR_WIDTH, height, Math.min(1.5, height / 2));
    context.fill();
    context.globalAlpha = 1;
  }

  private applyEdgeFade(context: CanvasRenderingContext2D): void {
    const fadeWidth = EDGE_FADE_WIDTH;
    if (!fadeWidth || this.width <= fadeWidth * 2) return;
    if (!this.fadeGradient) {
      const gradient = context.createLinearGradient(0, 0, this.width, 0);
      const fraction = Math.min(0.3, fadeWidth / this.width);
      gradient.addColorStop(0, "rgba(255,255,255,1)");
      gradient.addColorStop(fraction, "rgba(255,255,255,0)");
      gradient.addColorStop(1 - fraction, "rgba(255,255,255,0)");
      gradient.addColorStop(1, "rgba(255,255,255,1)");
      this.fadeGradient = gradient;
    }
    context.globalCompositeOperation = "destination-out";
    context.fillStyle = this.fadeGradient;
    context.fillRect(0, 0, this.width, this.height);
    context.globalCompositeOperation = "source-over";
  }

  private scheduleStaleClear(): void {
    this.cancelStaleTimer();
    if (!this.reducedMotion?.matches || this.lastInputAt === undefined) return;
    const remaining = Math.max(
      0,
      STALE_AFTER_MS - (performance.now() - this.lastInputAt),
    );
    this.staleTimer = setTimeout(() => {
      this.staleTimer = undefined;
      if (
        !this.active ||
        this.lastInputAt === undefined ||
        performance.now() - this.lastInputAt <= STALE_AFTER_MS
      )
        return;
      this.displayedLevel = 0;
      this.targetLevel = 0;
      this.draw(performance.now());
    }, remaining + 1);
  }

  private cancelAnimation(): void {
    if (this.animationFrame !== undefined) {
      cancelAnimationFrame(this.animationFrame);
      this.animationFrame = undefined;
    }
  }

  private cancelStaleTimer(): void {
    if (this.staleTimer !== undefined) {
      clearTimeout(this.staleTimer);
      this.staleTimer = undefined;
    }
  }

  private clear(): void {
    this.columns = [];
    this.targetLevel = 0;
    this.displayedLevel = 0;
    this.lastInputAt = undefined;
    this.lastFrameAt = undefined;
    this.lastColumnAt = undefined;
    this.cancelAnimation();
    this.cancelStaleTimer();
    this.context?.clearRect(0, 0, this.width, this.height);
    this.draw(performance.now());
  }
}
