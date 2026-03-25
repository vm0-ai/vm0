import { Component, useState } from "react";
import {
  useGet,
  useSet,
  useLastLoadable,
  useLastResolved,
} from "ccstate-react";
import slackIcon from "./components/settings/icons/slack.svg";
import zeroAvatarImg from "./assets/avatar_0.png";
import { Button, Input } from "@vm0/ui";
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
import { IconCircleCheck, IconLoader, IconSearch } from "@tabler/icons-react";
import { detach, Reason } from "../../signals/utils.ts";
import { create as createConfetti } from "canvas-confetti";

// ---------------------------------------------------------------------------
// Progress bar
// ---------------------------------------------------------------------------

function ProgressBar({
  totalSteps,
  currentStep,
}: {
  totalSteps: number;
  currentStep: number;
}) {
  return (
    <div className="flex items-center gap-1.5 w-full">
      {Array.from({ length: totalSteps }, (_, i) => (
        <div
          key={i}
          className={`h-1 flex-1 rounded-full transition-colors duration-300 ${
            i <= currentStep ? "bg-foreground" : "bg-muted"
          }`}
        />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Welcome animation (typewriter + confetti)
// ---------------------------------------------------------------------------

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
            position: "fixed",
            inset: 0,
            width: "100%",
            height: "100%",
            pointerEvents: "none",
            zIndex: 10,
          }}
        />
        <h2 className="text-2xl font-semibold tracking-tight min-h-[2rem]">
          {displayed}
          {displayed.length < this.props.title.length && (
            <span className="inline-block w-[2px] h-5 bg-foreground align-text-bottom animate-pulse ml-0.5" />
          )}
        </h2>
        <p
          className="text-sm text-muted-foreground leading-relaxed max-w-[420px] mt-3 transition-opacity duration-700"
          style={{ opacity: showSubtitle ? 1 : 0 }}
        >
          {subtitle}
        </p>
      </>
    );
  }
}

// ---------------------------------------------------------------------------
// Connector card
// ---------------------------------------------------------------------------

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
      className={`flex items-center gap-3 rounded-xl border px-4 py-3.5 transition-colors focus:outline-none ${
        isSelected
          ? "border-primary/40 bg-primary/5 cursor-pointer"
          : isPolling
            ? "border-yellow-500/30 bg-yellow-500/5"
            : "border-border hover:bg-muted/30 cursor-pointer"
      }`}
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted/40 overflow-hidden">
        <ConnectorIcon type={type} size={20} />
      </span>
      <span className="min-w-0 flex-1 text-left">
        <span className="block text-sm font-medium text-foreground truncate">
          {label}
        </span>
      </span>
      {isSelected && (
        <IconCircleCheck className="h-4 w-4 shrink-0 text-primary" />
      )}
      {isPolling && (
        <IconLoader className="h-4 w-4 shrink-0 text-yellow-500 animate-spin" />
      )}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Connectors step content
// ---------------------------------------------------------------------------

/** Step 2: Pure selection — just toggle connectors, no OAuth. */
function SelectConnectorsContent({
  selectedConnectors,
}: {
  selectedConnectors: string[];
}) {
  const toggleConnector = useSet(toggleZeroConnector$);
  const [search, setSearch] = useState("");

  const connectorEntries = Object.entries(CONNECTOR_TYPES) as [
    ConnectorType,
    (typeof CONNECTOR_TYPES)[ConnectorType],
  ][];

  const needle = search.trim().toLowerCase();
  const filtered = needle
    ? connectorEntries.filter(([, config]) =>
        config.label.toLowerCase().includes(needle),
      )
    : connectorEntries;

  const selectedSet = new Set(selectedConnectors);

  return (
    <>
      <h2 className="text-2xl font-semibold tracking-tight">
        Choose your tools
      </h2>
      <p className="text-sm text-muted-foreground leading-relaxed mt-2 mb-6">
        Select the apps you use. You can add more later.
      </p>
      <div className="relative w-full mb-5">
        <IconSearch
          size={15}
          stroke={1.5}
          className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground/60"
        />
        <Input
          type="text"
          placeholder="Search connectors..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="h-9 w-full pl-9 rounded-lg"
        />
      </div>
      <div className="w-full grid grid-cols-3 gap-3">
        {filtered.map(([type, config]) => (
          <OnboardingConnectorCard
            key={type}
            type={type}
            label={config.label}
            isSelected={selectedSet.has(type)}
            isPolling={false}
            onClick={() => toggleConnector(type)}
          />
        ))}
        {filtered.length === 0 && (
          <p className="col-span-3 text-sm text-muted-foreground py-4">
            No connectors match your search.
          </p>
        )}
      </div>
    </>
  );
}

