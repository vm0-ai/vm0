import type { CSSProperties, ReactNode } from "react";
import { useLastLoadable } from "ccstate-react";
import type { OnboardingWorkflow } from "./onboarding-data.ts";
import { connectorCatalogStatusByRef$ } from "../../signals/external/connectors.ts";
import { ConnectorIcon } from "../zero-page/components/settings/connector-icons.tsx";

function DiagramConnectorIcon({
  connectorRef,
  size,
}: {
  readonly connectorRef: string;
  readonly size: number;
}) {
  const catalogByRefLoadable = useLastLoadable(connectorCatalogStatusByRef$);
  const icon =
    catalogByRefLoadable.state === "hasData"
      ? catalogByRefLoadable.data.get(connectorRef)?.icon
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

function connectorLabel(connectorId: string): string {
  return CONNECTOR_LABELS[connectorId] ?? connectorId;
}

const WORKFLOW_SOURCE_CONNECTOR_IDS: ReadonlySet<string> = new Set([
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

const WORKFLOW_OUTPUT_CONNECTOR_IDS: ReadonlySet<string> = new Set([
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

const WORKFLOW_DELIVERY_CONNECTOR_IDS: ReadonlySet<string> = new Set([
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

function uniqueWorkflowConnectors(
  connectors: readonly string[],
): readonly string[] {
  const seen = new Set<string>();
  return connectors.filter((connectorId) => {
    if (seen.has(connectorId)) {
      return false;
    }
    seen.add(connectorId);
    return true;
  });
}

interface WorkflowDiagramModel {
  readonly sourceConnectors: readonly string[];
  readonly sourceLabel: string;
  readonly destinationConnector: string | undefined;
}

function buildWorkflowDiagramModel(
  workflow: OnboardingWorkflow,
): WorkflowDiagramModel {
  const allConnectors = uniqueWorkflowConnectors(workflow.connectors);
  const sourceCandidates = uniqueWorkflowConnectors([
    ...allConnectors.filter((connectorId) => {
      return WORKFLOW_SOURCE_CONNECTOR_IDS.has(connectorId);
    }),
    ...allConnectors,
  ]);
  const outputCandidates = uniqueWorkflowConnectors([
    ...allConnectors.filter((connectorId) => {
      return WORKFLOW_OUTPUT_CONNECTOR_IDS.has(connectorId);
    }),
    ...allConnectors,
  ]);

  const primarySource = sourceCandidates[0] ?? allConnectors[0];
  const destinationConnector =
    outputCandidates.find((connectorId) => {
      return (
        connectorId !== primarySource &&
        WORKFLOW_DELIVERY_CONNECTOR_IDS.has(connectorId)
      );
    }) ??
    outputCandidates.find((connectorId) => {
      return connectorId !== primarySource;
    }) ??
    undefined;
  const sourceConnectors = uniqueWorkflowConnectors([
    ...(primarySource ? [primarySource] : []),
    ...allConnectors.filter((connectorId) => {
      return connectorId !== destinationConnector;
    }),
  ]);
  const primaryLabel = sourceConnectors[0]
    ? connectorLabel(sourceConnectors[0])
    : "Source";
  const sourceLabel =
    sourceConnectors.length > 1
      ? `${primaryLabel} + ${sourceConnectors.length - 1}`
      : sourceConnectors[0]
        ? connectorLabel(sourceConnectors[0])
        : "";

  return {
    sourceConnectors,
    sourceLabel,
    destinationConnector,
  };
}

function WorkflowDiagramNode({
  label,
  connector,
  connectors,
  className,
  iconClassName,
  children,
}: {
  readonly label: string;
  readonly connector?: string;
  readonly connectors?: readonly string[];
  readonly className: string;
  readonly iconClassName?: string;
  readonly children?: ReactNode;
}) {
  const visibleConnectors = connectors?.slice(0, 3) ?? [];
  const hiddenConnectorCount = Math.max((connectors?.length ?? 0) - 3, 0);

  return (
    <div className={`owf-diagram-node ${className}`}>
      {label ? <span>{label}</span> : null}
      <span className={`owf-diagram-icon-box ${iconClassName ?? ""}`}>
        {children ??
          (visibleConnectors.length > 1 ? (
            <span className="owf-diagram-icon-stack">
              {visibleConnectors.map((item) => {
                return (
                  <span key={item} className="owf-diagram-icon-stack-item">
                    <DiagramConnectorIcon connectorRef={item} size={22} />
                  </span>
                );
              })}
              {hiddenConnectorCount > 0 ? (
                <span className="owf-diagram-icon-stack-more">
                  +{hiddenConnectorCount}
                </span>
              ) : null}
            </span>
          ) : connector ? (
            <DiagramConnectorIcon connectorRef={connector} size={34} />
          ) : null)}
      </span>
    </div>
  );
}

function WorkflowDiagramAction({
  title,
  description,
  variant,
  className,
}: {
  readonly title: string;
  readonly description: string;
  readonly variant: "filed" | "complete";
  readonly className: string;
}) {
  return (
    <div className={`owf-diagram-action ${className}`}>
      <span
        className={`owf-diagram-action-icon ${
          variant === "complete"
            ? "owf-diagram-action-icon-complete"
            : "owf-diagram-action-icon-filed"
        }`}
      >
        <span />
      </span>
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
  const diagram = buildWorkflowDiagramModel(workflow);
  const firstStep = workflow.detailSteps[1] ?? workflow.detailSteps[0];
  const lastStep = workflow.detailSteps.at(-1) ?? firstStep;
  const destinationCurvePath =
    "M485 112V148.65C485 166.79 469.17 175.85 437.51 175.85H352.59C325.19 175.85 311.5 183.7 311.5 199.4V223";
  const beamPath = diagram.destinationConnector
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
          {diagram.destinationConnector ? (
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
        {diagram.destinationConnector ? (
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
        {diagram.sourceConnectors.length > 0 ? (
          <WorkflowDiagramNode
            label={diagram.sourceLabel}
            connector={diagram.sourceConnectors[0]}
            connectors={diagram.sourceConnectors}
            className="owf-diagram-node-source"
          />
        ) : null}
        <WorkflowDiagramNode
          label=""
          className="owf-diagram-node-zero"
          iconClassName="owf-diagram-avatar"
        >
          <span className="owf-diagram-zero-icon" aria-hidden="true">
            <img src="/onboarding/zero-avatar-head.svg" alt="" aria-hidden />
            <img src="/onboarding/zero-avatar-hair.svg" alt="" aria-hidden />
            <img src="/onboarding/zero-avatar-face.svg" alt="" aria-hidden />
          </span>
        </WorkflowDiagramNode>
        {diagram.destinationConnector ? (
          <WorkflowDiagramNode
            label={connectorLabel(diagram.destinationConnector)}
            connector={diagram.destinationConnector}
            className="owf-diagram-node-output"
          />
        ) : null}
        <WorkflowDiagramAction
          title={firstStep?.title ?? "Workflow prepared"}
          description={
            firstStep?.description ??
            "Zero prepares the next step from your tools."
          }
          variant="filed"
          className="owf-diagram-action-one"
        />
        <WorkflowDiagramAction
          title={lastStep?.title ?? "Ready for review"}
          description={
            lastStep?.description ??
            "Zero completes the workflow and returns the result."
          }
          variant="complete"
          className="owf-diagram-action-two"
        />
      </div>
    </div>
  );
}
