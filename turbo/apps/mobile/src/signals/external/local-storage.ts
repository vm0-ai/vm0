import { command, computed, state, type Getter } from "ccstate";
import { jsonParseOr } from "../utils.ts";

/**
 * Signal pair backed by AsyncStorage.
 *
 * Mirrors platform's localStorageSignals pattern, using React Native's
 * AsyncStorage (synchronous on iOS via MMKV when available, async otherwise).
 * For now, uses a runtime polyfill — swap to expo-secure-store or MMKV
 * when the native layer is ready.
 */

// In-memory fallback until AsyncStorage native module is linked
const memoryStore = new Map<string, string>();

const storageReload$ = state(0);

/**
 * Create a signal pair persisted to the given storage key.
 */
export function localStorageSignals(key: string) {
  const get$ = computed((get): string | undefined => {
    get(storageReload$);
    const raw = memoryStore.get(key);
    return raw ?? undefined;
  });

  const set$ = command(({ set }, value: string | undefined) => {
    if (value === undefined) {
      memoryStore.delete(key);
    } else {
      memoryStore.set(key, value);
    }
    set(storageReload$, (prev) => {
      return prev + 1;
    });
  });

  const getJSON$ = computed(<T>(get: Getter): T | undefined => {
    const raw = get(get$);
    if (raw === undefined) {
      return undefined;
    }
    return jsonParseOr<T>(raw, undefined as unknown as T);
  });

  const setJSON$ = command(({ set }, value: unknown) => {
    set(set$, JSON.stringify(value));
  });

  return { get$, set$, getJSON$, setJSON$ };
}
