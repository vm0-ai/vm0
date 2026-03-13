import { useCCState } from "ccstate-react/experimental";
import { useGet, useSet, useLoadable, useLastLoadable } from "ccstate-react";
import slackIcon from "../settings-page/icons/slack.svg";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  Button,
  Input,
} from "@vm0/ui";
import { ProviderIcon } from "../settings-page/provider-icons";
import {
  MODEL_PROVIDER_TYPES,
  type ConnectorType,
  type ModelProviderType,
} from "@vm0/core";
import { skills$ } from "../../data/skills.ts";
import { ProviderFormFields } from "../shared/provider-form-fields";
import { getUILabel } from "../settings-page/provider-ui-config";
import {
  zeroOnboardingStep$,
  zeroAgentName$,
  zeroProviderType$,
  zeroFormValues$,
  zeroSaving$,
  zeroCanSave$,
  setZeroStep$,
  setZeroAgentName$,
  setZeroProviderType$,
  setZeroSecret$,
  setZeroModel$,
  setZeroUseDefaultModel$,
  setZeroAuthMethod$,
  setZeroSecretField$,
  saveZeroModelProvider$,
  completeZeroOnboarding$,
  zeroHasModelProvider$,
  zeroSelectedSkills$,
  toggleZeroSkill$,
  zeroOnboardingError$,
  clearZeroOnboardingError$,
} from "../../signals/zero-page/zero-onboarding.ts";
import { fetchSlackIntegration$ } from "../../signals/integrations-page/slack-integration.ts";
import {
  allConnectorTypes$,
  connectConnector$,
  pollingConnectorType$,
  selectedConnectorType$,
  setSelectedConnectorType$,
} from "../../signals/settings-page/connectors.ts";
import { ConnectModal } from "../settings-page/add-connection-dialog.tsx";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { IconCircleCheck, IconLoader } from "@tabler/icons-react";
import { detach, Reason } from "../../signals/utils.ts";

const MODEL_PROVIDER_LIST: readonly ModelProviderType[] = [
  "claude-code-oauth-token",
  "anthropic-api-key",
  "openrouter-api-key",
  "moonshot-api-key",
  "minimax-api-key",
  "deepseek-api-key",
  "zai-api-key",
  "azure-foundry",
  "aws-bedrock",
];

function OnboardingSkillCard({
  label,
  iconUrl,
  isSelected,
  isPolling,
  onClick,
}: {
  label: string;
  iconUrl: string | undefined;
  isSelected: boolean;
  isPolling: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={isPolling}
      className={`zero-card flex items-center gap-2 rounded-xl border px-3 py-2 min-w-0 transition-colors ${
        isSelected
          ? "border-green-500/30 bg-green-500/5 cursor-pointer"
          : isPolling
            ? "border-yellow-500/30 bg-yellow-500/5"
            : "border-border hover:bg-muted/50 cursor-pointer"
      }`}
    >
      <span className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden">
        {iconUrl ? (
          <img src={iconUrl} alt="" className="h-5 w-5 object-contain" />
        ) : (
          <span className="text-xs font-medium text-muted-foreground">
            {label.slice(0, 2)}
          </span>
        )}
      </span>
      <span className="text-sm font-medium text-foreground whitespace-nowrap">
        {label}
      </span>
      {isSelected && (
        <IconCircleCheck className="h-4 w-4 shrink-0 text-green-500" />
      )}
      {isPolling && (
        <IconLoader className="h-4 w-4 shrink-0 text-yellow-500 animate-spin" />
      )}
    </button>
  );
}

