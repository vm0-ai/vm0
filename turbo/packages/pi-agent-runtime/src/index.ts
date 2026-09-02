import { isPiAgentModelSupported as isPiAgentModelSupportedImpl } from "./model";
import type { PiAgentModelConfig } from "./types";

/** Whether Pi's native provider catalog knows this model. */
export const isPiAgentModelSupported: (config: PiAgentModelConfig) => boolean =
  isPiAgentModelSupportedImpl;

export { resolvePiAgentCredential } from "./credential";
export { PI_AGENT_THINKING_LEVELS } from "./types";
export type {
  PiAgentCredentialHeaderTemplate,
  PiAgentCredentialTarget,
  PiAgentModelConfig,
  PiAgentRequestHeaders,
  PiAgentServiceTier,
  PiAgentThinkingLevel,
} from "./types";
