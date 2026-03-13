import { command, computed, state } from "ccstate";
import { toast } from "@vm0/ui/components/ui/sonner";
import { fetch$ } from "../fetch.ts";
import { throwIfAbort } from "../utils.ts";
import { logger } from "../log.ts";

const L = logger("GitHubIntegration");

interface GitHubIntegrationData {
  installation: {
    id: string;
    installationId: string | null;
    status: string;
    targetName: string | null;
    targetType: string | null;
    isAdmin: boolean;
  };
  agent: { id: string; name: string; orgSlug: string } | null;
  environment: {
    requiredSecrets: string[];
    requiredVars: string[];
    missingSecrets: string[];
    missingVars: string[];
  };
}

interface GitHubIntegrationState {
  data: GitHubIntegrationData | null;
  loading: boolean;
  error: string | null;
  notLinked: boolean;
  installUrl: string | null;
  pendingApproval: boolean;
}

const githubIntegrationState$ = state<GitHubIntegrationState>({
  data: null,
  loading: false,
  error: null,
  notLinked: false,
  installUrl: null,
  pendingApproval: false,
});

export const githubIntegrationData$ = computed(
  (get) => get(githubIntegrationState$).data,
);
export const githubIntegrationLoading$ = computed(
  (get) => get(githubIntegrationState$).loading,
);
export const githubIntegrationNotLinked$ = computed(
  (get) => get(githubIntegrationState$).notLinked,
);
export const githubInstallUrl$ = computed(
  (get) => get(githubIntegrationState$).installUrl,
);
export const githubIntegrationPendingApproval$ = computed(
  (get) => get(githubIntegrationState$).pendingApproval,
);
export const githubIntegrationIsAdmin$ = computed(
  (get) => get(githubIntegrationState$).data?.installation.isAdmin ?? false,
);

export const fetchGitHubIntegration$ = command(async ({ get, set }) => {
  set(githubIntegrationState$, (prev) => ({
    ...prev,
    loading: true,
    error: null,
  }));

  try {
    const fetchFn = get(fetch$);
    const response = await fetchFn("/api/integrations/github");

    if (response.status === 404) {
      const body = (await response.json()) as {
        installUrl?: string | null;
      };
      set(githubIntegrationState$, {
        data: null,
        loading: false,
        error: null,
        notLinked: true,
        installUrl: body.installUrl ?? null,
        pendingApproval: false,
      });
      return;
    }

    if (!response.ok) {
      throw new Error(
        `Failed to fetch GitHub integration: ${response.statusText}`,
      );
    }

    const data = (await response.json()) as GitHubIntegrationData;
    set(githubIntegrationState$, {
      data,
      loading: false,
      error: null,
      notLinked: false,
      installUrl: null,
      pendingApproval: data.installation.status === "pending",
    });
  } catch (error) {
    throwIfAbort(error);
    L.error("Failed to fetch GitHub integration:", error);
    set(githubIntegrationState$, (prev) => ({
      ...prev,
      loading: false,
      error: error instanceof Error ? error.message : "Unknown error",
    }));
  }
});

const githubDisconnectDialogState$ = state(false);

export const githubDisconnectDialogOpen$ = computed((get) =>
  get(githubDisconnectDialogState$),
);

export const openGithubDisconnectDialog$ = command(({ set }) => {
  set(githubDisconnectDialogState$, true);
});

export const closeGithubDisconnectDialog$ = command(({ set }) => {
  set(githubDisconnectDialogState$, false);
});

export const updateGithubDefaultAgent$ = command(
  async ({ get, set }, agentName: string) => {
    // Optimistically update agent name so the UI doesn't flash a loading state
    set(githubIntegrationState$, (prev) => {
      if (!prev.data) {
        return prev;
      }
      return {
        ...prev,
        data: {
          ...prev.data,
          agent: prev.data.agent
            ? { ...prev.data.agent, name: agentName }
            : { id: "", name: agentName, orgSlug: "" },
        },
      };
    });

    const fetchFn = get(fetch$);
    const response = await fetchFn("/api/integrations/github", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentName }),
    });

    if (!response.ok) {
      toast.error("Failed to update default agent");
      // Re-fetch to revert optimistic update
      await set(fetchGitHubIntegration$);
      return;
    }

    toast.success(`Default agent updated to ${agentName}`);

    // Silently refresh to pick up updated environment status without loading spinner
    try {
      const refreshResponse = await fetchFn("/api/integrations/github");
      if (refreshResponse.ok) {
        const data = (await refreshResponse.json()) as GitHubIntegrationData;
        set(githubIntegrationState$, (prev) => ({
          ...prev,
          data,
        }));
      }
    } catch (error) {
      throwIfAbort(error);
      L.error("Failed to refresh after agent update:", error);
    }
  },
);

export const disconnectGithub$ = command(async ({ get, set }) => {
  const fetchFn = get(fetch$);
  const response = await fetchFn("/api/integrations/github", {
    method: "DELETE",
  });

  if (!response.ok) {
    throw new Error("Failed to disconnect GitHub");
  }

  // Re-fetch to get the updated state with install URL
  await set(fetchGitHubIntegration$);
});
