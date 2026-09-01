export const LEGACY_DATABASE_IDENTITY_SOURCES = [
  "snapshot",
  "catalog",
  "semantic-contract",
] as const;

export type LegacyDatabaseIdentitySource =
  (typeof LEGACY_DATABASE_IDENTITY_SOURCES)[number];

export const LEGACY_DATABASE_IDENTITY_KINDS = [
  "relation",
  "view",
  "column",
  "index",
  "constraint",
  "default",
  "enum-discriminator-value",
  "trigger",
  "function",
] as const;

export type LegacyDatabaseIdentityKind =
  (typeof LEGACY_DATABASE_IDENTITY_KINDS)[number];

export interface LegacyDatabaseIdentityManifestEntry {
  readonly classification: "migrate" | "retain";
  readonly drainEvidence: string;
  readonly key: string;
  readonly kind: LegacyDatabaseIdentityKind;
  readonly members: readonly string[];
  readonly ownerIssue: `#${number}`;
  readonly reason: string;
  readonly removalGate: string;
  readonly sources: readonly LegacyDatabaseIdentitySource[];
  readonly writerStopCondition: string;
}

type ManifestDisposition = Pick<
  LegacyDatabaseIdentityManifestEntry,
  | "classification"
  | "drainEvidence"
  | "ownerIssue"
  | "reason"
  | "removalGate"
  | "writerStopCondition"
>;

type PhysicalIdentitySpec = Pick<
  LegacyDatabaseIdentityManifestEntry,
  "key" | "kind" | "sources"
>;

const SNAPSHOT_AND_CATALOG = ["snapshot", "catalog"] as const;
const CATALOG_ONLY = ["catalog"] as const;

function physicalEntries(
  specs: readonly PhysicalIdentitySpec[],
  disposition: ManifestDisposition,
): readonly LegacyDatabaseIdentityManifestEntry[] {
  return specs.map((spec) => {
    return {
      ...disposition,
      ...spec,
      members: [spec.key.slice(spec.key.indexOf(":") + 1)],
    };
  });
}

const acquisitionDisposition = {
  classification: "migrate",
  reason:
    "The legacy acquisition column and temporary mirror bridge remain rollback compatibility after active application authority moved to the canonical first-party-source column.",
  ownerIssue: "#28368",
  writerStopCondition:
    "#30605 makes acquisition_first_party_source the only active application writer and in-repository acquisition reader while the mirror bridge remains installed for rollback.",
  drainEvidence:
    "The production-accepted bounded backfill has exact MaskDB parity with valid both-null rows preserved; the 7-day legacy reader/writer audit and rollback drain remain open.",
  removalGate:
    "#28368 may remove the bridge or contract acquisition_vm0_source only after writer-stop, exact parity, the 7-day reporting-reader audit, rollback drain, and replayed/regenerated catalog-contract verification all pass.",
} as const satisfies ManifestDisposition;

const publicBrandDisposition = {
  classification: "retain",
  reason:
    "VM0 remains a supported public presentation brand, so persisted public_brand values are an active product boundary rather than an internal alias.",
  ownerIssue: "#27750",
  writerStopCondition:
    "#27750 records a product decision that disables creation of new VM0-branded objects on every listed public_brand surface.",
  drainEvidence:
    "For 30 consecutive days after that decision, production counts have zero new vm0-branded rows and zero supported VM0-domain reads that require the value.",
  removalGate:
    "#27750 approves removal only after the 30-day zero-write/read window and every listed public_brand member is backfilled or explicitly retained.",
} as const satisfies ManifestDisposition;

const desktopDisposition = {
  classification: "retain",
  reason:
    "Zero remains a supported Desktop product identity during the measured Computer Use migration and rollback window.",
  ownerIssue: "#26364",
  writerStopCondition:
    "The #26370 hard stop is production-accepted and no supported Zero Desktop version can register or refresh a Computer Use host.",
  drainEvidence:
    "Aggregate host telemetry has zero Zero-product heartbeats and commands for 14 consecutive days after the hard stop, with zero active rollback dependency.",
  removalGate:
    "#26368 may remove the zero value only after the 14-day zero-activity window and the legacy feed, auth, and rollback gates all pass.",
} as const satisfies ManifestDisposition;

const runnerProfileDisposition = {
  classification: "retain",
  reason:
    "vm0/default remains a retained Runner routing protocol shared by the API, queue, and supported Runner releases, with its database surface tracked by #28368.",
  ownerIssue: "#26701",
  writerStopCondition:
    "#26701 records that API and Runner releases both emit an approved canonical profile and the oldest supported rollback Runner no longer requires vm0/default.",
  drainEvidence:
    "#26701 records exact zero queue counts for vm0/default across a 7-day Runner release cycle and no supported Runner advertises the legacy profile.",
  removalGate:
    "#26701 approves a separate contract only after the 7-day zero-queue window and exact supported-Runner inventory both pass.",
} as const satisfies ManifestDisposition;

