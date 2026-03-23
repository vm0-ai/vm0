import type { ZeroAgentResponse } from "@vm0/core";
import { SEED_INSTRUCTIONS } from "../../data/the-seed.ts";

interface CreateZeroAgentParams {
  connectors: string[];
  displayName: string;
  sound?: string;
}

/**
 * Create a zero agent and upload seed instructions.
 *
 * Shared between onboarding (lead agent) and sub-agent creation
 * to keep the two flows in sync.
 */
export async function createZeroAgent(
  fetchFn: typeof fetch,
  params: CreateZeroAgentParams,
): Promise<ZeroAgentResponse> {
  // Step 1: Create agent (compose)
  const createResp = await fetchFn("/api/zero/agents", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      connectors: params.connectors,
      displayName: params.displayName,
      sound: params.sound,
    }),
  });

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

  // Step 2: Upload seed instructions
  const instrResp = await fetchFn(
    `/api/zero/agents/${encodeURIComponent(agent.name)}/instructions`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: SEED_INSTRUCTIONS }),
    },
  );

  if (!instrResp.ok) {
    const errorData = (await instrResp.json().catch(() => null)) as {
      error?: { message?: string };
    } | null;
    throw new Error(
      errorData?.error?.message ??
        `Failed to upload instructions: ${instrResp.statusText}`,
    );
  }

  return agent;
}