function OnboardingSkillsStep({
  name,
  allSkills,
  selectedSkills,
}: {
  name: string;
  allSkills: readonly { value: string; label: string; icon?: string }[];
  selectedSkills: string[];
}) {
  const connectorTypesLoadable = useLastLoadable(allConnectorTypes$);
  const pollingType = useGet(pollingConnectorType$);
  const connect = useSet(connectConnector$);
  const setSelectedConnector = useSet(setSelectedConnectorType$);
  const pageSignal = useGet(pageSignal$);
  const toggleSkill = useSet(toggleZeroSkill$);

  const allConnectors =
    connectorTypesLoadable.state === "hasData"
      ? connectorTypesLoadable.data
      : [];
  const connectorMap = new Map(allConnectors.map((c) => [c.type, c]));
  const selectedSet = new Set(selectedSkills);

  const handleClick = (value: string) => {
    // Already selected → deselect (don't disconnect)
    if (selectedSet.has(value)) {
      toggleSkill(value);
      return;
    }

    const connector = connectorMap.get(value as ConnectorType);
    if (!connector) {
      // Non-connector skill: select immediately
      toggleSkill(value);
      return;
    }

    // Connector skill: already connected → select immediately
    if (connector.connected) {
      toggleSkill(value);
      return;
    }

    // Not connected → start connect flow, select on success
    if (connector.availableAuthMethods.includes("api-token")) {
      setSelectedConnector(value as ConnectorType);
    } else {
      // OAuth flow: select skill after connect completes
      detach(
        (async () => {
          await connect(value as ConnectorType, pageSignal);
          toggleSkill(value);
        })(),
        Reason.DomCallback,
      );
    }
  };

  return (
    <div className="flex-1 min-h-0 overflow-y-auto flex flex-col items-center text-center px-8 pt-8">
      <DialogHeader className="space-y-2">
        <DialogTitle className="text-xl font-semibold tracking-tight">
          Add skills
        </DialogTitle>
      </DialogHeader>
      <p className="text-sm text-muted-foreground leading-relaxed mt-1 mb-6">
        Add skills so {name || "Zero"} can work with your tools. You can skip
        and add more later.
      </p>
      <div className="w-full px-4 flex-1 min-h-0">
        <div className="w-full flex flex-wrap justify-center gap-3 pb-4">
          {allSkills.map((skill) => (
            <OnboardingSkillCard
              key={skill.value}
              label={skill.label}
              iconUrl={skill.icon}
              isSelected={selectedSet.has(skill.value)}
              isPolling={pollingType === skill.value}
              onClick={() => handleClick(skill.value)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

/** Zero onboarding: creates org, model provider, and default agent. */
export function ZeroOnboarding({
  zeroAvatarSrc = "/zero-avatar.png",
  onAvatarClick,
}: {
  zeroAvatarSrc?: string;
  onAvatarClick?: () => void;
}) {
  const step = useGet(zeroOnboardingStep$);
  const setStep = useSet(setZeroStep$);
  const name = useGet(zeroAgentName$);
  const setName = useSet(setZeroAgentName$);
  const providerType = useGet(zeroProviderType$);
  const setProviderType = useSet(setZeroProviderType$);
  const formValues = useGet(zeroFormValues$);
  const setSecret = useSet(setZeroSecret$);
  const setModel = useSet(setZeroModel$);
  const setUseDefaultModel = useSet(setZeroUseDefaultModel$);
  const setAuthMethod = useSet(setZeroAuthMethod$);
  const setSecretField = useSet(setZeroSecretField$);
  const saving = useGet(zeroSaving$);
  const canSave = useGet(zeroCanSave$);
  const allSkills = useGet(skills$);
  const selectedSkills = useGet(zeroSelectedSkills$);
  const toggleSkill = useSet(toggleZeroSkill$);
  const saveModelProvider = useSet(saveZeroModelProvider$);
  const completeOnboarding = useSet(completeZeroOnboarding$);
  const fetchSlack = useSet(fetchSlackIntegration$);
  const hasModelProviderLoadable = useLoadable(zeroHasModelProvider$);
  const hasModelProvider =
    hasModelProviderLoadable.state === "hasData" &&
    hasModelProviderLoadable.data === true;
  const onboardingError = useGet(zeroOnboardingError$);
  const clearOnboardingError = useSet(clearZeroOnboardingError$);
  const selectedConnectorType = useGet(selectedConnectorType$);
  const setSelected = useSet(setSelectedConnectorType$);

  // Local UI state: whether user has picked a provider (showing form vs list)
  const providerPicked$ = useCCState(false);
  const providerPicked = useGet(providerPicked$);
  const setProviderPicked = useSet(providerPicked$);

  const handleSelectProvider = (type: ModelProviderType) => {
    setProviderType(type);
    setProviderPicked(true);
  };

  const handleStep1Next = () => {
    setStep(hasModelProvider ? "3" : "2");
  };

  const handleStep2Next = () => {
    const controller = new AbortController();
    detach(
      (async () => {
        await saveModelProvider(controller.signal);
        setStep("3");
      })(),
      Reason.DomCallback,
    );
  };

  const handleStep2Back = () => {
    if (providerPicked) {
      setProviderPicked(false);
    } else {
      setStep("1");
    }
  };

  const handleStep3Next = () => {
    setStep("4");
  };

  const handleStep3Back = () => {
    setStep(hasModelProvider ? "1" : "2");
  };

  const handleStep4Back = () => {
    setStep("3");
  };

  const handleAddToSlack = () => {
    clearOnboardingError();
    const controller = new AbortController();
    detach(
      (async () => {
        await completeOnboarding(controller.signal);
        // Fetch Slack integration to get install URL
        const url = await fetchSlack();
        if (url) {
          window.location.href = url;
        }
      })(),
      Reason.DomCallback,
    );
  };

  const handleContinueWithWeb = () => {
    clearOnboardingError();
    const controller = new AbortController();
    detach(completeOnboarding(controller.signal), Reason.DomCallback);
  };

  if (step === "done") {
    return null;
  }

  const dialogBaseClass =
    "zero-app sm:max-w-[720px] h-[500px] gap-0 p-0 flex flex-col rounded-xl border border-border bg-card shadow-lg";
  const footerClass =
    "zero-onboarding-footer shrink-0 border-t h-16 flex items-center gap-2 px-8";

  return (
    <>
      {/* Step 1: Meet your new teammate */}
      <Dialog open={step === "1"}>
        <DialogContent
          className={`${dialogBaseClass} zero-onboarding-dialog zero-onboarding-step1`}
          onPointerDownOutside={(e) => e.preventDefault()}
          onEscapeKeyDown={(e) => e.preventDefault()}
          aria-describedby={undefined}
        >
          <div className="flex-1 min-h-0 overflow-y-auto flex flex-col items-center justify-center text-center px-8 py-8">
            <button
              type="button"
              onClick={onAvatarClick}
              className="h-16 w-16 shrink-0 flex items-center justify-center overflow-hidden rounded-xl transition-colors duration-150 hover:bg-muted/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 mb-5"
              aria-label="Switch Zero avatar"
            >
              <img
                src={zeroAvatarSrc}
                alt=""
                role="presentation"
                className="h-16 w-16 rounded-full object-cover object-top"
              />
            </button>
            <DialogHeader className="space-y-2">
              <DialogTitle className="text-xl font-semibold tracking-tight">
                Meet your new teammate
              </DialogTitle>
            </DialogHeader>
            <p className="text-sm text-muted-foreground leading-relaxed max-w-[360px] mt-1 mb-6">
              Your AI teammate works across all your tools, learns what you
              need, and gets better over time. Give it a name to get started.
            </p>
            <div className="w-full max-w-[320px] flex flex-col gap-2 text-left">
              <Input
                id="onboarding-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Zero"
                className="w-full h-10 rounded-lg border border-border bg-input px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground outline-none transition-colors focus:border-primary focus:ring-2 focus:ring-primary/20"
              />
            </div>
          </div>
          <div className={`${footerClass} justify-end`}>
            <Button
              onClick={handleStep1Next}
              className="rounded-lg min-w-[100px]"
            >
              Next
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Step 2: Add model provider */}
      <Dialog open={step === "2"}>
        <DialogContent
          className={`${dialogBaseClass} zero-onboarding-dialog`}
          onPointerDownOutside={(e) => e.preventDefault()}
          onEscapeKeyDown={(e) => e.preventDefault()}
          aria-describedby={undefined}
        >
          <div className="flex-1 min-h-0 overflow-y-auto flex flex-col justify-center px-8 pt-8 pb-8">
            {providerPicked ? (
              <div className="flex flex-col items-center pt-10">
                <div className="flex items-center justify-center gap-3 mb-6">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden">
                    <ProviderIcon type={providerType} size={28} />
                  </span>
                  <h2 className="text-xl font-semibold tracking-tight text-foreground">
                    {getUILabel(providerType)}
                  </h2>
                </div>
                <div className="w-full max-w-md flex flex-col gap-4 text-left">
                  <ProviderFormFields
                    providerType={providerType}
                    formValues={formValues}
                    onProviderTypeChange={() => {}}
                    onSecretChange={setSecret}
                    onModelChange={setModel}
                    onUseDefaultModelChange={setUseDefaultModel}
                    onAuthMethodChange={setAuthMethod}
                    onSecretFieldChange={setSecretField}
                    isLoading={saving}
                  />
                </div>
              </div>
            ) : (
              <div className="flex flex-col items-center text-center">
                <DialogHeader className="space-y-2">
                  <DialogTitle className="text-xl font-semibold tracking-tight">
                    Add model provider
                  </DialogTitle>
                </DialogHeader>
                <p className="text-sm text-muted-foreground leading-relaxed mt-1 mb-6 max-w-[400px]">
                  Bring your own model. We never charge for chat. Pick a
                  provider below to get started.
                </p>
                <div className="w-full flex flex-wrap justify-center gap-3">
                  {MODEL_PROVIDER_LIST.map((type) => {
                    const config = MODEL_PROVIDER_TYPES[type];
                    return (
                      <button
                        key={type}
                        type="button"
                        onClick={() => handleSelectProvider(type)}
                        className="zero-card flex items-center gap-2 rounded-xl border border-border px-3 py-2 min-w-0 hover:border-primary/30 hover:bg-muted/30 transition-colors text-left"
                      >
                        <span className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden">
                          <ProviderIcon type={type} size={18} />
                        </span>
                        <span className="text-sm font-medium text-foreground whitespace-nowrap">
                          {config.label}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
          <div className={`${footerClass} justify-between`}>
            <Button
              variant="ghost"
              className="rounded-lg text-muted-foreground"
              onClick={handleStep2Back}
              disabled={saving}
            >
              Back
            </Button>
            <Button
              onClick={handleStep2Next}
              className="rounded-lg min-w-[100px]"
              disabled={!providerPicked || !canSave || saving}
            >
              {saving ? "Saving\u2026" : "Next"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Step 3: Add skills */}
      <Dialog open={step === "3"}>
        <DialogContent
          className={`${dialogBaseClass} zero-onboarding-dialog`}
          onPointerDownOutside={(e) => e.preventDefault()}
          onEscapeKeyDown={(e) => e.preventDefault()}
          aria-describedby={undefined}
        >
          <OnboardingSkillsStep
            name={name}
            allSkills={allSkills}
            selectedSkills={selectedSkills}
          />
          <div className={`${footerClass} justify-between`}>
            <Button
              variant="ghost"
              className="rounded-lg text-muted-foreground"
              onClick={handleStep3Back}
            >
              Back
            </Button>
            <Button
              onClick={handleStep3Next}
              className="rounded-lg min-w-[100px]"
            >
              Next
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {selectedConnectorType && (
        <ConnectModal
          onClose={() => {
            setSelected(null);
          }}
          onSuccess={() => {
            toggleSkill(selectedConnectorType);
          }}
        />
      )}

      {/* Step 4: Where would you like to work with Zero? */}
      <Dialog open={step === "4"}>
        <DialogContent
          className={`${dialogBaseClass} zero-onboarding-dialog`}
          onPointerDownOutside={(e) => e.preventDefault()}
          onEscapeKeyDown={(e) => e.preventDefault()}
          aria-describedby={undefined}
        >
          <div className="flex-1 min-h-0 overflow-y-auto flex flex-col items-center justify-center text-center px-8 py-8">
            <DialogHeader className="space-y-2">
              <DialogTitle className="text-xl font-semibold tracking-tight">
                Where would you like to work with {name || "Zero"}?
              </DialogTitle>
            </DialogHeader>
            <p className="text-sm text-muted-foreground leading-relaxed max-w-[400px] mt-1 mb-6">
              Choose how you&apos;d like to interact with your agent.
            </p>
            {onboardingError && (
              <div className="w-full max-w-[560px] mb-4 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
                {onboardingError === "Build timed out"
                  ? "Setup is taking longer than expected. Please try again."
                  : onboardingError}
              </div>
            )}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 w-full max-w-[560px]">
              <div className="zero-card flex flex-col items-center text-center rounded-xl border border-border p-5">
                <span className="flex h-12 w-12 shrink-0 items-center justify-center mb-3 overflow-hidden">
                  <img src={slackIcon} alt="" className="h-7 w-7" />
                </span>
                <span className="text-sm font-semibold text-foreground mb-1">
                  Add {name || "Zero"} to Slack
                </span>
                <p className="text-xs text-muted-foreground leading-relaxed mb-4 flex-1">
                  Work with {name || "Zero"} in your Slack workspace where your
                  team already collaborates.
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  className="w-full rounded-lg zero-btn-morandi"
                  onClick={handleAddToSlack}
                  disabled={saving}
                >
                  {saving ? "Saving\u2026" : "Add to Slack"}
                </Button>
              </div>
              <div className="zero-card flex flex-col items-center text-center rounded-xl border border-border p-5">
                <span className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-full mb-3">
                  <img
                    src={zeroAvatarSrc}
                    alt=""
                    role="presentation"
                    className="h-12 w-12 rounded-full object-cover object-top"
                  />
                </span>
                <span className="text-sm font-semibold text-foreground mb-1">
                  Continue in web
                </span>
                <p className="text-xs text-muted-foreground leading-relaxed mb-4 flex-1">
                  Chat with {name || "Zero"} in your browser with full access to
                  workflows and settings.
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  className="w-full rounded-lg zero-btn-morandi"
                  onClick={handleContinueWithWeb}
                  disabled={saving}
                >
                  {saving ? "Saving\u2026" : `Chat with ${name || "Zero"}`}
                </Button>
              </div>
            </div>
          </div>
          <div className={`${footerClass} justify-start`}>
            <Button
              variant="ghost"
              className="rounded-lg text-muted-foreground"
              onClick={handleStep4Back}
              disabled={saving}
            >
              Back
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
