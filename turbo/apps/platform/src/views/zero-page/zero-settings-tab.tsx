// TODO(#8609): split large components to comply with max-lines-per-function (128)
// oxlint-disable max-lines-per-function
import { useGet, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import { pageSignal$ } from "../../signals/page-signal.ts";
import {
  Button,
  Card,
  CardContent,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Switch,
  cn,
} from "@vm0/ui";
import { IconAlertTriangle } from "@tabler/icons-react";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@vm0/ui/components/ui/alert";
import { type Tone, TONE_OPTIONS } from "./zero-tone-constants.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { ZeroUnsavedBar } from "./zero-unsaved-bar.tsx";
import type { Command } from "ccstate";
import { InlineSettingsRow } from "./components/zero-inline-settings-row.tsx";
import {
  AgentDeleteDialog,
  type AgentDeleteWorkflow,
  type AgentDeleteCopyTarget,
} from "./components/zero-delete-agent-dialog.tsx";
import { toast } from "@vm0/ui/components/ui/sonner";
import { serializeAvatarSvgConfig } from "./avatar-svg-utils.ts";
import { resolveAvatarSvgConfig } from "./avatar-utils.ts";
import { AvatarSvgPreview } from "./avatar-svg-preview.tsx";
import { AvatarMaker } from "./avatar-maker.tsx";
import {
  settingsFormDraft$,
  patchSettingsForm$,
  resetSettingsForm$,
  agentDemoteConfirmOpen$,
  setAgentDemoteConfirmOpen$,
} from "../../signals/zero-page/settings/settings-tab.ts";

interface ZeroSettingsTabProps {
  agentId: string;
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
  agentId,
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
  const { t } = useTranslation("agents");
  const defaults = {
    name: resolvedAgentName,
    description: initialDescription,
    tone: initialSound,
    avatarUrl: initialAvatarUrl,
    visibility: initialVisibility,
  };
  const draft = useGet(settingsFormDraft$);
  const values =
    draft?.agentId === agentId ? { ...defaults, ...draft.patch } : defaults;
  const {
    name: agentName,
    description: desc,
    tone,
    avatarUrl,
    visibility,
  } = values;
  const isSettingsDirty =
    agentName !== defaults.name ||
    desc !== defaults.description ||
    tone !== defaults.tone ||
    avatarUrl !== defaults.avatarUrl ||
    visibility !== defaults.visibility;
  const patchForm = useSet(patchSettingsForm$);
  const resetForm = useSet(resetSettingsForm$);

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
  const toneCopy = {
    professional: {
      label: t(($) => {
        return $.profile.tones.professional.label;
      }),
      hint: t(($) => {
        return $.profile.tones.professional.hint;
      }),
      user: t(($) => {
        return $.profile.tones.professional.userSample;
      }),
      agent: t(($) => {
        return $.profile.tones.professional.agentSample;
      }),
    },
    friendly: {
      label: t(($) => {
        return $.profile.tones.friendly.label;
      }),
      hint: t(($) => {
        return $.profile.tones.friendly.hint;
      }),
      user: t(($) => {
        return $.profile.tones.friendly.userSample;
      }),
      agent: t(($) => {
        return $.profile.tones.friendly.agentSample;
      }),
    },
    direct: {
      label: t(($) => {
        return $.profile.tones.direct.label;
      }),
      hint: t(($) => {
        return $.profile.tones.direct.hint;
      }),
      user: t(($) => {
        return $.profile.tones.direct.userSample;
      }),
      agent: t(($) => {
        return $.profile.tones.direct.agentSample;
      }),
    },
    supportive: {
      label: t(($) => {
        return $.profile.tones.supportive.label;
      }),
      hint: t(($) => {
        return $.profile.tones.supportive.hint;
      }),
      user: t(($) => {
        return $.profile.tones.supportive.userSample;
      }),
      agent: t(($) => {
        return $.profile.tones.supportive.agentSample;
      }),
    },
  } satisfies Record<
    Tone,
    { label: string; hint: string; user: string; agent: string }
  >;

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
        toast.success(
          t(($) => {
            return $.profile.saved;
          }),
        );
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

  return (
    <>
      <div className="mx-auto max-w-[900px]">
        <Card className="zero-card overflow-hidden">
          <CardContent className="p-4 sm:p-5">
            <InlineSettingsRow
              label={t(($) => {
                return $.profile.fields.avatar.label;
              })}
              description={t(($) => {
                return $.profile.fields.avatar.description;
              })}
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
                      patchForm({
                        agentId,
                        patch: { avatarUrl: newAvatarUrl },
                      });
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
                      toast.success(
                        t(($) => {
                          return $.profile.saved;
                        }),
                      );
                    }}
                  />
                </div>
              </div>
            </InlineSettingsRow>

            <InlineSettingsRow
              label={t(($) => {
                return $.profile.fields.name.label;
              })}
              description={t(($) => {
                return $.profile.fields.name.description;
              })}
              wideControls
            >
              <div className="min-w-0 w-full">
                <Input
                  id={inputId}
                  value={agentName}
                  onChange={(e) => {
                    return patchForm({
                      agentId,
                      patch: { name: e.target.value },
                    });
                  }}
                  placeholder={t(($) => {
                    return $.profile.fields.name.placeholder;
                  })}
                  className="h-9 w-full"
                  aria-label={t(($) => {
                    return $.profile.fields.name.label;
                  })}
                />
              </div>
            </InlineSettingsRow>

            <InlineSettingsRow
              label={t(($) => {
                return $.profile.fields.description.label;
              })}
              description={t(($) => {
                return $.profile.fields.description.description;
              })}
              wideControls
            >
              <div className="min-w-0 w-full">
                <textarea
                  id={`${inputId}-description`}
                  value={desc}
                  onChange={(e) => {
                    return patchForm({
                      agentId,
                      patch: { description: e.target.value },
                    });
                  }}
                  placeholder={t(($) => {
                    return $.profile.fields.description.placeholder;
                  })}
                  rows={3}
                  className="w-full rounded-lg border-[0.7px] border-[hsl(var(--gray-400))] bg-input px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground outline-none transition-colors focus:border-primary focus:ring-[3px] focus:ring-primary/10 resize-y min-h-[72px]"
                  aria-label={t(($) => {
                    return $.profile.fields.description.label;
                  })}
                />
              </div>
            </InlineSettingsRow>

            <InlineSettingsRow
              label={t(($) => {
                return $.profile.fields.tone.label;
              })}
              description={t(($) => {
                return $.profile.fields.tone.description;
              })}
              wideControls
            >
              <div
                className="min-w-0 w-full flex flex-col gap-3"
                role="group"
                aria-label={t(
                  ($) => {
                    return $.profile.fields.tone.accessibilityLabel;
                  },
                  { agentName: resolvedAgentName },
                )}
              >
                <div
                  className="grid w-full grid-cols-2 gap-2"
                  role="group"
                  aria-label={t(($) => {
                    return $.profile.fields.tone.groupLabel;
                  })}
                >
                  {TONE_OPTIONS.map((opt) => {
                    return (
                      <button
                        key={opt}
                        type="button"
                        onClick={() => {
                          return patchForm({
                            agentId,
                            patch: { tone: opt },
                          });
                        }}
                        className={cn(
                          "w-full min-w-0 rounded-lg border border-[0.7px] px-3 py-2.5 text-sm font-medium transition-all duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                          tone === opt
                            ? "border-primary/40 bg-primary/10 text-primary dark:border-primary/50 dark:bg-primary/15"
                            : "zero-chip text-muted-foreground hover:text-foreground",
                        )}
                      >
                        {toneCopy[opt].label}
                      </button>
                    );
                  })}
                </div>
                <div
                  className="rounded-lg bg-muted/30 px-3 py-2 w-full zero-border"
                  key={tone}
                >
                  <p className="text-xs text-muted-foreground italic min-h-[1.25rem] leading-relaxed">
                    {toneCopy[tone].hint}
                  </p>
                  <div className="my-2 border-t border-border/30" />
                  <div className="flex flex-col gap-1.5 pb-1.5">
                    <div className="flex justify-end">
                      <div className="zero-bubble-cool max-w-[85%] rounded-xl px-3 py-2 text-sm leading-relaxed transition-colors duration-200">
                        {toneCopy[tone].user}
                      </div>
                    </div>
                    <div className="flex justify-start">
                      <div className="zero-chat-bubble-assistant max-w-[85%] rounded-xl px-3 py-2 text-sm text-foreground leading-relaxed transition-colors duration-200">
                        {toneCopy[tone].agent}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </InlineSettingsRow>
            {canEditVisibility && (
              <InlineSettingsRow
                label={t(($) => {
                  return $.profile.fields.visibility.label;
                })}
                description={t(($) => {
                  return $.profile.fields.visibility.description;
                })}
              >
                <Switch
                  checked={visibility === "public"}
                  onCheckedChange={(checked) => {
                    return patchForm({
                      agentId,
                      patch: { visibility: checked ? "public" : "private" },
                    });
                  }}
                  aria-label={t(($) => {
                    return $.profile.fields.visibility.label;
                  })}
                />
              </InlineSettingsRow>
            )}
          </CardContent>
        </Card>

        {!isDefaultAgent && onDelete && (
          <AgentDeleteDialog
            resolvedAgentName={resolvedAgentName}
            onDelete={onDelete}
            deleteWorkflows={deleteWorkflows}
            deleteCopyTargets={deleteCopyTargets}
            onCopyWorkflowBeforeDelete={onCopyWorkflowBeforeDelete}
          />
        )}
      </div>

      {isSettingsDirty && (
        <ZeroUnsavedBar
          onDiscard={handleResetSettings}
          onSave={handleSaveSettings}
          saving={saving}
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

      <Dialog open={demoteConfirmOpen} onOpenChange={setDemoteConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t(
                ($) => {
                  return $.profile.makePrivate.title;
                },
                { agentName: resolvedAgentName },
              )}
            </DialogTitle>
            <DialogDescription>
              {t(($) => {
                return $.profile.makePrivate.description;
              })}
            </DialogDescription>
          </DialogHeader>
          <Alert variant="destructive">
            <IconAlertTriangle size={16} stroke={1.5} />
            <AlertTitle>
              {t(($) => {
                return $.profile.makePrivate.warningTitle;
              })}
            </AlertTitle>
            <AlertDescription>
              {t(
                ($) => {
                  return $.profile.makePrivate.warningDescription;
                },
                { agentName: resolvedAgentName },
              )}
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
              {t(($) => {
                return $.actions.cancel;
              })}
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
              {saving
                ? t(($) => {
                    return $.actions.saving;
                  })
                : t(($) => {
                    return $.profile.makePrivate.confirm;
                  })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
