import {
  zeroAgentsMainContract,
  zeroAgentInstructionsContract,
  type ZeroAgentResponse,
} from "@vm0/api-contracts/contracts/zero-agents";
import type { ZeroClientFactory } from "../api-client.ts";
import { SEED_INSTRUCTIONS } from "../../data/the-seed.ts";
import { randomPresetAvatar } from "../../views/zero-page/avatar-utils.ts";

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
): Promise<ZeroAgentResponse> {
  // Use provided avatar or pick a random preset
  const avatarUrl = params.avatarUrl ?? randomPresetAvatar();

  // Step 1: Create agent (compose)
  const agentsClient = createClient(zeroAgentsMainContract);
  const createResult = await agentsClient.create({
    body: {
      displayName: params.displayName,
      sound: params.sound,
      avatarUrl,
    },
  });

  if (createResult.status !== 201) {
    throw new Error(`Failed to create agent (${createResult.status})`);
  }

  const agent = createResult.body;

  // Step 2: Upload seed instructions
  const instrClient = createClient(zeroAgentInstructionsContract);
  const instrResult = await instrClient.update({
    params: { id: agent.agentId },
    body: { content: SEED_INSTRUCTIONS },
  });

  if (instrResult.status !== 200) {
    throw new Error(`Failed to upload instructions (${instrResult.status})`);
  }

  return agent;
}
