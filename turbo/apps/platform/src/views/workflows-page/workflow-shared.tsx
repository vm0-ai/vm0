// Shared presentational helpers for the workflow list, index, and detail views.
import type {
  ZeroWorkflowSummary,
  ZeroWorkflowTriggerSummary,
} from "@vm0/api-contracts/contracts/zero-workflows";
import { IconLock, IconWorld } from "@tabler/icons-react";

export function workflowTitle(workflow: {
  readonly name: string;
  readonly displayName: string | null;
}): string {
  return workflow.displayName ?? workflow.name;
}

export function isMarkdownPath(path: string): boolean {
  return /\.(md|markdown|mdx)$/i.test(path);
}

export function agentLabel(workflow: {
  readonly agentDisplayName: string | null;
  readonly agentName: string | null;
  readonly agentId: string;
}): string {
  return workflow.agentDisplayName ?? workflow.agentName ?? workflow.agentId;
}

export function triggerKindLabel(trigger: ZeroWorkflowTriggerSummary): string {
  if (trigger.kind === "schedule") {
    return "Schedule trigger";
  }
  return trigger.eventType === "webhook-received"
    ? "Webhook trigger"
    : "Event trigger";
}

export function VisibilityBadge({
  visibility,
  requestToPublish,
}: {
  readonly visibility: ZeroWorkflowSummary["visibility"];
  readonly requestToPublish?: boolean;
}) {
  const isPrivate = visibility === "private";
  const Icon = isPrivate ? IconLock : IconWorld;
  const label = isPrivate && requestToPublish ? "pending review" : visibility;

  return (
    <span className="inline-flex h-6 max-w-full items-center gap-1 rounded-full border border-border/60 px-2 text-xs font-medium capitalize text-muted-foreground">
      <Icon size={12} stroke={1.5} className="shrink-0" />
      <span className="truncate">{label}</span>
    </span>
  );
}
