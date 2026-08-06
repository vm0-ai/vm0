import {
  PI_STANDBY_PROFILE,
  type PiModelConfig,
  type RunSkillSnapshot,
} from "@vm0/api-contracts/contracts/runners";
import {
  isPiAgentModelSupported,
  type ExecutionEnv,
  type PiAgentModelConfig,
  type PiOpenAICompatibleProvider,
} from "@vm0/pi-agent-runtime";

/**
 * Cycle-free Pi edge configuration shared between the launch pipeline
 * (agent-run-create) and the edge turn runner (pi-edge-loop.service). This
 * module must not import other services.
 */

export type PiEdgeModelConfig = PiAgentModelConfig;

export interface PiEdgeTurnArgs {
  readonly runId: string;
  readonly userId: string;
  readonly orgId: string;
  readonly prompt: string;
  readonly systemPrompt: string;
  readonly model: PiEdgeModelConfig;
  readonly executionEnv: ExecutionEnv;
  readonly skillSnapshot: RunSkillSnapshot;
  readonly runnerGroup: string;
  readonly apiStartTime: number;
}

/**
 * Runner job profile for Pi runs. Runners advertise this as a distinct queue
 * lane backed by the default Sandbox resource shape, allowing the standby job
 * to be claimed independently from ordinary agent work.
 */
export { PI_STANDBY_PROFILE };

/** Build the non-secret model config persisted for the standby Sandbox. */
export function piSandboxModelConfig(config: PiEdgeModelConfig): PiModelConfig {
  return {
    provider: config.provider,
    baseUrl: config.baseUrl,
    model: config.model,
    apiKeyEnv:
      config.provider === "moonshotai"
        ? "ANTHROPIC_AUTH_TOKEN"
        : "OPENAI_API_KEY",
  };
}

const PI_EDGE_DEFAULT_BASE_URLS: Readonly<Record<string, string>> = {
  "openai-api-key": "https://api.openai.com/v1/",
  deepseek: "https://api.deepseek.com/",
  "moonshot-api-key": "https://api.moonshot.ai/v1/",
};

export function isPiEdgeCompatibleProviderType(type: string): boolean {
  return (
    type === "openrouter-codex" ||
    type === "vercel-ai-gateway-codex" ||
    Object.hasOwn(PI_EDGE_DEFAULT_BASE_URLS, type)
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
    provider.environment.OPENAI_BASE_URL ??
    PI_EDGE_DEFAULT_BASE_URLS[concreteType];
  const model =
    provider.environment.OPENAI_MODEL ??
    provider.environment.ANTHROPIC_MODEL ??
    provider.selectedModel;
  const apiKey = provider.piEdgeApiKey ?? Object.values(provider.secrets).at(0);
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
