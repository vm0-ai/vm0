import { command, computed, state } from "ccstate";
import { apiBase$ } from "../fetch.ts";
import { clerk$ } from "../auth.ts";

interface PhoneStatus {
  userPhone: string | null;
  userPhonePending: string | null;
  orgPhone: string | null;
}

// Internal state
const internalPhoneStatus$ = state<PhoneStatus | null>(null);
const internalPhoneLoading$ = state(true);
const internalPhoneError$ = state<string | null>(null);
const internalPhoneSaving$ = state(false);
const internalPhoneSetupLoading$ = state(false);
const internalPhoneInput$ = state("");

// Exported computed (read-only)
export const phoneStatus$ = computed((get) => {
  return get(internalPhoneStatus$);
});
export const phoneLoading$ = computed((get) => {
  return get(internalPhoneLoading$);
});
export const phoneError$ = computed((get) => {
  return get(internalPhoneError$);
});
export const phoneSaving$ = computed((get) => {
  return get(internalPhoneSaving$);
});
export const phoneInput$ = computed((get) => {
  return get(internalPhoneInput$);
});
export const phoneSetupLoading$ = computed((get) => {
  return get(internalPhoneSetupLoading$);
});

// Exported commands (write)
export const setPhoneInput$ = command(({ set }, value: string) => {
  set(internalPhoneInput$, value);
});

export const fetchPhoneStatus$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    set(internalPhoneLoading$, true);
    try {
      const base = get(apiBase$);
      const clerk = await get(clerk$);
      signal.throwIfAborted();
      const token = await clerk.session?.getToken();
      signal.throwIfAborted();
      const headers: Record<string, string> = token
        ? { Authorization: `Bearer ${token}` }
        : {};
      const res = await globalThis.fetch(`${base}/api/zero/phone/status`, {
        headers,
        signal,
      });
      if (res.ok) {
        const data = (await res.json()) as PhoneStatus;
        set(internalPhoneStatus$, data);
      }
    } finally {
      set(internalPhoneLoading$, false);
    }
  },
);

export const savePhoneLink$ = command(
  async ({ get, set }, phoneNumber: string, signal: AbortSignal) => {
    set(internalPhoneError$, null);
    set(internalPhoneSaving$, true);
    try {
      const base = get(apiBase$);
      const clerk = await get(clerk$);
      signal.throwIfAborted();
      const token = await clerk.session?.getToken();
      signal.throwIfAborted();
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      };
      const res = await globalThis.fetch(`${base}/api/zero/phone/link`, {
        method: "POST",
        headers,
        body: JSON.stringify({ phoneNumber }),
        signal,
      });
      if (res.ok) {
        set(internalPhoneInput$, "");
        await set(fetchPhoneStatus$, signal);
      } else {
        const data = (await res.json()) as { error?: string };
        set(internalPhoneError$, data.error ?? "Failed to save phone number");
      }
    } finally {
      set(internalPhoneSaving$, false);
    }
  },
);

export const removePhoneLink$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    set(internalPhoneError$, null);
    set(internalPhoneSaving$, true);
    try {
      const base = get(apiBase$);
      const clerk = await get(clerk$);
      signal.throwIfAborted();
      const token = await clerk.session?.getToken();
      signal.throwIfAborted();
      const headers: Record<string, string> = token
        ? { Authorization: `Bearer ${token}` }
        : {};
      const res = await globalThis.fetch(`${base}/api/zero/phone/link`, {
        method: "DELETE",
        headers,
        signal,
      });
      if (res.ok) {
        await set(fetchPhoneStatus$, signal);
      } else {
        const data = (await res.json()) as { error?: string };
        set(internalPhoneError$, data.error ?? "Failed to remove phone number");
      }
    } finally {
      set(internalPhoneSaving$, false);
    }
  },
);

export const requestOrgPhoneSetup$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    set(internalPhoneSetupLoading$, true);
    set(internalPhoneError$, null);
    try {
      const base = get(apiBase$);
      const clerk = await get(clerk$);
      signal.throwIfAborted();
      const token = await clerk.session?.getToken();
      signal.throwIfAborted();
      const headers: Record<string, string> = {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      };
      const res = await globalThis.fetch(`${base}/api/zero/phone/setup`, {
        method: "POST",
        headers,
        signal,
      });
      if (res.ok) {
        await set(fetchPhoneStatus$, signal);
      } else {
        const data = (await res.json()) as { error?: string };
        set(internalPhoneError$, data.error ?? "Failed to set up phone");
      }
    } finally {
      set(internalPhoneSetupLoading$, false);
    }
  },
);
