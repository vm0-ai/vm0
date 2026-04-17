import { generateCallbackSecret, getApiUrl } from "../../../infra/callback";
import type { GitHubIssuesCallbackPayload } from "../../../infra/callback/callback-payloads";
import type { CreateZeroRunParams } from "../../zero-run-service";

interface GithubTriggerContext {
  userId: string;
  agentId: string;
  sessionId: string | undefined;
  prompt: string;
  appendSystemPrompt: string | undefined;
  callbackPayload: GitHubIssuesCallbackPayload;
}

export function adaptGithubTrigger(
  ctx: GithubTriggerContext,
): CreateZeroRunParams {
  return {
    userId: ctx.userId,
    agentId: ctx.agentId,
    sessionId: ctx.sessionId,
    prompt: ctx.prompt,
    appendSystemPrompt: ctx.appendSystemPrompt,
    triggerSource: "github",
    callbacks: [
      {
        url: `${getApiUrl()}/api/internal/callbacks/github/issues`,
        secret: generateCallbackSecret(),
        payload: ctx.callbackPayload,
      },
    ],
  };
}
