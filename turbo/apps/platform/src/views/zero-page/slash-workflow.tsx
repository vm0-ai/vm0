// Slash-workflow domain helpers and the suggestion menu, shared by the chat
// composer. Kept in its own module so the textarea composer and the TipTap
// workflow composer can both reuse them without an import cycle.
import { IconChevronRight, IconFileText } from "@tabler/icons-react";
import type { ZeroWorkflowSummary } from "@vm0/api-contracts/contracts/zero-workflows";
import { cn, PopoverContent } from "@vm0/ui";
import { Link } from "../router/link.tsx";

export interface SlashWorkflowRange {
  readonly start: number;
  readonly end: number;
  readonly query: string;
}

export interface ComposerSlashWorkflow {
  readonly name: string;
  readonly displayName: string | null;
  readonly description: string | null;
  readonly token: string;
}

export function findActiveSlashWorkflowRange(
  value: string,
  caretIndex: number,
): SlashWorkflowRange | null {
  const beforeCaret = value.slice(0, caretIndex);
  const match = /(?:^|\s)\/([a-z0-9-]*)$/i.exec(beforeCaret);
  if (!match) {
    return null;
  }

  const query = match[1] ?? "";
  const slashOffset = match[0].lastIndexOf("/");
  const start = beforeCaret.length - match[0].length + slashOffset;
  return { start, end: caretIndex, query };
}

export function matchesWorkflowQuery(
  workflow: ComposerSlashWorkflow,
  query: string,
): boolean {
  if (!query) {
    return true;
  }

  const normalizedQuery = query.toLowerCase();
  return [workflow.name, workflow.displayName ?? "", workflow.description ?? ""]
    .join(" ")
    .toLowerCase()
    .includes(normalizedQuery);
}

export function workflowTokenPattern(
  workflowNames: readonly string[],
): RegExp | null {
  if (workflowNames.length === 0) {
    return null;
  }

  const escaped = workflowNames.map((name) => {
    return name.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
  });
  return new RegExp(`/(?:${escaped.join("|")})(?=$|\\s)`, "g");
}

export function buildComposerSlashWorkflows({
  agentId,
  workflows,
}: {
  readonly agentId: string | null | undefined;
  readonly workflows: readonly ZeroWorkflowSummary[];
}): readonly ComposerSlashWorkflow[] {
  if (!agentId) {
    return [];
  }

  return workflows
    .filter((workflow) => {
      return workflow.attachedAgents.some((agent) => {
        return agent.agentId === agentId;
      });
    })
    .map((workflow) => {
      const name = workflow.name;
      return {
        name,
        displayName: workflow.displayName,
        description: workflow.description,
        token: `/${name}`,
      };
    });
}

function slashWorkflowOptionId(workflowName: string): string {
  return `slash-workflow-option-${workflowName}`;
}

export function scrollSlashWorkflowIntoView(
  workflow: ComposerSlashWorkflow | undefined,
): void {
  if (!workflow) {
    return;
  }

  window.requestAnimationFrame(() => {
    const option = document.getElementById(
      slashWorkflowOptionId(workflow.name),
    );
    if (option && typeof option.scrollIntoView === "function") {
      option.scrollIntoView({ block: "nearest" });
    }
  });
}

export function SlashWorkflowMenu({
  workflows,
  loading,
  selectedIndex,
  showWorkflowsPageLink,
  onSelect,
}: {
  readonly workflows: readonly ComposerSlashWorkflow[];
  readonly loading: boolean;
  readonly selectedIndex: number;
  readonly showWorkflowsPageLink: boolean;
  readonly onSelect: (workflow: ComposerSlashWorkflow) => void;
}) {
  return (
    <PopoverContent
      side="top"
      align="start"
      sideOffset={8}
      collisionPadding={12}
      // Keep focus in the TipTap editor: the menu's keyboard navigation is
      // handled there, so the popover must never steal focus when it opens.
      onOpenAutoFocus={(event) => {
        event.preventDefault();
      }}
      className="flex max-h-80 w-[260px] max-w-[calc(100vw-1.5rem)] flex-col overflow-hidden p-0"
      data-testid="slash-workflow-menu"
    >
      <div className="px-2.5 pt-2 pb-1 text-[0.6875rem] font-medium uppercase tracking-wide text-muted-foreground">
        Workflows
      </div>
      {loading ? (
        <div className="px-2.5 py-2 text-sm text-muted-foreground">
          Loading workflows...
        </div>
      ) : workflows.length > 0 ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-1.5">
          {workflows.map((workflow, index) => {
            const selected = index === selectedIndex;
            return (
              <button
                id={slashWorkflowOptionId(workflow.name)}
                key={workflow.name}
                type="button"
                className={cn(
                  "flex w-full items-center rounded px-2 py-1.5 text-left transition-colors",
                  selected ? "bg-accent" : "hover:bg-accent/60",
                )}
                onMouseDown={(event) => {
                  event.preventDefault();
                  onSelect(workflow);
                }}
              >
                <span className="truncate font-mono text-sm text-primary">
                  {workflow.token}
                </span>
              </button>
            );
          })}
        </div>
      ) : (
        <div className="px-2.5 pt-1 pb-2.5 text-sm text-muted-foreground">
          No matching workflows
        </div>
      )}
      {showWorkflowsPageLink && (
        <div className="shrink-0 border-t border-border/60 bg-popover/95 p-1.5">
          <Link
            pathname="/workflows"
            className="flex h-9 w-full items-center justify-between rounded px-2 text-sm font-medium text-popover-foreground transition-colors hover:bg-accent"
          >
            <span className="flex min-w-0 items-center gap-2">
              <IconFileText
                size={16}
                stroke={1.8}
                className="shrink-0 text-muted-foreground"
              />
              <span className="truncate">View all workflows</span>
            </span>
            <IconChevronRight
              size={16}
              stroke={1.8}
              className="shrink-0 text-muted-foreground"
            />
          </Link>
        </div>
      )}
    </PopoverContent>
  );
}
