import { command } from "ccstate";
import { fetch$ } from "../fetch.ts";
import { zeroOnboardingStatus$ } from "./zero-onboarding.ts";
import { logger } from "../log.ts";

const L = logger("ZeroDevTools");

/**
 * Dev-only: remove defaultAgent and delete compose to re-trigger onboarding.
 */
export const resetDefaultAgent$ = command(async ({ get }) => {
  const fetchFn = get(fetch$);
  const status = await get(zeroOnboardingStatus$);
  const composeId = status.defaultAgentComposeId;

  // Clear default agent
  const resp = await fetchFn("/api/scopes/default-agent", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agentComposeId: null }),
  });

  if (!resp.ok) {
    L.error(`Failed to reset default agent: ${resp.status}`);
    return;
  }

  // Delete the compose if it exists
  if (composeId) {
    const delResp = await fetchFn(`/api/agent/composes/${composeId}`, {
      method: "DELETE",
    });

    if (!delResp.ok) {
      L.error(`Failed to delete agent compose: ${delResp.status}`);
    } else {
      L.debug("Agent compose deleted", { composeId });
    }
  }

  L.debug("Default agent reset — reloading page");
  window.location.reload();
});
