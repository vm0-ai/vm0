export const CALLBACK_PROMPT_PLACEHOLDER =
  "SOMETHING_AGENT_WANT_TO_BE_CALLBACK";

export function connectorActionCallbackAvailable(): boolean {
  return Boolean(process.env.ZERO_CHAT_THREAD_ID?.trim());
}

function currentChatThreadId(agentId: string | undefined): string | null {
  const threadId = process.env.ZERO_CHAT_THREAD_ID?.trim();
  const currentAgentId = process.env.ZERO_AGENT_ID?.trim();
  if (!threadId || !currentAgentId || agentId !== currentAgentId) {
    return null;
  }
  return threadId;
}

export function currentChatSupportsActionCallback(
  agentId: string | undefined,
): boolean {
  return currentChatThreadId(agentId) !== null;
}

function addCallbackSearchParams(
  params: URLSearchParams,
  threadId: string,
  callbackPrompt: string,
): void {
  params.set("threadId", threadId);
  params.set("callbackPrompt", callbackPrompt);
}

export function addRequestedCallbackSearchParams(
  params: URLSearchParams,
  callbackPrompt: string | undefined,
  agentId: string | undefined,
): void {
  if (callbackPrompt === undefined) {
    return;
  }

  const normalizedPrompt = callbackPrompt.trim();
  if (!normalizedPrompt) {
    throw new Error("--callback-prompt cannot be empty");
  }

  const threadId = currentChatThreadId(agentId);
  if (!threadId) {
    throw new Error(
      "--callback-prompt can only target the current Zero web chat thread and agent",
    );
  }
  addCallbackSearchParams(params, threadId, normalizedPrompt);
}

export function connectorActionUrl(args: {
  readonly origin: string;
  readonly path: string;
  readonly agentId?: string;
}): string {
  const url = new URL(args.path, args.origin);
  if (args.agentId) {
    url.searchParams.set("agentId", args.agentId);
  }
  return url.toString();
}

function callbackActionUrlExample(
  actionUrl: string,
  agentId: string | undefined,
): string | null {
  const threadId = currentChatThreadId(agentId);
  if (!threadId) {
    return null;
  }

  const url = new URL(actionUrl);
  addCallbackSearchParams(
    url.searchParams,
    threadId,
    CALLBACK_PROMPT_PLACEHOLDER,
  );
  return url.toString();
}

export function printCallbackActionUrlExample(
  actionUrl: string,
  agentId: string | undefined,
): void {
  const callbackUrl = callbackActionUrlExample(actionUrl, agentId);
  if (!callbackUrl) {
    return;
  }

  console.log("");
  console.log(
    "Or, if this is the only connector or permission action needed, use the callback URL below. After the user completes this action, Zero will automatically start the next round with the callback prompt:",
  );
  console.log(callbackUrl);
}

export function printCallbackTurnInstruction(): void {
  console.log("");
  console.log(
    "After sharing this callback URL, end the current turn. When the user completes the action, Zero will automatically start the next round with the callback prompt.",
  );
}
