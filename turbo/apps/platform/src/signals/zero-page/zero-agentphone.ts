import { command, computed, state } from "ccstate";
import { toast } from "@vm0/ui/components/ui/sonner";
import {
  zeroIntegrationsAgentPhoneContract,
  type AgentPhoneLinkStatusResponse,
  type AgentPhoneStartLinkResponse,
} from "@vm0/api-contracts/contracts/zero-integrations-agentphone";
import { zeroClient$ } from "../api-client.ts";
import { accept } from "../../lib/accept.ts";
import { setAblyLoop$ } from "../realtime.ts";

const internalReload$ = state(0);
const internalPhoneForm$ = state("");
const internalConnectDialogOpen$ = state(false);
const internalVerificationPhone$ = state<string | null>(null);
const internalShowPhoneError$ = state(false);

function normalizeAgentPhoneHandle(value: string): string {
  return value.trim().replace(/[^\d+]/gu, "");
}

function isValidAgentPhoneHandle(value: string): boolean {
  return /^\+[1-9]\d{7,14}$/u.test(value);
}

export const agentPhonePhoneForm$ = computed((get) => {
  return get(internalPhoneForm$);
});

export const agentPhoneConnectDialogOpen$ = computed((get) => {
  return get(internalConnectDialogOpen$);
});

export const agentPhoneVerificationPhone$ = computed((get) => {
  return get(internalVerificationPhone$);
});

export const agentPhoneShowPhoneError$ = computed((get) => {
  return get(internalShowPhoneError$);
});

export const agentPhonePhoneFormNormalized$ = computed((get) => {
  return normalizeAgentPhoneHandle(get(internalPhoneForm$));
});

export const agentPhonePhoneFormError$ = computed((get) => {
  const raw = get(internalPhoneForm$);
  if (!raw.trim()) {
    return null;
  }
  return isValidAgentPhoneHandle(get(agentPhonePhoneFormNormalized$))
    ? null
    : "Enter a phone number with country code, like +1 555 555 1212.";
});

export const setAgentPhonePhoneForm$ = command(({ set }, value: string) => {
  set(internalPhoneForm$, value);
});

export const setAgentPhoneConnectDialogOpen$ = command(
  ({ set }, value: boolean) => {
    set(internalConnectDialogOpen$, value);
  },
);

export const setAgentPhoneVerificationPhone$ = command(
  ({ set }, value: string | null) => {
    set(internalVerificationPhone$, value);
  },
);

export const setAgentPhoneShowPhoneError$ = command(
  ({ set }, value: boolean) => {
    set(internalShowPhoneError$, value);
  },
);

export const resetAgentPhoneConnectUi$ = command(({ set }) => {
  set(internalPhoneForm$, "");
  set(internalVerificationPhone$, null);
  set(internalShowPhoneError$, false);
});

export const agentPhoneLinkStatus$ = computed(
  async (get): Promise<AgentPhoneLinkStatusResponse> => {
    get(internalReload$);
    const client = get(zeroClient$)(zeroIntegrationsAgentPhoneContract, {
      apiBase: "api",
    });
    const result = await accept(client.getLinkStatus({ headers: {} }), [200], {
      toast: false,
    });
    return result.body;
  },
);

const reloadAgentPhoneLinkStatus$ = command(({ set }) => {
  set(internalReload$, (prev) => {
    return prev + 1;
  });
});

export const startAgentPhoneLink$ = command(
  async (
    { get, set },
    signal: AbortSignal,
  ): Promise<AgentPhoneStartLinkResponse> => {
    const phoneHandle = get(agentPhonePhoneFormNormalized$);
    if (!isValidAgentPhoneHandle(phoneHandle)) {
      throw new Error(
        "Enter a phone number with country code, like +1 555 555 1212.",
      );
    }

    const client = get(zeroClient$)(zeroIntegrationsAgentPhoneContract, {
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
    set(reloadAgentPhoneLinkStatus$);
    toast.success("Verification text sent");
    return { phoneHandle, verificationSent: true };
  },
);

export const waitForAgentPhoneConnection$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<void> => {
    const current = await get(agentPhoneLinkStatus$);
    signal.throwIfAborted();
    if (current.linked) {
      return;
    }

    const onAgentPhoneChanged$ = command(
      async ({ get, set }, sig: AbortSignal) => {
        set(reloadAgentPhoneLinkStatus$);
        const client = get(zeroClient$)(zeroIntegrationsAgentPhoneContract, {
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

    await set(setAblyLoop$, "agentphone:changed", onAgentPhoneChanged$, signal);
    toast.success("AgentPhone connected");
  },
);

export const disconnectAgentPhone$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<void> => {
    const client = get(zeroClient$)(zeroIntegrationsAgentPhoneContract, {
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
    set(reloadAgentPhoneLinkStatus$);
    toast.success("AgentPhone disconnected");
  },
);
