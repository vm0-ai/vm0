import { initClient } from "@ts-rest/core";
import {
  runsMainContract,
  runEventsContract,
  runsCancelContract,
  runsQueueContract,
  type RunsListResponse,
  type CancelRunResponse,
  type QueueResponse,
  type FirewallPolicies,
} from "@vm0/core";
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
  vars?: Record<string, string>;
  secrets?: Record<string, string>;
  volumeVersions?: Record<string, string>;
  // Multi-mount artifacts passed directly at run time
  artifacts?: Array<{
    name: string;
    version?: string;
    mountPath: string;
  }>;
  // Additional volumes passed directly at run time (bypass compose)
  additionalVolumes?: Array<{
    name: string;
    version?: string;
    mountPath: string;
  }>;
  // Debug flag (internal use only)
  debugNoMockClaude?: boolean;
  // Capture HTTP request headers, request bodies, and response bodies in network logs
  captureNetworkBodies?: boolean;
  // Append text to the agent's system prompt
  appendSystemPrompt?: string;
  // Tools to disable in Claude CLI (passed as --disallowed-tools)
  disallowedTools?: string[];
  // Tools to make available in Claude CLI (passed as --tools)
  tools?: string[];
  // Settings JSON to pass to Claude CLI (passed as --settings)
  settings?: string;
  // Per-permission policies
  permissionPolicies?: FirewallPolicies;
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
      since: options?.since ?? -1,
      limit: options?.limit ?? 100,
    },
  });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, "Failed to fetch events");
}

/**
 * List runs with optional filters
 */
export async function listRuns(params?: {
  status?: string; // comma-separated: "pending,running"
  agent?: string;
  since?: string; // ISO timestamp
  until?: string; // ISO timestamp
  limit?: number;
}): Promise<RunsListResponse> {
  const config = await getClientConfig();
  const client = initClient(runsMainContract, config);

  const result = await client.list({
    query: {
      status: params?.status,
      agent: params?.agent,
      since: params?.since,
      until: params?.until,
      limit: params?.limit ?? 50,
    },
  });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, "Failed to list runs");
}

/**
 * Get org run queue status
 */
export async function getRunQueue(): Promise<QueueResponse> {
  const config = await getClientConfig();
  const client = initClient(runsQueueContract, config);

  const result = await client.getQueue({ headers: {} });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, "Failed to get run queue");
}

/**
 * Cancel (kill) a run
 */
export async function cancelRun(runId: string): Promise<CancelRunResponse> {
  const config = await getClientConfig();
  const client = initClient(runsCancelContract, config);

  const result = await client.cancel({
    params: { id: runId },
  });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, "Failed to cancel run");
}
