import { command } from "ccstate";
import type { Editor, JSONContent } from "@tiptap/core";

export interface WorkflowHighlightStorage {
  workflowNames: readonly string[];
}

export interface TiptapWorkflowComposerEditorSyncArgs {
  readonly editor: Editor;
  readonly workflowNames?: readonly string[];
  readonly input?: string;
}

export function valueToWorkflowComposerDoc(value: string): JSONContent {
  const content: JSONContent[] = value.split("\n").map((line) => {
    return line.length > 0
      ? { type: "paragraph", content: [{ type: "text", text: line }] }
      : { type: "paragraph" };
  });
  return { type: "doc", content };
}

export function workflowComposerDocToString(editor: Editor): string {
  return editor.getText({
    blockSeparator: "\n",
    textSerializers: {
      hardBreak: () => {
        return "\n";
      },
    },
  });
}

function isWorkflowHighlightStorage(
  value: unknown,
): value is WorkflowHighlightStorage {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray(Reflect.get(value, "workflowNames"))
  );
}

export const syncTiptapWorkflowComposerEditor$ = command(
  (
    _context,
    { editor, workflowNames, input }: TiptapWorkflowComposerEditorSyncArgs,
  ): void => {
    if (workflowNames) {
      const workflowHighlightStorage = Reflect.get(
        editor.storage,
        "workflowHighlight",
      );
      if (isWorkflowHighlightStorage(workflowHighlightStorage)) {
        workflowHighlightStorage.workflowNames = workflowNames;
      }
    }
    if (input !== undefined && workflowComposerDocToString(editor) !== input) {
      editor.commands.setContent(valueToWorkflowComposerDoc(input), {
        emitUpdate: false,
      });
    }
  },
);
