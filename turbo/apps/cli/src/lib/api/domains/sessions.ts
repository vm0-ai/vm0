import { sessionsByIdContract, checkpointsByIdContract } from "@vm0/core";
import {
  getClientConfig,
  createClient,
  handleError,
} from "../core/client-factory";
import type { GetSessionResponse, GetCheckpointResponse } from "../core/types";

export async function getSession(
  sessionId: string,
): Promise<GetSessionResponse> {
  const config = await getClientConfig();
  const client = createClient(sessionsByIdContract, config);

  const result = await client.getById({
    params: { id: sessionId },
  });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, `Session not found: ${sessionId}`);
}

export async function getCheckpoint(
  checkpointId: string,
): Promise<GetCheckpointResponse> {
  const config = await getClientConfig();
  const client = createClient(checkpointsByIdContract, config);

  const result = await client.getById({
    params: { id: checkpointId },
  });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, `Checkpoint not found: ${checkpointId}`);
}
