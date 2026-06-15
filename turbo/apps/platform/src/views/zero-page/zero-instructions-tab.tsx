import type { AgentInstructions } from "../../signals/zero-page/agent-types.ts";
import { ZeroUnsavedBar } from "./zero-unsaved-bar.tsx";
import { TiptapInstructionsEditor } from "./tiptap-instructions-editor.tsx";

interface ZeroInstructionsTabProps {
  instructions: AgentInstructions | null;
  loading: boolean;
  fetchError: string | null;
  editedContent: string | null;
  isDirty: boolean;
  isBuilding: boolean;
  buildError: string | null;
  onEdit: (value: string) => void;
  onDiscard: () => void;
  onBuild: () => void;
}

export function ZeroInstructionsTab({
  instructions,
  loading,
  fetchError,
  editedContent,
  isDirty,
  isBuilding,
  buildError,
  onEdit,
  onDiscard,
  onBuild,
}: ZeroInstructionsTabProps) {
  const rawContent = instructions?.content ?? "";
  const displayContent = editedContent ?? rawContent;

  // Use rawContent as key so the editor remounts when saved content changes
  // (initial fetch or after discard). During typing, editedContent changes
  // but rawContent stays the same, so the editor keeps its internal state.
  const editorKey = rawContent;

  return (
    <div className="mx-auto max-w-[900px]">
      {loading ? (
        <div className="space-y-4 animate-pulse">
          <div className="h-5 w-40 rounded bg-muted/50" />
          <div className="h-64 w-full rounded bg-muted/30" />
        </div>
      ) : fetchError ? (
        <p className="text-sm text-destructive">{fetchError}</p>
      ) : (
        <>
          <TiptapInstructionsEditor
            key={editorKey}
            initialContent={displayContent}
            onChange={onEdit}
            disabled={isBuilding}
          />
          {buildError && (
            <p className="text-xs font-medium text-destructive mt-3">
              {buildError}
            </p>
          )}
        </>
      )}

      {(isDirty || isBuilding) && (
        <ZeroUnsavedBar
          onDiscard={onDiscard}
          onSave={onBuild}
          saving={isBuilding}
        />
      )}
    </div>
  );
}
