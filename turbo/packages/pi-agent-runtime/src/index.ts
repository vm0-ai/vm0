import {
  isPiAgentModelSupported as isPiAgentModelSupportedImpl,
  resolvePiAgentModelApi as resolvePiAgentModelApiImpl,
} from "./model";
import type {
  PiAgentApi,
  PiAgentModelConfig,
  PiOpenAICompatibleProvider,
} from "./types";

/** Whether Pi's native provider catalog knows this model. */
export const isPiAgentModelSupported: (config: PiAgentModelConfig) => boolean =
  isPiAgentModelSupportedImpl;

/** VM0-supported Pi transport for a provider catalog model. */
export const resolvePiAgentModelApi: (args: {
  readonly provider: PiOpenAICompatibleProvider;
  readonly model: string;
}) => PiAgentApi | null = resolvePiAgentModelApiImpl;

export {
  PI_AGENT_APIS,
  PI_AGENT_THINKING_LEVELS,
  PI_OPENAI_COMPATIBLE_PROVIDERS,
} from "./types";
export type {
  PiAgentApi,
  PiAgentModelConfig,
  PiAgentThinkingLevel,
  PiOpenAICompatibleProvider,
} from "./types";
