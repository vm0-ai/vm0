import { initClient } from "@ts-rest/core";
import {
  sessionsByIdContract,
  checkpointsByIdContract,
  type ApiErrorResponse,
} from "@vm0/core";
import { getClientConfig, handleError } from "../core/client-factory";
import type { GetSessionResponse, GetCheckpointResponse } from "../core/types";

/**
 * Get session by ID
 * Used by run continue to fetch session info including secretNames
 */
export async function getSession(
  sessionId: string,
): Promise<GetSessionResponse> {
  const config = await getClientConfig();
  const client = initClient(sessionsByIdContract, config);

  const result = await client.getById({
    params: { id: sessionId },
  });

  if (result.status === 200) {
    return result.body;
  }

  const errorBody = result.body as ApiErrorResponse;
  const message = errorBody.error?.message || `Session not found: ${sessionId}`;
  throw new Error(message);
}

/**
 * Get checkpoint by ID
 * Used by run resume to fetch checkpoint info including secretNames
 */
export async function getCheckpoint(
  checkpointId: string,
): Promise<GetCheckpointResponse> {
  const config = await getClientConfig();
  const client = initClient(checkpointsByIdContract, config);

  const result = await client.getById({
    params: { id: checkpointId },
  });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, `Checkpoint not found: ${checkpointId}`);
}
