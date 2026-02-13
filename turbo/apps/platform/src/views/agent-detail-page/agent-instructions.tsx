import { useGet, useSet } from "ccstate-react";
import { Tabs, TabsList, TabsTrigger } from "@vm0/ui/components/ui/tabs";
import { Skeleton } from "@vm0/ui/components/ui/skeleton";
import MarkdownPreview from "@uiw/react-markdown-preview";
import {
  instructionsViewMode$,
  setInstructionsViewMode$,
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

  if (loading) {
    return (
      <div className="flex-1 rounded-lg border border-border p-4">
        <Skeleton className="h-5 w-40 mb-6" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (!instructions?.content) {
    return (
      <div className="flex-1 rounded-lg border border-border p-4">
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
    <div className="flex-1 rounded-lg border border-border p-4 flex flex-col">
      <div className="flex items-start justify-between gap-4">
        <h2 className="text-base font-medium text-foreground">
          Agent instructions
        </h2>
        <Tabs value={viewMode} onValueChange={(v) => setViewMode(v)}>
          <TabsList>
            <TabsTrigger value="markdown">Markdown</TabsTrigger>
            <TabsTrigger value="preview">Preview</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      <div className="mt-6 flex-1 overflow-y-auto">
        {viewMode === "markdown" ? (
          <pre className="px-1 text-sm font-mono text-foreground overflow-x-auto whitespace-pre-wrap">
            {instructions.content}
          </pre>
        ) : (
          <div className="px-1">
            <MarkdownPreview
              source={instructions.content}
              className="!bg-transparent !text-foreground text-sm"
              style={{
                backgroundColor: "transparent",
                fontSize: "0.875rem",
                lineHeight: "1.5",
              }}
            />
          </div>
        )}
      </div>
    </div>
  );
}
