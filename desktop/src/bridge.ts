import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen as tauriListen } from "@tauri-apps/api/event";

type NativeWindow = Window & {
  webkit?: {
    messageHandlers?: {
      whisperfree?: { postMessage(message: unknown): Promise<unknown> };
    };
  };
};
const mac = (window as NativeWindow).webkit?.messageHandlers?.whisperfree;

/** Both apps render the same assets. Only this transport adapter knows the host toolkit. */
export async function invoke<T = unknown>(
  command: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  if (mac) return (await mac.postMessage({ command, args })) as T;
  return tauriInvoke<T>(command, args);
}
export async function listen<T>(
  name: string,
  handler: (event: { payload: T }) => void,
): Promise<() => void> {
  if (!mac) return tauriListen<T>(name, handler);
  const callback = (event: Event) =>
    handler({ payload: (event as CustomEvent<T>).detail });
  window.addEventListener(`whisperfree:${name}`, callback);
  return () => window.removeEventListener(`whisperfree:${name}`, callback);
}