const nonWorkflowPhysicalEntries = [
  ...physicalEntries(
    [
      {
        key: "column:public.org_metadata.acquisition_vm0_source",
        kind: "column",
        sources: SNAPSHOT_AND_CATALOG,
      },
      {
        key: "function:public.sync_org_metadata_acquisition_first_party_source_1033()",
        kind: "function",
        sources: CATALOG_ONLY,
      },
      {
        key: "trigger:public.org_metadata.sync_org_metadata_acquisition_first_party_source_1033",
        kind: "trigger",
        sources: CATALOG_ONLY,
      },
    ],
    acquisitionDisposition,
  ),
  ...physicalEntries(
    [
      "agentphone_user_links",
      "chat_automation_context",
      "chat_github_context",
      "email_outbox",
      "export_jobs",
      "feishu_org_installations",
      "push_subscriptions",
      "shared_threads",
      "telegram_installations",
      "telegram_official_user_links",
      "usage_pack_invitation_purchases",
    ].map((tableName) => {
      return {
        key: `default:public.${tableName}.public_brand`,
        kind: "default" as const,
        sources: SNAPSHOT_AND_CATALOG,
      };
    }),
    publicBrandDisposition,
  ),
  ...physicalEntries(
    [
      {
        key: "default:public.computer_use_hosts.client_product",
        kind: "default",
        sources: SNAPSHOT_AND_CATALOG,
      },
      {
        key: "constraint:public.computer_use_hosts.computer_use_hosts_client_product_check",
        kind: "constraint",
        sources: SNAPSHOT_AND_CATALOG,
      },
    ],
    desktopDisposition,
  ),
  ...physicalEntries(
    [
      {
        key: "default:public.runner_job_queue.profile",
        kind: "default",
        sources: SNAPSHOT_AND_CATALOG,
      },
    ],
    runnerProfileDisposition,
  ),
] as const satisfies readonly LegacyDatabaseIdentityManifestEntry[];

const publicBrandMembers = [
  "public.agentphone_messages.public_brand = 'vm0'",
  "public.agentphone_user_links.public_brand = 'vm0'",
  "public.browser_sessions.public_brand = 'vm0'",
  "public.chat_agentphone_context.public_brand = 'vm0'",
  "public.chat_automation_context.public_brand = 'vm0'",
  "public.chat_feishu_context.public_brand = 'vm0'",
  "public.chat_github_context.public_brand = 'vm0'",
  "public.chat_slack_context.public_brand = 'vm0'",
  "public.chat_teams_context.public_brand = 'vm0'",
  "public.chat_telegram_context.public_brand = 'vm0'",
  "public.email_outbox.public_brand = 'vm0'",
  "public.export_jobs.public_brand = 'vm0'",
  "public.feishu_chat_ingress.public_brand = 'vm0'",
  "public.feishu_org_connections.public_brand = 'vm0'",
  "public.feishu_org_installations.public_brand = 'vm0'",
  "public.github_installations.public_brand = 'vm0'",
  "public.hosted_deployments.public_brand = 'vm0'",
  "public.hosted_sites.public_brand = 'vm0'",
  "public.push_subscriptions.public_brand = 'vm0'",
  "public.shared_threads.public_brand = 'vm0'",
  "public.slack_chat_ingress.public_brand = 'vm0'",
  "public.slack_org_installations.public_brand = 'vm0'",
  "public.socialkit_download_jobs.public_brand = 'vm0'",
  "public.teams_org_installations.public_brand = 'vm0'",
  "public.telegram_installations.public_brand = 'vm0'",
  "public.telegram_official_user_links.public_brand = 'vm0'",
  "public.usage_pack_invitation_purchases.public_brand = 'vm0'",
] as const;

const semanticFamilyEntries = [
  {
    ...publicBrandDisposition,
    key: "enum-discriminator-value:contract.public-brand = 'vm0'",
    kind: "enum-discriminator-value",
    members: publicBrandMembers,
    sources: ["semantic-contract"],
  },
  {
    ...desktopDisposition,
    key: "enum-discriminator-value:contract.desktop-product = 'zero'",
    kind: "enum-discriminator-value",
    members: ["public.computer_use_hosts.client_product = 'zero'"],
    sources: ["semantic-contract"],
  },
  {
    ...runnerProfileDisposition,
    key: "enum-discriminator-value:contract.runner-profile = 'vm0/default'",
    kind: "enum-discriminator-value",
    members: ["public.runner_job_queue.profile = 'vm0/default'"],
    sources: ["semantic-contract"],
  },
] as const satisfies readonly LegacyDatabaseIdentityManifestEntry[];

export const LEGACY_DATABASE_IDENTITY_MANIFEST = [
  ...nonWorkflowPhysicalEntries,
  ...semanticFamilyEntries,
] as const satisfies readonly LegacyDatabaseIdentityManifestEntry[];
