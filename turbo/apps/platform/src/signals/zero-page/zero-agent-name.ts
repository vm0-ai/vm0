import { computed } from "ccstate";
import { zeroOnboardingStatus$ } from "./zero-onboarding.ts";

/**
 * Default agent compose ID from onboarding status.
 * Returns null if no default agent is set.
 */
export const defaultAgentId$ = computed(async (get) => {
  const status = await get(zeroOnboardingStatus$);
  return status.defaultAgentId;
});

/**
 * Metadata for the default agent (displayName, sound).
 */
export const defaultAgentMetadata$ = computed(async (get) => {
  const status = await get(zeroOnboardingStatus$);
  return status.defaultAgentMetadata ?? null;
});

/**
 * Display name for the default agent.
 * Reads metadata.displayName if available, otherwise falls back to "Zero".
 */
export const agentDisplayName$ = computed(async (get) => {
  const metadata = await get(defaultAgentMetadata$);
  if (metadata?.displayName) {
    return metadata.displayName;
  }
  return "Zero";
});
