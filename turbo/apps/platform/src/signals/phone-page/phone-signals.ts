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
const internalPhoneVerifyStep$ = state<"phone" | "code">("phone");
const internalPhoneSending$ = state(false);
const internalPhoneInput$ = state("");
const internalCodeInput$ = state("");

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
export const phoneVerifyStep$ = computed((get) => {
  return get(internalPhoneVerifyStep$);
});
export const phoneSending$ = computed((get) => {
  return get(internalPhoneSending$);
});
export const phoneInput$ = computed((get) => {
  return get(internalPhoneInput$);
});
export const codeInput$ = computed((get) => {
  return get(internalCodeInput$);
});

// Exported commands (write)
export const setPhoneInput$ = command(({ set }, value: string) => {
  set(internalPhoneInput$, value);
});

export const setCodeInput$ = command(({ set }, value: string) => {
  set(internalCodeInput$, value);
});

export const setPhoneVerifyStep$ = command(
  ({ set }, step: "phone" | "code") => {
    set(internalPhoneVerifyStep$, step);
  },
);

export const setPhoneError$ = command(({ set }, error: string | null) => {
  set(internalPhoneError$, error);
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

export const sendPhoneVerifyCode$ = command(
  async ({ get, set }, phoneNumber: string, signal: AbortSignal) => {
    set(internalPhoneError$, null);
    set(internalPhoneSending$, true);
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
      const res = await globalThis.fetch(`${base}/api/zero/phone/verify/send`, {
        method: "POST",
        headers,
        body: JSON.stringify({ phoneNumber }),
        signal,
      });
      if (res.ok) {
        set(internalPhoneVerifyStep$, "code");
      } else {
        const data = (await res.json()) as { error?: string };
        set(internalPhoneError$, data.error ?? "Failed to send code");
      }
    } finally {
      set(internalPhoneSending$, false);
    }
  },
);

export const confirmPhoneVerifyCode$ = command(
  async (
    { get, set },
    params: { phoneNumber: string; code: string },
    signal: AbortSignal,
  ) => {
    set(internalPhoneError$, null);
    set(internalPhoneSending$, true);
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
      const res = await globalThis.fetch(
        `${base}/api/zero/phone/verify/confirm`,
        {
          method: "POST",
          headers,
          body: JSON.stringify(params),
          signal,
        },
      );
      if (res.ok) {
        set(internalPhoneVerifyStep$, "phone");
        await set(fetchPhoneStatus$, signal);
      } else {
        const data = (await res.json()) as { error?: string };
        set(internalPhoneError$, data.error ?? "Invalid code");
      }
    } finally {
      set(internalPhoneSending$, false);
    }
  },
);
