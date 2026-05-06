import {
  zeroAgentsMainContract,
  zeroAgentInstructionsContract,
  type ZeroAgentResponse,
} from "@vm0/api-contracts/contracts/zero-agents";
import type { ZeroClientFactory } from "../api-client.ts";
import { SEED_INSTRUCTIONS } from "../../data/the-seed.ts";
import { randomPresetAvatar } from "../../views/zero-page/avatar-utils.ts";
import { accept } from "../../lib/accept.ts";

interface CreateZeroAgentParams {
  displayName: string;
  sound?: string;
  avatarUrl?: string;
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
  // Use provided avatar or pick a random preset
  const avatarUrl = params.avatarUrl ?? randomPresetAvatar();

  // Step 1: Create agent (compose)
  const agentsClient = createClient(zeroAgentsMainContract);
  const createResult = await accept(
    agentsClient.create({
      body: {
        displayName: params.displayName,
        sound: params.sound,
        avatarUrl,
      },
      fetchOptions: { signal },
    }),
    [201],
  );
  signal.throwIfAborted();

  const agent = createResult.body;

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
