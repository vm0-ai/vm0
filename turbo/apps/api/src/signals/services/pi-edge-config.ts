/**
 * Cycle-free Pi edge configuration shared between the launch pipeline
 * (agent-run-create) and the edge turn runner (pi-edge-loop.service). This
 * module must not import other services.
 */

export interface PiEdgeModelConfig {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
}

export interface PiEdgeTurnArgs {
  readonly runId: string;
  readonly userId: string;
  readonly orgId: string;
  readonly prompt: string;
  readonly model: PiEdgeModelConfig;
  readonly apiStartTime: number;
}

/**
 * Runner job profile for Pi runs. No runner advertises it yet, so the
 * launch-time job row stays unclaimed and expires; the pi-standby prewarm
 * (workstream B of #25433) will claim it.
 */
export const PI_STANDBY_PROFILE = "vm0/pi-standby";

const PI_EDGE_COMPATIBLE_TYPE = "openai-api-key";

/**
 * Resolves the edge-callable model config from a resolved run provider.
 * Only OpenAI-compatible providers with an eagerly resolved secret qualify;
 * firewall-injected providers return null and fall back to the legacy path.
 */
export function resolvePiEdgeModelConfig(
  provider: {
    readonly type: string;
    readonly concreteType?: string;
    readonly environment: Record<string, string>;
    readonly secrets: Record<string, string>;
    readonly selectedModel: string | null;
  } | null,
): PiEdgeModelConfig | null {
  if (!provider || !provider.selectedModel) {
    return null;
  }
  if ((provider.concreteType ?? provider.type) !== PI_EDGE_COMPATIBLE_TYPE) {
    return null;
  }
  const baseUrlEntry = Object.entries(provider.environment).find(([key]) => {
    return key.endsWith("BASE_URL");
  });
  const [apiKey] = Object.values(provider.secrets);
  if (!baseUrlEntry || apiKey === undefined || apiKey.length === 0) {
    return null;
  }
  return {
    baseUrl: baseUrlEntry[1],
    apiKey,
    model: provider.selectedModel,
  };
}
