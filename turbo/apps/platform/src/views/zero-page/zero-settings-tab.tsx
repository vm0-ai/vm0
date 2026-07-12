// TODO(#8609): split large components to comply with max-lines-per-function (128)
// oxlint-disable max-lines-per-function
import { useGet, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { pageSignal$ } from "../../signals/page-signal.ts";
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
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  cn,
} from "@vm0/ui";
import { IconAlertTriangle, IconTrash } from "@tabler/icons-react";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@vm0/ui/components/ui/alert";
import {
  type Tone,
  TONE_OPTIONS,
  toneLabel,
  TONE_HINT,
  TONE_SAMPLES,
} from "./zero-tone-constants.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { ZeroUnsavedBar } from "./zero-unsaved-bar.tsx";
import type { Command } from "ccstate";
import { InlineSettingsRow } from "./components/zero-inline-settings-row.tsx";
import { toast } from "@vm0/ui/components/ui/sonner";
import { serializeAvatarSvgConfig } from "./avatar-svg-utils.ts";
import { resolveAvatarSvgConfig } from "./avatar-utils.ts";
import { AvatarSvgPreview } from "./avatar-svg-preview.tsx";
import { AvatarMaker } from "./avatar-maker.tsx";
import {
  settingsAgentName$,
  setSettingsAgentName$,
  settingsDesc$,
  setSettingsDesc$,
  settingsTone$,
  setSettingsTone$,
  settingsAvatarUrl$,
  setSettingsAvatarUrl$,
  settingsDirty$,
  initSettingsForm$,
  resetSettingsForm$,
  markSettingsSaved$,
  deleteAgent$,
  settingsVisibility$,
  setSettingsVisibility$,
  agentDemoteConfirmOpen$,
  setAgentDemoteConfirmOpen$,
  agentDeleteCopyChoices$,
  setAgentDeleteCopyChoices$,
  agentDeleteCopying$,
  setAgentDeleteCopying$,
} from "../../signals/zero-page/settings/settings-tab.ts";

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

interface ZeroSettingsTabProps {
  displayName: string;
  description: string;
  sound: Tone;
  avatarUrl: string | null;
  visibility?: "public" | "private";
  canEditVisibility?: boolean;
  /** Workflows bound to this agent, offered for rescue in the delete dialog. */
  deleteWorkflows?: readonly AgentDeleteWorkflow[];
  /** Agents the caller can copy a workflow onto before deleting this agent. */
  deleteCopyTargets?: readonly AgentDeleteCopyTarget[];
  /** Copy a workflow onto another agent before the agent is deleted. */
  onCopyWorkflowBeforeDelete?: (
    workflowId: string,
    toAgentId: string,
  ) => Promise<void>;
  updateSettings$: Command<
    Promise<void>,
    [
      {
        displayName: string;
        sound: string;
        description: string;
        avatarUrl?: string | null;
        visibility?: "public" | "private";
      },
      AbortSignal,
    ]
  >;
  inputId?: string;
  /** Whether this is the default agent (cannot be deleted). */
  isDefaultAgent?: boolean;
  /** Callback to delete the agent. */
  onDelete?: () => Promise<void>;
}

