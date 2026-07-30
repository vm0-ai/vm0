import type { AgentInstructions } from "../../signals/zero-page/agent-types.ts";
import { useTranslation } from "react-i18next";
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
  const { t } = useTranslation("agents");
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
            ariaLabel={t(($) => {
              return $.instructions.editor.accessibilityLabel;
            })}
            placeholder={t(($) => {
              return $.instructions.editor.placeholder;
            })}
            footerHint={t(($) => {
              return $.instructions.editor.footerHint;
            })}
            toolbarLabels={{
              bold: t(($) => {
                return $.instructions.editor.toolbar.bold;
              }),
              italic: t(($) => {
                return $.instructions.editor.toolbar.italic;
              }),
              strikethrough: t(($) => {
                return $.instructions.editor.toolbar.strikethrough;
              }),
              inlineCode: t(($) => {
                return $.instructions.editor.toolbar.inlineCode;
              }),
              heading1: t(($) => {
                return $.instructions.editor.toolbar.heading1;
              }),
              heading2: t(($) => {
                return $.instructions.editor.toolbar.heading2;
              }),
              heading3: t(($) => {
                return $.instructions.editor.toolbar.heading3;
              }),
              bulletList: t(($) => {
                return $.instructions.editor.toolbar.bulletList;
              }),
              orderedList: t(($) => {
                return $.instructions.editor.toolbar.orderedList;
              }),
              blockquote: t(($) => {
                return $.instructions.editor.toolbar.blockquote;
              }),
            }}
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
          message={t(($) => {
            return $.unsaved.message;
          })}
          discardLabel={t(($) => {
            return $.actions.discard;
          })}
          saveLabel={t(($) => {
            return $.actions.save;
          })}
        />
      )}
    </div>
  );
}
