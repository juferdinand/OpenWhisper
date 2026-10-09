import { randomUUID } from "node:crypto";
import type { BusEvent, BusFailureCode, BusFilter, BusMethod, BusReply } from "../../src/platforms/linux/shared/bus.js";
import type { BusValue } from "../../src/platforms/linux/shared/bus-values.js";

export const fixtureKey = "openwhisperOwnedPlatformEntryFixture";
export interface PlatformEntryFixture {
  buses: LinuxBus[];
  failSubscribe: boolean;
  exitCodes: number[];
  openingGate?: Promise<void>;
  subscriptionGate?: Promise<void>;
}
function fixture(): PlatformEntryFixture {
  const input: unknown = Reflect.get(process, fixtureKey);
  if (typeof input !== "object" || input === null || !Array.isArray(Reflect.get(input, "buses")) ||
      !Array.isArray(Reflect.get(input, "exitCodes")) || typeof Reflect.get(input, "failSubscribe") !== "boolean") {
    throw new Error("Owned platform fixture required.");
  }
  return input as PlatformEntryFixture;
}

/** Synthetic bus only. This fixture never opens a socket, display or native addon. */
export class LinuxBus {
  readonly uniqueName = ":1.5";
  readonly generation = randomUUID();
  isClosed = false;
  closeCount = 0;
  exportCount = 0;
  readonly calls: BusMethod[] = [];
  readonly subscriptions = new Map<BusFilter, (event: BusEvent) => void>();
  static async open(_binding: unknown, _address: string): Promise<LinuxBus> {
    const bus = new LinuxBus(), state = fixture(); state.buses.push(bus); await state.openingGate; return bus;
  }
  async owner(_name: string): Promise<string> { return ":1.8"; }
  async call(method: BusMethod): Promise<BusReply> {
    this.calls.push(method);
    let body: BusValue[] = [];
    if (method.member === "Get") body = [{ type: "v", signature: "u", value: { type: "u", value: 1 } }];
    if (method.member === "RequestName") body = [{ type: "u", value: 1 }];
    return { sender: method.destination, signature: method.outputSignature, body };
  }
  async subscribe(filter: BusFilter, callback: (event: BusEvent) => void): Promise<() => Promise<void>> {
    if (fixture().failSubscribe) throw new BusFailure("REMOTE_ERROR");
    this.subscriptions.set(filter, callback); await fixture().subscriptionGate;
    return async () => { this.subscriptions.delete(filter); };
  }
  async exportControl(_callback: (event: BusEvent) => void): Promise<void> { this.exportCount++; }
  async authorizeControl(_event: BusEvent): Promise<void> {}
  controlCurrent(_event: BusEvent): boolean { return false; }
  async reply(_id: string, _status: string): Promise<void> {}
  async reject(_id: string, _category: string): Promise<void> {}
  async close(): Promise<void> {
    if (this.isClosed) return;
    this.isClosed = true; this.closeCount++; this.subscriptions.clear();
  }
}
export class BusFailure extends Error {
  constructor(readonly code: BusFailureCode) { super("Synthetic session service failed."); }
}
export async function openLinuxBus(address: string): Promise<LinuxBus> { return LinuxBus.open(undefined, address); }
/** Records the entry's exit decision; actual OS retirement is covered by package checks. */
export function fixtureExit(code: number): void { fixture().exitCodes.push(code); }
