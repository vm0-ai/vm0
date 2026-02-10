import { command, computed, state } from "ccstate";
import { pathParams$ } from "../route";

const internalLogDetailSearchTerm$ = state("");

export type ViewMode = "formatted" | "raw";
const internalViewMode$ = state<ViewMode>("formatted");

const internalCurrentMatchIndex$ = state(0);
const internalTotalMatchCount$ = state(0);

export const currentLogId$ = computed((get) => {
  const params = get(pathParams$) as { id?: string } | undefined;
  return params?.id ?? null;
});

export const logDetailSearchTerm$ = internalLogDetailSearchTerm$;

export const viewMode$ = internalViewMode$;

export const currentMatchIndex$ = internalCurrentMatchIndex$;
export const totalMatchCount$ = internalTotalMatchCount$;

export const setLogDetailSearchTerm$ = command(({ set }, term: string) => {
  set(internalLogDetailSearchTerm$, term);
});
