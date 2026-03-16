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
  buildInstructions$,
  isBuildingInstructions$,
} from "../../signals/agent-detail/agent-detail.ts";
import type { AgentInstructions as AgentInstructionsType } from "../../signals/agent-detail/types.ts";

interface AgentInstructionsProps {
  instructions: AgentInstructionsType | null;
  loading: boolean;
}

export function AgentInstructions({
  instructions,
  loading,
}: AgentInstructionsProps) {
  const viewMode = useGet(instructionsViewMode$);
  const setViewMode = useSet(setInstructionsViewMode$);
  const edited = useGet(editedContent$);
  const isDirty = useGet(isInstructionsDirty$);
  const setEdited = useSet(setEditedContent$);
  const cancel = useSet(cancelEditInstructions$);
  const build = useSet(buildInstructions$);
  const isBuilding = useGet(isBuildingInstructions$);

  const displayContent = edited ?? instructions?.content ?? "";

  if (loading) {
    return (
      <div className="rounded-lg border border-border bg-card p-4">
        <Skeleton className="h-5 w-40 mb-6" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border bg-card p-4 flex flex-col h-full">
      <div className="flex items-center justify-between gap-4 shrink-0">
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
                disabled={isBuilding}
              >
                Discard
              </Button>
              <Button
                size="sm"
                className="h-7 text-xs"
                onClick={() => void build()}
                disabled={isBuilding}
              >
                {isBuilding ? "Building..." : "Build"}
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

      <div className="mt-2 flex-1 overflow-y-auto min-h-0">
        {viewMode === "markdown" ? (
          <textarea
            aria-label="Agent instructions editor"
            className="px-1 text-sm font-mono text-foreground w-full min-h-[200px] bg-transparent border-none outline-none resize-none whitespace-pre-wrap"
            value={displayContent}
            onChange={(e) => setEdited(e.target.value)}
            rows={displayContent.split("\n").length + 2}
          />
        ) : (
          <div className="px-1">
            <Markdown source={displayContent} />
          </div>
        )}
      </div>
    </div>
  );
}
