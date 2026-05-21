import { command, computed, state } from "ccstate";
import { toast } from "@vm0/ui/components/ui/sonner";
import {
  zeroIntegrationsWhatsAppContract,
  type WhatsAppLinkStatusResponse,
  type WhatsAppStartLinkResponse,
} from "@vm0/api-contracts/contracts/zero-integrations-whatsapp";
import { zeroClient$ } from "../api-client.ts";
import { accept } from "../../lib/accept.ts";
import { setAblyLoop$ } from "../realtime.ts";

const internalReload$ = state(0);
const internalPhoneForm$ = state("");
const internalConnectDialogOpen$ = state(false);
const internalVerificationPhone$ = state<string | null>(null);
const internalShowPhoneError$ = state(false);

function normalizeWhatsAppHandle(value: string): string {
  return value.trim().replace(/[^\d+]/gu, "");
}

function isValidWhatsAppHandle(value: string): boolean {
  return /^\+[1-9]\d{7,14}$/u.test(value);
}

export const whatsAppPhoneForm$ = computed((get) => {
  return get(internalPhoneForm$);
});

export const whatsAppConnectDialogOpen$ = computed((get) => {
  return get(internalConnectDialogOpen$);
});

export const whatsAppVerificationPhone$ = computed((get) => {
  return get(internalVerificationPhone$);
});

export const whatsAppShowPhoneError$ = computed((get) => {
  return get(internalShowPhoneError$);
});

export const whatsAppPhoneFormNormalized$ = computed((get) => {
  return normalizeWhatsAppHandle(get(internalPhoneForm$));
});

export const whatsAppPhoneFormError$ = computed((get) => {
  const raw = get(internalPhoneForm$);
  if (!raw.trim()) {
    return null;
  }
  return isValidWhatsAppHandle(get(whatsAppPhoneFormNormalized$))
    ? null
    : "Enter a phone number with country code, like +1 555 555 1212.";
});

export const setWhatsAppPhoneForm$ = command(({ set }, value: string) => {
  set(internalPhoneForm$, value);
});

export const setWhatsAppConnectDialogOpen$ = command(
  ({ set }, value: boolean) => {
    set(internalConnectDialogOpen$, value);
  },
);

export const setWhatsAppVerificationPhone$ = command(
  ({ set }, value: string | null) => {
    set(internalVerificationPhone$, value);
  },
);

export const setWhatsAppShowPhoneError$ = command(({ set }, value: boolean) => {
  set(internalShowPhoneError$, value);
});

export const resetWhatsAppConnectUi$ = command(({ set }) => {
  set(internalPhoneForm$, "");
  set(internalVerificationPhone$, null);
  set(internalShowPhoneError$, false);
});

export const whatsAppLinkStatus$ = computed(
  async (get): Promise<WhatsAppLinkStatusResponse> => {
    get(internalReload$);
    const client = get(zeroClient$)(zeroIntegrationsWhatsAppContract, {
      apiBase: "api",
    });
    const result = await accept(client.getLinkStatus({ headers: {} }), [200], {
      toast: false,
    });
    return result.body;
  },
);

const reloadWhatsAppLinkStatus$ = command(({ set }) => {
  set(internalReload$, (prev) => {
    return prev + 1;
  });
});

export const startWhatsAppLink$ = command(
  async (
    { get, set },
    signal: AbortSignal,
  ): Promise<WhatsAppStartLinkResponse> => {
    const phoneHandle = get(whatsAppPhoneFormNormalized$);
    if (!isValidWhatsAppHandle(phoneHandle)) {
      throw new Error(
        "Enter a phone number with country code, like +1 555 555 1212.",
      );
    }

    const client = get(zeroClient$)(zeroIntegrationsWhatsAppContract, {
      apiBase: "api",
    });
    await accept(
      client.startLink({
        headers: {},
        body: { phoneHandle },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    set(reloadWhatsAppLinkStatus$);
    toast.success("Verification message sent");
    return { phoneHandle, verificationSent: true };
  },
);

export const waitForWhatsAppConnection$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<void> => {
    const current = await get(whatsAppLinkStatus$);
    signal.throwIfAborted();
    if (current.linked) {
      return;
    }

    const onWhatsAppChanged$ = command(
      async ({ get, set }, sig: AbortSignal) => {
        set(reloadWhatsAppLinkStatus$);
        const client = get(zeroClient$)(zeroIntegrationsWhatsAppContract, {
          apiBase: "api",
        });
        const result = await accept(
          client.getLinkStatus({
            headers: {},
            fetchOptions: { signal: sig },
          }),
          [200],
          { toast: false },
        );
        return result.body.linked;
      },
    );

    await set(setAblyLoop$, "whatsapp:changed", onWhatsAppChanged$, signal);
    toast.success("WhatsApp connected");
  },
);

export const disconnectWhatsApp$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<void> => {
    const client = get(zeroClient$)(zeroIntegrationsWhatsAppContract, {
      apiBase: "api",
    });
    await accept(
      client.unlink({
        headers: {},
        fetchOptions: { signal },
      }),
      [204],
    );
    signal.throwIfAborted();
    set(reloadWhatsAppLinkStatus$);
    toast.success("WhatsApp disconnected");
  },
);
