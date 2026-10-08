import { ControlClientError, type ControlOperationContext, type DevelopmentControlFactory, type DevelopmentControlPort } from "./control-client.js";
import { controlTarget, type ControlKind } from "./control-identity.js";
import { BusFailure, parseSessionBusAddress, type BusMethod, type LinuxBus } from "./bus.js";

const daemon = "org.freedesktop.DBus";
const daemonPath = "/org/freedesktop/DBus";
function current(context: ControlOperationContext): void {
  if (context.signal.aborted) throw new ControlClientError("CANCELLED");
  if (BigInt(context.expiresAtUs) <= process.hrtime.bigint() / 1000n) throw new ControlClientError("TIMEOUT");
}

/** Fixed session operations only; constructing the factory does not open a bus. */
export function createControlAdapter(options: { readonly kind: ControlKind; readonly address: unknown;
  readonly open: (address: string, context: ControlOperationContext) => Promise<LinuxBus> }): DevelopmentControlFactory {
  const target = controlTarget(options.kind);
  return async (context) => {
    current(context);
    let address: string;
    try { address = parseSessionBusAddress(options.address); }
    catch { throw new ControlClientError("NO_SESSION_BUS"); }
    let bus: LinuxBus;
    try { bus = await options.open(address, context); }
    catch (error: unknown) {
      if (error instanceof ControlClientError) throw error;
      throw new ControlClientError("SESSION_UNAVAILABLE");
    }
    try { current(context); }
    catch (error: unknown) { await bus.close(); throw error; }
    const frame = (sender: string, value: unknown) => Object.freeze({ generation: bus.generation, sender, value });
    const call = async (method: Omit<BusMethod, "timeoutMs">, operation: ControlOperationContext, category: "NOT_RUNNING" | "OWNER_UNVERIFIED" | "CONTROL_FAILED") => {
      current(operation);
      const remaining = Number((BigInt(operation.expiresAtUs) - process.hrtime.bigint() / 1000n + 999n) / 1000n);
      try {
        const reply = await bus.call({ ...method, timeoutMs: Math.max(1, Math.min(operation.timeoutMs, remaining)) }, operation.signal);
        current(operation);
        if (reply.body.length !== 1) throw new ControlClientError("INVALID_RESPONSE");
        const value = reply.body[0];
        if (!value || !((method.outputSignature === "s" && value.type === "s") ||
            (method.outputSignature === "u" && value.type === "u"))) throw new ControlClientError("INVALID_RESPONSE");
        if (value.type !== "s" && value.type !== "u") throw new ControlClientError("INVALID_RESPONSE");
        return frame(reply.sender, value.value);
      } catch (error: unknown) {
        if (error instanceof ControlClientError) throw error;
        if (error instanceof BusFailure && error.code === "INVALID_FRAME") throw new ControlClientError("INVALID_RESPONSE");
        throw new ControlClientError(category);
      }
    };
    const port: DevelopmentControlPort = {
      get generation() { return bus.generation; }, get isClosed() { return bus.isClosed; },
      async watchDevelopmentOwner(handler, operation) {
        current(operation);
        return bus.subscribe({ sender: daemon, path: daemonPath, interface: daemon, member: "NameOwnerChanged" }, (event) => {
          const [name, before, after] = event.body;
          if (event.signature !== "sss" || event.body.length !== 3 || name?.type !== "s" || before?.type !== "s" || after?.type !== "s") {
            handler(undefined); return;
          }
          // Unrelated daemon signals do not alter this transaction.
          if (name.value !== target.name && !name.value.startsWith(":")) return;
          handler({ generation: bus.generation, name: name.value, before: before.value, after: after.value });
        });
      },
      resolveDevelopmentOwner: (operation) => call({ destination: daemon, path: daemonPath, interface: daemon,
        member: "GetNameOwner", inputSignature: "s", outputSignature: "s", body: [{ type: "s", value: target.name }] }, operation, "NOT_RUNNING"),
      ownerUid: (owner, operation) => call({ destination: daemon, path: daemonPath, interface: daemon,
        member: "GetConnectionUnixUser", inputSignature: "s", outputSignature: "u", body: [{ type: "s", value: owner }] }, operation, "OWNER_UNVERIFIED"),
      readStatus: (owner, operation) => call({ destination: owner, path: target.path, interface: target.interface,
        member: "Status", inputSignature: "", outputSignature: "s", body: [] }, operation, "CONTROL_FAILED"),
      executeAction: (owner, action, operation) => call({ destination: owner, path: target.path, interface: target.interface,
        member: "Execute", inputSignature: "s", outputSignature: "s", body: [{ type: "s", value: action }] }, operation, "CONTROL_FAILED"),
      close: () => bus.close(),
    };
    return port;
  };
}
