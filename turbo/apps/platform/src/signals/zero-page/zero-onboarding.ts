import { command, computed, state } from "ccstate";
import {
  type ModelProviderType,
  type ZeroAgentResponse,
  getDefaultAuthMethod,
  getDefaultModel,
  getSecretsForAuthMethod,
  hasAuthMethods,
  hasModelSelection,
  onboardingStatusResponseSchema,
} from "@vm0/core";
import { fetch$ } from "../fetch.ts";
import { clerk$ } from "../auth.ts";
import { createOrgModelProvider$ } from "../external/org-model-providers.ts";
import { getProviderShape } from "../../views/zero-page/components/settings/provider-ui-config.ts";
import { SEED_INSTRUCTIONS, SEED_SKILLS } from "../../data/the-seed.ts";
import { throwIfAbort } from "../utils.ts";
import { logger } from "../log.ts";

const L = logger("ZeroOnboarding");

// ---------------------------------------------------------------------------
// Onboarding status (from API)
// ---------------------------------------------------------------------------

const internalReload$ = state(0);

/** Trigger a refresh of the onboarding status from the API. */
export const reloadOnboardingStatus$ = command(({ set }) => {
  set(internalReload$, (x) => x + 1);
});

export const zeroOnboardingStatus$ = computed(async (get) => {
  get(internalReload$);
  const fetchFn = get(fetch$);
  const resp = await fetchFn("/api/zero/onboarding/status");
  if (!resp.ok) {
    throw new Error(`Failed to fetch onboarding status: ${resp.status}`);
  }
  return onboardingStatusResponseSchema.parse(await resp.json());
});

/**
 * Whether the admin onboarding flow should be shown.
 * Only true for admins when org setup is incomplete (no model provider or agent).
 */
export const zeroNeedsOnboarding$ = computed(async (get) => {
  const status = await get(zeroOnboardingStatus$);
  return status.isAdmin && status.needsOnboarding;
});

/**
 * Whether a member (non-admin) needs to see the welcome screen.
 * True when: org is set up (has default agent), user is not admin,
 * and the API says needsOnboarding (Clerk membership metadata).
 */
export const zeroNeedsMemberOnboarding$ = computed(async (get) => {
  const status = await get(zeroOnboardingStatus$);
  return !status.isAdmin && status.needsOnboarding;
});

/**
 * Mark member onboarding as complete.
 * Writes to Clerk membership metadata, then reloads onboarding status
 * so the dialog disappears (server reads Clerk API directly, no JWT needed).
 */
export const completeMemberOnboarding$ = command(async ({ get, set }) => {
  const fetchFn = get(fetch$);
  await fetchFn("/api/zero/onboarding/complete", { method: "POST" });
  set(internalReload$, (x) => x + 1);
});

// ---------------------------------------------------------------------------
// Onboarding form state
// ---------------------------------------------------------------------------

type ZeroOnboardingStep = "1" | "2" | "3" | "4" | "done";

const internalStep$ = state<ZeroOnboardingStep>("1");
const internalAgentName$ = state("Zero");
const internalProviderType$ = state<ModelProviderType>(
  "claude-code-oauth-token",
);

interface ZeroFormValues {
  secret: string;
  selectedModel: string;
  authMethod: string;
  secrets: Record<string, string>;
  useDefaultModel: boolean;
}

function defaultFormValues(): ZeroFormValues {
  return {
    secret: "",
    selectedModel: "",
    authMethod: "",
    secrets: {},
    useDefaultModel: true,
  };
}

const internalFormValues$ = state<ZeroFormValues>(defaultFormValues());
const internalSaving$ = state(false);
const internalSelectedSkills$ = state<string[]>([]);
const internalOnboardingError$ = state<string | null>(null);

// ---------------------------------------------------------------------------
// Exported computed state
// ---------------------------------------------------------------------------

export const zeroOnboardingStep$ = computed((get) => get(internalStep$));
export const zeroAgentName$ = computed((get) => get(internalAgentName$));
export const zeroFormValues$ = computed((get) => get(internalFormValues$));
export const zeroSaving$ = computed((get) => get(internalSaving$));
export const zeroSelectedSkills$ = computed((get) =>
  get(internalSelectedSkills$),
);

export const zeroOnboardingError$ = computed((get) =>
  get(internalOnboardingError$),
);

export const clearZeroOnboardingError$ = command(({ set }) => {
  set(internalOnboardingError$, null);
});

export const zeroCanSave$ = computed((get) => {
  const providerType = get(internalProviderType$);
  const formValues = get(internalFormValues$);
  const shape = getProviderShape(providerType);

  if (shape === "multi-auth") {
    const secretsConfig = getSecretsForAuthMethod(
      providerType,
      formValues.authMethod,
    );
    if (!secretsConfig) {
      return false;
    }
    for (const [key, config] of Object.entries(secretsConfig)) {
      if (config.required && !formValues.secrets[key]?.trim()) {
        return false;
      }
    }
    return true;
  }

  if (shape === "no-secret") {
    return true;
  }

  return formValues.secret.trim().length > 0;
});

// ---------------------------------------------------------------------------
// Commands: form updates
// ---------------------------------------------------------------------------

