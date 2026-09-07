import { command, computed, state } from "ccstate";
import type { GenerationTemplateRequest } from "@okouai/api-contracts/contracts/chat-threads";
import type { DraftSignals } from "./chat-draft.ts";
import { Fragment } from "@tiptap/pm/model";
import { i18n } from "../../i18n/index.ts";
import { composerTaskEntriesEnabled$ } from "../external/feature-switch.ts";
import type { ComposerUiSignalGroups } from "./chat-composer.ts";
import type {
  ComposerTemplateAttachment,
  WorkflowComposerSignals,
  WorkflowComposerSubmissionSnapshot,
} from "./tiptap-workflow-composer.ts";
import {
  createEditorDocumentSnapshot,
  INLINE_TEMPLATE_NODE_NAME,
  TEMPLATE_ATTACHMENT_NODE_NAME,
} from "./user-message-document-codec.ts";

export type ComposerTask =
  | "workflow"
  | "slides"
  | "image"
  | "video"
  | "website";

function createClearTaskTemplatesSignal(
  composer: WorkflowComposerSignals,
  draft: DraftSignals,
) {
  return command(({ get, set }, task: ComposerTask | null) => {
    const category = task === "image" ? "illustration" : task;
    const templateType = task === "slides" ? "presentation" : category;
    const legacy = get(draft.generationTemplate$);
    if (legacy && legacy.type !== templateType) {
      set(draft.setGenerationTemplate$, undefined);
    }
    const editor = composer.editor;
    const ranges: { from: number; to: number }[] = [];
    editor.state.doc.descendants((node, position) => {
      if (
        (node.type.name === INLINE_TEMPLATE_NODE_NAME ||
          node.type.name === TEMPLATE_ATTACHMENT_NODE_NAME) &&
        node.attrs.category !== category
      ) {
        ranges.push({ from: position, to: position + node.nodeSize });
      }
    });
    if (ranges.length === 0) {
      return;
    }
    const transaction = editor.state.tr;
    for (const range of ranges.reverse()) {
      transaction.delete(range.from, range.to);
    }
    if (transaction.doc.childCount === 0) {
      transaction.insert(0, editor.schema.node("paragraph"));
    }
    editor.view.dispatch(transaction);
  });
}

export function createComposerTaskSignals(
  ui: ComposerUiSignalGroups,
  composer: WorkflowComposerSignals,
  draft: DraftSignals,
) {
  const clearTaskTemplates$ = createClearTaskTemplatesSignal(composer, draft);
  const internalTask$ = state<ComposerTask | null>(null);
  const task$ = computed((get) => {
    return get(composerTaskEntriesEnabled$) ? get(internalTask$) : null;
  });
  const selectTask$ = command(({ get, set }, task: ComposerTask | null) => {
    if (get(internalTask$) !== task) {
      set(ui.videoOptions.setVideoRunOptions$, {});
    }
    set(clearTaskTemplates$, task);
    set(internalTask$, task);
    set(
      ui.model.setMediaModelCategory$,
      task === "image" || task === "video" ? task : null,
    );
    set(composer.focus$);
  });
  const resetTask$ = command(({ set }) => {
    set(internalTask$, null);
    set(ui.videoOptions.setVideoRunOptions$, {});
  });
  // Capture the selected task in the same canonical document as text, files,
  // and template references. The editor and a failed send's draft stay intact.
  const prepareSubmission$ = command(
    (
      { get },
      submission: WorkflowComposerSubmissionSnapshot,
    ): WorkflowComposerSubmissionSnapshot => {
      const task = get(task$);
      if (task === null) {
        return submission;
      }
      const instructions = i18n.t(
        ($) => {
          return $.chat.taskEntries.instructions;
        },
        {
          returnObjects: true,
        },
      );
      const instruction = instructions[task];
      const schema = composer.editor.schema;
      const document = schema.nodeFromJSON(
        submission.editorDocument.toEditorDocument(),
      );
      const paragraph = schema.node(
        "paragraph",
        null,
        schema.text(instruction),
      );
      return {
        prompt: `${instruction}\n${submission.prompt}`,
        editorDocument: createEditorDocumentSnapshot(
          document.copy(Fragment.from(paragraph).append(document.content)),
        ),
      };
    },
  );
  const insertTemplate$ = command(
    (
      { get, set },
      request: GenerationTemplateRequest,
      attachment: ComposerTemplateAttachment,
    ) => {
      if (get(task$) !== null) {
        const templateTasks: Record<
          ComposerTemplateAttachment["type"],
          ComposerTask | null
        > = {
          workflow: "workflow",
          presentation: "slides",
          illustration: "image",
          video: "video",
          website: "website",
          avatar: null,
        };
        set(selectTask$, templateTasks[attachment.type]);
      }
      set(composer.insertTemplate$, request, attachment);
    },
  );
  return {
    task$,
    selectTask$,
    resetTask$,
    prepareSubmission$,
    insertTemplate$,
  };
}
