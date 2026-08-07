import type { CSSProperties, ReactNode } from "react";
import { useLastLoadable } from "ccstate-react";
import type { ConnectorSlug } from "@vm0/api-contracts/contracts/connector-identity";
import { useTranslation } from "react-i18next";
import type { OnboardingWorkflow } from "./onboarding-data.ts";
import { connectorCatalogStatusBySlug$ } from "../../signals/external/connectors.ts";
import { ConnectorIcon } from "../zero-page/components/settings/connector-icons.tsx";
import { platformStaticAssetUrl } from "../../lib/static-assets.ts";

const ZERO_AVATAR_HEAD_IMG = platformStaticAssetUrl(
  "views/onboarding/assets/zero-avatar-head-840043d16b50.svg",
);
const ZERO_AVATAR_HAIR_IMG = platformStaticAssetUrl(
  "views/onboarding/assets/zero-avatar-hair-c1d917488df8.svg",
);
const ZERO_AVATAR_FACE_IMG = platformStaticAssetUrl(
  "views/onboarding/assets/zero-avatar-face-19a2ae88c11d.svg",
);

function DiagramConnectorIcon({
  connectorSlug,
  size,
}: {
  readonly connectorSlug: ConnectorSlug;
  readonly size: number;
}) {
  const catalogBySlugLoadable = useLastLoadable(connectorCatalogStatusBySlug$);
  const icon =
    catalogBySlugLoadable.state === "hasData"
      ? catalogBySlugLoadable.data.get(connectorSlug)?.icon
      : undefined;
  return <ConnectorIcon icon={icon} size={size} />;
}

const CONNECTOR_LABELS: Readonly<Record<string, string>> = {
  langfuse: "Langfuse",
  productlane: "Productlane",
  typeform: "Typeform",
  posthog: "PostHog",
  plausible: "Plausible",
  clerk: "Clerk",
  snowflake: "Snowflake",
  ahrefs: "Ahrefs",
  strapi: "Strapi",
  buffer: "Buffer",
  mailchimp: "Mailchimp",
  "google-ads": "Google Ads",
  "meta-ads": "Meta Ads",
  exa: "Exa",
  apollo: "Apollo",
  instantly: "Instantly",
  resend: "Resend",
  stripe: "Stripe",
  deel: "Deel",
  "cal-com": "Cal.com",
  todoist: "Todoist",
  reddit: "Reddit",
  gamma: "Gamma",
  figma: "Figma",
  gong: "Gong",
  "google-docs": "Docs",
  sentry: "Sentry",
  slack: "Slack",
  github: "GitHub",
  notion: "Notion",
  vercel: "Vercel",
  axiom: "Axiom",
  asana: "Asana",
  clickup: "ClickUp",
  monday: "Monday",
  heygen: "HeyGen",
  elevenlabs: "ElevenLabs",
  metabase: "Metabase",
  linear: "Linear",
  revenuecat: "RevenueCat",
  "google-sheets": "Sheets",
  hubspot: "HubSpot",
  jira: "Jira",
  firecrawl: "Firecrawl",
  serpapi: "SerpAPI",
  youtube: "YouTube",
  x: "X",
  gmail: "Gmail",
  "google-calendar": "Calendar",
  "google-drive": "Drive",
  xero: "Xero",
  similarweb: "SimilarWeb",
  salesforce: "Salesforce",
  streak: "Streak",
  airtable: "Airtable",
  calendly: "Calendly",
  intercom: "Intercom",
  zendesk: "Zendesk",
  chatwoot: "Chatwoot",
  fireflies: "Fireflies",
  tldv: "tl;dv",
};

function connectorLabel(connectorSlug: ConnectorSlug): string {
  return CONNECTOR_LABELS[connectorSlug] ?? connectorSlug;
}

const WORKFLOW_SOURCE_CONNECTOR_SLUGS: ReadonlySet<ConnectorSlug> = new Set([
  "apollo",
  "axiom",
  "gmail",
  "google-calendar",
  "google-drive",
  "linear",
  "plausible",
  "sentry",
  "slack",
  "x",
]);

const WORKFLOW_OUTPUT_CONNECTOR_SLUGS: ReadonlySet<ConnectorSlug> = new Set([
  "elevenlabs",
  "gamma",
  "github",
  "gmail",
  "heygen",
  "linear",
  "notion",
  "resend",
  "slack",
  "strapi",
  "v0",
  "vercel",
]);

