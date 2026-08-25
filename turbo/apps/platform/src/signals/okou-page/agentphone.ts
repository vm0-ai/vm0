import { command, computed, state } from "ccstate";
import { toast } from "@okouai/ui/components/ui/sonner";
import {
  integrationsAgentPhoneContract,
  type AgentPhoneLinkStatusResponse,
  type AgentPhoneStartLinkResponse,
} from "@okouai/api-contracts/contracts/integrations-agentphone";
import { apiClient$ } from "../api-client.ts";
import { accept } from "../../lib/accept.ts";
import { setAblyLoop$ } from "../realtime.ts";
import { i18n } from "../../i18n/index.ts";

const internalReload$ = state(0);
const internalPhoneForm$ = state("");
const internalConnectDialogOpen$ = state(false);
const internalConnectDialogCloseComplete$ = state(true);
const internalVerificationPhone$ = state<string | null>(null);
const internalShowPhoneError$ = state(false);
const internalAgentPhoneStatus$ = state<AgentPhoneLinkStatusResponse | null>(
  null,
);

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
    : i18n.t(($) => {
        return $.connectors.providerSettings.errors.agentphonePhone;
      });
});

export const setAgentPhonePhoneForm$ = command(({ set }, value: string) => {
  set(internalPhoneForm$, value);
});

export const resetAgentPhoneConnectUi$ = command(({ set }) => {
  set(internalPhoneForm$, "");
  set(internalVerificationPhone$, null);
  set(internalShowPhoneError$, false);
});

export const setAgentPhoneConnectDialogOpen$ = command(
  ({ get, set }, value: boolean) => {
    const connecting =
      get(internalVerificationPhone$) !== null &&
      get(internalAgentPhoneStatus$)?.linked !== true;
    if (value && !connecting) {
      set(resetAgentPhoneConnectUi$);
    }
    if (value) {
      set(internalConnectDialogCloseComplete$, false);
    }
    set(internalConnectDialogOpen$, value);
  },
);

export const completeAgentPhoneConnectDialogClose$ = command(({ get, set }) => {
  if (get(internalConnectDialogOpen$)) {
    return;
  }
  set(internalConnectDialogCloseComplete$, true);
  if (get(internalAgentPhoneStatus$)?.linked) {
    set(resetAgentPhoneConnectUi$);
  }
});

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

export const agentPhoneLinkStatus$ = computed(
  async (get): Promise<AgentPhoneLinkStatusResponse> => {
    get(internalReload$);
    const client = get(apiClient$)(integrationsAgentPhoneContract, {
      apiBase: "api",
    });
    const result = await accept(client.getLinkStatus({ headers: {} }), [200]);
    return result.body;
  },
);

const reloadAgentPhoneLinkStatus$ = command(({ set }) => {
  set(internalReload$, (prev) => {
    return prev + 1;
  });
});

function hasAgentPhoneStatusChanged(
  previous: AgentPhoneLinkStatusResponse | null,
  next: AgentPhoneLinkStatusResponse,
): previous is AgentPhoneLinkStatusResponse {
  return previous !== null && previous.linked !== next.linked;
}

function toastAgentPhoneStatusChange(
  previous: AgentPhoneLinkStatusResponse,
  next: AgentPhoneLinkStatusResponse,
): void {
  if (next.linked && !previous.linked) {
    toast.success(
      i18n.t(($) => {
        return $.connectors.providerSettings.toasts.agentphoneConnected;
      }),
    );
    return;
  }
  if (!next.linked && previous.linked) {
    toast.success(
      i18n.t(($) => {
        return $.connectors.providerSettings.toasts.agentphoneDisconnected;
      }),
    );
  }
}

const refreshAgentPhoneFromChange$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<boolean> => {
    const previous = get(internalAgentPhoneStatus$);
    set(reloadAgentPhoneLinkStatus$);
    const data = await get(agentPhoneLinkStatus$);
    signal.throwIfAborted();
    set(internalAgentPhoneStatus$, data);

    if (hasAgentPhoneStatusChanged(previous, data)) {
      toastAgentPhoneStatusChange(previous, data);
      if (data.linked) {
        set(internalConnectDialogOpen$, false);
        if (get(internalConnectDialogCloseComplete$)) {
          set(resetAgentPhoneConnectUi$);
        }
      } else {
        set(resetAgentPhoneConnectUi$);
      }
    }

    return false;
  },
);

export const watchAgentPhoneConnection$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<void> => {
    const current = await get(agentPhoneLinkStatus$);
    signal.throwIfAborted();
    set(internalAgentPhoneStatus$, current);
    await set(
      setAblyLoop$,
      {
        topic: "agentphone:changed",
        loopCommand$: refreshAgentPhoneFromChange$,
      },
      signal,
    );
  },
);

export const startAgentPhoneLink$ = command(
  async (
    { get, set },
    signal: AbortSignal,
  ): Promise<AgentPhoneStartLinkResponse> => {
    const phoneHandle = get(agentPhonePhoneFormNormalized$);
    if (!isValidAgentPhoneHandle(phoneHandle)) {
      throw new Error(
        i18n.t(($) => {
          return $.connectors.providerSettings.errors.agentphonePhone;
        }),
      );
    }

    const client = get(apiClient$)(integrationsAgentPhoneContract, {
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
    toast.success(
      i18n.t(($) => {
        return $.connectors.providerSettings.toasts.agentphoneVerificationSent;
      }),
    );
    return { phoneHandle, verificationSent: true };
  },
);

export const disconnectAgentPhone$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<void> => {
    const client = get(apiClient$)(integrationsAgentPhoneContract, {
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
    set(resetAgentPhoneConnectUi$);
  },
);
