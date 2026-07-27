// Slash-workflow domain helpers and the suggestion menu, shared by the chat
// composer. Kept in its own module so the textarea composer and the TipTap
// workflow composer can both reuse them without an import cycle.
import { IconChevronRight, IconFileText } from "@tabler/icons-react";
import { cn, PopoverContent } from "@vm0/ui";
import { ROUTES } from "../../signals/route-paths.ts";
import { Link } from "../router/link.tsx";
import type { ComposerSlashWorkflow } from "../../signals/zero-page/workflow-composer-domain.ts";

export {
  buildComposerSlashWorkflows,
  matchesWorkflowQuery,
  type ComposerSlashWorkflow,
} from "../../signals/zero-page/workflow-composer-domain.ts";

function slashWorkflowOptionId(workflowName: string): string {
  return `slash-workflow-option-${workflowName}`;
}

const COMPOSER_SUGGESTION_COLLISION_GAP = 12;

export function composerSuggestionCollisionPadding():
  | number
  | { top: number; right: number; bottom: number; left: number } {
  // The global safe-area vars are applied as #root padding, while Radix portals
  // the menu to body. Read the resolved pixel values from #root so collision
  // detection keeps the portal inside the same visible content boundary.
  const root = document.getElementById("root");
  if (!root) {
    return COMPOSER_SUGGESTION_COLLISION_GAP;
  }
  const styles = window.getComputedStyle(root);
  const inset = (value: string): number => {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : 0;
  };
  return {
    top: COMPOSER_SUGGESTION_COLLISION_GAP + inset(styles.paddingTop),
    right: COMPOSER_SUGGESTION_COLLISION_GAP + inset(styles.paddingRight),
    bottom: COMPOSER_SUGGESTION_COLLISION_GAP + inset(styles.paddingBottom),
    left: COMPOSER_SUGGESTION_COLLISION_GAP + inset(styles.paddingLeft),
  };
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
  query,
  loading,
  selectedIndex,
  showWorkflowsPageLink,
  onSelect,
}: {
  readonly workflows: readonly ComposerSlashWorkflow[];
  readonly query: string;
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
      collisionPadding={composerSuggestionCollisionPadding()}
      updatePositionStrategy="always"
      // Keep focus in the TipTap editor: the menu's keyboard navigation is
      // handled there, so the popover must never steal focus when it opens.
      onOpenAutoFocus={(event) => {
        event.preventDefault();
      }}
      className="flex h-[min(16rem,var(--radix-popover-content-available-height))] w-[300px] max-w-[calc(100vw-1.5rem)] flex-col overflow-hidden p-0 md:h-[min(20rem,var(--radix-popover-content-available-height))]"
      data-testid="slash-workflow-menu"
    >
      <div className="px-2.5 pt-2 pb-2 text-xs font-medium text-muted-foreground">
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
                  "flex w-full flex-col items-start gap-0.5 rounded px-2 py-1.5 text-left transition-colors",
                  selected ? "bg-accent" : "hover:bg-accent/60",
                )}
                onMouseDown={(event) => {
                  event.preventDefault();
                  onSelect(workflow);
                }}
              >
                <span className="w-full truncate font-mono text-sm text-foreground">
                  <span className="text-primary">/</span>
                  {query && (
                    <span className="text-primary/60">
                      {workflow.name.slice(0, query.length)}
                    </span>
                  )}
                  {workflow.name.slice(query.length)}
                </span>
                {workflow.description && (
                  <span className="w-full truncate text-xs text-muted-foreground/70">
                    {workflow.description}
                  </span>
                )}
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
        <div className="shrink-0 border-t border-border/60 bg-popover/95 p-1">
          <Link
            pathname={ROUTES.workflows}
            onMouseDown={(event) => {
              // Keep the composer focused until Link handles the click.
              event.preventDefault();
            }}
            className="flex h-8 w-full items-center justify-between rounded px-2 text-sm font-medium text-popover-foreground transition-colors hover:bg-accent"
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
