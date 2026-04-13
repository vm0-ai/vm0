import { command, computed, state } from "ccstate";
import {
  zeroSkillsCollectionContract,
  zeroSkillsDetailContract,
  zeroSkillsSkillMdContract,
} from "@vm0/core";
import { zeroClient$ } from "../api-client.ts";
import { accept } from "../../lib/accept.ts";
import { reloadSkillsList$ } from "./skills-list.ts";

type EditorMode =
  | { kind: "closed" }
  | { kind: "create" }
  | { kind: "edit"; name: string };

interface EditorDraft {
  name: string;
  displayName: string;
  description: string;
  content: string;
}

interface EditorOriginal {
  name: string;
  displayName: string;
  description: string;
  content: string;
  /** Other files (non-SKILL.md) preserved by the API on PATCH. UI shows them
   *  read-only as a hint that this skill must be edited via CLI for files
   *  beyond SKILL.md. */
  otherFiles: { path: string; size: number }[];
}

function emptyDraft(): EditorDraft {
  return { name: "", displayName: "", description: "", content: "" };
}

const internalMode$ = state<EditorMode>({ kind: "closed" });
const internalDraft$ = state<EditorDraft>(emptyDraft());
const internalOriginal$ = state<EditorOriginal | null>(null);
const internalSaving$ = state<boolean>(false);
const internalError$ = state<string | null>(null);
const internalLoading$ = state<boolean>(false);

export const editorMode$ = computed((get) => {
  return get(internalMode$);
});

export const editorDraft$ = computed((get) => {
  return get(internalDraft$);
});

export const editorOriginal$ = computed((get) => {
  return get(internalOriginal$);
});

export const editorSaving$ = computed((get) => {
  return get(internalSaving$);
});

export const editorError$ = computed((get) => {
  return get(internalError$);
});

export const editorLoading$ = computed((get) => {
  return get(internalLoading$);
});

export const editorDirty$ = computed((get) => {
  const mode = get(internalMode$);
  const draft = get(internalDraft$);
  if (mode.kind === "closed") {
    return false;
  }
  if (mode.kind === "create") {
    return (
      draft.name !== "" ||
      draft.displayName !== "" ||
      draft.description !== "" ||
      draft.content !== ""
    );
  }
  const original = get(internalOriginal$);
  if (!original) {
    return false;
  }
  return (
    draft.displayName !== original.displayName ||
    draft.description !== original.description ||
    draft.content !== original.content
  );
});

export const setEditorDraft$ = command(
  ({ set }, patch: Partial<EditorDraft>) => {
    set(internalDraft$, (prev) => {
      return { ...prev, ...patch };
    });
  },
);

export const openCreateEditor$ = command(({ set }) => {
  set(internalMode$, { kind: "create" });
  set(internalDraft$, emptyDraft());
  set(internalOriginal$, null);
  set(internalError$, null);
});

export const closeEditor$ = command(({ set }) => {
  set(internalMode$, { kind: "closed" });
  set(internalDraft$, emptyDraft());
  set(internalOriginal$, null);
  set(internalError$, null);
  set(internalSaving$, false);
  set(internalLoading$, false);
});

export const openEditEditor$ = command(
  async ({ get, set }, name: string, signal: AbortSignal) => {
    set(internalMode$, { kind: "edit", name });
    set(internalLoading$, true);
    set(internalError$, null);
    set(internalOriginal$, null);
    set(internalDraft$, emptyDraft());

    const client = get(zeroClient$)(zeroSkillsDetailContract);
    const result = await accept(
      client.get({ params: { name } }),
      [200],
    ).finally(() => {
      set(internalLoading$, false);
    });
    signal.throwIfAborted();
    const body = result.body;
    const otherFiles = (body.files ?? []).filter((f) => {
      return f.path !== "SKILL.md";
    });
    const original: EditorOriginal = {
      name: body.name,
      displayName: body.displayName ?? "",
      description: body.description ?? "",
      content: body.content ?? "",
      otherFiles,
    };
    set(internalOriginal$, original);
    set(internalDraft$, {
      name: body.name,
      displayName: original.displayName,
      description: original.description,
      content: original.content,
    });
  },
);

export const submitEditor$ = command(
  async ({ get, set }, _signal: AbortSignal) => {
    const mode = get(internalMode$);
    if (mode.kind === "closed") {
      return;
    }
    const draft = get(internalDraft$);
    set(internalSaving$, true);
    set(internalError$, null);

    const submitPromise =
      mode.kind === "create"
        ? accept(
            get(zeroClient$)(zeroSkillsCollectionContract).create({
              body: {
                name: draft.name,
                displayName: draft.displayName || undefined,
                description: draft.description || undefined,
                files: [{ path: "SKILL.md", content: draft.content }],
              },
            }),
            [201],
          )
        : accept(
            get(zeroClient$)(zeroSkillsSkillMdContract).patchSkillMd({
              params: { name: mode.name },
              body: {
                content: draft.content,
                displayName: draft.displayName || null,
                description: draft.description || null,
              },
            }),
            [200],
          );

    await submitPromise.then(
      () => {
        set(reloadSkillsList$);
        set(internalMode$, { kind: "closed" });
        set(internalDraft$, emptyDraft());
        set(internalOriginal$, null);
        set(internalSaving$, false);
      },
      (error: unknown) => {
        set(
          internalError$,
          error instanceof Error ? error.message : "Save failed",
        );
        set(internalSaving$, false);
        throw error;
      },
    );
  },
);
