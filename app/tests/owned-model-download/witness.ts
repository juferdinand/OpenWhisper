import type { ClientRequest, IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import { FixtureError, type Component } from "./contracts.js";

interface Observed { readonly value: object; readonly close: Promise<void>; closed: boolean; errors: number }
/** Separate listeners observe originals; they never consume the response body. */
export class Witness {
  private readonly components: Record<Component, Observed[]> = { request: [], response: [], socket: [] };
  private readonly identities = new WeakSet<object>();
  observe(value: ClientRequest | IncomingMessage | Socket, component: Component): void {
    if (this.identities.has(value) || this.components[component].length >= 16) throw new FixtureError();
    this.identities.add(value);
    let accept!: () => void;
    const item: Observed = { value, closed: false, errors: 0, close: new Promise<void>((yes) => { accept = yes; }) };
    this.components[component].push(item);
    value.on("error", () => { item.errors++; });
    value.on("close", () => { if (item.closed) throw new FixtureError(); item.closed = true; accept(); });
  }
  snapshot(component: Component): Readonly<{ acquired: number; closed: number; errors: number }> {
    const items = this.components[component]; return { acquired: items.length, closed: items.filter((item) => item.closed).length,
      errors: items.reduce((n, item) => n + item.errors, 0) };
  }
  async closed(): Promise<void> {
    const owned = Object.values(this.components).flat(); await Promise.all(owned.map((item) => item.close));
    // Callers first await the retained request/driver receipt. Refuse a late
    // acquisition if that precondition was violated instead of certifying it.
    if (Object.values(this.components).flat().length !== owned.length) throw new FixtureError();
  }
}
/** Delays notification delivery only. The independent original close witness
 * remains active; this never claims a physically retained socket. */
export class NotificationGate {
  private callbacks: (() => void)[] = []; private released = false;
  observed = false;
  receive(callback: () => void): void {
    if (this.observed) throw new FixtureError(); this.observed = true;
    if (this.released) callback(); else this.callbacks.push(callback);
  }
  release(): void { this.released = true; for (const callback of this.callbacks.splice(0)) callback(); }
}
