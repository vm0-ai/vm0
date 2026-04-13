import { command, computed, state } from "ccstate";
import { zeroVoiceChatPrepareTriggerContract } from "@vm0/core";
import { zeroClient$ } from "../api-client.ts";
import { defaultAgentId$ } from "../agent.ts";
import { accept, ApiError } from "../../lib/accept.ts";
import { setLoop, throwIfAbort } from "../utils.ts";

type PreparationStatus = "idle" | "preparing" | "ready" | "failed";

const POLL_INTERVAL_MS = 5000;

// --- Internal state ---

const internalPrepStatus$ = state<PreparationStatus>("idle");
const internalPrepPrompt$ = state<string | null>(null);
const internalPrepStartTime$ = state<number | null>(null);

// --- Exported computed ---

export const meetingPrepStatus$ = computed((get) => {
  return get(internalPrepStatus$);
});

export const meetingPrepPrompt$ = computed((get) => {
  return get(internalPrepPrompt$);
});

export const meetingPrepStartTime$ = computed((get) => {
  return get(internalPrepStartTime$);
});

// --- Commands ---

export const triggerPreparation$ = command(
  async ({ get, set }, prompt: string, signal: AbortSignal) => {
    const createClient = get(zeroClient$);
    const client = createClient(zeroVoiceChatPrepareTriggerContract);
    const agentId = await get(defaultAgentId$);
    signal.throwIfAborted();

    if (!agentId) {
      set(internalPrepStatus$, "failed");
      return;
    }

    set(internalPrepStatus$, "preparing");
    set(internalPrepPrompt$, prompt);
    set(internalPrepStartTime$, Date.now());

    let initialStatus: string;
    // eslint-disable-next-line no-restricted-syntax -- accept() throws on non-200; must catch to transition to "failed" state instead of leaving "preparing" forever
    try {
      const res = await accept(
        client.trigger({ body: { agentId, mode: "meeting", prompt } }),
        [200],
        { toast: false },
      );
      signal.throwIfAborted();
      initialStatus = res.body.preparation.status;
    } catch (error) {
      throwIfAbort(error);
      if (error instanceof ApiError) {
        set(internalPrepStatus$, "failed");
        return;
      }
      throw error;
    }

    if (initialStatus === "ready") {
      set(internalPrepStatus$, "ready");
      return;
    }

    // Poll until ready or failed.
    // setLoop handles transient errors (including ApiError from accept())
    // with fibonacci backoff retry.
    await setLoop(
      async (loopSignal: AbortSignal) => {
        const pollRes = await accept(
          client.trigger({ body: { agentId, mode: "meeting", prompt } }),
          [200],
          { toast: false },
        );
        loopSignal.throwIfAborted();

        if (pollRes.body.preparation.status === "ready") {
          set(internalPrepStatus$, "ready");
          return true;
        }

        if (pollRes.body.preparation.status === "failed") {
          set(internalPrepStatus$, "failed");
          return true;
        }

        return false;
      },
      POLL_INTERVAL_MS,
      signal,
    );
  },
);

export const clearPreparation$ = command(({ set }) => {
  set(internalPrepStatus$, "idle");
  set(internalPrepPrompt$, null);
  set(internalPrepStartTime$, null);
});
