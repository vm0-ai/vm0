import { useGet, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import {
  Button,
  Card,
  CardContent,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@vm0/ui";
import { IconAlertTriangle, IconTrash } from "@tabler/icons-react";
import { pageSignal$ } from "../../../signals/page-signal.ts";
import { detach, Reason } from "../../../signals/utils.ts";
import {
  deleteAgent$,
  agentDeleteCopyChoices$,
  setAgentDeleteCopyChoices$,
  agentDeleteCopying$,
  setAgentDeleteCopying$,
} from "../../../signals/zero-page/settings/settings-tab.ts";

export interface AgentDeleteWorkflow {
  readonly id: string;
  readonly title: string;
}

export interface AgentDeleteCopyTarget {
  readonly id: string;
  readonly displayName: string | null;
}

/** Sentinel Select value meaning "let this workflow be deleted with the agent". */
const DELETE_WITH_AGENT = "__delete_with_agent__";

interface AgentDeleteDialogProps {
  /** Agent name shown in the confirmation copy. */
  resolvedAgentName: string;
  /** Callback to delete the agent. */
  onDelete: () => Promise<void>;
  /** Workflows bound to this agent, offered for rescue in the delete dialog. */
  deleteWorkflows?: readonly AgentDeleteWorkflow[];
  /** Agents the caller can copy a workflow onto before deleting this agent. */
  deleteCopyTargets?: readonly AgentDeleteCopyTarget[];
  /** Copy a workflow onto another agent before the agent is deleted. */
  onCopyWorkflowBeforeDelete?: (
    workflowId: string,
    toAgentId: string,
  ) => Promise<void>;
}

export function AgentDeleteDialog({
  resolvedAgentName,
  onDelete,
  deleteWorkflows = [],
  deleteCopyTargets = [],
  onCopyWorkflowBeforeDelete,
}: AgentDeleteDialogProps) {
  const pageSignal = useGet(pageSignal$);

  const [deleteLoadable, deleteAgentFn] = useLoadableSet(deleteAgent$);
  const deleting = deleteLoadable.state === "loading";

  // Delete reconcile: each bound workflow maps to a Select value that is either
  // DELETE_WITH_AGENT (default) or a target agent id to copy it onto first.
  const copyChoices = useGet(agentDeleteCopyChoices$);
  const setCopyChoices = useSet(setAgentDeleteCopyChoices$);
  const copying = useGet(agentDeleteCopying$);
  const setCopying = useSet(setAgentDeleteCopying$);
  const canReconcile =
    deleteWorkflows.length > 0 &&
    deleteCopyTargets.length > 0 &&
    onCopyWorkflowBeforeDelete !== undefined;

  const handleDelete = () => {
    // Scope rescues to this agent's workflows so stale choices from a
    // previously opened delete dialog never trigger an unrelated copy.
    const currentWorkflowIds = new Set(
      deleteWorkflows.map((workflow) => {
        return workflow.id;
      }),
    );
    const rescues = Object.entries(copyChoices).filter(
      ([workflowId, target]) => {
        return (
          target !== DELETE_WITH_AGENT && currentWorkflowIds.has(workflowId)
        );
      },
    );
    detach(
      (async () => {
        if (rescues.length > 0 && onCopyWorkflowBeforeDelete) {
          setCopying(true);
          for (const [workflowId, toAgentId] of rescues) {
            await onCopyWorkflowBeforeDelete(workflowId, toAgentId);
          }
          setCopying(false);
        }
        await deleteAgentFn(onDelete, pageSignal);
      })(),
      Reason.DomCallback,
    );
  };

  const deleteButtonLabel = copying
    ? "Copying…"
    : deleting
      ? "Deleting…"
      : "Delete agent";

  const deleteDangerHeader = (
    <>
      <DialogHeader className="space-y-0 text-left">
        <div className="flex items-center gap-2">
          <IconAlertTriangle
            size={20}
            stroke={1.5}
            className="shrink-0 text-destructive"
          />
          <DialogTitle>Delete {resolvedAgentName}?</DialogTitle>
        </div>
        <DialogDescription className="mt-3">
          Deletes the agent, its workflows, automations, and everyone&apos;s
          chat history.
        </DialogDescription>
      </DialogHeader>
      <p className="mt-3 text-sm font-semibold text-foreground">
        This can&apos;t be undone.
      </p>
    </>
  );

  return (
    <Card className="zero-card overflow-hidden border-destructive/20 mt-4">
      <CardContent className="p-4 sm:p-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
          <div className="min-w-0 sm:max-w-[46%]">
            <h3 className="text-sm font-medium text-foreground">Danger zone</h3>
            <p className="text-xs text-muted-foreground mt-1 leading-snug">
              Permanently remove this agent and all its data. This action cannot
              be undone.
            </p>
          </div>
          <div className="flex w-full shrink-0 justify-end sm:w-auto">
            <Dialog>
              <DialogTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-9 gap-2 rounded-lg border-destructive/40 px-4 text-destructive hover:bg-destructive/10 hover:text-destructive"
                >
                  <IconTrash size={14} stroke={1.5} />
                  Delete agent
                </Button>
              </DialogTrigger>
              <DialogContent className="max-w-3xl gap-0 overflow-hidden p-0">
                {canReconcile ? (
                  <div className="grid grid-cols-[264px_1fr]">
                    <div className="flex flex-col border-r border-[hsl(var(--gray-400))]/40 bg-muted/40 px-6 py-6">
                      {deleteDangerHeader}
                      <div className="mt-auto flex flex-col gap-2 pt-8">
                        <Button
                          variant="destructive"
                          size="sm"
                          className="w-full"
                          disabled={deleting || copying}
                          onClick={handleDelete}
                        >
                          {deleteButtonLabel}
                        </Button>
                        <DialogClose asChild>
                          <Button
                            variant="outline"
                            size="sm"
                            className="w-full"
                          >
                            Cancel
                          </Button>
                        </DialogClose>
                      </div>
                    </div>
                    <div className="flex flex-col px-6 py-6">
                      <p className="text-sm font-medium text-foreground">
                        Keep any workflows?
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Copy a workflow to another agent to keep it. Anything
                        left is deleted.
                      </p>
                      <div className="mt-3 flex max-h-[320px] flex-col gap-1 overflow-y-auto">
                        {deleteWorkflows.map((workflow) => {
                          return (
                            <div
                              key={workflow.id}
                              className="grid grid-cols-[1fr_200px] items-center gap-6"
                            >
                              <span
                                className="min-w-0 truncate text-sm text-foreground"
                                title={workflow.title}
                              >
                                {workflow.title}
                              </span>
                              <Select
                                value={
                                  copyChoices[workflow.id] ?? DELETE_WITH_AGENT
                                }
                                onValueChange={(value) => {
                                  setCopyChoices({
                                    ...copyChoices,
                                    [workflow.id]: value,
                                  });
                                }}
                              >
                                <SelectTrigger
                                  className="w-full"
                                  aria-label={`Handle workflow ${workflow.title}`}
                                >
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value={DELETE_WITH_AGENT}>
                                    Delete with agent
                                  </SelectItem>
                                  {deleteCopyTargets.map((target) => {
                                    return (
                                      <SelectItem
                                        key={target.id}
                                        value={target.id}
                                      >
                                        Copy to{" "}
                                        {target.displayName ?? target.id}
                                      </SelectItem>
                                    );
                                  })}
                                </SelectContent>
                              </Select>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-col px-6 py-6">
                    {deleteDangerHeader}
                    <DialogFooter className="mt-6">
                      <DialogClose asChild>
                        <Button variant="outline" size="sm">
                          Cancel
                        </Button>
                      </DialogClose>
                      <Button
                        variant="destructive"
                        size="sm"
                        disabled={deleting || copying}
                        onClick={handleDelete}
                      >
                        {deleteButtonLabel}
                      </Button>
                    </DialogFooter>
                  </div>
                )}
              </DialogContent>
            </Dialog>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
