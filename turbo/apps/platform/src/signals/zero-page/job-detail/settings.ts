import { command, computed, state } from "ccstate";
import { toast } from "@vm0/ui/components/ui/sonner";
import { zeroAgentsByIdContract } from "@vm0/core";
import { throwIfAbort } from "../../utils.ts";
import { logger } from "../../log.ts";
import { zeroClient$ } from "../../api-client.ts";
import { zeroJobDetail$, fetchZeroJobDetail$ } from "./detail.ts";
import { reloadAgents$ } from "../agents-list.ts";

const L = logger("ZeroJobDetail");

// ---------------------------------------------------------------------------
// Settings: update agent metadata (displayName, sound)
// ---------------------------------------------------------------------------

const internalSaving$ = state(false);
export const zeroJobSettingsSaving$ = computed((get) => {
  return get(internalSaving$);
});

/** Reset saving state. */
export const resetSavingState$ = command(({ set }) => {
  set(internalSaving$, false);
});

/** Set saving state to true (used by connectors module). */
export const setSaving$ = command(({ set }, value: boolean) => {
  set(internalSaving$, value);
});

interface ZeroJobSettingsUpdate {
  displayName?: string;
  description?: string;
  sound?: string;
  avatarUrl?: string | null;
}

export const zeroJobUpdateSettings$ = command(
  async ({ get, set }, update: ZeroJobSettingsUpdate, signal: AbortSignal) => {
    const detail = get(zeroJobDetail$);
    if (!detail) {
      throw new Error("No compose detail found");
    }

    set(internalSaving$, true);
    try {
      const client = get(zeroClient$)(zeroAgentsByIdContract);
      const result = await client.updateMetadata({
        params: { id: detail.agentId },
        body: update,
      });
      signal.throwIfAborted();
      if (result.status !== 200) {
        const detail =
          result.status === 401 ||
          result.status === 403 ||
          result.status === 404
            ? result.body.error.message
            : `status ${result.status}`;
        throw new Error(`Save failed: ${detail}`);
      }

      await set(fetchZeroJobDetail$, signal);
      set(reloadAgents$);
      toast.success("Profile saved");
    } catch (error) {
      throwIfAbort(error);
      L.error("Failed to update settings:", error);
      toast.error(error instanceof Error ? error.message : "Save failed");
    } finally {
      set(internalSaving$, false);
    }
  },
);
