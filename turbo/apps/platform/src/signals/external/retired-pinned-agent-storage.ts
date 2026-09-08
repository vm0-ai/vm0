import { command } from "ccstate";
import { localStorageSignals } from "./local-storage.ts";

const { clear$: clearPinnedAgentGridRows$ } = localStorageSignals(
  "pinnedAgentGridRows",
);
const { clear$: clearPinnedAgentPreviewCache$ } = localStorageSignals(
  "vm0:pinned-agent-preview-cache:v1",
);

export const clearRetiredPinnedAgentStorage$ = command(({ set }) => {
  set(clearPinnedAgentGridRows$);
  set(clearPinnedAgentPreviewCache$);
});