export const setZeroStep$ = command(({ set }, step: ZeroOnboardingStep) => {
  set(internalStep$, step);
});

export const setZeroAgentName$ = command(({ set }, name: string) => {
  set(internalAgentName$, name);
});

export const setZeroProviderType$ = command(
  ({ set }, type: ModelProviderType) => {
    set(internalProviderType$, type);

    const defaultAuth = hasAuthMethods(type)
      ? (getDefaultAuthMethod(type) ?? "")
      : "";
    const defaultModel = hasModelSelection(type)
      ? (getDefaultModel(type) ?? "")
      : "";

    set(internalFormValues$, {
      secret: "",
      selectedModel: defaultModel,
      authMethod: defaultAuth,
      secrets: {},
      useDefaultModel: !defaultModel,
    });
  },
);

export const toggleZeroSkill$ = command(({ set }, skillValue: string) => {
  set(internalSelectedSkills$, (prev) =>
    prev.includes(skillValue)
      ? prev.filter((s) => s !== skillValue)
      : [...prev, skillValue],
  );
});

// ---------------------------------------------------------------------------
// Commands: lifecycle
// ---------------------------------------------------------------------------

/**
 * Initialize onboarding step based on current status.
 * Skips steps that are already completed.
 */
export const initZeroOnboarding$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const status = await get(zeroOnboardingStatus$);
    signal.throwIfAborted();

    if (!status.needsOnboarding) {
      set(internalStep$, "done");
      return;
    }

    // Always start from step 1 when onboarding is needed
    set(internalStep$, "1");
  },
);

/**
 * Save model provider (step 2 completion).
 */
export const saveZeroModelProvider$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    set(internalSaving$, true);

    try {
      const providerType = get(internalProviderType$);
      const formValues = get(internalFormValues$);
      const shape = getProviderShape(providerType);

      // Build request based on provider shape
      const request: Record<string, unknown> = { type: providerType };

      if (shape === "multi-auth") {
        request.authMethod = formValues.authMethod;
        request.secrets = formValues.secrets;
      } else if (shape !== "no-secret") {
        request.secret = formValues.secret.trim();
      }

      if (
        hasModelSelection(providerType) &&
        !formValues.useDefaultModel &&
        formValues.selectedModel
      ) {
        request.selectedModel = formValues.selectedModel;
      }

      await set(
        createOrgModelProvider$,
        request as Parameters<typeof createOrgModelProvider$.write>[1],
      );
      signal.throwIfAborted();

      L.debug("Model provider created during zero onboarding");
    } finally {
      set(internalSaving$, false);
    }
  },
);

/**
 * Complete onboarding: create agent via zero agents API and set as default.
 */
export const completeZeroOnboarding$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    set(internalSaving$, true);
    set(internalOnboardingError$, null);

    try {
      const displayName = get(internalAgentName$);
      const selectedSkills = get(internalSelectedSkills$);
      const fetchFn = get(fetch$);

      // Merge seed skills with user-selected skills (deduplicated)
      const allConnectors = [...new Set([...SEED_SKILLS, ...selectedSkills])];

      // Create agent via zero agents API
      const createResp = await fetchFn("/api/zero/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          connectors: allConnectors,
          displayName,
          sound: "professional",
        }),
      });
      signal.throwIfAborted();

      if (!createResp.ok) {
        const errorData = (await createResp.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        throw new Error(
          errorData?.error?.message ??
            `Failed to create agent: ${createResp.statusText}`,
        );
      }

      const agent = (await createResp.json()) as ZeroAgentResponse;
      signal.throwIfAborted();

      // Upload instructions via zero agents API
      const instrResp = await fetchFn(
        `/api/zero/agents/${encodeURIComponent(agent.name)}/instructions`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: SEED_INSTRUCTIONS }),
        },
      );
      signal.throwIfAborted();

      if (!instrResp.ok) {
        const errorData = (await instrResp.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        throw new Error(
          errorData?.error?.message ??
            `Failed to upload instructions: ${instrResp.statusText}`,
        );
      }

      // Set as default agent
      const defaultResp = await fetchFn("/api/zero/default-agent", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentComposeId: agent.agentComposeId,
        }),
      });
      signal.throwIfAborted();

      if (!defaultResp.ok) {
        throw new Error(`Failed to set default agent: ${defaultResp.status}`);
      }

      L.debug("Zero onboarding completed", {
        agentName: agent.name,
        composeId: agent.agentComposeId,
      });

      // Force JWT refresh so updated org metadata is available immediately
      const clerk = await get(clerk$);
      signal.throwIfAborted();
      await clerk.session?.getToken({ skipCache: true });
      signal.throwIfAborted();

      // Reload status and mark done
      set(internalReload$, (x) => x + 1);
      set(internalStep$, "done");

      return agent.agentComposeId;
    } catch (error) {
      throwIfAbort(error);
      const message =
        error instanceof Error ? error.message : "Failed to complete setup";
      L.error("Failed to complete onboarding:", error);
      set(internalOnboardingError$, message);
      return undefined;
    } finally {
      set(internalSaving$, false);
    }
  },
);