export function ZeroSettingsTab({
  displayName: resolvedAgentName,
  description: initialDescription,
  sound: initialSound,
  avatarUrl: initialAvatarUrl,
  visibility: initialVisibility = "public",
  canEditVisibility = true,
  updateSettings$,
  inputId = "zero-agent-name",
  isDefaultAgent = false,
  onDelete,
  deleteWorkflows = [],
  deleteCopyTargets = [],
  onCopyWorkflowBeforeDelete,
}: ZeroSettingsTabProps) {
  useSet(initSettingsForm$)({
    name: resolvedAgentName,
    description: initialDescription,
    tone: initialSound,
    avatarUrl: initialAvatarUrl,
    visibility: initialVisibility,
  });

  const agentName = useGet(settingsAgentName$);
  const setAgentName = useSet(setSettingsAgentName$);
  const desc = useGet(settingsDesc$);
  const setDesc = useSet(setSettingsDesc$);
  const tone = useGet(settingsTone$);
  const setTone = useSet(setSettingsTone$);
  const avatarUrl = useGet(settingsAvatarUrl$);
  const setAvatarUrl = useSet(setSettingsAvatarUrl$);
  const visibility = useGet(settingsVisibility$);
  const setVisibility = useSet(setSettingsVisibility$);
  const isSettingsDirty = useGet(settingsDirty$);
  const resetForm = useSet(resetSettingsForm$);
  const markSaved = useSet(markSettingsSaved$);

  const [deleteLoadable, deleteAgentFn] = useLoadableSet(deleteAgent$);
  const deleting = deleteLoadable.state === "loading";

  const [settingsLoadable, triggerUpdateSettings] =
    useLoadableSet(updateSettings$);
  const saving = settingsLoadable.state === "loading";

  const handleResetSettings = () => {
    resetForm();
  };

  const pageSignal = useGet(pageSignal$);

  const demoteConfirmOpen = useGet(agentDemoteConfirmOpen$);
  const setDemoteConfirmOpen = useSet(setAgentDemoteConfirmOpen$);
  const willDemoteVisibility =
    initialVisibility === "public" && visibility === "private";

  const runSaveSettings = () => {
    detach(
      (async () => {
        await triggerUpdateSettings(
          {
            displayName: agentName,
            description: desc,
            sound: tone,
            avatarUrl,
            visibility,
          },
          pageSignal,
        );
        markSaved();
        toast.success("Profile saved");
      })(),
      Reason.DomCallback,
    );
  };

  const handleSaveSettings = () => {
    if (willDemoteVisibility) {
      setDemoteConfirmOpen(true);
      return;
    }
    runSaveSettings();
  };

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
    if (!onDelete) {
      return;
    }
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
    <>
      <div className="mx-auto max-w-[900px]">
        <Card className="zero-card overflow-hidden">
          <CardContent className="p-4 sm:p-5">
            <InlineSettingsRow
              label="Avatar"
              description="Create your own avatar."
              wideControls
            >
              <div className="min-w-0 w-full">
                <div className="flex flex-wrap gap-2 items-center">
                  {(() => {
                    const resolved = resolveAvatarSvgConfig(avatarUrl);
                    if (resolved) {
                      return (
                        <div className="h-12 w-12 shrink-0 rounded-full border-2 border-primary ring-2 ring-primary/20">
                          <AvatarSvgPreview
                            config={resolved}
                            className="h-full w-full rounded-full"
                          />
                        </div>
                      );
                    }
                    return null;
                  })()}
                  <AvatarMaker
                    onConfirm={async (cfg) => {
                      const newAvatarUrl = serializeAvatarSvgConfig(cfg);
                      setAvatarUrl(newAvatarUrl);
                      await triggerUpdateSettings(
                        {
                          displayName: agentName,
                          description: desc,
                          sound: tone,
                          avatarUrl: newAvatarUrl,
                          visibility,
                        },
                        pageSignal,
                      );
                      markSaved();
                      toast.success("Profile saved");
                    }}
                  />
                </div>
              </div>
            </InlineSettingsRow>

            <InlineSettingsRow
              label="Name"
              description="Shown in the team list and when this agent speaks."
              wideControls
            >
              <div className="min-w-0 w-full">
                <Input
                  id={inputId}
                  value={agentName}
                  onChange={(e) => {
                    return setAgentName(e.target.value);
                  }}
                  placeholder="What should we call them?"
                  className="h-9 w-full"
                  aria-label="Name"
                />
              </div>
            </InlineSettingsRow>

            <InlineSettingsRow
              label="Description"
              description="What this agent helps with—visible to teammates."
              wideControls
            >
              <div className="min-w-0 w-full">
                <textarea
                  id={`${inputId}-description`}
                  value={desc}
                  onChange={(e) => {
                    return setDesc(e.target.value);
                  }}
                  placeholder="What does this agent do?"
                  rows={3}
                  className="w-full rounded-lg border-[0.7px] border-[hsl(var(--gray-400))] bg-input px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground outline-none transition-colors focus:border-primary focus:ring-[3px] focus:ring-primary/10 resize-y min-h-[72px]"
                  aria-label="Description"
                />
              </div>
            </InlineSettingsRow>

            <InlineSettingsRow
              label="How they sound"
              description="Voice style for replies. Preview updates when you change tone."
              wideControls
            >
              <div
                className="min-w-0 w-full flex flex-col gap-3"
                role="group"
                aria-label={`How ${resolvedAgentName} sounds`}
              >
                <div
                  className="grid w-full grid-cols-2 gap-2"
                  role="group"
                  aria-label="Tone"
                >
                  {TONE_OPTIONS.map((opt) => {
                    return (
                      <button
                        key={opt}
                        type="button"
                        onClick={() => {
                          return setTone(opt);
                        }}
                        className={cn(
                          "w-full min-w-0 rounded-lg border border-[0.7px] px-3 py-2.5 text-sm font-medium transition-all duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                          tone === opt
                            ? "border-primary/40 bg-primary/10 text-primary dark:border-primary/50 dark:bg-primary/15"
                            : "zero-chip text-muted-foreground hover:text-foreground",
                        )}
                      >
                        {toneLabel(opt)}
                      </button>
                    );
                  })}
                </div>
                <div
                  className="rounded-lg bg-muted/30 px-3 py-2 w-full zero-border"
                  key={tone}
                >
                  <p className="text-xs text-muted-foreground italic min-h-[1.25rem] leading-relaxed">
                    {TONE_HINT[tone]}
                  </p>
                  <div className="my-2 border-t border-border/30" />
                  <div className="flex flex-col gap-1.5 pb-1.5">
                    <div className="flex justify-end">
                      <div className="zero-bubble-cool max-w-[85%] rounded-xl px-3 py-2 text-sm leading-relaxed transition-colors duration-200">
                        {TONE_SAMPLES[tone].user}
                      </div>
                    </div>
                    <div className="flex justify-start">
                      <div className="zero-chat-bubble-assistant max-w-[85%] rounded-xl px-3 py-2 text-sm text-foreground leading-relaxed transition-colors duration-200">
                        {TONE_SAMPLES[tone].zero}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </InlineSettingsRow>
            {canEditVisibility && (
              <InlineSettingsRow
                label="Make public"
                description="Visible to everyone in this workspace."
              >
                <Switch
                  checked={visibility === "public"}
                  onCheckedChange={(checked) => {
                    return setVisibility(checked ? "public" : "private");
                  }}
                  aria-label="Make public"
                />
              </InlineSettingsRow>
            )}
          </CardContent>
        </Card>

        {!isDefaultAgent && onDelete && (
          <Card className="zero-card overflow-hidden border-destructive/20 mt-4">
            <CardContent className="p-4 sm:p-5">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
                <div className="min-w-0 sm:max-w-[46%]">
                  <h3 className="text-sm font-medium text-foreground">
                    Danger zone
                  </h3>
                  <p className="text-xs text-muted-foreground mt-1 leading-snug">
                    Permanently remove this agent and all its data. This action
                    cannot be undone.
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
                                {copying
                                  ? "Copying…"
                                  : deleting
                                    ? "Deleting…"
                                    : "Delete agent"}
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
                              Copy a workflow to another agent to keep it.
                              Anything left is deleted.
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
                                        copyChoices[workflow.id] ??
                                        DELETE_WITH_AGENT
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
                              {copying
                                ? "Copying…"
                                : deleting
                                  ? "Deleting…"
                                  : "Delete agent"}
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
        )}
      </div>

      {isSettingsDirty && (
        <ZeroUnsavedBar
          onDiscard={handleResetSettings}
          onSave={handleSaveSettings}
          saving={saving}
        />
      )}

      <Dialog open={demoteConfirmOpen} onOpenChange={setDemoteConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Make {resolvedAgentName} private?</DialogTitle>
            <DialogDescription>
              While this agent is private, other members lose access to their
              chat history under it. They regain access if you make it public
              again.
            </DialogDescription>
          </DialogHeader>
          <Alert variant="destructive">
            <IconAlertTriangle size={16} stroke={1.5} />
            <AlertTitle>Members lose access</AlertTitle>
            <AlertDescription>
              Other members will no longer see {resolvedAgentName} or their
              chats under it.
            </AlertDescription>
          </Alert>
          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              disabled={saving}
              onClick={() => {
                setDemoteConfirmOpen(false);
              }}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              disabled={saving}
              onClick={() => {
                setDemoteConfirmOpen(false);
                runSaveSettings();
              }}
            >
              {saving ? "Saving…" : "Make private"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
