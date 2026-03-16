import { command, computed, state } from "ccstate";
import { toast } from "@vm0/ui/components/ui/sonner";
import { fetch$ } from "../fetch.ts";

interface SlackOrgData {
  isConnected: boolean;
  isInstalled?: boolean;
  workspaceName: string | null;
  isAdmin: boolean;
  installUrl?: string | null;
  connectUrl?: string | null;
  defaultAgentName: string | null;
  agentOrgSlug: string | null;
  environment: {
    requiredSecrets: string[];
    requiredVars: string[];
    missingSecrets: string[];
    missingVars: string[];
  };
}

interface SlackOrgState {
  data: SlackOrgData | null;
  loading: boolean;
  error: string | null;
}

const slackOrgState$ = state<SlackOrgState>({
  data: null,
  loading: false,
  error: null,
});

export const slackOrgData$ = computed((get) => get(slackOrgState$).data);

const fetchSlackOrg$ = command(async ({ get, set }) => {
  set(slackOrgState$, (prev) => ({
    ...prev,
    loading: true,
    error: null,
  }));

  const fetchFn = get(fetch$);
  const response = await fetchFn("/api/integrations/slack/org");

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as {
      error?: { message?: string };
    };
    const errorMsg = body.error?.message ?? "Failed to fetch Slack status";
    set(slackOrgState$, (prev) => ({
      ...prev,
      loading: false,
      error: errorMsg,
    }));
    return;
  }

  const data = (await response.json()) as SlackOrgData;
  set(slackOrgState$, {
    data,
    loading: false,
    error: null,
  });
});

export const disconnectSlackOrg$ = command(async ({ get, set }) => {
  const fetchFn = get(fetch$);
  const response = await fetchFn("/api/integrations/slack/org", {
    method: "DELETE",
  });

  if (!response.ok) {
    toast.error("Failed to disconnect Slack");
    return;
  }

  await set(fetchSlackOrg$);
});

export const uninstallSlackOrg$ = command(async ({ get, set }) => {
  const fetchFn = get(fetch$);
  const response = await fetchFn(
    "/api/integrations/slack/org?action=uninstall",
    { method: "DELETE" },
  );

  if (!response.ok) {
    toast.error("Failed to uninstall Slack");
    return;
  }

  toast.success("Slack workspace uninstalled");
  await set(fetchSlackOrg$);
});

export const initSlackOrg$ = command(async ({ set }) => {
  await set(fetchSlackOrg$);

  const params = new URLSearchParams(window.location.search);
  if (params.get("installed") === "1") {
    toast.success("Slack installed successfully");
    window.history.replaceState({}, "", window.location.pathname);
  }
  if (params.get("connected") === "1") {
    toast.success("Slack connected successfully");
    window.history.replaceState({}, "", window.location.pathname);
  }
  if (params.get("error")) {
    toast.error(params.get("error")!);
    window.history.replaceState({}, "", window.location.pathname);
  }
});
