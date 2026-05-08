import { isSessionToolName } from "@vm0/core/voice-chat/session-config";
import { logger } from "../../../lib/log";
import { safeJsonParse } from "../../utils";

const log = logger("zero:voice-chat:relay:talker-tool");

const SHORT_PROMPT_MAX = 60;

interface FunctionCallOutputEvent {
  type: "conversation.item.create";
  item: {
    type: "function_call_output";
    call_id: string;
    output: string;
  };
}

type Fetcher = typeof fetch;

interface DispatchParams {
  voiceChatSessionId: string;
  toolName: string;
  callId: string;
  argumentsJson: string;
  relayToken: string;
  webBaseUrl: string;
  sendToOpenAi: (event: FunctionCallOutputEvent) => void;
  fetcher?: Fetcher;
}

/**
 * Dispatch a Talker `response.function_call_arguments.done` event:
 * validate the tool name + parse arguments, POST to apps/web's internal
 * `/api/internal/voice-chat/relay/[id]/tasks` route on success, and emit
 * the matching `function_call_output` back to OpenAI via `sendToOpenAi`.
 *
 * The output text mirrors what the legacy browser-side handler produced
 * (`Slow brain informed: '<short>'. ...`, `Inform failed: ...`,
 * `Slow brain not available for this session.`) so the user-facing voice
 * doesn't change when the relay path replaces the browser path.
 */
export async function dispatchTalkerTool(
  params: DispatchParams,
): Promise<void> {
  if (!isSessionToolName(params.toolName)) {
    log.warn(
      `talker tool dispatch rejected: unknown tool ${params.toolName} for session ${params.voiceChatSessionId}`,
    );
    sendOutput(params, "Inform failed: invalid args.");
    return;
  }

  const prompt = parsePrompt(params.argumentsJson);
  if (prompt.kind === "invalid_json") {
    sendOutput(params, "Inform failed: invalid args.");
    return;
  }
  if (prompt.kind === "empty") {
    sendOutput(params, "Inform failed: empty prompt.");
    return;
  }

  const status = await postToInternalTasksRoute({
    voiceChatSessionId: params.voiceChatSessionId,
    prompt: prompt.value,
    callId: params.callId,
    relayToken: params.relayToken,
    webBaseUrl: params.webBaseUrl,
    fetcher: params.fetcher ?? fetch,
  });

  if (status.kind === "ok") {
    sendOutput(
      params,
      `Slow brain informed: '${shortPrompt(prompt.value)}'. It will decide what to do and report back.`,
    );
    return;
  }

  if (status.kind === "no_agent") {
    sendOutput(params, "Slow brain not available for this session.");
    return;
  }

  sendOutput(
    params,
    "Failed to reach the slow brain. Please try again or rephrase.",
  );
}

type PromptParse =
  | { kind: "ok"; value: string }
  | { kind: "invalid_json" }
  | { kind: "empty" };

function parsePrompt(argumentsJson: string): PromptParse {
  const parsed = safeJsonParse(argumentsJson);
  if (!parsed || typeof parsed !== "object") {
    return { kind: "invalid_json" };
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.prompt !== "string") {
    return { kind: "invalid_json" };
  }
  if (!record.prompt.trim()) {
    return { kind: "empty" };
  }
  return { kind: "ok", value: record.prompt };
}

type DispatchOutcome =
  | { kind: "ok" }
  | { kind: "no_agent" }
  | { kind: "other_failure" };

async function postToInternalTasksRoute(opts: {
  voiceChatSessionId: string;
  prompt: string;
  callId: string;
  relayToken: string;
  webBaseUrl: string;
  fetcher: Fetcher;
}): Promise<DispatchOutcome> {
  const url = `${opts.webBaseUrl}/api/internal/voice-chat/relay/${opts.voiceChatSessionId}/tasks`;
  const response = await opts.fetcher(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${opts.relayToken}`,
    },
    body: JSON.stringify({ prompt: opts.prompt, callId: opts.callId }),
  });

  if (response.ok) {
    return { kind: "ok" };
  }

  if (response.status === 400) {
    const text = await response.text();
    const parsed = safeJsonParse(text) as
      | { error?: { code?: string } }
      | undefined;
    if (parsed?.error?.code === "NO_AGENT") {
      return { kind: "no_agent" };
    }
  }

  log.warn(
    `talker tool dispatch upstream failure ${String(response.status)} for session ${opts.voiceChatSessionId}`,
  );
  return { kind: "other_failure" };
}

function sendOutput(params: DispatchParams, output: string): void {
  params.sendToOpenAi({
    type: "conversation.item.create",
    item: {
      type: "function_call_output",
      call_id: params.callId,
      output,
    },
  });
}

function shortPrompt(prompt: string): string {
  const trimmed = prompt.trim();
  if (trimmed.length <= SHORT_PROMPT_MAX) {
    return trimmed;
  }
  return `${trimmed.slice(0, SHORT_PROMPT_MAX - 1)}…`;
}
