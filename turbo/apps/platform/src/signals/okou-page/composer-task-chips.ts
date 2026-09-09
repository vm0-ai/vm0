import { command, computed, state } from "ccstate";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { featureSwitch$ } from "../external/feature-switch.ts";
import type {
  ComposerCreateMode,
  ComposerCreateSignals,
} from "./composer-create.ts";

export type ComposerTask = ComposerCreateMode | "workflow" | "website";
export type ComposerIdeaTask = Exclude<ComposerTask, "presentation">;

export function createComposerTaskChipsSignals(create: ComposerCreateSignals) {
  const enabled$ = computed((get) => {
    return get(featureSwitch$)[FeatureSwitchKey.ComposerTaskChips];
  });
  const internalGeneralTask$ = state<"workflow" | "website" | null>("workflow");
  const task$ = computed((get): ComposerTask | null => {
    if (!get(enabled$) || get(create.choosing$)) {
      return null;
    }
    return get(create.mode$) ?? get(internalGeneralTask$);
  });
  const selectTask$ = command(({ get, set }, task: ComposerTask | null) => {
    if (!get(enabled$)) {
      return;
    }
    const next = get(task$) === task ? null : task;
    set(
      internalGeneralTask$,
      next === "workflow" || next === "website" ? next : null,
    );
    if (next === null || next === "workflow" || next === "website") {
      set(create.setMode$, null);
    } else {
      set(create.selectCommand$, next);
    }
  });
  const internalIdeaPages$ = state({
    image: 0,
    workflow: 0,
    video: 0,
    website: 0,
  });
  const ideaPages$ = computed((get) => {
    return get(internalIdeaPages$);
  });
  const nextIdeas$ = command(
    ({ get, set }, task: ComposerIdeaTask, pageCount: number) => {
      const pages = get(internalIdeaPages$);
      set(internalIdeaPages$, {
        ...pages,
        [task]: (pages[task] + 1) % pageCount,
      });
    },
  );
  return { enabled$, task$, selectTask$, ideaPages$, nextIdeas$ };
}

export type ComposerTaskChipsSignals = ReturnType<
  typeof createComposerTaskChipsSignals
>;
