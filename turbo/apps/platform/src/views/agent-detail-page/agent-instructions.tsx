import { useGet, useSet } from "ccstate-react";
import { Tabs, TabsList, TabsTrigger } from "@vm0/ui/components/ui/tabs";
import { Skeleton } from "@vm0/ui/components/ui/skeleton";
import { Button } from "@vm0/ui/components/ui/button";
import { Markdown } from "../components/markdown.tsx";
import {
  instructionsViewMode$,
  setInstructionsViewMode$,
  editedContent$,
  isInstructionsDirty$,
  setEditedContent$,
  cancelEditInstructions$,
  saveInstructions$,
  isSavingInstructions$,
} from "../../signals/agent-detail/agent-detail.ts";
import type { AgentInstructions as AgentInstructionsType } from "../../signals/agent-detail/types.ts";

interface AgentInstructionsProps {
  instructions: AgentInstructionsType | null;
  loading: boolean;
  isOwner: boolean;
}

export function AgentInstructions({
  instructions,
  loading,
  isOwner,
}: AgentInstructionsProps) {
  const viewMode = useGet(instructionsViewMode$);
  const setViewMode = useSet(setInstructionsViewMode$);
  const edited = useGet(editedContent$);
  const isDirty = useGet(isInstructionsDirty$);
  const setEdited = useSet(setEditedContent$);
  const cancel = useSet(cancelEditInstructions$);
  const save = useSet(saveInstructions$);
  const isSaving = useGet(isSavingInstructions$);

  const displayContent = edited ?? instructions?.content ?? "";

  if (loading) {
    return (
      <div className="rounded-lg border border-border p-4">
        <Skeleton className="h-5 w-40 mb-6" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (!instructions?.content && !isOwner) {
    return (
      <div className="rounded-lg border border-border p-4">
        <h2 className="text-base font-medium text-foreground">
          Agent instructions
        </h2>
        <p className="text-sm text-muted-foreground mt-6">
          No instructions configured
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border p-4">
      <div className="flex items-center justify-between gap-4">
        <h2 className="text-base font-medium text-foreground">
          Agent instructions
        </h2>
        <div className="flex items-center gap-2">
          {isDirty && (
            <>
              <span className="text-xs text-muted-foreground">Unsaved</span>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-xs"
                onClick={() => cancel()}
                disabled={isSaving}
              >
                Discard
              </Button>
              <Button
                size="sm"
                className="h-7 text-xs"
                onClick={() => void save()}
                disabled={isSaving}
              >
                {isSaving ? "Saving..." : "Save"}
              </Button>
            </>
          )}
          <Tabs value={viewMode} onValueChange={(v) => setViewMode(v)}>
            <TabsList>
              <TabsTrigger value="markdown">Markdown</TabsTrigger>
              <TabsTrigger value="preview">Preview</TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
      </div>

      <div className="instructions-content mt-2">
        {viewMode === "markdown" ? (
          isOwner ? (
            <textarea
              aria-label="Agent instructions editor"
              className="px-1 text-sm font-mono text-foreground w-full min-h-[200px] bg-transparent border-none outline-none resize-none whitespace-pre-wrap"
              value={displayContent}
              onChange={(e) => setEdited(e.target.value)}
              rows={displayContent.split("\n").length + 2}
            />
          ) : (
            <pre className="px-1 text-sm font-mono text-foreground overflow-x-auto whitespace-pre-wrap">
              {instructions?.content}
            </pre>
          )
        ) : (
          <div className="px-1">
            <Markdown source={displayContent} />
          </div>
        )}
      </div>
    </div>
  );
}
