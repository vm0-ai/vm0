// TODO(#8609): split large components to comply with max-lines-per-function (128)
// oxlint-disable max-lines-per-function
import { useGet, useSet, useLastResolved } from "ccstate-react";
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
  cn,
} from "@vm0/ui";
import { IconTrash } from "@tabler/icons-react";
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
  settingsModelSelection$,
  setSettingsModelSelection$,
  settingsPreferPersonalProvider$,
} from "../../signals/zero-page/settings/settings-tab.ts";
import { orgModelProviders$ } from "../../signals/external/org-model-providers.ts";
import { modelFirstModelProviderEnabled$ } from "../../signals/external/feature-switch.ts";
import {
  ModelProviderPicker,
  type ModelProviderSelection,
} from "./components/model-provider-picker.tsx";

interface ZeroSettingsTabProps {
  displayName: string;
  description: string;
  sound: Tone;
  avatarUrl: string | null;
  modelProviderId?: string | null;
  selectedModel?: string | null;
  preferPersonalProvider?: boolean;
  updateSettings$: Command<
    Promise<void>,
    [
      {
        displayName: string;
        sound: string;
        description: string;
        avatarUrl?: string | null;
        modelProviderId?: string | null;
        selectedModel?: string | null;
        preferPersonalProvider?: boolean;
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
  modelProviderId: initialModelProviderId,
  selectedModel: initialSelectedModel,
  preferPersonalProvider: initialPreferPersonalProvider = false,
  updateSettings$,
  inputId = "zero-agent-name",
  isDefaultAgent = false,
  onDelete,
}: ZeroSettingsTabProps) {
  const modelFirstEnabled = useGet(modelFirstModelProviderEnabled$);
  const initialModelSelection: ModelProviderSelection | null =
    !modelFirstEnabled && initialSelectedModel && initialModelProviderId
      ? {
          modelProviderId: initialModelProviderId,
          selectedModel: initialSelectedModel,
        }
      : null;

  useSet(initSettingsForm$)({
    name: resolvedAgentName,
    description: initialDescription,
    tone: initialSound,
    avatarUrl: initialAvatarUrl,
    modelSelection: initialModelSelection,
    preferPersonalProvider: initialPreferPersonalProvider,
  });

  const agentName = useGet(settingsAgentName$);
  const setAgentName = useSet(setSettingsAgentName$);
  const desc = useGet(settingsDesc$);
  const setDesc = useSet(setSettingsDesc$);
  const tone = useGet(settingsTone$);
  const setTone = useSet(setSettingsTone$);
  const avatarUrl = useGet(settingsAvatarUrl$);
  const setAvatarUrl = useSet(setSettingsAvatarUrl$);
  const modelSelection = useGet(settingsModelSelection$);
  const setModelSelection = useSet(setSettingsModelSelection$);
  const preferPersonalProvider = useGet(settingsPreferPersonalProvider$);
  const isSettingsDirty = useGet(settingsDirty$);
  const resetForm = useSet(resetSettingsForm$);
  const markSaved = useSet(markSettingsSaved$);

  const orgProviders = useLastResolved(orgModelProviders$);

  const [deleteLoadable, deleteAgentFn] = useLoadableSet(deleteAgent$);
  const deleting = deleteLoadable.state === "loading";

  const [settingsLoadable, triggerUpdateSettings] =
    useLoadableSet(updateSettings$);
  const saving = settingsLoadable.state === "loading";

  const handleResetSettings = () => {
    resetForm();
  };

  const pageSignal = useGet(pageSignal$);

  const handleSaveSettings = () => {
    detach(
      (async () => {
        await triggerUpdateSettings(
          {
            displayName: agentName,
            description: desc,
            sound: tone,
            avatarUrl,
            modelProviderId: modelFirstEnabled
              ? null
              : (modelSelection?.modelProviderId ?? null),
            selectedModel: modelFirstEnabled
              ? null
              : (modelSelection?.selectedModel ?? null),
            preferPersonalProvider,
          },
          pageSignal,
        );
        markSaved();
        toast.success("Profile saved");
      })(),
      Reason.DomCallback,
    );
  };

  const handleDelete = () => {
    if (!onDelete) {
      return;
    }
    detach(deleteAgentFn(onDelete, pageSignal), Reason.DomCallback);
  };

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
                    onConfirm={(cfg) => {
                      const newAvatarUrl = serializeAvatarSvgConfig(cfg);
                      setAvatarUrl(newAvatarUrl);
                      return triggerUpdateSettings(
                        {
                          displayName: agentName,
                          description: desc,
                          sound: tone,
                          avatarUrl: newAvatarUrl,
                          modelProviderId: modelFirstEnabled
                            ? null
                            : (modelSelection?.modelProviderId ?? null),
                          selectedModel: modelSelection?.selectedModel ?? null,
                          preferPersonalProvider,
                        },
                        pageSignal,
                      ).then(() => {
                        markSaved();
                        toast.success("Profile saved");
                      });
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
                  className="grid w-full grid-cols-2 gap-2 sm:grid-cols-4"
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
            {!modelFirstEnabled &&
              orgProviders &&
              orgProviders.modelProviders.length > 0 && (
                <InlineSettingsRow
                  label="Model"
                  description="The model used by this agent. Defaults to the workspace setting."
                >
                  <ModelProviderPicker
                    providers={orgProviders.modelProviders}
                    value={modelSelection}
                    onChange={setModelSelection}
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
                    <DialogContent>
                      <DialogHeader>
                        <DialogTitle>Delete {resolvedAgentName}?</DialogTitle>
                        <DialogDescription>
                          This will permanently delete the agent, its
                          instructions, schedules, and all associated data. This
                          action cannot be undone.
                        </DialogDescription>
                      </DialogHeader>
                      <DialogFooter>
                        <DialogClose asChild>
                          <Button variant="outline" size="sm">
                            Cancel
                          </Button>
                        </DialogClose>
                        <Button
                          variant="destructive"
                          size="sm"
                          disabled={deleting}
                          onClick={handleDelete}
                        >
                          {deleting ? "Deleting…" : "Delete agent"}
                        </Button>
                      </DialogFooter>
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
    </>
  );
}
