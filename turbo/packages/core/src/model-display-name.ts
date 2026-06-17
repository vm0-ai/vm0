/**
 * Human-readable display names for model IDs across all providers.
 * Falls back to the raw model ID if no mapping is found.
 */
const MODEL_DISPLAY_NAMES = Object.freeze<Record<string, string>>({
  // Anthropic direct (claude-code-oauth-token, anthropic-api-key, vm0)
  "claude-fable-5": "Claude Fable 5",
  "claude-sonnet-4-6": "Claude Sonnet 4.6",
  "claude-opus-4-8": "Claude Opus 4.8",
  "claude-opus-4-6": "Claude Opus 4.6",
  "claude-opus-4-7": "Claude Opus 4.7",
  "claude-haiku-4-5": "Claude Haiku 4.5",
  // Anthropic via OpenRouter / Vercel AI Gateway
  "anthropic/claude-fable-5": "Claude Fable 5",
  "anthropic/claude-sonnet-4.6": "Claude Sonnet 4.6",
  "anthropic/claude-opus-4.8": "Claude Opus 4.8",
  "anthropic/claude-opus-4.6": "Claude Opus 4.6",
  "anthropic/claude-opus-4.7": "Claude Opus 4.7",
  "anthropic/claude-sonnet-4.5": "Claude Sonnet 4.5",
  "anthropic/claude-opus-4.5": "Claude Opus 4.5",
  "anthropic/claude-haiku-4.5": "Claude Haiku 4.5",
  // DeepSeek (native)
  "deepseek-v4-pro": "DeepSeek V4 Pro",
  "deepseek-v4-flash": "DeepSeek V4 Flash",
  // DeepSeek via OpenRouter
  "deepseek/deepseek-v4-pro": "DeepSeek V4 Pro",
  "deepseek/deepseek-v4-flash": "DeepSeek V4 Flash",
  // MiniMax
  "MiniMax-M3": "MiniMax M3",
  "MiniMax-M2.7": "MiniMax M2.7",
  "MiniMax-M2.1": "MiniMax M2.1",
  "minimax/minimax-m2.5": "MiniMax M2.5",
  // Kimi / Moonshot
  "kimi-k2.6": "Kimi K2.6",
  "kimi-k2.5": "Kimi K2.5",
  "kimi-k2.7-code": "Kimi K2.7 Code",
  "kimi-k2-thinking": "Kimi K2 Thinking",
  "kimi-k2-thinking-turbo": "Kimi K2 Thinking Turbo",
  "moonshotai/kimi-k2.6": "Kimi K2.6",
  "moonshotai/kimi-k2.5": "Kimi K2.5",
  // GLM / ZhipuAI
  "glm-5.2": "GLM-5.2",
  "glm-5.1": "GLM-5.1",
  "glm-5": "GLM-5",
  "glm-4.7": "GLM-4.7",
  "glm-4.5-air": "GLM-4.5 Air",
  "zai/glm-5-turbo": "GLM-5 Turbo",
  "z-ai/glm-5.2": "GLM-5.2",
  "z-ai/glm-5.1": "GLM-5.1",
  // Minimax via OpenRouter
  "minimax/minimax-m2.7": "MiniMax M2.7",
  // OpenAI / Codex
  "gpt-5.5": "GPT-5.5",
  "gpt-5.4": "GPT-5.4",
  "gpt-5.4-mini": "GPT-5.4 Mini",
  "gpt-5.3-codex": "GPT-5.3 Codex",
  "gpt-5.2": "GPT-5.2",
  // Built-in image generation
  "nano-banana-2": "Nano Banana 2",
  "fal-ai/nano-banana-2": "Nano Banana 2",
  "fal-ai/flux-pro/v1.1": "Flux Pro v1.1",
  "fal-ai/flux-pro/v1.1-ultra": "Flux Pro v1.1 Ultra",
  "fal-ai/qwen-image": "Qwen Image",
  "fal-ai/bytedance/seedream/v4/text-to-image": "Seedream 4",
  // Built-in video generation
  "dreamina-seedance-2-0-260128": "Seedance 2.0",
  "dreamina-seedance-2-0-fast-260128": "Seedance 2.0 Fast",
  "seedance-2-0-260128": "Seedance 2.0",
  "seedance-2-0-fast-260128": "Seedance 2.0 Fast",
  "seedance-1-5-pro-251215": "Seedance 1.5 Pro",
  "fal-ai/veo3.1": "Veo 3.1",
  "fal-ai/veo3.1/fast": "Veo 3.1 Fast",
  "fal-ai/kling-video/o3/standard/text-to-video": "Kling O3 Standard",
  "fal-ai/kling-video/v3/4k/text-to-video": "Kling 3 4K",
});

/**
 * Get a human-readable display name for a model ID.
 * Returns the raw model ID if no friendly name is defined.
 */
export function getModelDisplayName(model: string): string {
  return MODEL_DISPLAY_NAMES[model] ?? model;
}