const WORKFLOW_DELIVERY_CONNECTOR_SLUGS: ReadonlySet<ConnectorSlug> = new Set([
  "slack",
  "gmail",
  "resend",
  "github",
  "linear",
  "notion",
  "strapi",
  "vercel",
  "v0",
  "gamma",
  "heygen",
]);

function uniqueWorkflowConnectorSlugs(
  connectorSlugs: readonly ConnectorSlug[],
): readonly ConnectorSlug[] {
  const seen = new Set<ConnectorSlug>();
  return connectorSlugs.filter((connectorSlug) => {
    if (seen.has(connectorSlug)) {
      return false;
    }
    seen.add(connectorSlug);
    return true;
  });
}

interface WorkflowDiagramModel {
  readonly sourceConnectorSlugs: readonly ConnectorSlug[];
  readonly sourceLabel: string;
  readonly destinationConnectorSlug: ConnectorSlug | undefined;
}

function buildWorkflowDiagramModel(
  workflow: OnboardingWorkflow,
  sourceFallback: string,
): WorkflowDiagramModel {
  const allConnectorSlugs = uniqueWorkflowConnectorSlugs(
    workflow.connectorSlugs,
  );
  const sourceCandidates = uniqueWorkflowConnectorSlugs([
    ...allConnectorSlugs.filter((connectorSlug) => {
      return WORKFLOW_SOURCE_CONNECTOR_SLUGS.has(connectorSlug);
    }),
    ...allConnectorSlugs,
  ]);
  const outputCandidates = uniqueWorkflowConnectorSlugs([
    ...allConnectorSlugs.filter((connectorSlug) => {
      return WORKFLOW_OUTPUT_CONNECTOR_SLUGS.has(connectorSlug);
    }),
    ...allConnectorSlugs,
  ]);

  const primarySource = sourceCandidates[0] ?? allConnectorSlugs[0];
  const destinationConnectorSlug =
    outputCandidates.find((connectorSlug) => {
      return (
        connectorSlug !== primarySource &&
        WORKFLOW_DELIVERY_CONNECTOR_SLUGS.has(connectorSlug)
      );
    }) ??
    outputCandidates.find((connectorSlug) => {
      return connectorSlug !== primarySource;
    }) ??
    undefined;
  const sourceConnectorSlugs = uniqueWorkflowConnectorSlugs([
    ...(primarySource ? [primarySource] : []),
    ...allConnectorSlugs.filter((connectorSlug) => {
      return connectorSlug !== destinationConnectorSlug;
    }),
  ]);
  const primaryLabel = sourceConnectorSlugs[0]
    ? connectorLabel(sourceConnectorSlugs[0])
    : sourceFallback;
  const sourceLabel =
    sourceConnectorSlugs.length > 1
      ? `${primaryLabel} + ${sourceConnectorSlugs.length - 1}`
      : sourceConnectorSlugs[0]
        ? connectorLabel(sourceConnectorSlugs[0])
        : "";

  return {
    sourceConnectorSlugs,
    sourceLabel,
    destinationConnectorSlug,
  };
}

function WorkflowDiagramNode({
  label,
  connectorSlug,
  connectorSlugs,
  className,
  iconClassName,
  children,
}: {
  readonly label: string;
  readonly connectorSlug?: ConnectorSlug;
  readonly connectorSlugs?: readonly ConnectorSlug[];
  readonly className: string;
  readonly iconClassName?: string;
  readonly children?: ReactNode;
}) {
  const visibleConnectorSlugs = connectorSlugs?.slice(0, 3) ?? [];
  const hiddenConnectorCount = Math.max((connectorSlugs?.length ?? 0) - 3, 0);

  return (
    <div className={`owf-diagram-node ${className}`}>
      {label ? <span>{label}</span> : null}
      <span className={`owf-diagram-icon-box ${iconClassName ?? ""}`}>
        {children ??
          (visibleConnectorSlugs.length > 1 ? (
            <span className="owf-diagram-icon-stack">
              {visibleConnectorSlugs.map((item) => {
                return (
                  <span key={item} className="owf-diagram-icon-stack-item">
                    <DiagramConnectorIcon connectorSlug={item} size={22} />
                  </span>
                );
              })}
              {hiddenConnectorCount > 0 ? (
                <span className="owf-diagram-icon-stack-more">
                  +{hiddenConnectorCount}
                </span>
              ) : null}
            </span>
          ) : connectorSlug ? (
            <DiagramConnectorIcon connectorSlug={connectorSlug} size={34} />
          ) : null)}
      </span>
    </div>
  );
}

