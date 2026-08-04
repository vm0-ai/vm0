import {
  zeroAgentsMainContract,
  zeroAgentInstructionsContract,
  type ZeroAgentResponse,
} from "@vm0/api-contracts/contracts/zero-agents";
import type { ZeroClientFactory } from "../api-client.ts";
import { SEED_INSTRUCTIONS } from "../../data/the-seed.ts";
import { accept } from "../../lib/accept.ts";

interface CreateZeroAgentParams {
  displayName: string;
  sound?: string;
  avatarUrl?: string;
  visibility?: "public" | "private";
}

/**
 * Create a zero agent and upload seed instructions.
 *
 * Shared between onboarding (lead agent) and sub-agent creation
 * to keep the two flows in sync.
 */
export async function createZeroAgent(
  createClient: ZeroClientFactory,
  params: CreateZeroAgentParams,
  signal: AbortSignal,
): Promise<ZeroAgentResponse> {
  // Step 1: Create agent (compose). The API assigns a random preset avatar
  // when none is provided.
  const agentsClient = createClient(zeroAgentsMainContract);
  const createResult = await accept(
    agentsClient.create({
      body: {
        displayName: params.displayName,
        sound: params.sound,
        avatarUrl: params.avatarUrl,
        visibility: params.visibility,
      },
      fetchOptions: { signal },
    }),
    [201],
  );
  signal.throwIfAborted();

  const agent = (createResult as { body: ZeroAgentResponse }).body;

  // Step 2: Upload seed instructions
  const instrClient = createClient(zeroAgentInstructionsContract);
  await accept(
    instrClient.update({
      params: { id: agent.agentId },
      body: { content: SEED_INSTRUCTIONS },
      fetchOptions: { signal },
    }),
    [200],
  );
  signal.throwIfAborted();

  return agent;
}
