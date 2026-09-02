import type { SimpleStreamOptions } from "@earendil-works/pi-ai";

import type { PiAgentServiceTier } from "./types";
import type { PiObservedServiceTier } from "./api-types";

/** Internal extension consumed by Pi's native OpenAI Responses adapter. */
export interface PiAgentStreamOptions extends SimpleStreamOptions {
  readonly onObservedServiceTier?: (serviceTier: PiObservedServiceTier) => void;
  readonly serviceTier?: PiAgentServiceTier;
}
