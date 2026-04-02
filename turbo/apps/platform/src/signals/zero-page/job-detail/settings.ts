import { command } from "ccstate";
import { zeroAgentsByIdContract } from "@vm0/core";
import { zeroClient$ } from "../../api-client.ts";
import { zeroJobDetail$, reloadJobDetail$ } from "./detail.ts";
import { reloadAgents$ } from "../agents-list.ts";

// ---------------------------------------------------------------------------
// Settings: update agent metadata (displayName, sound)
// ---------------------------------------------------------------------------

interface ZeroJobSettingsUpdate {
  displayName?: string;
  description?: string;
  sound?: string;
  avatarUrl?: string | null;
}

export const zeroJobUpdateSettings$ = command(
  async ({ get, set }, update: ZeroJobSettingsUpdate, signal: AbortSignal) => {
    const detail = await get(zeroJobDetail$);
    signal.throwIfAborted();
    if (!detail) {
      throw new Error("No compose detail found");
    }

    const client = get(zeroClient$)(zeroAgentsByIdContract);
    const result = await client.updateMetadata({
      params: { id: detail.agentId },
      body: update,
    });
    signal.throwIfAborted();
    if (result.status !== 200) {
      const detail =
        result.status === 401 || result.status === 403 || result.status === 404
          ? result.body.error.message
          : `status ${result.status}`;
      throw new Error(`Save failed: ${detail}`);
    }

    set(reloadJobDetail$);
    set(reloadAgents$);
  },
);