/** Step 3: Connect selected connectors (placeholder UI). */
function ConnectStepContent({
  selectedConnectors,
}: {
  selectedConnectors: string[];
}) {
  const connectorTypesLoadable = useLastLoadable(allConnectorTypes$);
  const pollingType = useGet(pollingConnectorType$);
  const connect = useSet(connectConnector$);
  const setSelectedConnector = useSet(setSelectedConnectorType$);
  const pageSignal = useGet(pageSignal$);

  const allConnectors =
    connectorTypesLoadable.state === "hasData"
      ? connectorTypesLoadable.data
      : [];
  const connectorMap = new Map(allConnectors.map((c) => [c.type, c]));
  const connectedSet = new Set(
    allConnectors.filter((c) => c.connected).map((c) => c.type),
  );

  const selectedEntries = (
    Object.entries(CONNECTOR_TYPES) as [
      ConnectorType,
      (typeof CONNECTOR_TYPES)[ConnectorType],
    ][]
  ).filter(([type]) => selectedConnectors.includes(type));

  const handleConnect = (type: ConnectorType) => {
    const connector = connectorMap.get(type);
    if (connector?.connected) return;
    if (connector?.availableAuthMethods.includes("api-token")) {
      setSelectedConnector(type);
    } else {
      detach(connect(type, pageSignal), Reason.DomCallback);
    }
  };

  return (
    <>
      <h2 className="text-2xl font-semibold tracking-tight">
        Connect your apps
      </h2>
      <p className="text-sm text-muted-foreground leading-relaxed mt-2 mb-6">
        Authorize each app so Zero can work with it.
      </p>
      {selectedEntries.length === 0 ? (
        <p className="text-sm text-muted-foreground py-8">
          No connectors selected. You can go back to add some, or skip this
          step.
        </p>
      ) : (
        <div className="w-full flex flex-col gap-3">
          {selectedEntries.map(([type, config]) => {
            const isConnected = connectedSet.has(type);
            const isPolling = pollingType === type;
            return (
              <div
                key={type}
                className={`flex items-center gap-4 rounded-xl border px-5 py-4 transition-colors ${
                  isConnected
                    ? "border-green-500/30 bg-green-500/5"
                    : "border-border"
                }`}
              >
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted/40 overflow-hidden">
                  <ConnectorIcon type={type} size={20} />
                </span>
                <span className="min-w-0 flex-1 text-sm font-medium text-foreground">
                  {config.label}
                </span>
                {isConnected ? (
                  <span className="flex items-center gap-1.5 text-xs text-green-600 font-medium">
                    <IconCircleCheck className="h-4 w-4" />
                    Connected
                  </span>
                ) : isPolling ? (
                  <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <IconLoader className="h-4 w-4 animate-spin" />
                    Connecting...
                  </span>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    className="rounded-lg text-xs h-8"
                    onClick={() => handleConnect(type)}
                  >
                    Connect
                  </Button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Where to work step content
// ---------------------------------------------------------------------------

function WhereToWorkContent({
  name,
  zeroAvatarSrc,
  onAddToSlack,
  onContinueWeb,
  saving,
  error,
}: {
  name: string;
  zeroAvatarSrc: string;
  onAddToSlack: () => void;
  onContinueWeb: () => void;
  saving: boolean;
  error: string | null;
}) {
  return (
    <>
      <h2 className="text-2xl font-semibold tracking-tight">
        Where would you like to work with {name || "Zero"}?
      </h2>
      <p className="text-sm text-muted-foreground leading-relaxed max-w-[420px] mt-2 mb-8">
        Choose how you&apos;d like to interact with your agent.
      </p>
      {error && (
        <div className="w-full mb-6 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {error === "Build timed out"
            ? "Setup is taking longer than expected. Please try again."
            : error}
        </div>
      )}
      <div className="flex flex-col gap-3 w-full">
        <button
          type="button"
          onClick={onAddToSlack}
          disabled={saving}
          className="flex items-center gap-4 rounded-xl border border-border bg-card p-5 text-left transition-colors hover:bg-muted/30 disabled:opacity-50"
        >
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted/40 overflow-hidden">
            <img src={slackIcon} alt="" className="h-6 w-6" />
          </span>
          <div className="min-w-0 flex-1">
            <span className="block text-sm font-semibold text-foreground">
              Add {name || "Zero"} to Slack
            </span>
            <p className="text-xs text-muted-foreground leading-relaxed mt-0.5">
              Work with {name || "Zero"} in Slack where your team already
              collaborates.
            </p>
          </div>
        </button>
        <button
          type="button"
          onClick={onContinueWeb}
          disabled={saving}
          className="flex items-center gap-4 rounded-xl border border-border bg-card p-5 text-left transition-colors hover:bg-muted/30 disabled:opacity-50"
        >
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg overflow-hidden">
            <img
              src={zeroAvatarSrc}
              alt=""
              role="presentation"
              className="h-10 w-10 rounded-lg object-cover object-top"
            />
          </span>
          <div className="min-w-0 flex-1">
            <span className="block text-sm font-semibold text-foreground">
              Continue in web
            </span>
            <p className="text-xs text-muted-foreground leading-relaxed mt-0.5">
              Chat with {name || "Zero"} in your browser with full access to
              workflows and settings.
            </p>
          </div>
        </button>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Full-page layout wrapper
// ---------------------------------------------------------------------------

// Step-specific illustration hints for the right panel
const STEP_ILLUSTRATIONS: Record<string, { title: string; subtitle: string }> =
  {
    workspace: {
      title: "Meet Zero, your new teammate!",
      subtitle:
        "Think of Zero as a teammate you can casually talk to, delegate tasks, and count on to get things done.",
    },
    connectors: {
      title: "Your tools, automated",
      subtitle:
        "Zero works across your apps — managing tasks, syncing data, and handling workflows so you don't have to.",
    },
    where: {
      title: "Almost there!",
      subtitle: "Choose where you'd like to chat with Zero — Slack or the web.",
    },
  };

function OnboardingPage({
  currentStep,
  totalSteps,
  stepKey,
  onBack,
  onNext,
  showBack,
  showNext,
  nextDisabled,
  zeroAvatarSrc,
  children,
}: {
  currentStep: number;
  totalSteps: number;
  stepKey: string;
  onBack?: () => void;
  onNext?: () => void;
  showBack: boolean;
  showNext: boolean;
  nextDisabled?: boolean;
  zeroAvatarSrc?: string;
  children: React.ReactNode;
}) {
  const illustration =
    STEP_ILLUSTRATIONS[stepKey] ?? STEP_ILLUSTRATIONS.welcome;

  return (
    <div className="zero-app flex h-dvh bg-muted/30">
      {/* Left panel — brand / illustration */}
      <div className="hidden lg:flex w-2/5 shrink-0 flex-col items-center justify-center p-10 relative overflow-hidden">
        {/* Decorative circles */}
        <div className="absolute inset-0 pointer-events-none" aria-hidden>
          <div className="absolute top-[15%] left-[10%] h-48 w-48 rounded-full border border-border/20" />
          <div className="absolute top-[25%] left-[20%] h-64 w-64 rounded-full border border-border/15" />
          <div className="absolute bottom-[20%] right-[5%] h-40 w-40 rounded-full border border-border/20" />
          <div className="absolute top-[60%] left-[5%] h-32 w-32 rounded-full border border-border/10" />
        </div>

        <div className="relative z-10 flex flex-col items-center">
          {zeroAvatarSrc && (
            <img
              src={zeroAvatarSrc}
              alt=""
              role="presentation"
              className="h-24 w-24 object-contain mb-8"
            />
          )}
          <h3 className="text-xl font-semibold text-foreground text-center leading-snug">
            {illustration.title}
          </h3>
          <p className="text-sm text-muted-foreground text-center leading-relaxed mt-3 max-w-[300px]">
            {illustration.subtitle}
          </p>
        </div>
      </div>

      {/* Right panel — form */}
      <div className="flex flex-1 flex-col min-w-0 bg-background items-center">
        <div className="flex flex-col w-full max-w-[750px] flex-1 min-h-0">
          {/* Progress bar */}
          <div className="shrink-0 px-10 pt-8 pb-4">
            <ProgressBar totalSteps={totalSteps} currentStep={currentStep} />
          </div>

          {/* Content */}
          <main className="flex-1 min-h-0 overflow-y-auto px-10 py-6 [scrollbar-width:none] [-webkit-overflow-scrolling:touch] [&::-webkit-scrollbar]:hidden">
            {children}
          </main>

          {/* Footer */}
          <div className="shrink-0 border-t border-border/40 flex items-center justify-between px-10 py-5">
            <div>
              {showBack && onBack && (
                <Button
                  variant="ghost"
                  className="rounded-lg text-muted-foreground"
                  onClick={onBack}
                >
                  Back
                </Button>
              )}
            </div>
            <div>
              {showNext && onNext && (
                <Button
                  onClick={onNext}
                  className="rounded-lg min-w-[100px]"
                  disabled={nextDisabled}
                >
                  Next
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Zero onboarding (admin flow) — full page
// ---------------------------------------------------------------------------

const ADMIN_STEPS = ["1", "3", "3c", "4"] as const;

function WorkspaceStep({
  zeroAvatarSrc,
  onNext,
}: {
  zeroAvatarSrc: string;
  onNext: () => void;
}) {
  const [workspaceName, setWorkspaceName] = useState("");

  return (
    <OnboardingPage
      currentStep={0}
      totalSteps={ADMIN_STEPS.length}
      stepKey="workspace"
      zeroAvatarSrc={zeroAvatarSrc}
      showBack={false}
      showNext
      onNext={onNext}
      nextDisabled={!workspaceName.trim()}
    >
      <h2 className="text-2xl font-semibold tracking-tight">
        Create your workspace
      </h2>
      <p className="text-sm text-muted-foreground leading-relaxed mt-2 mb-8">
        Workspaces are shared environments where your team can collaborate with
        Zero.
      </p>
      <div className="w-full">
        <label
          htmlFor="workspace-name"
          className="block text-sm font-medium text-foreground mb-2"
        >
          Workspace name
        </label>
        <Input
          id="workspace-name"
          type="text"
          placeholder="e.g. Acme Corp"
          value={workspaceName}
          onChange={(e) => setWorkspaceName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && workspaceName.trim()) onNext();
          }}
          className="h-10 rounded-lg"
          autoFocus
        />
      </div>
    </OnboardingPage>
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

  const handleAddToSlack = () => {
    clearOnboardingError();
    const controller = new AbortController();
    detach(
      (async () => {
        const result = await completeOnboarding(controller.signal);
        if (!result) return;
        reloadBilling();
        dismissOnboarding();
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
        if (!result) return;
        reloadBilling();
        navigate("/");
        startNewSession();
        // Use controller.signal instead of pageSignal: navigate("/") aborts
        // the onboarding page signal via resetRouteSignal$, so pageSignal is
        // already dead by the time sendMessage runs.
        detach(
          sendMessage(
            "Who are you and what can you do?",
            undefined,
            controller.signal,
          ),
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

  return (
    <>
      {step === "1" && (
        <WorkspaceStep
          zeroAvatarSrc={zeroAvatarSrc}
          onNext={() => setStep("3")}
        />
      )}

      {/* Step 2: Select connectors (pure toggle) */}
      {step === "3" && (
        <OnboardingPage
          currentStep={1}
          totalSteps={ADMIN_STEPS.length}
          stepKey="connectors"
          zeroAvatarSrc={zeroAvatarSrc}
          showBack
          showNext
          onBack={() => setStep("1")}
          onNext={() => setStep("3c")}
        >
          <SelectConnectorsContent selectedConnectors={selectedConnectors} />
        </OnboardingPage>
      )}

      {/* Step 3: Connect selected apps */}
      {step === "3c" && (
        <OnboardingPage
          currentStep={2}
          totalSteps={ADMIN_STEPS.length}
          stepKey="connectors"
          zeroAvatarSrc={zeroAvatarSrc}
          showBack
          showNext
          onBack={() => setStep("3")}
          onNext={() => setStep("4")}
        >
          <ConnectStepContent selectedConnectors={selectedConnectors} />
        </OnboardingPage>
      )}

      {selectedConnectorType && (
        <ConnectModal
          onClose={() => setSelected(null)}
          onSuccess={() => {
            /* connector list refreshes automatically */
          }}
        />
      )}

      {/* Step 4: Where to work */}
      {step === "4" && (
        <OnboardingPage
          currentStep={3}
          totalSteps={ADMIN_STEPS.length}
          stepKey="where"
          zeroAvatarSrc={zeroAvatarSrc}
          showBack
          showNext={false}
          onBack={() => setStep("3c")}
        >
          <WhereToWorkContent
            name={name}
            zeroAvatarSrc={zeroAvatarSrc}
            onAddToSlack={handleAddToSlack}
            onContinueWeb={handleContinueWithWeb}
            saving={saving}
            error={onboardingError}
          />
        </OnboardingPage>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Member welcome (full page)
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

  const onboardingStatus = useLastResolved(zeroOnboardingStatus$);
  const defaultAgentSkillUrls = onboardingStatus?.defaultAgentSkills ?? [];

  const connectorTypesLoadable = useLastLoadable(allConnectorTypes$);
  const allConnectors =
    connectorTypesLoadable.state === "hasData"
      ? connectorTypesLoadable.data
      : [];
  const connectorTypeSet = new Set(allConnectors.map((c) => c.type));
  const connectedSet = new Set(
    allConnectors.filter((c) => c.connected).map((c) => c.type),
  );

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

  const hasConnectors = memberConnectors.length > 0;

  const handleOpenSlack = () => {
    detach(
      (async () => {
        await completeMember(pageSignal);
        navigate("/works");
      })(),
      Reason.DomCallback,
    );
  };

  const handleContinueWeb = () => {
    const controller = new AbortController();
    detach(
      (async () => {
        await completeMember(controller.signal);
        navigate("/");
        startNewSession();
        // Use controller.signal instead of pageSignal: navigate("/") aborts
        // the onboarding page signal via resetRouteSignal$, so pageSignal is
        // already dead by the time sendIntro runs.
        detach(
          sendIntro(
            "Who are you and what can you do?",
            undefined,
            controller.signal,
          ),
          Reason.DomCallback,
        );
      })(),
      Reason.DomCallback,
    );
  };

  const totalSteps = hasConnectors ? 3 : 2;

  const stepToIndex = (s: string): number => {
    if (s === "welcome") return 0;
    if (s === "connectors") return 1;
    if (s === "where") return hasConnectors ? 2 : 1;
    return 0;
  };

  return (
    <>
      {step === "welcome" && (
        <OnboardingPage
          currentStep={0}
          totalSteps={totalSteps}
          stepKey="welcome"
          zeroAvatarSrc={zeroAvatarSrc}
          showBack={false}
          showNext
          onNext={() => setStep(hasConnectors ? "connectors" : "where")}
        >
          <WelcomeAnimation
            title={`Meet ${displayName}, your new teammate!`}
            subtitle={`Think of ${displayName} as a teammate in the office you can casually talk to, delegate tasks, and count on to get things done.`}
          />
        </OnboardingPage>
      )}

      {step === "connectors" && (
        <OnboardingPage
          currentStep={1}
          totalSteps={totalSteps}
          stepKey="connectors"
          zeroAvatarSrc={zeroAvatarSrc}
          showBack
          showNext
          onBack={() => setStep("welcome")}
          onNext={() => setStep("where")}
        >
          <h2 className="text-2xl font-semibold tracking-tight">
            Connect your tools
          </h2>
          <p className="text-sm text-muted-foreground leading-relaxed mt-2 mb-8 max-w-[480px]">
            Your workspace uses these tools with {displayName}. Connect the ones
            you use to get started.
          </p>
          {memberConnectors.length > 0 ? (
            <div className="w-full grid grid-cols-3 gap-3">
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
                          connector?.availableAuthMethods.includes("api-token")
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
          ) : (
            <p className="text-sm text-muted-foreground">
              No connectors to set up — you&apos;re all set!
            </p>
          )}
        </OnboardingPage>
      )}

      {selectedConnectorType && (
        <ConnectModal
          onClose={() => setSelected(null)}
          onSuccess={() => {
            /* connector list refreshes automatically */
          }}
        />
      )}

      {step === "where" && (
        <OnboardingPage
          currentStep={stepToIndex("where")}
          totalSteps={totalSteps}
          stepKey="where"
          zeroAvatarSrc={zeroAvatarSrc}
          showBack
          showNext={false}
          onBack={() => setStep(hasConnectors ? "connectors" : "welcome")}
        >
          <WhereToWorkContent
            name={displayName}
            zeroAvatarSrc={zeroAvatarSrc}
            onAddToSlack={handleOpenSlack}
            onContinueWeb={handleContinueWeb}
            saving={saving}
            error={null}
          />
        </OnboardingPage>
      )}
    </>
  );
}
