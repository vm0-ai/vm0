import { command, computed, state } from "ccstate";
import {
  integrationsGithubContract,
  type CreateGithubLabelListenerBody,
  type GithubInstallationNotFoundResponse,
  type GithubInstallationResponse,
  type GithubLabelTriggerMode,
} from "@vm0/api-contracts/contracts/integrations-github";
import { toast } from "@vm0/ui/components/ui/sonner";
import { zeroClient$ } from "../api-client.ts";
import { accept } from "../../lib/accept.ts";

interface GithubIntegrationMissingData extends GithubInstallationNotFoundResponse {
  readonly isInstalled: false;
  readonly installation: null;
  readonly isConnected: false;
  readonly connectedGithubUserId: null;
  readonly connectUrl: string;
  readonly agent: null;
  readonly environment: GithubInstallationResponse["environment"];
  readonly labelListeners: readonly [];
}

export type GithubIntegrationData =
  | (GithubInstallationResponse & { readonly isInstalled: true })
  | GithubIntegrationMissingData;

export interface GithubLabelListenerForm {
  readonly labelName: string;
  readonly agentId: string;
  readonly triggerMode: GithubLabelTriggerMode;
  readonly prompt: string;
}

const internalReload$ = state(0);
const internalManageDialogOpen$ = state(false);
const internalLabelListenerForm$ = state<GithubLabelListenerForm>({
  labelName: "",
  agentId: "",
  triggerMode: "created_by_me",
  prompt: "",
});

function emptyEnvironment(): GithubInstallationResponse["environment"] {
  return {
    requiredSecrets: [],
    requiredVars: [],
    missingSecrets: [],
    missingVars: [],
  };
}

export const githubIntegrationData$ = computed(
  async (get): Promise<GithubIntegrationData> => {
    get(internalReload$);
    const client = get(zeroClient$)(integrationsGithubContract, {
      apiBase: "api",
    });
    const result = await accept(
      client.getInstallation({ headers: {} }),
      [200, 404],
      { toast: false },
    );

    if (result.status === 404) {
      return {
        ...result.body,
        isInstalled: false,
        installation: null,
        isConnected: false,
        connectedGithubUserId: null,
        connectUrl: "/connectors/github/connect",
        agent: null,
        environment: emptyEnvironment(),
        labelListeners: [],
      };
    }

    return { ...result.body, isInstalled: true };
  },
);

const reloadGithubIntegration$ = command(({ set }) => {
  set(internalReload$, (previous) => {
    return previous + 1;
  });
});

export const githubManageDialogOpen$ = computed((get) => {
  return get(internalManageDialogOpen$);
});

export const githubLabelListenerForm$ = computed((get) => {
  return get(internalLabelListenerForm$);
});

export const setGithubManageDialogOpen$ = command(({ set }, value: boolean) => {
  set(internalManageDialogOpen$, value);
});

export const setGithubLabelListenerForm$ = command(
  ({ set }, patch: Partial<GithubLabelListenerForm>) => {
    set(internalLabelListenerForm$, (previous) => {
      return { ...previous, ...patch };
    });
  },
);

export const resetGithubLabelListenerForm$ = command(({ set }) => {
  set(internalLabelListenerForm$, {
    labelName: "",
    agentId: "",
    triggerMode: "created_by_me",
    prompt: "",
  });
});

export const connectGithubInstallation$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<void> => {
    const client = get(zeroClient$)(integrationsGithubContract, {
      apiBase: "api",
    });
    await accept(
      client.connectUser({ headers: {}, fetchOptions: { signal } }),
      [200],
    );
    signal.throwIfAborted();
    set(reloadGithubIntegration$);
    toast.success("GitHub connected");
  },
);

export const disconnectGithubInstallation$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<void> => {
    const client = get(zeroClient$)(integrationsGithubContract, {
      apiBase: "api",
    });
    await accept(
      client.disconnectUser({ headers: {}, fetchOptions: { signal } }),
      [200],
    );
    signal.throwIfAborted();
    set(reloadGithubIntegration$);
    toast.success("GitHub disconnected");
  },
);

export const uninstallGithubInstallation$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<void> => {
    const client = get(zeroClient$)(integrationsGithubContract, {
      apiBase: "api",
    });
    await accept(
      client.deleteInstallation({ headers: {}, fetchOptions: { signal } }),
      [200],
    );
    signal.throwIfAborted();
    set(reloadGithubIntegration$);
    toast.success("GitHub installation removed");
  },
);

export const createGithubLabelListener$ = command(
  async (
    { get, set },
    body: CreateGithubLabelListenerBody,
    signal: AbortSignal,
  ): Promise<void> => {
    const client = get(zeroClient$)(integrationsGithubContract, {
      apiBase: "api",
    });
    await accept(
      client.createLabelListener({
        headers: {},
        body,
        fetchOptions: { signal },
      }),
      [201],
    );
    signal.throwIfAborted();
    set(reloadGithubIntegration$);
    toast.success("GitHub label listener added");
  },
);

export const deleteGithubLabelListener$ = command(
  async (
    { get, set },
    listenerId: string,
    signal: AbortSignal,
  ): Promise<void> => {
    const client = get(zeroClient$)(integrationsGithubContract, {
      apiBase: "api",
    });
    await accept(
      client.deleteLabelListener({
        headers: {},
        params: { listenerId },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    set(reloadGithubIntegration$);
    toast.success("GitHub label listener removed");
  },
);

export const initGithubIntegration$ = command(({ set }) => {
  const params = new URLSearchParams(window.location.search);
  const status = params.get("github");
  if (status === "installed") {
    toast.success("GitHub installed successfully");
    set(reloadGithubIntegration$);
    window.history.replaceState({}, "", window.location.pathname);
  } else if (status === "connected") {
    toast.success("GitHub connected successfully");
    set(reloadGithubIntegration$);
    window.history.replaceState({}, "", window.location.pathname);
  } else if (status === "pending") {
    toast.success("GitHub installation request sent");
    window.history.replaceState({}, "", window.location.pathname);
  }
});

export type { GithubLabelTriggerMode };
