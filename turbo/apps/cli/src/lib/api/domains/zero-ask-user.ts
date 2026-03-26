import { initClient } from "@ts-rest/core";
import {
  zeroAskUserQuestionContract,
  zeroAskUserAnswerContract,
  type AskUserQuestionBody,
  type AskUserQuestionResponse,
  type AskUserAnswerResponse,
} from "@vm0/core";
import { getClientConfig, handleError } from "../core/client-factory";

export async function postAskUserQuestion(
  body: AskUserQuestionBody,
): Promise<AskUserQuestionResponse> {
  const config = await getClientConfig();
  const client = initClient(zeroAskUserQuestionContract, config);
  const result = await client.postQuestion({ body, headers: {} });
  if (result.status === 200) return result.body;
  handleError(result, "Failed to post question");
}

export async function getAskUserAnswer(
  pendingId: string,
): Promise<AskUserAnswerResponse> {
  const config = await getClientConfig();
  const client = initClient(zeroAskUserAnswerContract, config);
  const result = await client.getAnswer({
    query: { pendingId },
    headers: {},
  });
  if (result.status === 200) return result.body;
  handleError(result, "Failed to get answer");
}
