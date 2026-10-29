import { useSyncExternalStore } from "react";

const subscribe = () => () => {};

/** False while the server-rendered page has not hydrated yet, true after: forms stay inert until then (no native submit). */
export function useHydrated(): boolean {
  return useSyncExternalStore(subscribe, () => true, () => false);
}
