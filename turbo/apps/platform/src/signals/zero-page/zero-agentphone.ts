import { command, computed, state } from "ccstate";
import { toast } from "@vm0/ui/components/ui/sonner";
import {
  zeroIntegrationsAgentPhoneContract,
  type AgentPhoneLinkStatusResponse,
  type AgentPhoneStartLinkResponse,
} from "@vm0/api-contracts/contracts/zero-integrations-agentphone";
import { zeroClient$ } from "../api-client.ts";
import { accept } from "../../lib/accept.ts";

const internalReload$ = state(0);
const internalPhoneForm$ = state("");

function normalizeAgentPhoneHandle(value: string): string {
  return value.trim().replace(/[^\d+]/gu, "");
}

export const agentPhonePhoneForm$ = computed((get) => {
  return get(internalPhoneForm$);
});

export const agentPhonePhoneFormNormalized$ = computed((get) => {
  return normalizeAgentPhoneHandle(get(internalPhoneForm$));
});

export const agentPhonePhoneFormError$ = computed((get) => {
  const raw = get(internalPhoneForm$);
  if (!raw.trim()) {
    return null;
  }
  return get(agentPhonePhoneFormNormalized$)
    ? null
    : "Enter a valid phone number.";
});

export const setAgentPhonePhoneForm$ = command(({ set }, value: string) => {
  set(internalPhoneForm$, value);
});

export const resetAgentPhoneSettingsUi$ = command(({ set }) => {
  set(internalPhoneForm$, "");
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

export const reloadAgentPhoneLinkStatus$ = command(({ set }) => {
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
    if (!phoneHandle) {
      throw new Error("Enter a valid phone number.");
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
