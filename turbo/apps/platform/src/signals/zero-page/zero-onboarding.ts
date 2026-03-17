import { command, computed, state } from "ccstate";
import {
  type ModelProviderType,
  getDefaultAuthMethod,
  getDefaultModel,
  getInstructionsFilename,
  getSecretsForAuthMethod,
  hasAuthMethods,
  hasModelSelection,
  onboardingStatusResponseSchema,
} from "@vm0/core";
import { fetch$ } from "../fetch.ts";
import { clerk$ } from "../auth.ts";
import { createModelProvider$ } from "../external/model-providers.ts";
import { getProviderShape } from "../../views/zero-page/components/settings/provider-ui-config.ts";
import { skillValueToUrl } from "../../data/skills.ts";
import { triggerAndPollComposeJob } from "./compose-job.ts";
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
  const resp = await fetchFn("/api/onboarding/status");
  if (!resp.ok) {
    throw new Error(`Failed to fetch onboarding status: ${resp.status}`);
  }
  return onboardingStatusResponseSchema.parse(await resp.json());
});

export const zeroNeedsOnboarding$ = computed(async (get) => {
  const status = await get(zeroOnboardingStatus$);
  return status.needsOnboarding;
});

export const zeroHasModelProvider$ = computed(async (get) => {
  const status = await get(zeroOnboardingStatus$);
  return status.hasModelProvider;
});

// ---------------------------------------------------------------------------
// Onboarding form state
// ---------------------------------------------------------------------------

type ZeroOnboardingStep = "1" | "2" | "3" | "4" | "done";

const internalStep$ = state<ZeroOnboardingStep>("1");
const internalAgentName$ = state("zero");
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
export const zeroProviderType$ = computed((get) => get(internalProviderType$));
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
      useDefaultModel: true,
    });
  },
);

export const setZeroSecret$ = command(({ set }, value: string) => {
  set(internalFormValues$, (prev) => ({ ...prev, secret: value }));
});

export const setZeroModel$ = command(({ set }, value: string) => {
  set(internalFormValues$, (prev) => ({
    ...prev,
    selectedModel: value,
    useDefaultModel: false,
  }));
});

export const setZeroUseDefaultModel$ = command(({ set }, value: boolean) => {
  set(internalFormValues$, (prev) => ({
    ...prev,
    useDefaultModel: value,
    selectedModel: value ? "" : prev.selectedModel,
  }));
});

export const setZeroAuthMethod$ = command(({ set }, value: string) => {
  set(internalFormValues$, (prev) => ({
    ...prev,
    authMethod: value,
    secrets: {},
  }));
});

export const setZeroSecretField$ = command(
  ({ set }, key: string, value: string) => {
    set(internalFormValues$, (prev) => ({
      ...prev,
      secrets: { ...prev.secrets, [key]: value },
    }));
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
      } else {
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
        createModelProvider$,
        request as Parameters<typeof createModelProvider$.write>[1],
      );
      signal.throwIfAborted();

      L.debug("Model provider created during zero onboarding");
    } finally {
      set(internalSaving$, false);
    }
  },
);

/**
 * Complete onboarding: create agent compose and set as default.
 */
export const completeZeroOnboarding$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    set(internalSaving$, true);
    set(internalOnboardingError$, null);

    try {
      const displayName = get(internalAgentName$);
      const selectedSkills = get(internalSelectedSkills$);
      const fetchFn = get(fetch$);

      // Use a UUID as the agent identifier; the user-facing name goes into metadata
      const agentId = crypto.randomUUID();

      // Build agent definition with optional skills and metadata
      const agentDef: Record<string, unknown> = {
        framework: "claude-code",
        instructions: getInstructionsFilename("claude-code"),
        metadata: {
          displayName,
          sound: "professional",
        },
      };
      if (selectedSkills.length > 0) {
        agentDef.skills = selectedSkills.map(skillValueToUrl);
      }

      const content = {
        version: "1",
        agents: {
          [agentId]: agentDef,
        },
      };

      // Run compose job (CLI processes skills, uploads assets)
      // Pass empty instructions so the server creates a CLAUDE.md with agent profile
      const job = await triggerAndPollComposeJob(fetchFn, content, "");
      signal.throwIfAborted();

      if (!job.result) {
        throw new Error("Compose job completed without result");
      }

      // Set as default agent
      const defaultResp = await fetchFn("/api/orgs/default-agent", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentComposeId: job.result.composeId,
        }),
      });
      signal.throwIfAborted();

      if (!defaultResp.ok) {
        throw new Error(`Failed to set default agent: ${defaultResp.status}`);
      }

      L.debug("Zero onboarding completed", {
        agentName: job.result.composeName,
        composeId: job.result.composeId,
      });

      // Force JWT refresh so updated org metadata is available immediately
      const clerk = await get(clerk$);
      signal.throwIfAborted();
      await clerk.session?.getToken({ skipCache: true });
      signal.throwIfAborted();

      // Reload status and mark done
      set(internalReload$, (x) => x + 1);
      set(internalStep$, "done");

      return job.result.composeId;
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
