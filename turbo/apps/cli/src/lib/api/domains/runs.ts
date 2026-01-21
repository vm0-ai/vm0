import { initClient } from "@ts-rest/core";
import { runsMainContract, runEventsContract } from "@vm0/core";
import { getClientConfig, handleError } from "../core/client-factory";
import type { CreateRunResponse, GetEventsResponse } from "../core/types";

/**
 * Create a run with unified request format
 * Supports new runs, checkpoint resume, and session continue
 * Note: Environment variables are expanded server-side from vars
 */
export async function createRun(body: {
  // Shortcuts (mutually exclusive)
  checkpointId?: string;
  sessionId?: string;
  // Base parameters
  agentComposeId?: string;
  agentComposeVersionId?: string;
  conversationId?: string;
  artifactName?: string;
  artifactVersion?: string;
  vars?: Record<string, string>;
  secrets?: Record<string, string>;
  volumeVersions?: Record<string, string>;
  // Debug flag (internal use only)
  debugNoMockClaude?: boolean;
  // Required
  prompt: string;
}): Promise<CreateRunResponse> {
  const config = await getClientConfig();
  const client = initClient(runsMainContract, config);

  const result = await client.create({ body });

  if (result.status === 201) {
    return result.body;
  }

  handleError(result, "Failed to create run");
}

export async function getEvents(
  runId: string,
  options?: { since?: number; limit?: number },
): Promise<GetEventsResponse> {
  const config = await getClientConfig();
  const client = initClient(runEventsContract, config);

  const result = await client.getEvents({
    params: { id: runId },
    query: {
      since: options?.since ?? 0,
      limit: options?.limit ?? 100,
    },
  });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, "Failed to fetch events");
}
