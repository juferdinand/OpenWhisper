/** Narrow adapter for Electron utility-process message ports. Calls retain Electron's port receiver. */
export interface WorkerParentPort<Outbound = unknown> {
  on(event: "message", listener: (event: { data: unknown }) => void): void;
  on(event: "close", listener: () => void): void;
  postMessage(value: Outbound): void;
}

export function workerParentPort<Outbound = unknown>(unavailableMessage: string): WorkerParentPort<Outbound> {
  const parent: unknown = Reflect.get(process, "parentPort");
  if (typeof parent !== "object" || parent === null) throw new Error(unavailableMessage);
  const on: unknown = Reflect.get(parent, "on"), postMessage: unknown = Reflect.get(parent, "postMessage");
  if (typeof on !== "function" || typeof postMessage !== "function") throw new Error(unavailableMessage);
  return {
    on: (event, listener) => { Reflect.apply(on, parent, [event, listener]); },
    postMessage: (value: Outbound) => { Reflect.apply(postMessage, parent, [value]); },
  };
}