function WorkflowDiagramAction({
  title,
  description,
  className,
}: {
  readonly title: string;
  readonly description: string;
  readonly className: string;
}) {
  return (
    <div className={`owf-diagram-action ${className}`}>
      <span className="owf-diagram-action-copy">
        <strong>{title}</strong>
        <span>{description}</span>
      </span>
    </div>
  );
}

export function WorkflowPreviewDiagram({
  workflow,
}: {
  readonly workflow: OnboardingWorkflow;
}) {
  const { t } = useTranslation();
  const diagram = buildWorkflowDiagramModel(
    workflow,
    t(($) => {
      return $.onboarding.workflowDiagram.source;
    }),
  );
  const firstStep = workflow.detailSteps[1] ?? workflow.detailSteps[0];
  const lastStep = workflow.detailSteps.at(-1) ?? firstStep;
  const destinationCurvePath =
    "M485 112V148.65C485 166.79 469.17 175.85 437.51 175.85H352.59C325.19 175.85 311.5 183.7 311.5 199.4V223";
  const beamPath = diagram.destinationConnectorSlug
    ? "M170 81H485V148.65C485 166.79 469.17 175.85 437.51 175.85H352.59C325.19 175.85 311.5 183.7 311.5 199.4V356"
    : "M170 81H311.5V223H312.5V356";

  return (
    <div className="owf-diagram-wrap">
      <div className="owf-diagram">
        <div className="owf-diagram-grid" aria-hidden="true" />
        <svg
          className="owf-diagram-lines"
          viewBox="0 0 614 470"
          fill="none"
          aria-hidden="true"
        >
          <path d="M170 81H277" />
          {diagram.destinationConnectorSlug ? (
            <>
              <path d="M349 81H451" />
              <path d={destinationCurvePath} />
            </>
          ) : (
            <path d="M311.5 112V223" />
          )}
        </svg>
        <span
          className="owf-diagram-beam"
          aria-hidden="true"
          style={{ offsetPath: `path("${beamPath}")` } satisfies CSSProperties}
        />
        <span className="owf-diagram-dot-source" aria-hidden="true" />
        {diagram.destinationConnectorSlug ? (
          <>
            <span
              className="owf-diagram-dot-destination-in"
              aria-hidden="true"
            />
            <span
              className="owf-diagram-dot-destination-down"
              aria-hidden="true"
            />
          </>
        ) : null}
        <span className="owf-diagram-dot-action-top" aria-hidden="true" />
        <span className="owf-diagram-vertical-control" aria-hidden="true" />
        <span className="owf-diagram-dot-action-middle" aria-hidden="true" />
        <span className="owf-diagram-dot-action-bottom" aria-hidden="true" />
        {diagram.sourceConnectorSlugs.length > 0 ? (
          <WorkflowDiagramNode
            label={diagram.sourceLabel}
            connectorSlug={diagram.sourceConnectorSlugs[0]}
            connectorSlugs={diagram.sourceConnectorSlugs}
            className="owf-diagram-node-source"
          />
        ) : null}
        <WorkflowDiagramNode
          label=""
          className="owf-diagram-node-zero"
          iconClassName="owf-diagram-avatar"
        >
          <span className="owf-diagram-zero-icon" aria-hidden="true">
            <img src={ZERO_AVATAR_HEAD_IMG} alt="" aria-hidden />
            <img src={ZERO_AVATAR_HAIR_IMG} alt="" aria-hidden />
            <img src={ZERO_AVATAR_FACE_IMG} alt="" aria-hidden />
          </span>
        </WorkflowDiagramNode>
        {diagram.destinationConnectorSlug ? (
          <WorkflowDiagramNode
            label={connectorLabel(diagram.destinationConnectorSlug)}
            connectorSlug={diagram.destinationConnectorSlug}
            className="owf-diagram-node-output"
          />
        ) : null}
        <WorkflowDiagramAction
          title={
            firstStep?.title ??
            t(($) => {
              return $.onboarding.workflowDiagram.preparedTitle;
            })
          }
          description={
            firstStep?.description ??
            t(($) => {
              return $.onboarding.workflowDiagram.preparedDescription;
            })
          }
          className="owf-diagram-action-one"
        />
        <WorkflowDiagramAction
          title={
            lastStep?.title ??
            t(($) => {
              return $.onboarding.workflowDiagram.reviewTitle;
            })
          }
          description={
            lastStep?.description ??
            t(($) => {
              return $.onboarding.workflowDiagram.reviewDescription;
            })
          }
          className="owf-diagram-action-two"
        />
      </div>
    </div>
  );
}
