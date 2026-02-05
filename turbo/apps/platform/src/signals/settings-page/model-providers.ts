import { command, computed, state } from "ccstate";
import {
  createModelProvider$,
  deleteModelProvider$,
  modelProviders$,
} from "../external/model-providers.ts";

const internalTokenValue$ = state("");
const internalIsEditing$ = state(false);

const internalActionPromise$ = state<Promise<unknown> | null>(null);

export const claudeCodeOauthTokenValue$ = computed((get) =>
  get(internalTokenValue$),
);

export const isEditingClaudeCodeOauthToken$ = computed((get) =>
  get(internalIsEditing$),
);

export const updateClaudeCodeOauthTokenValue$ = command(
  ({ set }, value: string) => {
    set(internalTokenValue$, value);
  },
);

export const startEditing$ = command(async ({ set }, signal: AbortSignal) => {
  set(internalIsEditing$, true);
  set(internalTokenValue$, "");

  await Promise.resolve();
  signal.throwIfAborted();
});

export const saveClaudeCodeOauthToken$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const tokenValue = get(internalTokenValue$);
    if (!tokenValue) {
      return;
    }

    set(internalTokenValue$, "");
    set(internalIsEditing$, false);

    const promise = set(createModelProvider$, {
      type: "claude-code-oauth-token",
      secret: tokenValue,
    });
    set(internalActionPromise$, promise);
    signal.addEventListener("abort", () => {
      set(internalActionPromise$, null);
    });

    await promise;
    signal.throwIfAborted();
  },
);

/**
 * Cancel editing and reset the token input.
 */
export const cancelSettingsEdit$ = command(({ set }) => {
  set(internalTokenValue$, "");
  set(internalIsEditing$, false);
});

export const hasClaudeCodeOauthToken$ = computed(async (get) => {
  const { modelProviders } = await get(modelProviders$);
  return modelProviders.some((p) => p.type === "claude-code-oauth-token");
});

export const deleteOAuthToken$ = command(
  async ({ set }, signal: AbortSignal) => {
    const promise = set(deleteModelProvider$, "claude-code-oauth-token");
    set(internalActionPromise$, promise);
    signal.addEventListener("abort", () => {
      set(internalActionPromise$, null);
    });

    await promise;
    signal.throwIfAborted();
  },
);

export const actionPromise$ = computed((get) => {
  return get(internalActionPromise$);
});
