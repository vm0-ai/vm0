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
const internalPhoneError$ = state<string | null>(null);
const internalPhoneInput$ = state("");
const internalSmsConsent$ = state(false);

// Exported computed (read-only)
export const phoneStatus$ = computed((get) => {
  return get(internalPhoneStatus$);
});
export const phoneError$ = computed((get) => {
  return get(internalPhoneError$);
});
export const phoneInput$ = computed((get) => {
  return get(internalPhoneInput$);
});
export const smsConsent$ = computed((get) => {
  return get(internalSmsConsent$);
});

// Exported commands (write)
export const setPhoneInput$ = command(({ set }, value: string) => {
  set(internalPhoneInput$, value);
});

export const setSmsConsent$ = command(({ set }, value: boolean) => {
  set(internalSmsConsent$, value);
});

export const fetchPhoneStatus$ = command(
  async ({ get, set }, signal: AbortSignal) => {
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
  },
);

export const savePhoneLink$ = command(
  async ({ get, set }, phoneNumber: string, signal: AbortSignal) => {
    set(internalPhoneError$, null);
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
  },
);

export const removePhoneLink$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    set(internalPhoneError$, null);
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
  },
);

export const requestOrgPhoneSetup$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    set(internalPhoneError$, null);
    const base = get(apiBase$);
    const clerk = await get(clerk$);
    signal.throwIfAborted();
    const token = await clerk.session?.getToken();
    signal.throwIfAborted();
    const headers: Record<string, string> = token
      ? { Authorization: `Bearer ${token}` }
      : {};
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
  },
);
