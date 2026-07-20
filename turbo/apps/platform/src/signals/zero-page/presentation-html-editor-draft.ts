import { computed, type Computed } from "ccstate";
import { pageSignal$ } from "../page-signal.ts";
import { currentPresentationEditorUrl$ } from "./zero-artifact-sidebar.ts";

/** Create the draft resource owned by the active presentation editor route. */
export function createCurrentPresentationDraft<T>(
  load: (url: string, signal: AbortSignal) => Promise<T>,
): Computed<Promise<T>> {
  return computed((get) => {
    const url = get(currentPresentationEditorUrl$);
    if (!url) {
      throw new Error("Presentation editor URL is unavailable");
    }
    return load(url, get(pageSignal$));
  });
}
