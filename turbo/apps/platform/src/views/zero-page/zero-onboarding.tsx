import { useState } from "react";
import slackIcon from "../settings-page/icons/slack.svg";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  Button,
  Input,
} from "@vm0/ui";
import { ConnectorIcon } from "../settings-page/connector-icons";
import { ProviderIcon } from "../settings-page/provider-icons";
import {
  CONNECTOR_TYPES,
  getDefaultAuthMethod,
  getDefaultModel,
  hasAuthMethods,
  hasModelSelection,
  MODEL_PROVIDER_TYPES,
  type ConnectorType,
  type ModelProviderType,
} from "@vm0/core";
import { ProviderFormFields } from "../shared/provider-form-fields";
import { getUILabel } from "../settings-page/provider-ui-config";

type OnboardingStep = "1" | "2" | "3" | "4" | "done";

const MODEL_PROVIDER_LIST: ModelProviderType[] = [
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

const CONNECTOR_LIST: ConnectorType[] = [
  "github",
  "notion",
  "gmail",
  "google-sheets",
  "google-docs",
  "google-drive",
  "google-calendar",
  "slack",
  "docusign",
  "dropbox",
  "linear",
  "deel",
  "figma",
  "mercury",
  "reddit",
  "strava",
  "x",
  "neon",
  "garmin-connect",
  "vercel",
  "sentry",
  "intervals-icu",
  "monday",
  "xero",
];

/** Demo onboarding: reference layout, Zero style (simple, elegant, consistent). */
export function ZeroOnboarding({
  zeroAvatarSrc = "/zero-avatar.png",
  onAvatarClick,
}: {
  zeroAvatarSrc?: string;
  onAvatarClick?: () => void;
}) {
  const [step, setStep] = useState<OnboardingStep>("1");
  const [name, setName] = useState("Zero");
  const [selectedProviderType, setSelectedProviderType] =
    useState<ModelProviderType | null>(null);
  const [providerFormValues, setProviderFormValues] = useState({
    secret: "",
    selectedModel: "",
    useDefaultModel: true,
    authMethod: "",
    secrets: {} as Record<string, string>,
  });

  const handleSelectProvider = (type: ModelProviderType) => {
    const defaultAuth = hasAuthMethods(type)
      ? (getDefaultAuthMethod(type) ?? "")
      : "";
    const defaultModel = hasModelSelection(type)
      ? (getDefaultModel(type) ?? "")
      : "";
    setProviderFormValues({
      secret: "",
      selectedModel: defaultModel,
      useDefaultModel: true,
      authMethod: defaultAuth,
      secrets: {},
    });
    setSelectedProviderType(type);
  };

  const handleStep1Next = () => setStep("2");
  const handleStep2Next = () => {
    setSelectedProviderType(null);
    setStep("3");
  };
  const handleStep2Back = () => {
    if (selectedProviderType) {
      setSelectedProviderType(null);
    } else {
      setStep("1");
    }
  };
  const handleStep3Next = () => setStep("4");
  const handleStep3Back = () => setStep("2");
  const handleStep4Back = () => setStep("3");
  const handleAddToSlack = () => setStep("done");
  const handleContinueWithWeb = () => setStep("done");

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
        >
          <div className="flex-1 min-h-0 overflow-y-auto flex flex-col justify-center px-8 pt-8 pb-8">
            {selectedProviderType ? (
              <div className="flex flex-col items-center pt-10">
                <div className="flex items-center justify-center gap-3 mb-6">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden">
                    <ProviderIcon type={selectedProviderType} size={28} />
                  </span>
                  <h2 className="text-xl font-semibold tracking-tight text-foreground">
                    {getUILabel(selectedProviderType)}
                  </h2>
                </div>
                <div className="w-full max-w-md flex flex-col gap-4 text-left">
                  <ProviderFormFields
                    providerType={selectedProviderType}
                    formValues={providerFormValues}
                    onProviderTypeChange={() => {}}
                    onSecretChange={(v) =>
                      setProviderFormValues((prev) => ({ ...prev, secret: v }))
                    }
                    onModelChange={(v) =>
                      setProviderFormValues((prev) => ({
                        ...prev,
                        selectedModel: v,
                        useDefaultModel: false,
                      }))
                    }
                    onUseDefaultModelChange={(v) =>
                      setProviderFormValues((prev) => ({
                        ...prev,
                        useDefaultModel: v,
                        selectedModel: v ? "" : prev.selectedModel,
                      }))
                    }
                    onAuthMethodChange={(v) =>
                      setProviderFormValues((prev) => ({
                        ...prev,
                        authMethod: v,
                        secrets: {},
                      }))
                    }
                    onSecretFieldChange={(key, value) =>
                      setProviderFormValues((prev) => ({
                        ...prev,
                        secrets: { ...prev.secrets, [key]: value },
                      }))
                    }
                    isLoading={false}
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
            >
              Back
            </Button>
            <Button
              onClick={handleStep2Next}
              className="rounded-lg min-w-[100px]"
            >
              Next
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Step 3: Set connectors */}
      <Dialog open={step === "3"}>
        <DialogContent
          className={`${dialogBaseClass} zero-onboarding-dialog`}
          onPointerDownOutside={(e) => e.preventDefault()}
          onEscapeKeyDown={(e) => e.preventDefault()}
        >
          <div className="flex-1 min-h-0 overflow-y-auto flex flex-col items-center text-center px-8 pt-8">
            <DialogHeader className="space-y-2">
              <DialogTitle className="text-xl font-semibold tracking-tight">
                Set connectors
              </DialogTitle>
            </DialogHeader>
            <p className="text-sm text-muted-foreground leading-relaxed mt-1 mb-6 whitespace-nowrap">
              Connect the tools Zero needs to work with. You can skip and add
              more later.
            </p>
            <div className="w-full px-8 flex-1 min-h-0">
              <div className="w-full flex flex-wrap justify-center gap-3 pb-4">
                {CONNECTOR_LIST.map((type) => {
                  const config = CONNECTOR_TYPES[type];
                  return (
                    <div
                      key={type}
                      className="zero-card flex items-center gap-2 rounded-xl border border-border px-3 py-2 min-w-0"
                    >
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden">
                        <ConnectorIcon type={type} size={18} />
                      </span>
                      <span className="text-sm font-medium text-foreground whitespace-nowrap">
                        {config.label}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
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

      {/* Step 4: Where would you like to work with Zero? */}
      <Dialog open={step === "4"}>
        <DialogContent
          className={`${dialogBaseClass} zero-onboarding-dialog`}
          onPointerDownOutside={(e) => e.preventDefault()}
          onEscapeKeyDown={(e) => e.preventDefault()}
        >
          <div className="flex-1 min-h-0 overflow-y-auto flex flex-col items-center justify-center text-center px-8 py-8">
            <DialogHeader className="space-y-2">
              <DialogTitle className="text-xl font-semibold tracking-tight">
                Where would you like to work with Zero?
              </DialogTitle>
            </DialogHeader>
            <p className="text-sm text-muted-foreground leading-relaxed max-w-[400px] mt-1 mb-6">
              Choose how you&apos;d like to interact with your agent.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 w-full max-w-[560px]">
              <div className="zero-card flex flex-col items-center text-center rounded-xl border border-border p-5">
                <span className="flex h-12 w-12 shrink-0 items-center justify-center mb-3 overflow-hidden">
                  <img src={slackIcon} alt="" className="h-7 w-7" />
                </span>
                <span className="text-sm font-semibold text-foreground mb-1">
                  Add Zero to Slack
                </span>
                <p className="text-xs text-muted-foreground leading-relaxed mb-4">
                  Work with Zero in your Slack workspace where your team already
                  collaborates.
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  className="w-full rounded-lg zero-btn-morandi"
                  onClick={handleAddToSlack}
                >
                  Add to Slack
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
                <p className="text-xs text-muted-foreground leading-relaxed mb-4">
                  Chat with Zero in your browser with full access to workflows
                  and settings.
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  className="w-full rounded-lg zero-btn-morandi"
                  onClick={handleContinueWithWeb}
                >
                  Chat with Zero
                </Button>
              </div>
            </div>
          </div>
          <div className={`${footerClass} justify-start`}>
            <Button
              variant="ghost"
              className="rounded-lg text-muted-foreground"
              onClick={handleStep4Back}
            >
              Back
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
