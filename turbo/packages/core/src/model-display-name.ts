/**
 * Human-readable display names for model IDs across all providers.
 * Falls back to the raw model ID if no mapping is found.
 */
const MODEL_DISPLAY_NAMES = Object.freeze<Record<string, string>>({
  // Anthropic direct (claude-code-oauth-token, anthropic-api-key, vm0)
  "claude-sonnet-4-6": "Claude Sonnet 4.6",
  "claude-opus-4-6": "Claude Opus 4.6",
  "claude-opus-4-7": "Claude Opus 4.7",
  "claude-haiku-4-5": "Claude Haiku 4.5",
  // Anthropic via OpenRouter / Vercel AI Gateway
  "anthropic/claude-sonnet-4.6": "Claude Sonnet 4.6",
  "anthropic/claude-opus-4.6": "Claude Opus 4.6",
  "anthropic/claude-sonnet-4.5": "Claude Sonnet 4.5",
  "anthropic/claude-opus-4.5": "Claude Opus 4.5",
  "anthropic/claude-haiku-4.5": "Claude Haiku 4.5",
  // DeepSeek
  "deepseek-v4-pro": "DeepSeek V4 Pro",
  "deepseek-v4-flash": "DeepSeek V4 Flash",
  // MiniMax
  "MiniMax-M2.7": "MiniMax M2.7",
  "MiniMax-M2.1": "MiniMax M2.1",
  "minimax/minimax-m2.5": "MiniMax M2.5",
  // Kimi / Moonshot
  "kimi-k2.6": "Kimi K2.6",
  "kimi-k2.5": "Kimi K2.5",
  "kimi-k2-thinking": "Kimi K2 Thinking",
  "kimi-k2-thinking-turbo": "Kimi K2 Thinking Turbo",
  "moonshotai/kimi-k2.6": "Kimi K2.6",
  "moonshotai/kimi-k2.5": "Kimi K2.5",
  // GLM / ZhipuAI
  "glm-5.1": "GLM-5.1",
  "glm-5": "GLM-5",
  "glm-4.7": "GLM-4.7",
  "glm-4.5-air": "GLM-4.5 Air",
  "zai/glm-5-turbo": "GLM-5 Turbo",
});

/**
 * Get a human-readable display name for a model ID.
 * Returns the raw model ID if no friendly name is defined.
 */
export function getModelDisplayName(model: string): string {
  return MODEL_DISPLAY_NAMES[model] ?? model;
}
