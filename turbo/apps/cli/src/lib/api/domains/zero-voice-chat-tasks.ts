import { initClient } from "@ts-rest/core";
import {
  zeroVoiceChatTasksContract,
  type VoiceChatTask,
  type CreateVoiceChatTaskBody,
} from "@vm0/core";
import { getClientConfig, handleError } from "../core/client-factory";

export async function createVoiceChatTask(
  sessionId: string,
  body: CreateVoiceChatTaskBody,
): Promise<VoiceChatTask> {
  const config = await getClientConfig();
  const client = initClient(zeroVoiceChatTasksContract, config);

  const result = await client.createTask({
    params: { id: sessionId },
    body,
    headers: {},
  });

  if (result.status === 200) {
    return result.body.task;
  }

  handleError(result, "Failed to create voice-chat task");
}

export async function getVoiceChatTask(
  sessionId: string,
  taskId: string,
): Promise<VoiceChatTask> {
  const config = await getClientConfig();
  const client = initClient(zeroVoiceChatTasksContract, config);

  const result = await client.getTask({
    params: { id: sessionId, taskId },
    headers: {},
  });

  if (result.status === 200) {
    return result.body.task;
  }

  handleError(result, "Failed to get voice-chat task");
}

export async function listVoiceChatTasks(
  sessionId: string,
): Promise<VoiceChatTask[]> {
  const config = await getClientConfig();
  const client = initClient(zeroVoiceChatTasksContract, config);

  const result = await client.listTasks({
    params: { id: sessionId },
    headers: {},
  });

  if (result.status === 200) {
    return result.body.tasks;
  }

  handleError(result, "Failed to list voice-chat tasks");
}
