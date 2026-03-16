import { useCCState, useCommand } from "ccstate-react/experimental";
import { useGet, useSet } from "ccstate-react";
import { Card, CardContent, Input, cn } from "@vm0/ui";
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

interface ZeroSettingsTabProps {
  agentName: string;
  description: string;
  sound: Tone;
  saving: boolean;
  updateSettings$: Command<
    Promise<void>,
    [{ displayName: string; sound: string; description: string }]
  >;
  inputId?: string;
}

export function ZeroSettingsTab({
  agentName: resolvedAgentName,
  description: initialDescription,
  sound: initialSound,
  saving,
  updateSettings$,
  inputId = "zero-agent-name",
}: ZeroSettingsTabProps) {
  const agentName$ = useCCState(resolvedAgentName);
  const agentName = useGet(agentName$);
  const setAgentName = useSet(agentName$);
  const desc$ = useCCState(initialDescription);
  const desc = useGet(desc$);
  const setDesc = useSet(desc$);
  const tone$ = useCCState<Tone>(initialSound);
  const tone = useGet(tone$);
  const setTone = useSet(tone$);
  const savedSettings$ = useCCState<{
    name: string;
    description: string;
    tone: Tone;
  }>({
    name: resolvedAgentName,
    description: initialDescription,
    tone: initialSound,
  });
  const savedSettings = useGet(savedSettings$);
  const setSavedSettings = useSet(savedSettings$);

  // Sync local state when props change (e.g. metadata finishes loading)
  const prevProps$ = useCCState({
    name: resolvedAgentName,
    description: initialDescription,
    tone: initialSound,
  });
  const prevProps = useGet(prevProps$);
  const setPrevProps = useSet(prevProps$);
  if (
    resolvedAgentName !== prevProps.name ||
    initialDescription !== prevProps.description ||
    initialSound !== prevProps.tone
  ) {
    queueMicrotask(() => {
      setPrevProps({
        name: resolvedAgentName,
        description: initialDescription,
        tone: initialSound,
      });
      setAgentName(resolvedAgentName);
      setDesc(initialDescription);
      setTone(initialSound);
      setSavedSettings({
        name: resolvedAgentName,
        description: initialDescription,
        tone: initialSound,
      });
    });
  }

  const isSettingsDirty =
    agentName !== savedSettings.name ||
    desc !== savedSettings.description ||
    tone !== savedSettings.tone;

  const handleResetSettings = () => {
    setAgentName(savedSettings.name);
    setDesc(savedSettings.description);
    setTone(savedSettings.tone);
  };

  const handleSaveSettings$ = useCommand(async ({ get, set }) => {
    const currentName = get(agentName$);
    const currentDesc = get(desc$);
    const currentTone = get(tone$);
    await set(updateSettings$, {
      displayName: currentName,
      description: currentDesc,
      sound: currentTone,
    });
    set(savedSettings$, {
      name: currentName,
      description: currentDesc,
      tone: currentTone,
    });
  });
  const handleSaveSettings = useSet(handleSaveSettings$);

  return (
    <>
      <div className="mx-auto max-w-[900px]">
        <Card className="zero-card-white">
          <CardContent className="py-5 flex flex-col gap-4">
            <div className="flex flex-col gap-8">
              <div className="flex flex-col gap-2">
                <label
                  htmlFor={inputId}
                  className="text-sm font-medium text-foreground"
                >
                  Name
                </label>
                <Input
                  id={inputId}
                  value={agentName}
                  onChange={(e) => setAgentName(e.target.value)}
                  placeholder="What should we call them?"
                  className="h-9 zero-form-border"
                />
              </div>
              <div className="flex flex-col gap-2">
                <label
                  htmlFor={`${inputId}-description`}
                  className="text-sm font-medium text-foreground"
                >
                  Description
                </label>
                <textarea
                  id={`${inputId}-description`}
                  value={desc}
                  onChange={(e) => setDesc(e.target.value)}
                  placeholder="What does this agent do?"
                  rows={3}
                  className="zero-form-border w-full rounded-lg bg-input px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground outline-none transition-colors focus:ring-[3px] focus:ring-primary/10 resize-y min-h-[72px]"
                />
              </div>
              <div
                className="flex flex-col gap-2"
                role="group"
                aria-label={`How ${resolvedAgentName} sounds`}
              >
                <span className="text-sm font-medium text-foreground">
                  How they sound
                </span>
                <div
                  className="flex flex-wrap gap-2"
                  role="group"
                  aria-label="Tone"
                >
                  {TONE_OPTIONS.map((opt) => (
                    <button
                      key={opt}
                      type="button"
                      onClick={() => setTone(opt)}
                      style={{ borderWidth: "0.7px" }}
                      className={cn(
                        "rounded-lg border px-4 py-2.5 text-sm font-medium transition-all duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                        tone === opt
                          ? "border-primary/40 bg-primary/10 text-primary dark:border-primary/50 dark:bg-primary/15"
                          : "zero-chip text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {toneLabel(opt)}
                    </button>
                  ))}
                </div>
                <div
                  className="rounded-lg bg-muted/30 px-3 py-2"
                  style={{ border: "0.7px solid hsl(var(--gray-400))" }}
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
                      <div
                        className="zero-chat-bubble-assistant max-w-[85%] rounded-xl px-3 py-2 text-sm text-foreground leading-relaxed transition-colors duration-200"
                        style={{ border: "0.7px solid hsl(var(--gray-400))" }}
                      >
                        {TONE_SAMPLES[tone].zero}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {isSettingsDirty && (
        <ZeroUnsavedBar
          onDiscard={handleResetSettings}
          onSave={() => detach(handleSaveSettings(), Reason.DomCallback)}
          saving={saving}
        />
      )}
    </>
  );
}
