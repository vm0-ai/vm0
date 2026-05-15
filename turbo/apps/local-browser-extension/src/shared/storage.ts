import type { ExtensionState } from "./protocol";

const STORAGE_KEY = "vm0.localBrowser";

function parseState(value: unknown): ExtensionState {
  if (typeof value !== "object" || value === null) {
    return {};
  }
  return value as ExtensionState;
}

export async function loadExtensionState(): Promise<ExtensionState> {
  const values = await chrome.storage.local.get(STORAGE_KEY);
  return parseState(values[STORAGE_KEY]);
}

export async function saveExtensionState(state: ExtensionState): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: state });
}

export async function patchExtensionState(
  patch: Partial<ExtensionState>,
): Promise<ExtensionState> {
  const current = await loadExtensionState();
  const next = { ...current, ...patch };
  await saveExtensionState(next);
  return next;
}

export async function clearExtensionState(): Promise<void> {
  await chrome.storage.local.remove(STORAGE_KEY);
}
