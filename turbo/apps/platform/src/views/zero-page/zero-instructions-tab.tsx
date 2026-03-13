import { stripMetadataFrontmatter } from "@vm0/core";
import { Card, CardContent } from "@vm0/ui";
import type { AgentInstructions } from "../../signals/agent-detail/types.ts";
import { ZeroUnsavedBar } from "./zero-unsaved-bar.tsx";

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
  const strippedContent = stripMetadataFrontmatter(rawContent);
  const displayContent = editedContent ?? strippedContent;

  return (
    <div className="mx-auto max-w-[900px] px-7">
      <Card className="zero-card-white">
        <CardContent className="py-7">
          {loading ? (
            <div className="space-y-4 animate-pulse">
              <div className="h-5 w-40 rounded bg-muted/50" />
              <div className="h-64 w-full rounded bg-muted/30" />
            </div>
          ) : fetchError ? (
            <p className="text-sm text-destructive">{fetchError}</p>
          ) : (
            <>
              <textarea
                aria-label="Agent instructions editor"
                className="px-1 text-sm font-mono text-foreground w-full min-h-[200px] bg-transparent border-none outline-none resize-none whitespace-pre-wrap leading-relaxed"
                value={displayContent}
                onChange={(e) => onEdit(e.target.value)}
                rows={Math.max(10, displayContent.split("\n").length + 2)}
                disabled={isBuilding}
                placeholder="Write instructions for your agent..."
              />
              <div className="flex items-center gap-2 pt-5 mt-5 border-t border-border/60">
                <p className="text-muted-foreground text-xs">
                  Edit the instructions directly to customize your agent&apos;s
                  behavior.
                </p>
                {buildError && (
                  <span className="text-xs font-medium text-destructive">
                    {buildError}
                  </span>
                )}
              </div>
            </>
          )}
        </CardContent>
      </Card>

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
