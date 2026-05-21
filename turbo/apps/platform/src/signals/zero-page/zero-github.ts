import { command, computed, state } from "ccstate";
import {
  integrationsGithubContract,
  type CreateGithubLabelListenerBody,
  type GithubInstallationNotFoundResponse,
  type GithubInstallationResponse,
  type GithubLabelTriggerMode,
  type UpdateGithubLabelListenerBody,
} from "@vm0/api-contracts/contracts/integrations-github";
import { toast } from "@vm0/ui/components/ui/sonner";
import { zeroClient$ } from "../api-client.ts";
import { accept } from "../../lib/accept.ts";
import { setAblyLoop$ } from "../realtime.ts";

interface GithubIntegrationMissingData extends GithubInstallationNotFoundResponse {
  readonly isInstalled: false;
  readonly installation: null;
  readonly isConnected: false;
  readonly connectedGithubUserId: null;
  readonly connectedGithubUsername: null;
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

interface UpdateGithubLabelListenerInput {
  readonly listenerId: string;
  readonly body: UpdateGithubLabelListenerBody;
}

interface GithubIntegrationStatus {
  readonly isInstalled: boolean;
  readonly isConnected: boolean;
}

const internalReload$ = state(0);
const internalAddListenerDialogOpen$ = state(false);
const internalGithubIntegrationStatus$ = state<GithubIntegrationStatus | null>(
  null,
);
const internalLabelListenerForm$ = state<GithubLabelListenerForm>({
  labelName: "",
  agentId: "",
  triggerMode: "created_by_me",
  prompt: "",
});

const GITHUB_CHANGED_TOPIC = "github:changed";

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
        connectedGithubUsername: null,
        connectUrl: "https://github.com/login/oauth/authorize",
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

function githubIntegrationStatus(
  data: GithubIntegrationData,
): GithubIntegrationStatus {
  return {
    isInstalled: data.isInstalled,
    isConnected: data.isConnected,
  };
}

function hasGithubIntegrationStatusChanged(
  previous: GithubIntegrationStatus | null,
  next: GithubIntegrationStatus,
): previous is GithubIntegrationStatus {
  return (
    previous !== null &&
    (previous.isInstalled !== next.isInstalled ||
      previous.isConnected !== next.isConnected)
  );
}

function toastGithubIntegrationChange(
  previous: GithubIntegrationStatus,
  next: GithubIntegrationStatus,
): void {
  if (next.isConnected && !previous.isConnected) {
    toast.success("GitHub connected successfully");
    return;
  }
  if (next.isInstalled && !previous.isInstalled) {
    toast.success("GitHub installed successfully");
    return;
  }
  if (!next.isInstalled && previous.isInstalled) {
    toast.success("GitHub installation removed");
    return;
  }
  if (!next.isConnected && previous.isConnected) {
    toast.success("GitHub disconnected");
    return;
  }
  toast.success("GitHub updated");
}

export const githubLabelListenerForm$ = computed((get) => {
  return get(internalLabelListenerForm$);
});

export const githubAddListenerDialogOpen$ = computed((get) => {
  return get(internalAddListenerDialogOpen$);
});

export const setGithubAddListenerDialogOpen$ = command(
  ({ set }, open: boolean) => {
    set(internalAddListenerDialogOpen$, open);
  },
);

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

function isStandaloneMode(): boolean {
  return window.matchMedia?.("(display-mode: standalone)").matches ?? false;
}

function openGithubOAuthWindow(): Pick<Window, "closed" | "location"> {
  const standalone = isStandaloneMode();
  const popupFeatures = standalone ? undefined : "width=600,height=700";
  const authWindow = window.open("about:blank", "_blank", popupFeatures);

  if (!authWindow && !standalone) {
    throw new Error("Failed to open authorization window");
  }

  if (authWindow) {
    return authWindow;
  }

  return window;
}

const refreshGithubIntegrationFromChange$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<boolean> => {
    const previous = get(internalGithubIntegrationStatus$);
    set(reloadGithubIntegration$);
    const data = await get(githubIntegrationData$);
    signal.throwIfAborted();
    const next = githubIntegrationStatus(data);
    set(internalGithubIntegrationStatus$, next);

    if (hasGithubIntegrationStatusChanged(previous, next)) {
      toastGithubIntegrationChange(previous, next);
    }

    return false;
  },
);

export const watchGithubIntegration$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<void> => {
    const current = await get(githubIntegrationData$);
    signal.throwIfAborted();
    set(internalGithubIntegrationStatus$, githubIntegrationStatus(current));

    await set(
      setAblyLoop$,
      GITHUB_CHANGED_TOPIC,
      refreshGithubIntegrationFromChange$,
      signal,
    );
  },
);

export const connectGithubInstallation$ = command(
  (_ctx, connectUrl: string, signal: AbortSignal): void => {
    signal.throwIfAborted();
    const authWindow = openGithubOAuthWindow();
    const fresh = new URL(connectUrl, window.location.origin);
    fresh.searchParams.set("_t", String(Date.now()));
    authWindow.location.href = fresh.toString();
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

export const updateGithubLabelListener$ = command(
  async (
    { get, set },
    input: UpdateGithubLabelListenerInput,
    signal: AbortSignal,
  ): Promise<void> => {
    const client = get(zeroClient$)(integrationsGithubContract, {
      apiBase: "api",
    });
    await accept(
      client.updateLabelListener({
        headers: {},
        params: { listenerId: input.listenerId },
        body: input.body,
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    set(reloadGithubIntegration$);
    toast.success("GitHub label listener updated");
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
