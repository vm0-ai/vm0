import { command, computed, state } from "ccstate";
import { toast } from "@vm0/ui/components/ui/sonner";
import { fetch$ } from "../fetch.ts";
import { zeroOnboardingStatus$ } from "./zero-onboarding.ts";
import { throwIfAbort } from "../utils.ts";
import { logger } from "../log.ts";
import { triggerAndPollComposeJob } from "../agent-detail/compose-job.ts";

const L = logger("ZeroMeet");

// ---------------------------------------------------------------------------
// Default agent compose
// ---------------------------------------------------------------------------

const zeroComposeId$ = computed(async (get) => {
  const status = await get(zeroOnboardingStatus$);
  return status.defaultAgentComposeId;
});

interface ZeroCompose {
  id: string;
  name: string;
  headVersionId: string | null;
  content: Record<string, unknown> | null;
}

const internalComposeReload$ = state(0);

const zeroCompose$ = computed(async (get) => {
  get(internalComposeReload$);
  const composeId = await get(zeroComposeId$);
  if (!composeId) {
    return null;
  }

  const fetchFn = get(fetch$);
  const resp = await fetchFn(`/api/agent/composes/${composeId}`);
  if (!resp.ok) {
    return null;
  }
  return (await resp.json()) as ZeroCompose;
});

// ---------------------------------------------------------------------------
// Settings: update agent name via compose content
// ---------------------------------------------------------------------------

const internalSaving$ = state(false);
export const zeroSettingsSaving$ = computed((get) => get(internalSaving$));

export const zeroUpdateSettings$ = command(
  async ({ get, set }, newName: string) => {
    const compose = await get(zeroCompose$);
    if (!compose?.content) {
      return;
    }

    const content = compose.content as {
      version: string;
      agents: Record<string, unknown>;
    };
    const oldName = Object.keys(content.agents)[0];
    if (!oldName) {
      return;
    }

    // Only update if name actually changed
    const nameChanged = oldName !== newName.toLowerCase();
    if (!nameChanged) {
      return;
    }

    set(internalSaving$, true);
    try {
      const agentConfig = content.agents[oldName];
      const newContent = {
        ...content,
        agents: { [newName.toLowerCase()]: agentConfig },
      };

      const fetchFn = get(fetch$);

      // Build the new compose via compose job
      const job = await triggerAndPollComposeJob(fetchFn, newContent);
      if (!job.result) {
        throw new Error("Build completed without result");
      }

      // Update default agent reference to the new compose
      const resp = await fetchFn("/api/scopes/default-agent", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentComposeId: job.result.composeId }),
      });

      if (!resp.ok) {
        const err = (await resp.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        throw new Error(
          err?.error?.message ?? `Failed to update: ${resp.statusText}`,
        );
      }

      set(internalComposeReload$, (x) => x + 1);
      toast.success("Settings saved");
    } catch (error) {
      throwIfAbort(error);
      L.error("Failed to update settings:", error);
      toast.error(error instanceof Error ? error.message : "Save failed");
    } finally {
      set(internalSaving$, false);
    }
  },
);
