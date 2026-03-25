import { Component } from "react";
import {
  useGet,
  useSet,
  useLastLoadable,
  useLastResolved,
} from "ccstate-react";
import slackIcon from "./components/settings/icons/slack.svg";
import zeroAvatarImg from "./assets/avatar_0.png";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  Button,
} from "@vm0/ui";
import { CONNECTOR_TYPES, type ConnectorType } from "@vm0/core";
import { ConnectorIcon } from "./components/settings/connector-icons.tsx";
import {
  zeroOnboardingStep$,
  zeroAgentName$,
  zeroSaving$,
  setZeroStep$,
  completeZeroOnboarding$,
  dismissZeroOnboarding$,
  zeroSelectedConnectors$,
  toggleZeroConnector$,
  zeroOnboardingError$,
  clearZeroOnboardingError$,
  completeMemberOnboarding$,
  zeroOnboardingStatus$,
  memberWelcomeStep$,
  setMemberWelcomeStep$,
} from "../../signals/zero-page/zero-onboarding.ts";
import {
  sendZeroChatMessage$,
  startNewZeroSession$,
} from "../../signals/zero-page/zero-chat.ts";
import { navigateTo$ } from "../../signals/route.ts";
import {
  allConnectorTypes$,
  connectConnector$,
  pollingConnectorType$,
  selectedConnectorType$,
  setSelectedConnectorType$,
} from "../../signals/zero-page/settings/connectors.ts";
import { ConnectModal } from "./components/settings/add-connection-dialog.tsx";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { slackOrgData$ } from "../../signals/zero-page/zero-slack.ts";
import { reloadBillingStatus$ } from "../../signals/zero-page/billing.ts";
import { IconCircleCheck, IconLoader } from "@tabler/icons-react";
import { detach, Reason } from "../../signals/utils.ts";
import { create as createConfetti } from "canvas-confetti";

class WelcomeAnimation extends Component<
  { title: string; subtitle: string },
  { displayed: string; showSubtitle: boolean; confettiFired: boolean }
> {
  private static readonly COLORS = [
    "#26ccff",
    "#fcff42",
    "#ff5e7e",
    "#88ff5a",
    "#ffa62d",
    "#ffdb4d",
  ];
  private timer: number | undefined;
  private canvasRef: HTMLCanvasElement | null = null;
  state = { displayed: "", showSubtitle: false, confettiFired: false };

  componentDidMount() {
    this.startTypewriter();
  }

  componentWillUnmount() {
    if (this.timer !== undefined) {
      window.clearInterval(this.timer);
    }
  }

  private startTypewriter() {
    let i = 0;
    const { title } = this.props;
    this.timer = window.setInterval(() => {
      i++;
      this.setState({ displayed: title.slice(0, i) });
      if (i >= title.length) {
        window.clearInterval(this.timer);
        this.timer = undefined;
        window.setTimeout(() => {
          this.setState({ showSubtitle: true });
          window.setTimeout(() => this.fireConfetti(), 400);
        }, 600);
      }
    }, 40);
  }

  private fireConfetti() {
    if (this.state.confettiFired || !this.canvasRef) {
      return;
    }
    this.setState({ confettiFired: true });
    const fire = createConfetti(this.canvasRef, { resize: true });
    if (!fire) {
      return;
    }
    const end = Date.now() + 800;
    const frame = () => {
      fire({
        particleCount: 3,
        angle: 60,
        spread: 55,
        origin: { x: 0, y: 0.5 },
        colors: WelcomeAnimation.COLORS,
      })?.catch(() => undefined);
      fire({
        particleCount: 3,
        angle: 120,
        spread: 55,
        origin: { x: 1, y: 0.5 },
        colors: WelcomeAnimation.COLORS,
      })?.catch(() => undefined);
      if (Date.now() < end) {
        window.requestAnimationFrame(frame);
      }
    };
    frame();
  }

  render() {
    const { subtitle } = this.props;
    const { displayed, showSubtitle } = this.state;
    return (
      <>
        <canvas
          ref={(el) => {
            this.canvasRef = el;
          }}
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            pointerEvents: "none",
            zIndex: 10,
          }}
        />
        <h2 className="text-xl font-semibold tracking-tight min-h-[1.75rem]">
          {displayed}
          {displayed.length < this.props.title.length && (
            <span className="inline-block w-[2px] h-5 bg-foreground align-text-bottom animate-pulse ml-0.5" />
          )}
        </h2>
        <p
          className="text-sm text-muted-foreground leading-relaxed max-w-[380px] mt-3 transition-opacity duration-700"
          style={{ opacity: showSubtitle ? 1 : 0 }}
        >
          {subtitle}
        </p>
      </>
    );
  }
}

