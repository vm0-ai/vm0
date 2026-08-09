import type {
  PiModelConfig,
  RunSkillSnapshot,
} from "@vm0/api-contracts/contracts/runners";
import {
  getModelProviderPiChatCompletionsUrl,
  supportedRunModelSchema,
  type ModelProviderType,
} from "@vm0/api-contracts/contracts/model-providers";
import {
  isPiAgentModelSupported,
  PI_OPENAI_COMPATIBLE_PROVIDERS,
  type ExecutionEnv,
  type PiAgentModelConfig,
  type PiOpenAICompatibleProvider,
} from "@vm0/pi-agent-runtime";
import { z } from "zod";

/**
 * Cycle-free Pi edge configuration shared between the launch pipeline
 * (agent-run-create) and the edge turn runner (pi-edge-loop.service). This
 * module must not import other services.
 */

export type PiEdgeModelConfig = PiAgentModelConfig;

export const piEdgeModelConfigSchema = z
  .object({
    provider: z.enum(PI_OPENAI_COMPATIBLE_PROVIDERS),
    baseUrl: z.url(),
    apiKey: z.string().min(1),
    model: z.string().min(1),
  })
  .readonly();

/** Canonical selected model used for observations and, when billable, pricing. */
export const piEdgeUsageConfigSchema = z
  .object({
    model: supportedRunModelSchema,
    billable: z.boolean(),
  })
  .readonly();

export type PiEdgeUsageConfig = z.infer<typeof piEdgeUsageConfigSchema>;

export interface PiEdgeTurnArgs {
  readonly runId: string;
  readonly userId: string;
  readonly orgId: string;
  readonly prompt: string;
  readonly systemPrompt: string;
  readonly model: PiEdgeModelConfig;
  readonly usage?: PiEdgeUsageConfig;
  readonly executionEnv: ExecutionEnv;
  readonly skillSnapshot: RunSkillSnapshot;
  readonly runnerGroup: string;
  readonly apiStartTime: number;
}

/** Build the non-secret model config persisted for the standby Sandbox. */
export function piSandboxModelConfig(config: PiEdgeModelConfig): PiModelConfig {
  return {
    provider: config.provider,
    baseUrl: config.baseUrl,
    model: config.model,
    apiKeyEnv:
      config.provider === "moonshotai"
        ? "ANTHROPIC_AUTH_TOKEN"
        : config.provider === "codex"
          ? "CHATGPT_ACCESS_TOKEN"
          : "OPENAI_API_KEY",
  };
}

/**
 * Pi base URLs are derived from the model-provider firewall table rather than
 * duplicated here. The firewall injects the real key only on bases it lists,
 * so a second copy of these URLs could drift out of the firewall's coverage
 * and leave a standby turn shipping the placeholder upstream.
 */
function piEdgeDefaultBaseUrl(concreteType: string): string | undefined {
  const chatCompletionsUrl = getModelProviderPiChatCompletionsUrl(
    concreteType as ModelProviderType,
  );
  return chatCompletionsUrl?.replace(/chat\/completions$/, "");
}

export function isPiEdgeCompatibleProviderType(type: string): boolean {
  return (
    type === "codex-oauth-token" ||
    type === "openrouter-codex" ||
    type === "vercel-ai-gateway-codex" ||
    piEdgeDefaultBaseUrl(type) !== undefined
  );
}

function piProvider(concreteType: string): PiOpenAICompatibleProvider | null {
  switch (concreteType) {
    case "deepseek": {
      return "deepseek";
    }
    case "moonshot-api-key": {
      return "moonshotai";
    }
    case "openai-api-key": {
      return "openai";
    }
    case "openrouter-codex": {
      return "openrouter";
    }
    case "vercel-ai-gateway-codex": {
      return "vercel-ai-gateway";
    }
    case "codex-oauth-token": {
      return "codex";
    }
    default: {
      return null;
    }
  }
}

/**
 * Resolves the edge-callable model config from a resolved run provider. The
 * API-only key is kept separate from the runner secret namespace so firewall
 * providers can still expose placeholders to the sandbox.
 */
export function resolvePiEdgeModelConfig(
  provider: {
    readonly type: string;
    readonly concreteType?: string;
    readonly environment: Record<string, string>;
    readonly secrets: Record<string, string>;
    readonly piEdgeApiKey?: string;
    readonly selectedModel: string | null;
    readonly inlineFirewall?: boolean;
  } | null,
): PiEdgeModelConfig | null {
  if (!provider || !provider.selectedModel || provider.inlineFirewall) {
    return null;
  }
  const concreteType = provider.concreteType ?? provider.type;
  const piProviderId = piProvider(concreteType);
  if (!isPiEdgeCompatibleProviderType(concreteType) || !piProviderId) {
    return null;
  }
  const baseUrl =
    provider.environment.OPENAI_BASE_URL ?? piEdgeDefaultBaseUrl(concreteType);
  const model =
    provider.environment.OPENAI_MODEL ??
    provider.environment.ANTHROPIC_MODEL ??
    provider.selectedModel;
  const apiKey = provider.piEdgeApiKey;
  if (!baseUrl || !model || !apiKey || apiKey.trim().length === 0) {
    return null;
  }
  const config: PiEdgeModelConfig = {
    provider: piProviderId,
    baseUrl,
    apiKey,
    model,
  };
  return isPiAgentModelSupported(config) ? config : null;
}
