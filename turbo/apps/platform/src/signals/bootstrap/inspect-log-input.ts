import { state, computed, command } from "ccstate";
import { onRef } from "../utils.ts";
import { loadInspectLogFile$ } from "../activity-page/inspect-log-signals";
import { detachedNavigateTo$ } from "../route";
import { pathname } from "../location";
import { ROUTES } from "../route-paths";

const internalInspectLogInput$ = state<HTMLInputElement | null>(null);

export const inspectLogInput$ = computed((get) => {
  return get(internalInspectLogInput$);
});

export const setInspectLogInput$ = onRef(
  command(({ set }, el: HTMLInputElement, signal: AbortSignal) => {
    signal.addEventListener("abort", () => {
      set(internalInspectLogInput$, null);
    });
    set(internalInspectLogInput$, el);
  }),
);

export const handleInspectLogFileChange$ = command(
  async ({ set }, file: File, signal: AbortSignal) => {
    await set(loadInspectLogFile$, file, signal);
    if (pathname() !== "/activities/inspect") {
      set(detachedNavigateTo$, ROUTES.activityInspect);
    }
  },
);
