import type { BackendSelection } from "../../services/speech/backend-supervisor.js";

export interface GpuSelectionStatusSnapshot {
  readonly supported: boolean;
  readonly checked: boolean;
  readonly available: boolean;
  readonly fallback: boolean;
  readonly probeFailed: boolean;
  readonly device: string | null;
}

/** Keeps startup capability results separate from the current recording's fallback state. */
export class GpuSelectionStatus {
  private checked = false;
  private available = false;
  private fallback = false;
  private probeFailed = false;
  private device: string | null = null;

  constructor(private readonly supported: boolean, private readonly publish: (snapshot: GpuSelectionStatusSnapshot) => void) {}

  snapshot(): GpuSelectionStatusSnapshot {
    return { supported: this.supported, checked: this.checked, available: this.available,
      fallback: this.fallback, probeFailed: this.probeFailed, device: this.device };
  }

  resetRecordingFallback(): void {
    this.fallback = false;
    this.report();
  }

  discovered(selection: BackendSelection): void {
    if (!this.supported || !selection.requestedGpu) return;
    this.checked = true;
    this.available = selection.gpu && selection.detection === "device";
    this.fallback = false;
    this.probeFailed = selection.detection === "unavailable";
    this.device = selection.gpuDevice ?? null;
    this.report();
  }

  backendSelected(selection: BackendSelection): void {
    if (!this.supported || !selection.requestedGpu) return;
    this.checked = true;
    this.available = selection.gpu && selection.detection === "device";
    this.fallback = !selection.gpu;
    this.probeFailed = selection.detection === "unavailable";
    if (selection.gpuDevice) this.device = selection.gpuDevice;
    this.report();
  }

  adaptiveFallback(): void {
    if (!this.supported) return;
    this.checked = true;
    this.fallback = true;
    this.report();
  }

  private report(): void {
    if (!this.supported) return;
    try { this.publish(this.snapshot()); }
    catch { /* UI state cannot affect recording ownership. */ }
  }
}
