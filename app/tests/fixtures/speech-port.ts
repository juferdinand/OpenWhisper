import { setImmediate as immediate } from "node:timers/promises";
import type { OriginalSpeechPort } from "../../src/services/speech/speech-transport.js";
import { speechChallengeRequestSchema } from "../../src/workers/speech-control.js";

/** Pure callbacks only: no child, native code, signal, or OS observation. */
export class InertSpeechPort implements OriginalSpeechPort {
  readonly sent: unknown[] = [];
  readonly spawns = new Set<(pid: unknown) => void>();
  readonly messages = new Set<(input: unknown) => void>();
  readonly exits = new Set<() => void>();
  readonly errors = new Set<() => void>();
  pid = 1234;
  autoChallenge = true;
  terminateCalls = 0;
  onPost: ((input: unknown) => void) | undefined;
  onTerminate: (() => Promise<void>) | undefined;
  onSpawn(listener: (pid: unknown) => void) { this.spawns.add(listener); return () => { this.spawns.delete(listener); }; }
  onMessage(listener: (input: unknown) => void) { this.messages.add(listener); return () => { this.messages.delete(listener); }; }
  onExit(listener: () => void) { this.exits.add(listener); return () => { this.exits.delete(listener); }; }
  onError(listener: () => void) { this.errors.add(listener); return () => { this.errors.delete(listener); }; }
  postMessage(input: unknown): void {
    this.sent.push(input); this.onPost?.(input);
    const challenge = speechChallengeRequestSchema.safeParse(input);
    if (challenge.success && this.autoChallenge) queueMicrotask(() => { this.reply(challenge.data); });
  }
  reply(input: unknown): void {
    const challenge = speechChallengeRequestSchema.parse(input);
    this.message({ version: 1, epoch: challenge.epoch, nonce: challenge.nonce, pid: this.pid });
  }
  message(input: unknown): void { for (const listener of this.messages) listener(input); }
  spawn(input: unknown = this.pid): void { for (const listener of this.spawns) listener(input); }
  ready(): void { this.message({ version: 1, type: "ready" }); }
  exit(): void { for (const listener of this.exits) listener(); }
  fail(): void { for (const listener of this.errors) listener(); }
  terminate(): Promise<void> { this.terminateCalls++; return this.onTerminate?.() ?? Promise.resolve(); }
}
export function deferred<T>() {
  let accept!: (value: T) => void, reject!: (cause: unknown) => void;
  const promise = new Promise<T>((resolve, fail) => { accept = resolve; reject = fail; });
  return { promise, accept, reject };
}
export const turn = () => immediate();
