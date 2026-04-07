import {
  useGet,
  useSet,
  useLastLoadable,
  useLastResolved,
} from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import slackIcon from "./components/settings/icons/slack.svg";
import zeroAvatarImg from "./assets/avatar_0.webp";
import zeroAnimatedSrc from "./assets/zero-animated.webp";
import slackPreviewImg from "./assets/Slack.png";
import { Button, Input } from "@vm0/ui";
import { CONNECTOR_TYPES, type ConnectorType } from "@vm0/core";
import { ConnectorIcon } from "./components/settings/connector-icons.tsx";
import {
  zeroWorkspaceName$,
  setZeroWorkspaceName$,
  zeroSelectedConnectors$,
  toggleZeroConnector$,
  connectorSearch$,
  setConnectorSearch$,
} from "../../signals/zero-page/zero-onboarding.ts";
import {
  onboardingDisplayName$,
  onboardingAddToSlack$,
  onboardingContinueWeb$,
  onboardingEffectiveStep$,
  onboardingEffectiveConnectors$,
  onboardingVisibleSteps$,
  onboardingCurrentStepIndex$,
  onboardingStepKey$,
  onboardingShowBack$,
  onboardingShowNext$,
  onboardingNextDisabled$,
  onboardingStepBack$,
  onboardingStepNext$,
  onboardingIsAdmin$,
} from "../../signals/zero-page/zero-onboarding-actions.ts";
import {
  allConnectorTypes$,
  connectConnector$,
  pollingConnectorType$,
  selectedConnectorType$,
  setSelectedConnectorType$,
} from "../../signals/zero-page/settings/connectors.ts";
import { ConnectModal } from "./components/settings/add-connection-dialog.tsx";
import { pageSignal$ } from "../../signals/page-signal.ts";
import {
  IconCircleCheck,
  IconCircleCheckFilled,
  IconLoader,
  IconSearch,
} from "@tabler/icons-react";
import { detach, Reason } from "../../signals/utils.ts";
import { AccountDropdown } from "./zero-sidebar.tsx";
import { VM0ClerkProvider } from "../clerk/clerk-provider.tsx";
import { handleZeroAccountAction$ } from "../../signals/zero-page/zero-nav.ts";

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
      {Array.from({ length: totalSteps }, (_, i) => {
        return (
          <div
            key={i}
            data-testid="progress-step"
            className={`h-1 flex-1 rounded-full transition-colors duration-300 ${
              i <= currentStep ? "bg-foreground" : "bg-muted"
            }`}
          />
        );
      })}
    </div>
  );
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
      data-testid={`connector-card-${type}`}
      onClick={onClick}
      disabled={isPolling}
      className={`flex items-center gap-3 rounded-xl px-4 py-3.5 transition-colors focus:outline-none zero-border ${
        isPolling ? "bg-yellow-500/5" : "hover:bg-muted/30 cursor-pointer"
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
        <IconCircleCheckFilled
          data-testid="connector-check-icon"
          className="h-4 w-4 shrink-0 text-primary"
        />
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
function SelectConnectorsContent() {
  const selectedConnectors = useGet(zeroSelectedConnectors$);
  const toggleConnector = useSet(toggleZeroConnector$);
  const search = useGet(connectorSearch$);
  const setSearch = useSet(setConnectorSearch$);

  const connectorEntries = Object.entries(CONNECTOR_TYPES) as [
    ConnectorType,
    (typeof CONNECTOR_TYPES)[ConnectorType],
  ][];

  const needle = search.trim().toLowerCase();
  const filtered = needle
    ? connectorEntries.filter(([, config]) => {
        return config.label.toLowerCase().includes(needle);
      })
    : connectorEntries;

  const selectedSet = new Set(selectedConnectors);

  return (
    <>
      <h2
        data-testid="onboarding-step-select-connectors"
        className="text-2xl font-semibold tracking-tight"
      >
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
          onChange={(e) => {
            return setSearch(e.target.value);
          }}
          className="h-9 w-full pl-9 rounded-lg"
        />
      </div>
      <div className="w-full grid grid-cols-2 sm:grid-cols-3 gap-3">
        {filtered.map(([type, config]) => {
          return (
            <OnboardingConnectorCard
              key={type}
              type={type}
              label={config.label}
              isSelected={selectedSet.has(type)}
              isPolling={false}
              onClick={() => {
                return toggleConnector(type);
              }}
            />
          );
        })}
        {filtered.length === 0 && (
          <p className="col-span-2 sm:col-span-3 text-sm text-muted-foreground py-4">
            No connectors match your search.
          </p>
        )}
      </div>
    </>
  );
}

/** Step 3: Connect selected connectors (placeholder UI). */
function ConnectStepContent() {
  const effectiveConnectors =
    useLastResolved(onboardingEffectiveConnectors$) ?? [];
  const connectorTypesLoadable = useLastLoadable(allConnectorTypes$);
  const pollingType = useGet(pollingConnectorType$);
  const connect = useSet(connectConnector$);
  const setSelectedConnector = useSet(setSelectedConnectorType$);
  const pageSignal = useGet(pageSignal$);

  const allConnectors =
    connectorTypesLoadable.state === "hasData"
      ? connectorTypesLoadable.data
      : [];
  const connectorMap = new Map(
    allConnectors.map((c) => {
      return [c.type, c];
    }),
  );
  const connectedSet = new Set(
    allConnectors
      .filter((c) => {
        return c.connected;
      })
      .map((c) => {
        return c.type;
      }),
  );

  const selectedEntries = (
    Object.entries(CONNECTOR_TYPES) as [
      ConnectorType,
      (typeof CONNECTOR_TYPES)[ConnectorType],
    ][]
  ).filter(([type]) => {
    return effectiveConnectors.includes(type);
  });

  const handleConnect = (type: ConnectorType) => {
    const connector = connectorMap.get(type);
    if (connector?.connected) {
      return;
    }
    if (connector?.availableAuthMethods.includes("api-token")) {
      setSelectedConnector(type);
    } else {
      detach(connect(type, pageSignal), Reason.DomCallback);
    }
  };

  return (
    <>
      <h2
        data-testid="onboarding-step-connect"
        className="text-2xl font-semibold tracking-tight"
      >
        Connect your apps
      </h2>
      <p className="text-sm text-muted-foreground leading-relaxed mt-2 mb-6">
        Authorize each app so Zero can work with it. You can always add more
        later.
      </p>
      {selectedEntries.length === 0 ? (
        <p
          data-testid="onboarding-no-connectors"
          className="text-sm text-muted-foreground py-8"
        >
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
                className="flex items-center gap-4 rounded-xl px-5 py-4 zero-border"
              >
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted/40 overflow-hidden">
                  <ConnectorIcon type={type} size={20} />
                </span>
                <div className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-foreground">
                    {config.label}
                  </span>
                  {"helpText" in config && config.helpText && (
                    <span className="block text-xs text-muted-foreground mt-0.5 line-clamp-1">
                      {(config.helpText as string)
                        .replace(/^Connect your \w+ account to /, "")
                        .replace(/^Connect /, "")}
                    </span>
                  )}
                </div>
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
                    onClick={() => {
                      return handleConnect(type);
                    }}
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

function WhereToWorkContent() {
  const name = useLastResolved(onboardingDisplayName$) ?? "Zero";

  const [slackLoadable, addToSlack] = useLoadableSet(onboardingAddToSlack$);
  const [webLoadable, continueWeb] = useLoadableSet(onboardingContinueWeb$);

  const pageSignal = useGet(pageSignal$);

  const saving =
    slackLoadable.state === "loading" || webLoadable.state === "loading";
  const error =
    slackLoadable.state === "hasError"
      ? String(slackLoadable.error)
      : webLoadable.state === "hasError"
        ? String(webLoadable.error)
        : null;

  return (
    <>
      <h2
        data-testid="onboarding-step-where-to-work"
        className="text-2xl font-semibold tracking-tight"
      >
        Where would you like to work with {name || "Zero"}?
      </h2>
      <p className="text-sm text-muted-foreground leading-relaxed max-w-[420px] mt-2 mb-8">
        Choose how you&apos;d like to interact with your agent.
      </p>
      {error && (
        <div className="w-full mb-6 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}
      <div className="flex flex-col gap-5 w-full">
        <button
          type="button"
          onClick={() => {
            detach(addToSlack(pageSignal), Reason.DomCallback);
          }}
          disabled={saving}
          className="flex items-center gap-4 rounded-xl bg-card px-6 py-6 text-left transition-colors hover:bg-muted/30 disabled:opacity-50 zero-border"
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
          onClick={() => {
            detach(continueWeb(pageSignal), Reason.DomCallback);
          }}
          disabled={saving}
          className="flex items-center gap-4 rounded-xl bg-card px-6 py-6 text-left transition-colors hover:bg-muted/30 disabled:opacity-50 zero-border"
        >
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg overflow-hidden">
            <img
              src={zeroAvatarImg}
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
// Chat preview for workspace step
// ---------------------------------------------------------------------------

function ChatPreview() {
  return (
    <div className="w-full max-w-[360px] flex flex-col items-center">
      {/* Header */}
      <img
        src={zeroAnimatedSrc}
        alt=""
        role="presentation"
        className="h-24 w-24 object-contain mb-5"
      />
      <h3 className="text-lg font-semibold text-foreground text-center leading-snug">
        AI that works alongside your team
      </h3>
      <p className="text-sm text-muted-foreground text-center leading-relaxed mt-2 mb-6 max-w-[300px]">
        Zero lives in your workspace, works across your tools, and helps
        everyone stay aligned.
      </p>

      {/* Mock chat — offset down */}
      <div className="mt-10" />
      <div className="zero-app w-full flex flex-col gap-5">
        {/* User message */}
        <div className="flex flex-col items-end pl-10">
          <div className="zero-chat-bubble-user rounded-xl text-[13px] leading-relaxed">
            <div className="px-4 py-3">
              Draft a Q2 brief and share it with the team
            </div>
          </div>
        </div>

        {/* Zero reply */}
        <div className="flex items-start gap-2.5 pr-10">
          <img
            src={zeroAvatarImg}
            alt=""
            className="h-6 w-6 shrink-0 object-contain mt-0.5"
          />
          <div className="text-[13px] text-foreground leading-relaxed">
            Created in Notion and shared in #product. Sarah and James tagged for
            review.
          </div>
        </div>

        {/* User follow-up */}
        <div className="flex flex-col items-end pl-10">
          <div className="zero-chat-bubble-user rounded-xl text-[13px] leading-relaxed">
            <div className="px-4 py-3">
              Keep it updated weekly and notify the team
            </div>
          </div>
        </div>

        {/* Zero reply */}
        <div className="flex items-start gap-2.5 pr-10">
          <img
            src={zeroAvatarImg}
            alt=""
            className="h-6 w-6 shrink-0 object-contain mt-0.5"
          />
          <div className="text-[13px] text-foreground leading-relaxed">
            Done! I&apos;ll update every Friday and post a summary to #product.
            🔄
          </div>
        </div>
      </div>
    </div>
  );
}

// Step-specific illustration hints for the right panel
type StepIllustration = {
  title: string;
  subtitle: string;
  showSlackPreview?: boolean;
};
function getStepIllustration(stepKey: string): StepIllustration {
  switch (stepKey) {
    case "connectors": {
      return {
        title: "Your tools, automated",
        subtitle:
          "Zero works across your apps — managing tasks, syncing data, and handling workflows so you don't have to.",
      };
    }
    case "where": {
      return {
        title: "Works where your team works",
        subtitle:
          "Zero also lives in Slack, connects your tools securely, and handles tasks so your team can focus on what matters.",
        showSlackPreview: true,
      };
    }
    default: {
      return {
        title: "AI that works alongside your team",
        subtitle:
          "Zero lives in your workspace, works across your tools, and helps everyone stay aligned.",
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Orbit illustration — selected connectors orbit around Zero
// ---------------------------------------------------------------------------

function OrbitIllustration() {
  const selectedConnectors =
    useLastResolved(onboardingEffectiveConnectors$) ?? [];

  const entries = (
    Object.entries(CONNECTOR_TYPES) as [
      ConnectorType,
      (typeof CONNECTOR_TYPES)[ConnectorType],
    ][]
  ).filter(([type]) => {
    return selectedConnectors.includes(type);
  });

  const innerRadius = 110;
  const outerRadius = 175;
  const inner = entries.slice(0, 6);
  const outer = entries.slice(6, 14);

  return (
    <div className="relative w-[400px] h-[400px]">
      {/* Spinning orbit rings */}
      <div
        className="absolute rounded-full border border-dashed border-foreground/8 animate-[spin_60s_linear_infinite]"
        style={{
          top: `calc(50% - ${innerRadius}px)`,
          left: `calc(50% - ${innerRadius}px)`,
          width: innerRadius * 2,
          height: innerRadius * 2,
        }}
      />
      {entries.length > 6 && (
        <div
          className="absolute rounded-full border border-dashed border-foreground/6 animate-[spin_90s_linear_infinite_reverse]"
          style={{
            top: `calc(50% - ${outerRadius}px)`,
            left: `calc(50% - ${outerRadius}px)`,
            width: outerRadius * 2,
            height: outerRadius * 2,
          }}
        />
      )}

      {/* Zero animated avatar at center */}
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-10">
        <img
          src={zeroAnimatedSrc}
          alt=""
          role="presentation"
          className="h-20 w-20 object-contain"
        />
      </div>

      {/* Inner orbit connectors */}
      {inner.map(([type], i) => {
        const angle =
          (i / Math.max(inner.length, 1)) * Math.PI * 2 - Math.PI / 2;
        const x = Math.cos(angle) * innerRadius;
        const y = Math.sin(angle) * innerRadius;
        return (
          <div
            key={type}
            className="absolute z-10 flex h-11 w-11 items-center justify-center rounded-xl bg-background shadow-sm transition-all duration-500 ease-out zero-border"
            style={{
              top: `calc(50% + ${y}px - 22px)`,
              left: `calc(50% + ${x}px - 22px)`,
            }}
          >
            <ConnectorIcon type={type} size={22} />
          </div>
        );
      })}

      {/* Outer orbit connectors */}
      {outer.map(([type], i) => {
        const angle =
          (i / Math.max(outer.length, 1)) * Math.PI * 2 - Math.PI / 2 + 0.3;
        const x = Math.cos(angle) * outerRadius;
        const y = Math.sin(angle) * outerRadius;
        return (
          <div
            key={type}
            className="absolute z-10 flex h-10 w-10 items-center justify-center rounded-xl bg-background shadow-sm transition-all duration-500 ease-out zero-border"
            style={{
              top: `calc(50% + ${y}px - 20px)`,
              left: `calc(50% + ${x}px - 20px)`,
            }}
          >
            <ConnectorIcon type={type} size={20} />
          </div>
        );
      })}

      {/* Empty state dots on orbit */}
      {entries.length === 0 &&
        Array.from({ length: 6 }, (_, i) => {
          const angle = (i / 6) * Math.PI * 2 - Math.PI / 2;
          const x = Math.cos(angle) * innerRadius;
          const y = Math.sin(angle) * innerRadius;
          return (
            <div
              key={i}
              className="absolute h-3.5 w-3.5 rounded-full bg-foreground/10"
              style={{
                top: `calc(50% + ${y}px - 7px)`,
                left: `calc(50% + ${x}px - 7px)`,
              }}
            />
          );
        })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Full-page layout wrapper — reads step/navigation state from signals
// ---------------------------------------------------------------------------

function OnboardingPageLayout({ children }: { children: React.ReactNode }) {
  const onAccountAction = useSet(handleZeroAccountAction$);
  const stepKey = useLastResolved(onboardingStepKey$) ?? "workspace";
  const currentStep = useLastResolved(onboardingCurrentStepIndex$) ?? 0;
  const visibleSteps = useLastResolved(onboardingVisibleSteps$) ?? [];
  const showBack = useLastResolved(onboardingShowBack$) ?? false;
  const showNext = useLastResolved(onboardingShowNext$) ?? false;
  const nextDisabled = useLastResolved(onboardingNextDisabled$) ?? false;
  const stepBack = useSet(onboardingStepBack$);
  const stepNext = useSet(onboardingStepNext$);
  const pageSignal = useGet(pageSignal$);
  const effectiveConnectors =
    useLastResolved(onboardingEffectiveConnectors$) ?? [];
  const illustration = getStepIllustration(stepKey);
  const showOrbit = stepKey === "connectors";
  const showChat = stepKey === "workspace";

  return (
    <div className="zero-app flex h-dvh bg-muted/30 relative">
      {/* VM0 logo — top left */}
      <div className="absolute top-6 left-6 z-20 text-foreground">
        <svg
          width="80"
          height="24"
          viewBox="0 0 100 30"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path
            d="M13.3915 0.0627979C13.2455 -0.0209506 13.0657 -0.020839 12.9198 0.0630906L1.0053 6.91543C0.692394 7.09539 0.690093 7.54442 1.00114 7.72755L12.9156 14.7423C13.0636 14.8295 13.2475 14.8296 13.3957 14.7426L25.3445 7.72785C25.6562 7.54485 25.6539 7.09497 25.3404 6.91514L13.3915 0.0627979Z"
            fill="#ED4E01"
          />
          <path
            d="M0.710495 8.33374L12.6479 15.2595C12.7944 15.3445 12.8846 15.5015 12.8846 15.6715L12.8843 29.5237C12.8843 29.8899 12.4897 30.1187 12.1741 29.9356L0.236691 23.0096C0.0902206 22.9246 -3.46036e-06 22.7676 0 22.5977L0.00028208 8.74568C0.000289537 8.37949 0.394855 8.15064 0.710495 8.33374Z"
            fill="#ED4E01"
          />
          <path
            d="M24.947 21.6772C24.947 21.9507 24.8017 22.2036 24.5655 22.3415L16.2103 27.219C15.6975 27.5184 15.0533 27.1485 15.0533 26.5547L15.0531 16.7842C15.0531 16.5107 15.1983 16.2578 15.4345 16.1199L23.7897 11.2425C24.3025 10.9431 24.9468 11.313 24.9468 11.9068L24.947 21.6772ZM13.6541 16.3426V29.5279C13.6541 29.8852 14.0308 30.1106 14.3391 29.9444L14.3538 29.9362L25.5769 23.3654C26.25 22.9808 26.3462 22.6924 26.3459 22.1188L26.3459 8.93378C26.3459 8.57084 25.9572 8.344 25.6462 8.52548L14.4231 15.0001C14.0385 15.2885 13.6539 15.577 13.6541 16.3426Z"
            fill="#ED4E01"
          />
          <path
            d="M25.9616 10.58L15.2113 28.4616L14.2308 27.8817L24.981 10.0001L25.9616 10.58Z"
            fill="#ED4E01"
          />
          <path
            d="M42.1865 25L34.3459 5H37.4651L43.7887 21.4575L50.1264 5H53.2315L45.3908 25H42.1865Z"
            fill="currentColor"
          />
          <path
            d="M66.9877 25L59.4023 10.3417V25H56.4957V5H59.6716L67.413 20.0628L75.1686 5H78.3304V25H75.438V10.3417L67.8526 25H66.9877Z"
            fill="currentColor"
          />
          <path
            d="M99.3459 22.1409C99.3459 22.5314 99.2703 22.9033 99.1191 23.2566C98.9678 23.6007 98.7599 23.9028 98.4952 24.1632C98.2305 24.4235 97.9186 24.6281 97.5594 24.7768C97.2097 24.9256 96.8363 25 96.4393 25H86.2735C85.8765 25 85.4984 24.9256 85.1392 24.7768C84.7894 24.6281 84.4822 24.4235 84.2176 24.1632C83.9529 23.9028 83.745 23.6007 83.5937 23.2566C83.4425 22.9033 83.3669 22.5314 83.3669 22.1409V7.85914C83.3669 7.46862 83.4425 7.10135 83.5937 6.75732C83.745 6.404 83.9529 6.10181 84.2176 5.85077C84.4822 5.59042 84.7894 5.38587 85.1392 5.2371C85.4984 5.07903 85.8765 5 86.2735 5H96.4393C96.8363 5 97.2097 5.07903 97.5594 5.2371C97.9186 5.38587 98.2305 5.59042 98.4952 5.85077C98.7599 6.10181 98.9678 6.404 99.1191 6.75732C99.2703 7.10135 99.3459 7.46862 99.3459 7.85914V22.1409ZM86.2735 7.85914V22.1409H96.4393V7.85914H86.2735Z"
            fill="currentColor"
          />
          <path
            d="M94.8994 6.79107L97.1494 8.06891L87.8973 23.8325L85.6473 22.5547L94.8994 6.79107Z"
            fill="currentColor"
          />
        </svg>
      </div>

      {/* Left panel — brand / illustration */}
      <div
        className={`hidden lg:flex w-2/5 shrink-0 flex-col items-center p-10 relative overflow-hidden ${showChat ? "pt-[8%]" : "justify-center"}`}
      >
        {/* Decorative circles (non-orbit, non-chat steps) */}
        {!showOrbit && !showChat && (
          <div className="absolute inset-0 pointer-events-none" aria-hidden>
            <div className="absolute top-[15%] left-[10%] h-48 w-48 rounded-full border border-border/20" />
            <div className="absolute top-[25%] left-[20%] h-64 w-64 rounded-full border border-border/15" />
            <div className="absolute bottom-[20%] right-[5%] h-40 w-40 rounded-full border border-border/20" />
            <div className="absolute top-[60%] left-[5%] h-32 w-32 rounded-full border border-border/10" />
          </div>
        )}

        <div className="relative z-10 flex flex-col items-center">
          {showChat ? (
            <ChatPreview />
          ) : showOrbit ? (
            <>
              <OrbitIllustration />
              <p className="text-sm text-muted-foreground text-center leading-relaxed mt-6 max-w-[300px]">
                {effectiveConnectors.length === 0
                  ? "Pick your tools and Zero will handle the rest, securely."
                  : `${effectiveConnectors.length} app${effectiveConnectors.length === 1 ? "" : "s"} selected. Zero will securely manage ${effectiveConnectors.length === 1 ? "it" : "them"} for you so you don\u2019t have to.`}
              </p>
              <p className="text-[11px] text-muted-foreground/50 text-center mt-4">
                Sandboxed VMs&ensp;|&ensp;No credential
                exposure&ensp;|&ensp;Full audit trail&ensp;|&ensp;Open source
              </p>
            </>
          ) : (
            <>
              <img
                src={zeroAnimatedSrc}
                alt=""
                role="presentation"
                className="h-24 w-24 object-contain mb-8"
              />
              <h3 className="text-xl font-semibold text-foreground text-center leading-snug">
                {illustration.title}
              </h3>
              {illustration.subtitle && (
                <p className="text-sm text-muted-foreground text-center leading-relaxed mt-3 max-w-[300px]">
                  {illustration.subtitle}
                </p>
              )}
              {illustration.showSlackPreview && (
                <div className="mt-4 w-full flex justify-center">
                  <img
                    src={slackPreviewImg}
                    alt="Zero working in Slack"
                    className="w-full max-w-[380px]"
                  />
                </div>
              )}
            </>
          )}
        </div>

        {/* Account dropdown — bottom-left of left panel */}
        <div className="absolute bottom-6 left-4 z-20">
          <VM0ClerkProvider>
            <AccountDropdown
              onAccountAction={onAccountAction}
              hidePreferences
            />
          </VM0ClerkProvider>
        </div>
      </div>

      {/* Right panel — form */}
      <div className="flex flex-1 flex-col min-w-0 bg-background items-center">
        <div className="flex flex-col w-full max-w-[750px] flex-1 min-h-0">
          {/* Progress bar */}
          <div className="shrink-0 px-5 sm:px-10 pt-8 pb-4">
            <ProgressBar
              totalSteps={visibleSteps.length}
              currentStep={currentStep}
            />
          </div>

          {/* Content */}
          <main className="flex-1 min-h-0 overflow-y-auto px-5 sm:px-10 pt-[12%] pb-6 [scrollbar-width:none] [-webkit-overflow-scrolling:touch] [&::-webkit-scrollbar]:hidden">
            {children}
          </main>

          {/* Footer */}
          <div className="shrink-0 border-t border-border/40 flex items-center justify-between px-5 sm:px-10 py-5">
            <div>
              {showBack && (
                <Button
                  variant="ghost"
                  className="rounded-lg text-muted-foreground"
                  onClick={() => {
                    detach(stepBack(pageSignal), Reason.DomCallback);
                  }}
                >
                  Back
                </Button>
              )}
            </div>
            <div>
              {showNext && (
                <Button
                  onClick={() => {
                    detach(stepNext(pageSignal), Reason.DomCallback);
                  }}
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
// Workspace step content (step 1)
// ---------------------------------------------------------------------------

function WorkspaceStepContent() {
  const workspaceName = useGet(zeroWorkspaceName$);
  const setWorkspaceName = useSet(setZeroWorkspaceName$);
  const stepNext = useSet(onboardingStepNext$);
  const pageSignal = useGet(pageSignal$);

  return (
    <>
      <h2
        data-testid="onboarding-step-workspace-name"
        className="text-2xl font-semibold tracking-tight"
      >
        Name your workspace
      </h2>
      <p className="text-sm text-muted-foreground leading-relaxed mt-2 mb-8">
        This is where your team will collaborate with Zero and other AI agents.
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
          onChange={(e) => {
            return setWorkspaceName(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && workspaceName.trim()) {
              detach(stepNext(pageSignal), Reason.DomCallback);
            }
          }}
          className="h-10 rounded-lg"
          autoFocus
        />
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Step content router
// ---------------------------------------------------------------------------

function OnboardingStepContent() {
  const effectiveStep = useLastResolved(onboardingEffectiveStep$);
  const isAdmin = useLastResolved(onboardingIsAdmin$) ?? false;

  switch (effectiveStep) {
    case "1": {
      return isAdmin ? <WorkspaceStepContent /> : null;
    }
    case "2": {
      return isAdmin ? <SelectConnectorsContent /> : null;
    }
    case "3": {
      return <ConnectStepContent />;
    }
    case "4": {
      return <WhereToWorkContent />;
    }
    default: {
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// Zero onboarding — main export
// ---------------------------------------------------------------------------

/** Zero onboarding — used for both admin and member flows. */
export function ZeroOnboarding() {
  const effectiveStep = useLastResolved(onboardingEffectiveStep$);
  const selectedConnectorType = useGet(selectedConnectorType$);
  const setSelected = useSet(setSelectedConnectorType$);

  if (!effectiveStep) {
    return null;
  }

  return (
    <>
      <OnboardingPageLayout>
        <OnboardingStepContent />
      </OnboardingPageLayout>

      {selectedConnectorType && (
        <ConnectModal
          onClose={() => {
            return setSelected(null);
          }}
          onSuccess={() => {
            /* connector list refreshes automatically */
          }}
        />
      )}
    </>
  );
}
