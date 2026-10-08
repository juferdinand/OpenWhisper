import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { z } from "zod";
import { backendIdentitySchema, backendObservationSchema, backendChallengeSchema,
  type BackendBindings, type ProvisionalBackendOwner, type RetirementBoundary } from "../../src/services/backend-supervisor.js";
import { speechRequestSchema } from "../../src/workers/speech-protocol.js";
import type { SpeechChannel } from "../../src/services/speech-client.js";
import type { Event } from "../owned-supervisor/contract.js";

export interface Receipt {
  pid: number; parentPid: number; uid: 1000; epoch: string; startTicks: string;
  nonceHashes: string[]; events: Event[]; genericExitObserved: boolean; leaseChecks: number;
}
/** Only process-boundary observation. No inventory/supervisor wrapper, clock,
 * reset, resource substitution or replacement retirement verdict. */
export function observeBindings(bindings: BackendBindings, whileLeased: () => Promise<void>) {
  const backends: string[] = [], receipts: Receipt[] = [], checks: Promise<void>[] = [];
  const effects: BackendBindings["effects"] = {
    verify(backend) { backends.push(backend); return bindings.effects.verify(backend); },
    async open(resource, epoch, signal) {
      const accepted = bindings.effects.open(resource, epoch, signal); const opened = await accepted;
      if (opened.kind !== "owner") return opened;
      const original = opened.owner, receipt: Receipt = { pid: original.pid, parentPid: process.pid, uid: 1000, epoch,
        startTicks: "", nonceHashes: [], events: [], genericExitObserved: false, leaseChecks: 0 };
      receipts.push(receipt);
      const note = (value: Event): void => { assert.ok(receipt.events.length < 128); receipt.events.push(value); };
      let bound: Promise<RetirementBoundary> | undefined;
      const owner: ProvisionalBackendOwner = Object.freeze({ pid: original.pid,
        challenge(nonce, challengedEpoch, cleanup) {
          const operation = original.challenge(nonce, challengedEpoch, cleanup);
          return operation.then((value) => { const parsed = backendChallengeSchema.parse(value);
            assert.equal(parsed.pid, original.pid); assert.equal(parsed.epoch, epoch); assert.equal(parsed.nonce, nonce);
            receipt.nonceHashes.push(createHash("sha256").update(nonce).digest("hex")); note("challenge"); return value; });
        },
        bindRetirement(challengedEpoch, cleanup) {
          if (!bound) {
            const operation = original.bindRetirement(challengedEpoch, cleanup);
            bound = operation.then((witness) => {
              const initial = z.strictObject({ level: z.literal("running"), canAdmit: z.literal(true), identity: backendIdentitySchema }).parse(witness.initial);
              const identity = initial.identity;
              assert.equal(identity.pid, original.pid); assert.equal(identity.parentPid, receipt.parentPid); assert.equal(identity.uid, receipt.uid);
              assert.equal(identity.birth.platform, "linux"); if (identity.birth.platform !== "linux") throw new Error("IDENTITY_FAILED");
              receipt.startTicks = identity.birth.startTicks.toString(); note("bind-running");
              return Object.freeze({ initial: witness.initial,
                get current() { const value = witness.current; if (value.level === "reaped") note("current-reaped"); return value; },
                async observe(next) { const operation = witness.observe(next); const value = await operation;
                  const observed = backendObservationSchema.parse(value); note(`observe-${observed.level}`); return value; },
                async waitForRetirement(next) { const operation = witness.waitForRetirement(next); await operation; note("wait-retired"); },
                async settleReads() { const operation = witness.settleReads(); await operation; note("reads-settled"); },
              } satisfies RetirementBoundary);
            }); void bound.catch(() => {});
          }
          return bound;
        },
        channel: Object.freeze({ send(value) {
          const command = speechRequestSchema.parse(value).command; note(`command-${command}`);
          if (command === "transcribe") {
            const checked = whileLeased().then(() => { receipt.leaseChecks++; }); checks.push(checked); void checked.catch(() => {});
          }
          original.channel.send(value);
        }, onMessage: (listener) => original.channel.onMessage(listener),
        onExit: (listener) => original.channel.onExit(() => { receipt.genericExitObserved = true; listener(); }),
        terminate() { note("terminate"); return original.channel.terminate(); },
        } satisfies SpeechChannel),
      } satisfies ProvisionalBackendOwner);
      return { kind: "owner", owner };
    },
  };
  return { bindings: Object.freeze({ ...bindings, effects: Object.freeze(effects) }), backends, receipts,
    settleChecks: async () => { await Promise.all(checks); } };
}