function OnboardingConnectorCard({
  type,
  label,
  isSelected,
  isPolling,
  onClick,
}: {
  type: ConnectorType;
  label: string;
  isSelected: boolean;
  isPolling: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={isPolling}
      className={`zero-card flex items-center gap-2 rounded-xl border px-3 py-2 min-w-0 transition-colors focus:outline-none ${
        isSelected
          ? "border-green-500/30 bg-green-500/5 cursor-pointer"
          : isPolling
            ? "border-yellow-500/30 bg-yellow-500/5"
            : "border-border hover:bg-muted/50 cursor-pointer"
      }`}
    >
      <span className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden">
        <ConnectorIcon type={type} size={20} />
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

function OnboardingConnectorsStep({
  name,
  selectedConnectors,
}: {
  name: string;
  selectedConnectors: string[];
}) {
  const connectorTypesLoadable = useLastLoadable(allConnectorTypes$);
  const pollingType = useGet(pollingConnectorType$);
  const connect = useSet(connectConnector$);
  const setSelectedConnector = useSet(setSelectedConnectorType$);
  const pageSignal = useGet(pageSignal$);
  const toggleConnector = useSet(toggleZeroConnector$);

  const allConnectors =
    connectorTypesLoadable.state === "hasData"
      ? connectorTypesLoadable.data
      : [];
  const connectorMap = new Map(allConnectors.map((c) => [c.type, c]));
  const selectedSet = new Set(selectedConnectors);

  const connectorEntries = Object.entries(CONNECTOR_TYPES) as [
    ConnectorType,
    (typeof CONNECTOR_TYPES)[ConnectorType],
  ][];

  const handleClick = (type: ConnectorType) => {
    // Already selected → deselect (don't disconnect)
    if (selectedSet.has(type)) {
      toggleConnector(type);
      return;
    }

    const connector = connectorMap.get(type);

    // Connector already connected → select immediately
    if (connector?.connected) {
      toggleConnector(type);
      return;
    }

    // Not connected → start connect flow, select on success
    if (connector?.availableAuthMethods.includes("api-token")) {
      setSelectedConnector(type);
    } else {
      // OAuth flow: select skill after connect completes
      detach(
        (async () => {
          await connect(type, pageSignal);
          toggleConnector(type);
        })(),
        Reason.DomCallback,
      );
    }
  };

  return (
    <div className="flex-1 min-h-0 overflow-y-auto flex flex-col items-center text-center px-8 pt-8">
      <DialogHeader className="space-y-2">
        <DialogTitle className="text-xl font-semibold tracking-tight">
          Add connector
        </DialogTitle>
      </DialogHeader>
      <p className="text-sm text-muted-foreground leading-relaxed mt-1 mb-6">
        Add connectors so {name || "Zero"} can work with your tools. You can
        skip and add more later.
      </p>
      <div className="w-full px-4 flex-1 min-h-0">
        <div className="w-full flex flex-wrap justify-center gap-3 pb-4">
          {connectorEntries.map(([type, config]) => (
            <OnboardingConnectorCard
              key={type}
              type={type}
              label={config.label}
              isSelected={selectedSet.has(type)}
              isPolling={pollingType === type}
              onClick={() => handleClick(type)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

/** Zero onboarding: creates org, model provider, and default agent. */
export function ZeroOnboarding({
  zeroAvatarSrc = zeroAvatarImg,
}: {
  zeroAvatarSrc?: string;
}) {
  const step = useGet(zeroOnboardingStep$);
  const setStep = useSet(setZeroStep$);
  const name = useGet(zeroAgentName$);
  const saving = useGet(zeroSaving$);
  const selectedConnectors = useGet(zeroSelectedConnectors$);
  const toggleConnector = useSet(toggleZeroConnector$);
  const completeOnboarding = useSet(completeZeroOnboarding$);
  const dismissOnboarding = useSet(dismissZeroOnboarding$);
  const sendMessage = useSet(sendZeroChatMessage$);
  const startNewSession = useSet(startNewZeroSession$);
  const navigate = useSet(navigateTo$);
  const onboardingError = useGet(zeroOnboardingError$);
  const clearOnboardingError = useSet(clearZeroOnboardingError$);
  const reloadBilling = useSet(reloadBillingStatus$);
  const selectedConnectorType = useGet(selectedConnectorType$);
  const setSelected = useSet(setSelectedConnectorType$);
  const slackData = useGet(slackOrgData$);

  const handleStep1Next = () => {
    setStep("3");
  };

  const handleStep3Next = () => {
    setStep("4");
  };

  const handleStep3Back = () => {
    setStep("1");
  };

  const handleStep4Back = () => {
    setStep("3");
  };

  const handleAddToSlack = () => {
    clearOnboardingError();
    const controller = new AbortController();
    detach(
      (async () => {
        const result = await completeOnboarding(controller.signal);
        if (!result) {
          return;
        }
        reloadBilling();
        dismissOnboarding();
        // Admin with install URL: open Slack OAuth install flow
        if (slackData?.isAdmin && slackData.installUrl) {
          const url = new URL(slackData.installUrl, window.location.origin);
          url.searchParams.set("_t", String(Date.now()));
          window.open(url.toString(), "_blank");
        }
        navigate("/works");
      })(),
      Reason.DomCallback,
    );
  };

  const handleContinueWithWeb = () => {
    clearOnboardingError();
    const controller = new AbortController();
    detach(
      (async () => {
        const result = await completeOnboarding(controller.signal);
        if (!result) {
          return;
        }
        reloadBilling();
        navigate("/");
        startNewSession();
        detach(
          sendMessage("Who are you and what can you do?"),
          Reason.DomCallback,
        );
        dismissOnboarding();
      })(),
      Reason.DomCallback,
    );
  };

  if (step === "done") {
    return null;
  }

  const dialogBaseClass =
    "zero-app sm:max-w-[720px] h-[min(500px,85dvh)] gap-0 p-0 flex flex-col rounded-xl border border-border bg-card shadow-lg";
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
          style={{ position: "fixed", overflow: "hidden" }}
        >
          <DialogTitle className="sr-only">
            Meet Zero, your new teammate!
          </DialogTitle>
          <div className="flex-1 min-h-0 overflow-y-auto flex flex-col items-center justify-center text-center px-8 py-8">
            <div className="h-16 w-16 shrink-0 overflow-hidden rounded-xl mb-5">
              <img
                src={zeroAvatarSrc}
                alt=""
                role="presentation"
                className="h-16 w-16 rounded-full object-cover object-top"
              />
            </div>
            <WelcomeAnimation
              title="Meet Zero, your new teammate!"
              subtitle="Think of Zero as a teammate in the office you can casually talk to, delegate tasks, and count on to get things done."
            />
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

      {/* Step 3: Add skills */}
      <Dialog open={step === "3"}>
        <DialogContent
          className={`${dialogBaseClass} zero-onboarding-dialog`}
          onPointerDownOutside={(e) => e.preventDefault()}
          onEscapeKeyDown={(e) => e.preventDefault()}
          aria-describedby={undefined}
        >
          <OnboardingConnectorsStep
            name={name}
            selectedConnectors={selectedConnectors}
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
          onClose={() => setSelected(null)}
          onSuccess={() => toggleConnector(selectedConnectorType)}
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

// ---------------------------------------------------------------------------
// Member welcome (two-step onboarding for invited team members)
// ---------------------------------------------------------------------------

export function MemberWelcome({
  displayName = "Zero",
  zeroAvatarSrc = zeroAvatarImg,
}: {
  displayName?: string;
  zeroAvatarSrc?: string;
}) {
  const step = useGet(memberWelcomeStep$);
  const setStep = useSet(setMemberWelcomeStep$);
  const completeMember = useSet(completeMemberOnboarding$);
  const navigate = useSet(navigateTo$);
  const startNewSession = useSet(startNewZeroSession$);
  const sendIntro = useSet(sendZeroChatMessage$);
  const saving = useGet(zeroSaving$);
  const selectedConnectorType = useGet(selectedConnectorType$);
  const setSelected = useSet(setSelectedConnectorType$);
  const connectConnectorFn = useSet(connectConnector$);
  const pageSignal = useGet(pageSignal$);

  // Get the default agent's skills from onboarding status
  const onboardingStatus = useLastResolved(zeroOnboardingStatus$);
  const defaultAgentSkillUrls = onboardingStatus?.defaultAgentSkills ?? [];

  // Convert skill URLs to values and filter to only connectable skills
  const connectorTypesLoadable = useLastLoadable(allConnectorTypes$);
  const allConnectors =
    connectorTypesLoadable.state === "hasData"
      ? connectorTypesLoadable.data
      : [];
  const connectorTypeSet = new Set(allConnectors.map((c) => c.type));
  const connectedSet = new Set(
    allConnectors.filter((c) => c.connected).map((c) => c.type),
  );

  // Only show connectors that: (1) are in the default agent, (2) have a connector type
  const memberConnectors = (
    Object.entries(CONNECTOR_TYPES) as [
      ConnectorType,
      (typeof CONNECTOR_TYPES)[ConnectorType],
    ][]
  ).filter(([type]) => {
    const isInAgent = defaultAgentSkillUrls.some((url) =>
      url.endsWith(`/${type}`),
    );
    return isInAgent && connectorTypeSet.has(type);
  });

  const handleOpenSlack = () => {
    detach(
      (async () => {
        await completeMember();
        navigate("/works");
      })(),
      Reason.DomCallback,
    );
  };

  const handleContinueWeb = () => {
    detach(
      (async () => {
        await completeMember();
        navigate("/");
        startNewSession();
        detach(
          sendIntro("Who are you and what can you do?"),
          Reason.DomCallback,
        );
      })(),
      Reason.DomCallback,
    );
  };

  const dialogBaseClass =
    "zero-app sm:max-w-[720px] h-[min(500px,85dvh)] gap-0 p-0 flex flex-col rounded-xl border border-border bg-card shadow-lg";
  const footerClass =
    "zero-onboarding-footer shrink-0 border-t h-16 flex items-center gap-2 px-8";

  return (
    <>
      {/* Step 1: Welcome */}
      <Dialog open={step === "welcome"}>
        <DialogContent
          className={`${dialogBaseClass} zero-onboarding-dialog`}
          onPointerDownOutside={(e) => e.preventDefault()}
          onEscapeKeyDown={(e) => e.preventDefault()}
          aria-describedby={undefined}
          style={{ position: "fixed", overflow: "hidden" }}
        >
          <DialogTitle className="sr-only">
            Meet {displayName}, your new teammate!
          </DialogTitle>
          <div className="flex-1 min-h-0 overflow-y-auto flex flex-col items-center justify-center text-center px-8 py-8">
            <span className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-full mb-5">
              <img
                src={zeroAvatarSrc}
                alt=""
                role="presentation"
                className="h-16 w-16 rounded-full object-cover object-top"
              />
            </span>
            <WelcomeAnimation
              title={`Meet ${displayName}, your new teammate!`}
              subtitle={`Think of ${displayName} as a teammate in the office you can casually talk to, delegate tasks, and count on to get things done.`}
            />
          </div>
          <div className={`${footerClass} justify-end`}>
            <Button
              onClick={() => {
                if (memberConnectors.length > 0) {
                  setStep("connectors");
                } else {
                  setStep("where");
                }
              }}
              className="rounded-lg min-w-[100px]"
            >
              Next
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Step 2: Connect your tools */}
      <Dialog open={step === "connectors"}>
        <DialogContent
          className={`${dialogBaseClass} zero-onboarding-dialog`}
          onPointerDownOutside={(e) => e.preventDefault()}
          onEscapeKeyDown={(e) => e.preventDefault()}
          aria-describedby={undefined}
        >
          <div className="flex-1 min-h-0 overflow-y-auto flex flex-col items-center text-center px-8 pt-8">
            <DialogHeader className="space-y-2">
              <DialogTitle className="text-xl font-semibold tracking-tight">
                Connect your tools
              </DialogTitle>
            </DialogHeader>
            <p className="text-sm text-muted-foreground leading-relaxed mt-1 mb-6">
              Your organization uses these tools with {displayName}. Connect the
              ones you use to get started.
            </p>
            {memberConnectors.length > 0 ? (
              <div className="w-full px-4 flex-1 min-h-0">
                <div className="w-full flex flex-wrap justify-center gap-3 pb-4">
                  {memberConnectors.map(([type, config]) => {
                    const isConnected = connectedSet.has(type);
                    return (
                      <OnboardingConnectorCard
                        key={type}
                        type={type}
                        label={config.label}
                        isSelected={isConnected}
                        isPolling={false}
                        onClick={() => {
                          if (!isConnected) {
                            const connector = allConnectors.find(
                              (c) => c.type === type,
                            );
                            if (
                              connector?.availableAuthMethods.includes(
                                "api-token",
                              )
                            ) {
                              setSelected(type);
                            } else {
                              detach(
                                (async () => {
                                  await connectConnectorFn(type, pageSignal);
                                })(),
                                Reason.DomCallback,
                              );
                            }
                          }
                        }}
                      />
                    );
                  })}
                </div>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                No connectors to set up — you&apos;re all set!
              </p>
            )}
          </div>
          <div className={`${footerClass} justify-between`}>
            <Button
              variant="ghost"
              className="rounded-lg text-muted-foreground"
              onClick={() => setStep("welcome")}
            >
              Back
            </Button>
            <Button
              onClick={() => setStep("where")}
              className="rounded-lg min-w-[100px]"
            >
              Next
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {selectedConnectorType && (
        <ConnectModal
          onClose={() => setSelected(null)}
          onSuccess={() => {
            /* connector list refreshes automatically */
          }}
        />
      )}

      {/* Step 3: Where to work */}
      <Dialog open={step === "where"}>
        <DialogContent
          className={`${dialogBaseClass} zero-onboarding-dialog`}
          onPointerDownOutside={(e) => e.preventDefault()}
          onEscapeKeyDown={(e) => e.preventDefault()}
          aria-describedby={undefined}
        >
          <div className="flex-1 min-h-0 overflow-y-auto flex flex-col items-center justify-center text-center px-8 py-8">
            <DialogHeader className="space-y-2">
              <DialogTitle className="text-xl font-semibold tracking-tight">
                Where would you like to work with {displayName}?
              </DialogTitle>
            </DialogHeader>
            <p className="text-sm text-muted-foreground leading-relaxed max-w-[400px] mt-1 mb-6">
              Your admin has already added {displayName} to your workspace. Pick
              how you&apos;d like to get started.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 w-full max-w-[560px]">
              <div className="zero-card flex flex-col items-center text-center rounded-xl border border-border p-5">
                <span className="flex h-12 w-12 shrink-0 items-center justify-center mb-3 overflow-hidden">
                  <img src={slackIcon} alt="" className="h-7 w-7" />
                </span>
                <span className="text-sm font-semibold text-foreground mb-1">
                  Open in Slack
                </span>
                <p className="text-xs text-muted-foreground leading-relaxed mb-4 flex-1">
                  {displayName} is already in your Slack workspace. Send a DM to
                  start chatting.
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  className="w-full rounded-lg zero-btn-morandi"
                  onClick={handleOpenSlack}
                  disabled={saving}
                >
                  {saving ? "Saving\u2026" : "Go to Slack"}
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
                  Chat with {displayName} right here with full access to
                  workflows and settings.
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  className="w-full rounded-lg zero-btn-morandi"
                  onClick={handleContinueWeb}
                  disabled={saving}
                >
                  {saving ? "Saving\u2026" : `Chat with ${displayName}`}
                </Button>
              </div>
            </div>
          </div>
          <div className={`${footerClass} justify-start`}>
            <Button
              variant="ghost"
              className="rounded-lg text-muted-foreground"
              onClick={() => {
                if (memberConnectors.length > 0) {
                  setStep("connectors");
                } else {
                  setStep("welcome");
                }
              }}
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
