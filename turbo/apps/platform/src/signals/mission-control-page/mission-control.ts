import { command, computed, state } from "ccstate";
import { tasksContract } from "@vm0/core";
import { zeroClient$ } from "../api-client";
import { accept } from "../../lib/accept";
import { onDomEventFn, setLoop } from "../utils.ts";
import { toggleTaskList$ } from "./mission-control-panels.ts";
import { openMissionControlTask$ } from "./mission-control-tasks.ts";

const internalReloadTasks$ = state(0);

export const tasks$ = computed(async (get) => {
  get(internalReloadTasks$);

  const client = get(zeroClient$)(tasksContract);
  const taskRequest = await accept(client.list({ query: {} }), [200]);

  return taskRequest.body.tasks;
});

const reloadTasks$ = command(({ set }) => {
  set(internalReloadTasks$, (x) => {
    return x + 1;
  });
});

const internalSelectedTaskIndex$ = state(0);

export const selectedTaskIndex$ = computed((get) => {
  return get(internalSelectedTaskIndex$);
});

const selectPrevTask$ = command(({ set }) => {
  set(internalSelectedTaskIndex$, (x) => {
    return Math.max(x - 1, 0);
  });
});

const selectNextTask$ = command(async ({ get, set }, signal: AbortSignal) => {
  const tasks = await get(tasks$);
  signal.throwIfAborted();

  set(internalSelectedTaskIndex$, (x) => {
    return Math.min(x + 1, tasks.length - 1);
  });
});

const openSelectedTask$ = command(async ({ get, set }, signal: AbortSignal) => {
  const tasks = await get(tasks$);
  signal.throwIfAborted();

  const index = get(selectedTaskIndex$);
  const task = tasks[index];
  if (!task) {
    return;
  }

  await set(openMissionControlTask$, task, signal);
});

export const setupMissionControlKeyboard$ = command(
  ({ set }, signal: AbortSignal) => {
    document.addEventListener(
      "keydown",
      onDomEventFn(async (e: KeyboardEvent) => {
        const target = e.target;
        if (!(target instanceof HTMLElement)) {
          return;
        }
        if (
          target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable
        ) {
          return;
        }

        if ((e.metaKey || e.ctrlKey) && e.key === "b") {
          e.preventDefault();
          set(toggleTaskList$);
          return;
        }

        if (e.key === "k") {
          e.preventDefault();
          set(selectPrevTask$);
        } else if (e.key === "j") {
          e.preventDefault();
          await set(selectNextTask$, signal);
        } else if (e.key === "Enter") {
          e.preventDefault();
          await set(openSelectedTask$, signal);
        }
      }),
      { signal },
    );
  },
);

export const setupMissionControlLoop$ = command(
  async ({ set, get }, signal: AbortSignal) => {
    await setLoop(
      async () => {
        set(reloadTasks$);
        await get(tasks$);
        signal.throwIfAborted();
        return false;
      },
      10_000,
      signal,
    );
  },
);
