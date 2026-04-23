import { command, computed, state } from "ccstate";
import {
  zeroPhoneStatusContract,
  zeroPhoneLinkContract,
  zeroPhoneSetupContract,
  type PhoneStatusResponse,
} from "@vm0/core/contracts/zero-phone";
import { zeroClient$ } from "../api-client.ts";

// Internal state
const internalPhoneStatus$ = state<PhoneStatusResponse | null>(null);
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
    const client = get(zeroClient$)(zeroPhoneStatusContract);
    signal.throwIfAborted();
    const result = await client.getStatus({ fetchOptions: { signal } });
    signal.throwIfAborted();
    if (result.status === 200) {
      set(internalPhoneStatus$, result.body);
    }
  },
);

export const savePhoneLink$ = command(
  async ({ get, set }, phoneNumber: string, signal: AbortSignal) => {
    set(internalPhoneError$, null);
    const client = get(zeroClient$)(zeroPhoneLinkContract);
    signal.throwIfAborted();
    const result = await client.link({
      body: { phoneNumber },
      fetchOptions: { signal },
    });
    signal.throwIfAborted();
    if (result.status === 200) {
      set(internalPhoneInput$, "");
      await set(fetchPhoneStatus$, signal);
    } else {
      const data = result.body as { error?: string };
      set(internalPhoneError$, data.error ?? "Failed to save phone number");
    }
  },
);

export const removePhoneLink$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    set(internalPhoneError$, null);
    const client = get(zeroClient$)(zeroPhoneLinkContract);
    signal.throwIfAborted();
    const result = await client.unlink({ fetchOptions: { signal } });
    signal.throwIfAborted();
    if (result.status === 200) {
      await set(fetchPhoneStatus$, signal);
    } else {
      const data = result.body as { error?: string };
      set(internalPhoneError$, data.error ?? "Failed to remove phone number");
    }
  },
);

export const requestOrgPhoneSetup$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    set(internalPhoneError$, null);
    const client = get(zeroClient$)(zeroPhoneSetupContract);
    signal.throwIfAborted();
    const result = await client.setup({ fetchOptions: { signal } });
    signal.throwIfAborted();
    if (result.status === 200) {
      await set(fetchPhoneStatus$, signal);
    } else {
      const data = result.body as { error?: string };
      set(internalPhoneError$, data.error ?? "Failed to set up phone");
    }
  },
);
