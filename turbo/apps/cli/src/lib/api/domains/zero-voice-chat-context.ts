import { initClient } from "@ts-rest/core";
import {
  zeroVoiceChatContextGetContract,
  zeroVoiceChatContextAppendContract,
  type ContextEventsResponse,
  type ContextEvent,
  type AppendContextEventBody,
} from "@vm0/core";
import { getClientConfig, handleError } from "../core/client-factory";

export async function getVoiceChatContextEvents(
  sessionId: string,
  after?: number,
): Promise<ContextEventsResponse> {
  const config = await getClientConfig();
  const client = initClient(zeroVoiceChatContextGetContract, config);

  const result = await client.getEvents({
    params: { id: sessionId },
    query: { after },
    headers: {},
  });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, "Failed to get voice-chat context events");
}

export async function appendVoiceChatContextEvent(
  sessionId: string,
  body: AppendContextEventBody,
): Promise<ContextEvent> {
  const config = await getClientConfig();
  const client = initClient(zeroVoiceChatContextAppendContract, config);

  const result = await client.appendEvent({
    params: { id: sessionId },
    body,
    headers: {},
  });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, "Failed to append voice-chat context event");
}
