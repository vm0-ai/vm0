import { command, computed, state } from "ccstate";
import {
  zeroVoiceChatPrepareTriggerContract,
  zeroVoiceChatPrepareListContract,
  type FreshPreparation,
} from "@vm0/core";
import { zeroClient$ } from "../api-client.ts";
import { defaultAgentId$ } from "../agent.ts";
import { accept, ApiError } from "../../lib/accept.ts";
import { throwIfAbort } from "../utils.ts";
import { setAblyLoop$ } from "../realtime.ts";
import { clerk$ } from "../auth.ts";

type PreparationStatus = "idle" | "preparing" | "ready" | "failed";

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

    let initialStatus: "preparing" | "ready" | "failed";
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
      await set(fetchFreshPreparations$, signal).catch((error: unknown) => {
        throwIfAbort(error);
      });
      signal.throwIfAborted();
      return;
    }

    if (initialStatus === "failed") {
      set(internalPrepStatus$, "failed");
      return;
    }

    // Poll until ready or failed.
    // setAblyLoop$ handles transient errors with fibonacci backoff retry.
    const clerkInstance = await get(clerk$);
    signal.throwIfAborted();
    const userId = clerkInstance.user?.id;
    if (!userId) {
      throw new Error(
        "voice-chat-preparation called without authenticated user",
      );
    }
    const pollBody$ = command(async ({ set }, loopSignal: AbortSignal) => {
      const pollRes = await accept(
        client.trigger({ body: { agentId, mode: "meeting", prompt } }),
        [200],
        { toast: false },
      );
      loopSignal.throwIfAborted();

      if (pollRes.body.preparation.status === "ready") {
        set(internalPrepStatus$, "ready");
        await set(fetchFreshPreparations$, loopSignal).catch(
          (error: unknown) => {
            throwIfAbort(error);
          },
        );
        return true;
      }

      if (pollRes.body.preparation.status === "failed") {
        set(internalPrepStatus$, "failed");
        return true;
      }

      return false;
    });
    await set(setAblyLoop$, `voice:prep:${userId}`, pollBody$, signal);
  },
);

export const clearPreparation$ = command(({ set }) => {
  set(internalPrepStatus$, "idle");
  set(internalPrepPrompt$, null);
  set(internalPrepStartTime$, null);
});

// --- Fresh preparations list ---

const internalFreshPreparations$ = state<FreshPreparation[]>([]);

export const freshPreparations$ = computed((get) => {
  return get(internalFreshPreparations$);
});

export const fetchFreshPreparations$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const createClient = get(zeroClient$);
    const client = createClient(zeroVoiceChatPrepareListContract);
    const res = await accept(client.list({}), [200], { toast: false });
    signal.throwIfAborted();
    set(internalFreshPreparations$, res.body.preparations);
  },
);
