import type { HeldSessionState } from "@vm0/api-contracts/contracts/runners";

import { now } from "../external/time";

export const RUNNER_SESSION_AFFINITY_PROTECTION_MS = 2000;

export function affinityProtectedUntil(
  cliAgentSessionId: string | null,
  createdAt: Date,
): Date | null {
  if (!cliAgentSessionId) {
    return null;
  }
  return new Date(createdAt.getTime() + RUNNER_SESSION_AFFINITY_PROTECTION_MS);
}

export function isAffinityProtected(
  cliAgentSessionId: string | null,
  createdAt: Date,
): boolean {
  const protectedUntil = affinityProtectedUntil(cliAgentSessionId, createdAt);
  return protectedUntil !== null && protectedUntil.getTime() > now();
}

export function heldSessionStatesContain(
  heldSessionStates: readonly HeldSessionState[],
  cliAgentSessionId: string,
): boolean {
  return heldSessionStates.some((state) => {
    return state.sessionId === cliAgentSessionId;
  });
}
