import { logger } from "../logger";
import { chat } from "../llm/llm-service";
import { env } from "../../env";

const log = logger("slack:router");

/** Free model for routing decisions (does not support system prompts) */
const ROUTING_MODEL = "google/gemma-3-4b-it:free";

/** Timeout for LLM routing in milliseconds */
const LLM_TIMEOUT_MS = 5000;

export interface AgentBinding {
  agentName: string;
  description: string | null;
}

/**
 * Result of routing a message to an agent
 */
export type RouteResult =
  | { type: "matched"; agentName: string }
  | { type: "ambiguous" }
  | { type: "not_request" };

/**
 * Route a message to the appropriate agent using keyword matching
 *
 * @param message - User's message content (without bot mention)
 * @param bindings - Available agent bindings
 * @returns Agent name if clear match found, null otherwise
 */
export function keywordMatch(
  message: string,
  bindings: AgentBinding[],
): string | null {
  const messageLower = message.toLowerCase();
  const scores: { binding: AgentBinding; score: number }[] = [];

  for (const binding of bindings) {
    const nameWords = binding.agentName.toLowerCase().split(/[-_\s]+/);
    let score = 0;

    // Check if agent name appears in message
    for (const word of nameWords) {
      if (word.length > 2 && messageLower.includes(word)) {
        score += 10;
      }
    }

    // Check if description keywords appear in message
    if (binding.description) {
      const descLower = binding.description.toLowerCase();
      const descWords = descLower.split(/\s+/).filter((w) => w.length > 3);
      for (const word of descWords) {
        if (messageLower.includes(word)) {
          score += 1;
        }
      }
    }

    scores.push({ binding, score });
  }

  // Sort by score descending
  scores.sort((a, b) => b.score - a.score);

  // If top score is significantly higher than second, use it
  const topScore = scores[0]?.score ?? 0;
  const secondScore = scores[1]?.score ?? 0;

  if (topScore > 0 && topScore >= secondScore * 2) {
    log.debug(
      `Keyword matched to agent "${scores[0]?.binding.agentName}" with score ${topScore}`,
    );
    return scores[0]?.binding.agentName ?? null;
  }

  log.debug(
    `Keyword matching ambiguous - top scores: ${topScore}, ${secondScore}`,
  );
  return null;
}

/**
 * Build combined prompt for LLM routing (no system prompt for gemma compatibility)
 */
function buildRoutingPrompt(
  message: string,
  bindings: AgentBinding[],
  context?: string,
): string {
  const agentList = bindings
    .map((b) => `- ${b.agentName}: ${b.description ?? "No description"}`)
    .join("\n");

  let prompt = `You are a router for VM0, a service that connects users to AI agents via Slack.

Your job is to analyze the user's message and determine:
1. Whether the user wants to use an agent
2. If yes, which agent is most appropriate

Available agents:
${agentList}

Reply with exactly ONE of these formats:
- AGENT:<agent-name> — if you can determine the appropriate agent (use exact agent name from list)
- AMBIGUOUS — if the user wants help but you can't determine which agent
- NOT_REQUEST — if the user is not requesting agent assistance (greetings, casual chat, questions about VM0 itself)

Examples:
- "help me review this code" with a code-reviewer agent → AGENT:code-reviewer
- "I need help" with no clear context → AMBIGUOUS
- "hi" or "hello" → NOT_REQUEST
- "what can you do?" → NOT_REQUEST

`;

  if (context) {
    prompt += `## Conversation Context
${context}

`;
  }

  prompt += `## User Message
${message}

Your response (AGENT:<name>, AMBIGUOUS, or NOT_REQUEST):`;

  return prompt;
}

/**
 * Parse LLM response into RouteResult
 */
function parseLlmResponse(
  response: string,
  bindings: AgentBinding[],
): RouteResult {
  const trimmed = response.trim();

  if (trimmed === "NOT_REQUEST") {
    return { type: "not_request" };
  }

  if (trimmed === "AMBIGUOUS") {
    return { type: "ambiguous" };
  }

  if (trimmed.startsWith("AGENT:")) {
    const agentName = trimmed.substring(6).trim();
    const matchedAgent = bindings.find(
      (b) => b.agentName.toLowerCase() === agentName.toLowerCase(),
    );
    if (matchedAgent) {
      return { type: "matched", agentName: matchedAgent.agentName };
    }
    log.warn(`LLM returned unknown agent: ${agentName}`);
  }

  // Unable to parse response, treat as ambiguous
  log.warn(`Unable to parse LLM response: ${trimmed}`);
  return { type: "ambiguous" };
}

/**
 * Route using LLM with timeout
 */
async function llmRoute(
  message: string,
  bindings: AgentBinding[],
  context?: string,
): Promise<RouteResult> {
  const apiKey = env().OPENROUTER_API_KEY;
  if (!apiKey) {
    log.debug("OPENROUTER_API_KEY not configured, skipping LLM routing");
    return { type: "ambiguous" };
  }

  const prompt = buildRoutingPrompt(message, bindings, context);

  log.debug("Starting LLM routing", { messageLength: message.length });

  // Use only user message (no system prompt) for gemma compatibility
  const llmPromise = chat(apiKey, {
    model: ROUTING_MODEL,
    messages: [{ role: "user", content: prompt }],
  });

  const timeoutPromise = new Promise<null>((resolve) =>
    setTimeout(() => resolve(null), LLM_TIMEOUT_MS),
  );

  const result = await Promise.race([llmPromise, timeoutPromise]);

  if (result === null) {
    log.warn("LLM routing timed out");
    return { type: "ambiguous" };
  }

  log.debug("LLM routing completed", { response: result.content });
  return parseLlmResponse(result.content, bindings);
}

/**
 * Route a message to the appropriate agent
 *
 * Routing logic:
 * 1. If no agents available, return ambiguous
 * 2. If only one agent, return matched
 * 3. Try keyword matching first (fast path)
 * 4. If keyword matching is ambiguous, use LLM routing
 * 5. LLM can return: matched agent, ambiguous, or not_request
 *
 * @param message - User's message content (without bot mention)
 * @param bindings - Available agent bindings
 * @param context - Optional conversation context (thread/channel history)
 * @returns RouteResult indicating the routing decision
 */
export async function routeToAgent(
  message: string,
  bindings: AgentBinding[],
  context?: string,
): Promise<RouteResult> {
  if (bindings.length === 0) {
    return { type: "ambiguous" };
  }

  if (bindings.length === 1 && bindings[0]) {
    return { type: "matched", agentName: bindings[0].agentName };
  }

  // Step 1: Try keyword matching (fast path)
  const keywordResult = keywordMatch(message, bindings);
  if (keywordResult) {
    return { type: "matched", agentName: keywordResult };
  }

  // Step 2: Keyword matching was ambiguous, try LLM routing
  log.debug("Keyword matching ambiguous, trying LLM routing");
  try {
    return await llmRoute(message, bindings, context);
  } catch (error) {
    log.error("LLM routing failed", { error });
    return { type: "ambiguous" };
  }
}
