import { isPiAgentModelSupported as isPiAgentModelSupportedImpl } from "./model";
import type { PiAgentModelConfig } from "./types";

/** Whether Pi's native provider catalog knows this model. */
export const isPiAgentModelSupported: (config: PiAgentModelConfig) => boolean =
  isPiAgentModelSupportedImpl;

export { PI_OPENAI_COMPATIBLE_PROVIDERS } from "./types";
export type { PiAgentModelConfig, PiOpenAICompatibleProvider } from "./types";
