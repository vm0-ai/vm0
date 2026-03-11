import { computed } from "ccstate";
import { zeroOnboardingStatus$ } from "./zero-onboarding.ts";

/**
 * Raw default agent name from onboarding status (lowercase identifier, e.g. "zero").
 * Returns null if no default agent is set.
 */
const defaultAgentName$ = computed(async (get) => {
  const status = await get(zeroOnboardingStatus$);
  return status.defaultAgentName;
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
 * Reads metadata.displayName if available, otherwise capitalizes the agent name.
 * Falls back to "Zero" when no agent is set.
 */
export const agentDisplayName$ = computed(async (get) => {
  const metadata = await get(defaultAgentMetadata$);
  if (metadata?.displayName) {
    return metadata.displayName;
  }
  const raw = await get(defaultAgentName$);
  const name = raw || "zero";
  return name.charAt(0).toUpperCase() + name.slice(1);
});
