import { command, computed, state } from "ccstate";
import {
  onboardingStatusContract,
  onboardingSetupContract,
} from "@vm0/api-contracts/contracts/onboarding";
import type { ConnectorType } from "@vm0/connectors/connectors";
import { clerk$ } from "../auth.ts";
import { zeroClient$ } from "../api-client.ts";
import { logger } from "../log.ts";
import { accept } from "../../lib/accept.ts";

const L = logger("ZeroOnboarding");

const internalReload$ = state(0);

export const reloadOnboardingStatus$ = command(({ set }) => {
  set(internalReload$, (x) => {
    return x + 1;
  });
});

export const zeroOnboardingStatus$ = computed(async (get) => {
  get(internalReload$);

  const client = get(zeroClient$)(onboardingStatusContract);
  const result = await accept(client.getStatus(), [200]);
  return result.body;
});

/**
 * Whether the current user needs onboarding. Onboarding is purely admin
 * workspace setup — the backend only returns `needsOnboarding: true` for an
 * admin whose org has no default agent yet.
 */
export const zeroNeedsOnboarding$ = computed(async (get) => {
  const status = await get(zeroOnboardingStatus$);
  return status.needsOnboarding;
});

type ZeroOnboardingStep = "1" | "2" | "3" | "done";

const userStep$ = state<ZeroOnboardingStep | null>(null);

const initialOnboardingStep$ = computed(async (get) => {
  const status = await get(zeroOnboardingStatus$);
  return status.needsOnboarding ? "1" : "done";
});

const internalAgentName$ = state("Zero");
const internalWorkspaceName$ = state("");

const internalSelectedConnectors$ = state<ConnectorType[]>([]);

/**
 * True when the user arrived via a "use case" deep link carrying both
 * `?connector=` and `?prompt=`. In this mode the onboarding is condensed to
 * step 3, which grows an editable composer so the user can tweak the prompt
 * before continuing straight into the web chat with their default agent.
 */
const internalUseCaseMode$ = state(false);
const internalPromptDraft$ = state("");

export const onboardingIsUseCase$ = computed((get) => {
  return get(internalUseCaseMode$);
});

export const onboardingPromptDraft$ = computed((get) => {
  return get(internalPromptDraft$);
});

export const markUseCaseMode$ = command(({ set }, prompt: string) => {
  set(internalUseCaseMode$, true);
  set(internalPromptDraft$, prompt);
});

export const setOnboardingPromptDraft$ = command(({ set }, value: string) => {
  set(internalPromptDraft$, value);
});

/**
 * True once an admin has clicked Next on step 1 and the workspace + default
 * agent have been provisioned. The dialog stays visible while the user
 * picks connectors in the (skippable) step 2.
 */
const internalEagerInitialized$ = state(false);

export const onboardingEagerInitialized$ = computed((get) => {
  return get(internalEagerInitialized$);
});

export const markEagerInitialized$ = command(({ set }) => {
  set(internalEagerInitialized$, true);
});

export const zeroOnboardingStep$ = computed(async (get) => {
  const userStep = get(userStep$);
  if (userStep !== null) {
    return userStep;
  }
  return await get(initialOnboardingStep$);
});

export const zeroWorkspaceName$ = computed((get) => {
  return get(internalWorkspaceName$);
});

export const zeroSelectedConnectors$ = computed((get) => {
  return get(internalSelectedConnectors$);
});

// ---------------------------------------------------------------------------
// Commands: form updates
// ---------------------------------------------------------------------------

export const setZeroStep$ = command(({ set }, step: ZeroOnboardingStep) => {
  set(userStep$, step);
});

export const setZeroAgentName$ = command(({ set }, name: string) => {
  set(internalAgentName$, name);
});

export const setZeroWorkspaceName$ = command(({ set }, name: string) => {
  set(internalWorkspaceName$, name);
});

const internalConnectorSearch$ = state("");

export const connectorSearch$ = computed((get) => {
  return get(internalConnectorSearch$);
});

export const setConnectorSearch$ = command(({ set }, value: string) => {
  set(internalConnectorSearch$, value);
});

export const toggleZeroConnector$ = command(
  ({ set }, connectorValue: ConnectorType) => {
    set(internalSelectedConnectors$, (prev) => {
      return prev.includes(connectorValue)
        ? prev.filter((s) => {
            return s !== connectorValue;
          })
        : [...prev, connectorValue];
    });
  },
);

// ---------------------------------------------------------------------------
// Commands: lifecycle
// ---------------------------------------------------------------------------

/**
 * Reset the onboarding step to null so initialOnboardingStep$ takes over.
 * Call this on page entry to ensure a fresh reactive derivation.
 */
export const resetOnboardingStep$ = command(({ set }) => {
  set(userStep$, null);
  set(internalUseCaseMode$, false);
  set(internalPromptDraft$, "");
  set(internalEagerInitialized$, false);
});

/**
 * Complete onboarding: single server-side API call that creates agent,
 * sets default, updates org, and marks onboarding done.
 */
export const completeZeroOnboarding$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const displayName = get(internalAgentName$);
    const workspaceName = get(internalWorkspaceName$);
    const selectedConnectors = get(internalSelectedConnectors$);
    const createClient = get(zeroClient$);

    const setupClient = createClient(onboardingSetupContract);
    const result = await accept(
      setupClient.setup({
        body: {
          displayName,
          workspaceName: workspaceName.trim() || undefined,
          sound: "professional",
          avatarUrl: "preset:0",
          selectedConnectors:
            selectedConnectors.length > 0 ? selectedConnectors : undefined,
          timezone: new Intl.DateTimeFormat().resolvedOptions().timeZone,
        },
        fetchOptions: { signal },
      }),
      [200, 409],
    );
    signal.throwIfAborted();

    const { agentId } = result.body;

    L.debug("Zero onboarding completed", { agentId });

    // Force JWT refresh so updated org metadata is available immediately
    const clerk = await get(clerk$);
    signal.throwIfAborted();
    await clerk.session?.getToken({ skipCache: true });
    signal.throwIfAborted();

    // Reload the Clerk organization object so client-side reads
    // (e.g. org switcher) reflect the updated name immediately.
    await clerk.organization?.reload();
    signal.throwIfAborted();

    set(internalReload$, (x) => {
      return x + 1;
    });

    return agentId;
  },
);
