import { logger } from "../logger";

const log = logger("slack:router");

interface AgentBinding {
  agentName: string;
  description: string | null;
}

/**
 * Route a message to the appropriate agent
 *
 * Routing logic:
 * 1. If only one agent is available, use it
 * 2. If multiple agents, use simple keyword matching against descriptions
 * 3. Return null if routing is ambiguous
 *
 * Note: This is a simplified routing implementation. For production use with
 * multiple agents, consider integrating an LLM-based router.
 *
 * @param message - User's message content (without bot mention)
 * @param bindings - Available agent bindings
 * @returns Agent name to use, or null if undetermined
 */
export async function routeToAgent(
  message: string,
  bindings: AgentBinding[],
): Promise<string | null> {
  if (bindings.length === 0) {
    return null;
  }

  if (bindings.length === 1 && bindings[0]) {
    return bindings[0].agentName;
  }

  // Simple keyword-based routing
  // Check if message contains keywords that match an agent's description
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
      `Routed to agent "${scores[0]?.binding.agentName}" with score ${topScore}`,
    );
    return scores[0]?.binding.agentName ?? null;
  }

  // If no clear winner, return null
  log.debug(
    `Could not determine agent - top scores: ${topScore}, ${secondScore}`,
  );
  return null;
}
