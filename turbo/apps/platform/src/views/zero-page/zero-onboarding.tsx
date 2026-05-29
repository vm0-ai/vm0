// TODO(#8609): split large components to comply with max-lines-per-function (128)
// oxlint-disable max-lines-per-function
import {
  useGet,
  useSet,
  useLastLoadable,
  useLastResolved,
} from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { getAvatarPresets } from "./zero-avatars.ts";
import { AvatarSvgPreview } from "./avatar-svg-preview.tsx";
import zeroAnimatedSrc from "./assets/zero-animated.webp";
import trialWorkflowSrc from "./assets/trial-workflow.webp";
import webModernSrc from "./assets/web-modern.webp";
import webCafeSrc from "./assets/web-cafe.webp";
import webEnergeticSrc from "./assets/web-energetic.webp";
import webFantasySrc from "./assets/web-fantasy.webp";
import illFolkSrc from "./assets/ill-folk.webp";
import illFlatfolkSrc from "./assets/ill-flatfolk.webp";
import illBotanicalSrc from "./assets/ill-botanical.webp";
import illPapernookSrc from "./assets/ill-papernook.webp";
import illPosterSrc from "./assets/ill-poster.webp";
import illOpedcoverSrc from "./assets/ill-opedcover.webp";
import illMellowPopSrc from "./assets/ill-mellow-pop.webp";
import illEndpaperSrc from "./assets/ill-endpaper.webp";
import illIsoSceneSrc from "./assets/ill-iso-scene.webp";
import illInkdabSrc from "./assets/ill-inkdab.webp";
import slackIconImg from "./components/settings/icons/slack.svg";
import telegramIconImg from "./components/settings/icons/telegram.svg";
import imessageIconImg from "./components/settings/icons/imessage.svg";
import { Button, Input } from "@vm0/ui";
import type { ConnectorType } from "@vm0/connectors/connectors";
import { ConnectorIcon } from "./components/settings/connector-icons.tsx";
import {
  zeroWorkspaceName$,
  setZeroWorkspaceName$,
  zeroSelectedRole$,
  setZeroRole$,
  trialGalleryIndex$,
  setTrialGalleryIndex$,
  zeroSelectedConnectors$,
  toggleZeroConnector$,
  connectorSearch$,
  setConnectorSearch$,
  onboardingIsUseCase$,
  onboardingPromptDraft$,
  setOnboardingPromptDraft$,
} from "../../signals/zero-page/zero-onboarding.ts";
import {
  onboardingBackendWillAuthorizeConnectors$,
  onboardingEffectiveStep$,
  onboardingEffectiveConnectors$,
  onboardingVisibleSteps$,
  onboardingCurrentStepIndex$,
  onboardingStepKey$,
  onboardingShowNext$,
  onboardingNextDisabled$,
  onboardingNextLabel$,
  onboardingStepNext$,
  onboardingIsAdmin$,
} from "../../signals/zero-page/zero-onboarding-actions.ts";
import {
  allConnectorTypes$,
  connectConnectorOAuthAuthCode$,
  matchesConnectorSearch,
  pollingOAuthAuthCodeConnectorType$,
  pollingOAuthDeviceAuthConnectorType$,
  selectedConnectorType$,
  setSelectedConnectorType$,
  setPermissionDialogType$,
  getConnectorConnectLaunchMode,
} from "../../signals/zero-page/settings/connectors.ts";
import { ConnectModal } from "./components/settings/add-connection-dialog.tsx";
import { pageSignal$ } from "../../signals/page-signal.ts";
import {
  IconCheck,
  IconCircleCheck,
  IconCircleCheckFilled,
  IconLoader,
  IconSearch,
} from "@tabler/icons-react";
import { detach, Reason } from "../../signals/utils.ts";
import { AccountDropdown } from "./zero-sidebar.tsx";
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
  const connectorEntries = useLastResolved(allConnectorTypes$) ?? [];

  const filtered = connectorEntries.filter((connector) => {
    return matchesConnectorSearch(search, connector);
  });

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
          placeholder="Find connectors..."
          value={search}
          onChange={(e) => {
            return setSearch(e.target.value);
          }}
          className="h-9 w-full pl-9 rounded-lg"
        />
      </div>
      <div className="w-full grid grid-cols-2 sm:grid-cols-3 gap-3">
        {filtered.map((connector) => {
          return (
            <OnboardingConnectorCard
              key={connector.type}
              type={connector.type}
              label={connector.label}
              isSelected={selectedSet.has(connector.type)}
              isPolling={false}
              onClick={() => {
                return toggleConnector(connector.type);
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
  const pollingAuthCodeType = useGet(pollingOAuthAuthCodeConnectorType$);
  const pollingDeviceAuthType = useGet(pollingOAuthDeviceAuthConnectorType$);
  const connect = useSet(connectConnectorOAuthAuthCode$);
  const setSelectedConnector = useSet(setSelectedConnectorType$);
  const clearPermissionDialog = useSet(setPermissionDialogType$);
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

  const selectedEntries = allConnectors.filter((connector) => {
    return effectiveConnectors.includes(connector.type);
  });

  const handleConnect = (type: ConnectorType) => {
    const connector = connectorMap.get(type);
    if (connector?.connected) {
      return;
    }
    if (!connector) {
      return;
    }
    const launchMode = getConnectorConnectLaunchMode({
      type,
      availableAuthMethods: connector.availableAuthMethods,
      preferModalForGoogleOAuth: true,
    });
    if (launchMode === "modal") {
      setSelectedConnector(type);
    } else {
      detach(
        (async () => {
          await connect(type, {}, pageSignal);
          await clearPermissionDialog(null);
        })(),
        Reason.DomCallback,
      );
    }
  };

  return (
    <>
      <h2
        data-testid="onboarding-step-connect"
        className="text-2xl font-semibold tracking-tight"
      >
        Try this prompt
      </h2>
      <p className="text-sm text-muted-foreground leading-relaxed mt-2 mb-6">
        Tweak it below or run it as-is. Zero takes it from here — your tools
        stay sandboxed and nothing leaves your workspace.
      </p>
      {selectedEntries.length > 0 && (
        <div className="w-full flex flex-col gap-3">
          {selectedEntries.map((connector) => {
            const type = connector.type;
            const isConnected = connectedSet.has(type);
            const isPolling =
              pollingAuthCodeType === type || pollingDeviceAuthType === type;
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
                    {connector.label}
                  </span>
                  {connector.helpText && (
                    <span className="block text-xs text-muted-foreground mt-0.5 line-clamp-1">
                      {connector.helpText
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
      <UseCasePromptComposer />
    </>
  );
}

// ---------------------------------------------------------------------------
// Use case "Try It" composer — only renders when onboarding arrived via the
// `?prompt=...&connector=...` deep link. A plain editable textarea so the
// user can tweak the suggested prompt before clicking the footer "Try It".
// No internal send button — the footer button is the single CTA.
// ---------------------------------------------------------------------------

function UseCasePromptComposer() {
  const isUseCase = useGet(onboardingIsUseCase$);
  const draft = useGet(onboardingPromptDraft$);
  const setDraft = useSet(setOnboardingPromptDraft$);

  if (!isUseCase) {
    return null;
  }

  return (
    <div data-testid="onboarding-prompt-composer" className="w-full mt-6">
      <textarea
        data-testid="onboarding-prompt-input"
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
        }}
        autoFocus
        rows={4}
        className="w-full resize-none rounded-xl zero-border bg-background px-4 py-3 text-sm leading-relaxed text-foreground placeholder:text-muted-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pro trial step (step 4).
//
// The benefit list below is a temporary constant. Once billing/Stripe is
// wired, the entitlements (and the trial dates) should come from the pricing
// config rather than being hardcoded here.
// ---------------------------------------------------------------------------

// Pro features below the hero credit card. Phrased as "what your agent
// can do", not feature names. Single column, no em-dashes in the copy.
const PRO_TRIAL_BENEFITS: readonly string[] = [
  "All flagship models including Claude, GPT and Gemini",
  "All multimodal models for image, video and voice",
  "Run 2 tasks at the same time",
  "Slack-native agent in threads and @mentions",
  "Telegram and iMessage agents",
  "200+ integrations with real tool execution",
  "Scheduled tasks that run on their own",
  "Artifacts including slide decks, HTML pages, video and audio",
  "Voice input",
  "Unlimited workspace members",
];

/** Step 4: what Pro unlocks + the 7-day trial framing. */
function TrialStepContent() {
  const selectedConnectors =
    useLastResolved(onboardingEffectiveConnectors$) ?? [];
  const connectorEntries = (useLastResolved(allConnectorTypes$) ?? []).filter(
    (connector) => {
      return selectedConnectors.includes(connector.type);
    },
  );

  return (
    <>
      <h2
        data-testid="onboarding-step-trial"
        className="text-2xl font-semibold tracking-tight"
      >
        Your 7-day Pro trial is ready
      </h2>
      <p className="text-sm text-muted-foreground leading-relaxed mt-2 mb-6">
        Here&apos;s what you get the moment you finish setup.
      </p>

      {connectorEntries.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-5">
          {connectorEntries.map((connector) => {
            return (
              <span
                key={connector.type}
                className="zero-border flex items-center gap-1.5 rounded-full bg-background px-2.5 py-1 text-xs text-foreground"
              >
                <ConnectorIcon type={connector.type} size={14} />
                {connector.label}
              </span>
            );
          })}
        </div>
      )}

      {/* Hero: lead with the dollar value so users see they're getting
          real spending power, not a token allowance. The $20 is the visual
          anchor of the entire step. */}
      <div className="rounded-2xl bg-gray-50 px-6 py-6 mb-6 relative overflow-hidden">
        <div className="flex items-baseline gap-2">
          <span className="text-5xl font-semibold text-foreground leading-none tracking-tight">
            $20
          </span>
          <span className="text-base font-medium text-foreground">
            in credits, on us
          </span>
        </div>
        <p className="text-sm text-foreground mt-3 leading-relaxed">
          <span className="font-medium">20,000 VM0 credits</span> to spend on
          Zero.
        </p>
      </div>

      <p className="text-sm font-semibold text-foreground mb-3">
        Plus, everything your agent can do
      </p>
      <ul
        data-testid="onboarding-trial-benefits"
        className="w-full flex flex-col gap-y-2.5"
      >
        {PRO_TRIAL_BENEFITS.map((benefit) => {
          return (
            <li key={benefit} className="flex items-start gap-2.5">
              <IconCheck
                size={16}
                stroke={2.25}
                className="text-primary shrink-0 mt-0.5"
              />
              <span className="text-sm text-foreground leading-snug">
                {benefit}
              </span>
            </li>
          );
        })}
      </ul>
    </>
  );
}

// ---------------------------------------------------------------------------
// Trial step — left-panel gallery (step 4)
//
// Three-slide auto-rotating carousel. Each slide showcases a category of
// output Zero can produce:
//   - workflow: the workflow walkthrough gif
//   - website: a 2x2 masonry of generated landing pages
//   - illustration: a 3x2 grid of editorial illustrations
// Thumbnails along the bottom center mark and switch the active slide.
// ---------------------------------------------------------------------------

type TrialGalleryCopy = {
  readonly id: string;
  readonly label: string;
  readonly title: string;
  readonly subtitle: string;
};

const TRIAL_GALLERY_COPY: readonly TrialGalleryCopy[] = [
  {
    id: "workflow",
    label: "Workflow",
    title: "Workflows that run themselves",
    subtitle: "Daily briefs, scheduled alerts, weekly digests",
  },
  {
    id: "website",
    label: "Website",
    title: "Websites that look hand-designed",
    subtitle: "Landing pages, brand sites, launch microsites",
  },
  {
    id: "illustration",
    label: "Illustration",
    title: "Illustrations in your brand voice",
    subtitle: "Editorial covers, hero art, mascots",
  },
];

const TRIAL_WEBSITE_TILES: readonly string[] = [
  webModernSrc,
  webCafeSrc,
  webFantasySrc,
  webEnergeticSrc,
];

const TRIAL_ILLUSTRATION_TILES: readonly string[] = [
  illFlatfolkSrc,
  illEndpaperSrc,
  illBotanicalSrc,
  illFolkSrc,
  illMellowPopSrc,
  illPapernookSrc,
  illIsoSceneSrc,
  illOpedcoverSrc,
  illInkdabSrc,
  illPosterSrc,
];

const TRIAL_GALLERY_THUMBS: readonly string[] = [
  trialWorkflowSrc,
  webModernSrc,
  illFlatfolkSrc,
];

const TRIAL_WORKFLOW_CHANNELS: readonly { key: string; src: string }[] = [
  { key: "slack", src: slackIconImg },
  { key: "telegram", src: telegramIconImg },
  { key: "imessage", src: imessageIconImg },
];

function TrialWorkflowSlide() {
  return (
    <div className="h-full w-full flex flex-col items-center justify-center gap-3 p-3">
      <div className="flex items-center justify-center gap-4">
        {TRIAL_WORKFLOW_CHANNELS.map((channel) => {
          // Slack's source SVG places its mark in the centre of a padded
          // 270x270 viewBox; without scaling, the visible hash mark is much
          // smaller than Telegram + iMessage which fill their own viewBoxes
          // edge to edge. scale-[1.85] sizes Slack to match, and the
          // remaining ~3px asymmetry around the layout box is well within
          // the gap-4 (16px) inter-icon spacing.
          const slackScale =
            channel.key === "slack" ? "scale-[1.85] -mr-px" : "";
          return (
            <img
              key={channel.key}
              src={channel.src}
              alt=""
              className={`h-9 w-9 object-contain ${slackScale}`}
            />
          );
        })}
      </div>
      <img
        src={trialWorkflowSrc}
        alt="Workflow preview"
        className="block min-h-0 max-w-[78%] max-h-full object-contain rounded-xl"
      />
    </div>
  );
}

function TrialWebsiteSlide() {
  return (
    <div className="h-full w-full grid grid-cols-2 grid-rows-2 gap-2 p-2">
      {TRIAL_WEBSITE_TILES.map((src) => {
        return (
          <div key={src} className="rounded-xl overflow-hidden bg-background">
            <img
              src={src}
              alt=""
              className="h-full w-full object-cover object-top"
            />
          </div>
        );
      })}
    </div>
  );
}

function TrialIllustrationSlide() {
  return (
    <div className="h-full w-full p-2 overflow-hidden columns-4 gap-2 [&>*]:mb-2 [&>*]:break-inside-avoid">
      {TRIAL_ILLUSTRATION_TILES.map((src) => {
        return (
          <div key={src} className="rounded-xl overflow-hidden bg-background">
            <img src={src} alt="" className="block w-full h-auto" />
          </div>
        );
      })}
    </div>
  );
}

function OnboardingTrialPanel() {
  const rawIndex = useGet(trialGalleryIndex$);
  const setIndex = useSet(setTrialGalleryIndex$);

  const slideCount = TRIAL_GALLERY_COPY.length;
  const activeIndex = ((rawIndex % slideCount) + slideCount) % slideCount;
  const activeCopy = TRIAL_GALLERY_COPY[activeIndex];

  return (
    <div
      data-testid="onboarding-trial-gallery"
      className="flex flex-col gap-5 w-full max-w-[560px] items-center"
    >
      <div className="aspect-[4/3] w-full rounded-2xl overflow-hidden">
        {activeIndex === 0 ? (
          <TrialWorkflowSlide />
        ) : activeIndex === 1 ? (
          <TrialWebsiteSlide />
        ) : (
          <TrialIllustrationSlide />
        )}
      </div>
      <div className="flex flex-col items-center text-center max-w-[400px]">
        <h3 className="text-lg font-semibold text-foreground leading-snug">
          {activeCopy.title}
        </h3>
        <p className="text-sm text-muted-foreground leading-relaxed mt-1.5">
          {activeCopy.subtitle}
        </p>
      </div>
      <div className="flex items-center justify-center gap-2.5">
        {TRIAL_GALLERY_COPY.map((copy, i) => {
          const isActive = i === activeIndex;
          return (
            <button
              key={copy.id}
              type="button"
              aria-label={`Show ${copy.label} preview`}
              data-testid={`onboarding-trial-gallery-dot-${copy.id}`}
              onClick={() => {
                setIndex(i);
              }}
              className={`relative h-12 w-12 rounded-lg overflow-hidden transition-all ${
                isActive
                  ? "ring-2 ring-primary ring-offset-2 ring-offset-background"
                  : "opacity-50 hover:opacity-100"
              }`}
            >
              <img
                src={TRIAL_GALLERY_THUMBS[i]}
                alt=""
                className="block w-full h-full object-cover object-center"
              />
            </button>
          );
        })}
      </div>
    </div>
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
          <AvatarSvgPreview
            config={getAvatarPresets()[0]}
            size={24}
            className="shrink-0 rounded-full mt-0.5"
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
          <AvatarSvgPreview
            config={getAvatarPresets()[0]}
            size={24}
            className="shrink-0 rounded-full mt-0.5"
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

// ---------------------------------------------------------------------------
// Compliance trust badges — shown in the left panel
// ---------------------------------------------------------------------------

function ComplianceTrustBadges() {
  return (
    <div className="grid grid-cols-2 gap-3 w-full max-w-[420px] mt-6">
      <div className="rounded-lg bg-muted/40 px-3.5 py-2.5">
        <p className="text-[11px] font-medium text-muted-foreground mb-1">
          SOC 2 Type 2
        </p>
        <p className="text-[10px] text-muted-foreground/60 leading-relaxed">
          Robust internal controls aligned with Trust Services Criteria. Active
          attestation phase with external advisors.
        </p>
      </div>
      <div className="rounded-lg bg-muted/30 px-3.5 py-2.5">
        <p className="text-[11px] font-medium text-muted-foreground mb-1">
          GDPR &amp; CCPA
        </p>
        <p className="text-[10px] text-muted-foreground/60 leading-relaxed">
          Privacy framework fully integrated. Compliance validations in progress
          for global data sovereignty.
        </p>
      </div>
    </div>
  );
}

// Step-specific illustration hints for the right panel
type StepIllustration = {
  title: string;
  subtitle: string;
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
  const connectorEntries = useLastResolved(allConnectorTypes$) ?? [];

  const entries = connectorEntries.filter((connector) => {
    return selectedConnectors.includes(connector.type);
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
      {inner.map((connector, i) => {
        const type = connector.type;
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
      {outer.map((connector, i) => {
        const type = connector.type;
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

function OnboardingProgressBar() {
  const currentStep = useLastResolved(onboardingCurrentStepIndex$) ?? 0;
  const visibleSteps = useLastResolved(onboardingVisibleSteps$) ?? [];
  // A single-step flow has nothing to track — hide the bar to avoid the
  // visual "always 100%" stripe (use-case revisit by an onboarded user).
  if (visibleSteps.length <= 1) {
    return null;
  }
  return (
    <ProgressBar totalSteps={visibleSteps.length} currentStep={currentStep} />
  );
}

function OnboardingFooterNav() {
  const showNext = useLastResolved(onboardingShowNext$) ?? false;
  const nextDisabled = useLastResolved(onboardingNextDisabled$) ?? false;
  const nextLabel = useLastResolved(onboardingNextLabel$) ?? "Next";
  // Step 1's Next triggers eager-init (a backend setup call); the loadable
  // state lets us disable the button + show a spinner so users can't double
  // submit and so e2e drivers can see the in-flight state.
  const [nextLoadable, stepNext] = useLoadableSet(onboardingStepNext$);
  const pageSignal = useGet(pageSignal$);
  const nextLoading = nextLoadable.state === "loading";
  const nextError =
    nextLoadable.state === "hasError" ? String(nextLoadable.error) : null;
  return (
    <div className="shrink-0 border-t border-border/40 flex flex-col gap-2 px-5 sm:px-10 py-5">
      {nextError && (
        <div
          role="alert"
          className="w-full rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-2 text-sm text-destructive"
        >
          {nextError}
        </div>
      )}
      <div className="flex items-center justify-end">
        <div>
          {showNext && (
            <Button
              onClick={() => {
                detach(stepNext(pageSignal), Reason.DomCallback);
              }}
              className="rounded-lg min-w-[100px]"
              disabled={nextDisabled || nextLoading}
              aria-busy={nextLoading}
              data-testid="onboarding-next-button"
            >
              {nextLoading ? (
                <IconLoader size={16} className="animate-spin" />
              ) : (
                nextLabel
              )}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function OnboardingOrbitPanel() {
  const effectiveConnectors =
    useLastResolved(onboardingEffectiveConnectors$) ?? [];
  const isUseCase = useGet(onboardingIsUseCase$);
  // Use-case mode without any preselected connectors has no picker to point
  // the user at, so the "Pick your tools\u2026" hint is misleading. Drop it and
  // let the orbit + trust badges carry the panel on their own.
  const hideCopy = isUseCase && effectiveConnectors.length === 0;
  return (
    <>
      <OrbitIllustration />
      {!hideCopy && (
        <p className="text-sm text-foreground text-center leading-relaxed mt-6 max-w-[300px]">
          {effectiveConnectors.length === 0
            ? "Pick your tools and Zero will handle the rest, securely."
            : `${effectiveConnectors.length} app${effectiveConnectors.length === 1 ? "" : "s"} selected. Zero will securely manage ${effectiveConnectors.length === 1 ? "it" : "them"} for you so you don\u2019t have to.`}
        </p>
      )}
      <p className="text-[11px] text-muted-foreground text-center mt-4">
        Sandboxed VMs&ensp;|&ensp;No credential exposure&ensp;|&ensp;Full audit
        trail&ensp;|&ensp;Open source
      </p>
      <ComplianceTrustBadges />
    </>
  );
}

function OnboardingIllustrationPanel() {
  const stepKey = useLastResolved(onboardingStepKey$) ?? "workspace";
  const illustration = getStepIllustration(stepKey);
  const showOrbit = stepKey === "connectors";
  const showChat = stepKey === "workspace";
  const showTrial = stepKey === "trial";

  return (
    <div
      className={`hidden lg:flex w-2/5 shrink-0 flex-col items-center p-10 relative overflow-hidden ${
        showChat
          ? "pt-[8%]"
          : showTrial
            ? "justify-start pt-24"
            : "justify-center"
      }`}
    >
      {/* Decorative circles (non-orbit, non-chat, non-trial steps) */}
      {!showOrbit && !showChat && !showTrial && (
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
          <OnboardingOrbitPanel />
        ) : showTrial ? (
          <OnboardingTrialPanel />
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
          </>
        )}
      </div>

      {/* Account dropdown — bottom-left of left panel */}
      <div className="absolute bottom-6 left-4 z-20">
        <OnboardingAccountDropdown />
      </div>
    </div>
  );
}

function OnboardingAccountDropdown() {
  const onAccountAction = useSet(handleZeroAccountAction$);
  return <AccountDropdown onAccountAction={onAccountAction} hidePreferences />;
}

function OnboardingPageLayout({ children }: { children: React.ReactNode }) {
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
      <OnboardingIllustrationPanel />

      {/* Right panel — form */}
      <div className="flex flex-1 flex-col min-w-0 bg-background items-center">
        <div className="flex flex-col w-full max-w-[750px] flex-1 min-h-0">
          {/* Progress bar */}
          <div className="shrink-0 px-5 sm:px-10 pt-8 pb-4">
            <OnboardingProgressBar />
          </div>

          {/* Content */}
          <main className="flex-1 min-h-0 overflow-y-auto px-5 sm:px-10 pt-[12%] pb-6 [scrollbar-width:none] [-webkit-overflow-scrolling:touch] [&::-webkit-scrollbar]:hidden">
            {children}
          </main>

          {/* Footer */}
          <OnboardingFooterNav />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Workspace step content (step 1)
// ---------------------------------------------------------------------------

type RoleOption = {
  readonly id: string;
  readonly label: string;
};

const ROLE_OPTIONS: readonly RoleOption[] = [
  { id: "founder", label: "Founder" },
  { id: "sales-marketing", label: "Sales & marketing" },
  { id: "ops-support", label: "Operations" },
  { id: "engineer", label: "Engineer" },
  { id: "coach-consultant", label: "Consultant" },
  { id: "other", label: "Something else" },
];

function RoleChip({
  option,
  isSelected,
  onClick,
}: {
  option: RoleOption;
  isSelected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      data-testid={`onboarding-role-${option.id}`}
      onClick={onClick}
      aria-pressed={isSelected}
      className={`rounded-lg px-3.5 h-9 text-sm transition-colors focus:outline-none ${
        isSelected
          ? "bg-primary/10 text-primary font-medium border border-primary/30"
          : "zero-border bg-background text-foreground hover:bg-muted/40"
      }`}
    >
      {option.label}
    </button>
  );
}

function WorkspaceStepContent() {
  const workspaceName = useGet(zeroWorkspaceName$);
  const setWorkspaceName = useSet(setZeroWorkspaceName$);
  const selectedRole = useGet(zeroSelectedRole$);
  const setRole = useSet(setZeroRole$);
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
            if (e.key === "Enter" && workspaceName.trim() && selectedRole) {
              detach(stepNext(pageSignal), Reason.DomCallback);
            }
          }}
          className="h-10 rounded-lg"
          autoFocus
        />
      </div>
      <div className="w-full mt-6">
        <p className="block text-sm font-medium text-foreground mb-3">
          Your role
        </p>
        <div
          data-testid="onboarding-role-list"
          className="flex flex-wrap gap-2"
        >
          {ROLE_OPTIONS.map((option) => {
            return (
              <RoleChip
                key={option.id}
                option={option}
                isSelected={selectedRole === option.id}
                onClick={() => {
                  return setRole(option.id);
                }}
              />
            );
          })}
        </div>
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
      // Step 1 is admin-only (workspace creation).
      return isAdmin ? <WorkspaceStepContent /> : null;
    }
    case "2": {
      return <SelectConnectorsContent />;
    }
    case "3": {
      return <ConnectStepContent />;
    }
    case "4": {
      return <TrialStepContent />;
    }
    default: {
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// Zero onboarding — main export
// ---------------------------------------------------------------------------

/** Zero onboarding — admin workspace setup + use-case deep-link flow. */
export function ZeroOnboarding() {
  const effectiveStep = useLastResolved(onboardingEffectiveStep$);
  const selectedConnectorType = useGet(selectedConnectorType$);
  const setSelected = useSet(setSelectedConnectorType$);
  const clearPermissionDialog = useSet(setPermissionDialogType$);
  // We suppress the post-connect permission dialog only when the backend will
  // bulk-authorize selected connectors at the end of onboarding. Already-
  // onboarded users entering via a use-case deep link need the dialog so each
  // new connector is authorized to their existing default agent.
  const suppressPermissionDialog =
    useLastResolved(onboardingBackendWillAuthorizeConnectors$) ?? true;

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
            if (suppressPermissionDialog) {
              clearPermissionDialog(null);
            }
          }}
        />
      )}
    </>
  );
}
