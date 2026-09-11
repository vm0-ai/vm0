import { registerSessionResourceCleanup } from "@earendil-works/pi-ai";

import { piAgentStreamForConfig, resolvePiAgentModel } from "./model";
import type { PiAgentStreamConfig } from "./types";

export function initializePiSessionResourceRegistry(): void {
  // Vite's SSR bundle otherwise keeps Pi's registry behind only the lazy
  // Codex adapter initializer, while AgentSession.dispose() remains eager.
  // Registering and immediately removing a no-op makes the shared registry's
  // initialization explicit without changing its cleanup policy.
  const unregister = registerSessionResourceCleanup(() => {
    return undefined;
  });
  unregister();
}

export function registeredModelConfig(
  model: NonNullable<ReturnType<typeof resolvePiAgentModel>>,
  apiKey: string,
  config: PiAgentStreamConfig,
) {
  return {
    name: model.provider,
    baseUrl: model.baseUrl,
    apiKey,
    api: model.api,
    streamSimple: piAgentStreamForConfig(config),
    models: [
      {
        id: model.id,
        name: model.name,
        api: model.api,
        baseUrl: model.baseUrl,
        reasoning: model.reasoning,
        thinkingLevelMap: model.thinkingLevelMap,
        input: model.input,
        cost: model.cost,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
        headers: model.headers,
        compat: model.compat,
      },
    ],
  };
}
