import { command, computed, state } from "ccstate";
import { fetch$ } from "../fetch.ts";
import { throwIfAbort } from "../utils.ts";
import { logger } from "../log.ts";

const L = logger("GitHubIntegration");

interface GitHubIntegrationData {
  installation: { id: string; installationId: string };
  agent: { id: string; name: string; scopeSlug: string } | null;
}

interface GitHubIntegrationState {
  data: GitHubIntegrationData | null;
  loading: boolean;
  error: string | null;
  notLinked: boolean;
  installUrl: string | null;
}

const githubIntegrationState$ = state<GitHubIntegrationState>({
  data: null,
  loading: false,
  error: null,
  notLinked: false,
  installUrl: null,
});

export const githubIntegrationLoading$ = computed(
  (get) => get(githubIntegrationState$).loading,
);
export const githubIntegrationNotLinked$ = computed(
  (get) => get(githubIntegrationState$).notLinked,
);
export const githubInstallUrl$ = computed(
  (get) => get(githubIntegrationState$).installUrl,
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
