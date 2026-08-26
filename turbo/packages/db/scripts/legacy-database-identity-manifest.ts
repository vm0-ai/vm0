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

const workflowDisposition = {
  classification: "migrate",
  reason:
    "The physical Workflow storage cluster and its compatibility views remain on the staged expand, switch, and contract path.",
  ownerIssue: "#26896",
  writerStopCondition:
    "The #26896 canonical read/write switch is production-accepted and every supported rollback build addresses all six canonical Workflow relations.",
  drainEvidence:
    "A fresh pg_catalog replay has zero unowned legacy dependencies, MaskDB has exact key parity for all six relation pairs, and a 24-hour post-switch Axiom window has zero legacy-relation SQL errors.",
  removalGate:
    "#26896 may contract an entry only after the 24-hour zero-error window, zero legacy writer inventory, and exact catalog dependency review all pass.",
} as const satisfies ManifestDisposition;

const workflowIdentities = [
  {
    key: "relation:public.zero_workflow_automations",
    kind: "relation",
    sources: SNAPSHOT_AND_CATALOG,
  },
  {
    key: "relation:public.zero_workflow_github_processed_events",
    kind: "relation",
    sources: SNAPSHOT_AND_CATALOG,
  },
  {
    key: "relation:public.zero_workflow_strapi_automations",
    kind: "relation",
    sources: SNAPSHOT_AND_CATALOG,
  },
  {
    key: "relation:public.zero_workflow_webhook_automations",
    kind: "relation",
    sources: SNAPSHOT_AND_CATALOG,
  },
  {
    key: "relation:public.zero_workflow_webhook_deliveries",
    kind: "relation",
    sources: SNAPSHOT_AND_CATALOG,
  },
  {
    key: "relation:public.zero_workflows",
    kind: "relation",
    sources: SNAPSHOT_AND_CATALOG,
  },
  {
    key: "view:public.workflow_automations",
    kind: "view",
    sources: CATALOG_ONLY,
  },
  {
    key: "view:public.workflow_github_processed_events",
    kind: "view",
    sources: CATALOG_ONLY,
  },
  {
    key: "view:public.workflow_strapi_automations",
    kind: "view",
    sources: CATALOG_ONLY,
  },
  {
    key: "view:public.workflow_webhook_automations",
    kind: "view",
    sources: CATALOG_ONLY,
  },
  {
    key: "view:public.workflow_webhook_deliveries",
    kind: "view",
    sources: CATALOG_ONLY,
  },
  {
    key: "view:public.workflows",
    kind: "view",
    sources: CATALOG_ONLY,
  },
  {
    key: "index:public.idx_zero_workflow_automations_next_run",
    kind: "index",
    sources: SNAPSHOT_AND_CATALOG,
  },
  {
    key: "index:public.idx_zero_workflow_automations_org",
    kind: "index",
    sources: SNAPSHOT_AND_CATALOG,
  },
  {
    key: "index:public.idx_zero_workflow_automations_workflow",
    kind: "index",
    sources: SNAPSHOT_AND_CATALOG,
  },
  {
    key: "index:public.idx_zero_workflow_github_processed_automation_delivery",
    kind: "index",
    sources: SNAPSHOT_AND_CATALOG,
  },
  {
    key: "index:public.idx_zero_workflow_github_processed_subject",
    kind: "index",
    sources: SNAPSHOT_AND_CATALOG,
  },
  {
    key: "index:public.idx_zero_workflow_strapi_automations_integration",
    kind: "index",
    sources: SNAPSHOT_AND_CATALOG,
  },
  {
    key: "index:public.idx_zero_workflow_webhook_automations_token_hash",
    kind: "index",
    sources: SNAPSHOT_AND_CATALOG,
  },
  {
    key: "index:public.idx_zero_workflow_webhook_deliveries_automation_key",
    kind: "index",
    sources: SNAPSHOT_AND_CATALOG,
  },
  {
    key: "index:public.idx_zero_workflow_webhook_deliveries_automation_received",
    kind: "index",
    sources: SNAPSHOT_AND_CATALOG,
  },
  {
    key: "index:public.idx_zero_workflows_agent",
    kind: "index",
    sources: SNAPSHOT_AND_CATALOG,
  },
  {
    key: "index:public.idx_zero_workflows_org",
    kind: "index",
    sources: SNAPSHOT_AND_CATALOG,
  },
  {
    key: "index:public.idx_zero_workflows_org_owner",
    kind: "index",
    sources: SNAPSHOT_AND_CATALOG,
  },
  {
    key: "index:public.idx_zero_workflows_private_owner_agent_name_unique",
    kind: "index",
    sources: SNAPSHOT_AND_CATALOG,
  },
  {
    key: "index:public.idx_zero_workflows_public_agent_name_unique",
    kind: "index",
    sources: SNAPSHOT_AND_CATALOG,
  },
  {
    key: "constraint:public.agent_runs.agent_runs_workflow_automation_id_zero_workflow_automations_id_",
    kind: "constraint",
    sources: SNAPSHOT_AND_CATALOG,
  },
  {
    key: "constraint:public.gmail_processed_events.gmail_processed_events_automation_id_zero_workflow_automations_",
    kind: "constraint",
    sources: SNAPSHOT_AND_CATALOG,
  },
  {
    key: "constraint:public.google_calendar_processed_events.google_calendar_processed_events_automation_id_zero_workflow_au",
    kind: "constraint",
    sources: SNAPSHOT_AND_CATALOG,
  },
  {
    key: "constraint:public.google_forms_automation_cursors.google_forms_automation_cursors_automation_id_zero_workflow_aut",
    kind: "constraint",
    sources: SNAPSHOT_AND_CATALOG,
  },
  {
    key: "constraint:public.google_forms_processed_events.google_forms_processed_events_automation_id_zero_workflow_autom",
    kind: "constraint",
    sources: SNAPSHOT_AND_CATALOG,
  },
  {
    key: "constraint:public.google_workspace_processed_events.google_workspace_processed_events_automation_id_zero_workflow_a",
    kind: "constraint",
    sources: SNAPSHOT_AND_CATALOG,
  },
  {
    key: "constraint:public.notion_workflow_pending_events.notion_workflow_pending_events_automation_id_zero_workflow_auto",
    kind: "constraint",
    sources: SNAPSHOT_AND_CATALOG,
  },
  {
    key: "constraint:public.strapi_workflow_pending_events.strapi_workflow_pending_events_automation_id_zero_workflow_auto",
    kind: "constraint",
    sources: SNAPSHOT_AND_CATALOG,
  },
  {
    key: "constraint:public.stripe_workflow_automation_health.stripe_workflow_automation_health_automation_id_zero_workflow_a",
    kind: "constraint",
    sources: SNAPSHOT_AND_CATALOG,
  },
  {
    key: "constraint:public.workflow_user_automation_threads.workflow_user_automation_threads_workflow_id_zero_workflows_id_",
    kind: "constraint",
    sources: SNAPSHOT_AND_CATALOG,
  },
  {
    key: "constraint:public.zero_workflow_automations.zero_workflow_automations_autonomy_budget_check",
    kind: "constraint",
    sources: SNAPSHOT_AND_CATALOG,
  },
  {
    key: "constraint:public.zero_workflow_automations.zero_workflow_automations_schedule_config_check",
    kind: "constraint",
    sources: SNAPSHOT_AND_CATALOG,
  },
  {
    key: "constraint:public.zero_workflow_automations.zero_workflow_automations_workflow_id_zero_workflows_id_fk",
    kind: "constraint",
    sources: SNAPSHOT_AND_CATALOG,
  },
  {
    key: "constraint:public.zero_workflow_github_processed_events.zero_workflow_github_processed_events_automation_id_zero_workfl",
    kind: "constraint",
    sources: SNAPSHOT_AND_CATALOG,
  },
  {
    key: "constraint:public.zero_workflow_strapi_automations.zero_workflow_strapi_automations_automation_id_zero_workflow_au",
    kind: "constraint",
    sources: SNAPSHOT_AND_CATALOG,
  },
  {
    key: "constraint:public.zero_workflow_strapi_automations.zero_workflow_strapi_automations_integration_id_strapi_integrat",
    kind: "constraint",
    sources: SNAPSHOT_AND_CATALOG,
  },
  {
    key: "constraint:public.zero_workflow_webhook_automations.zero_workflow_webhook_automations_automation_id_zero_workflow_a",
    kind: "constraint",
    sources: SNAPSHOT_AND_CATALOG,
  },
  {
    key: "constraint:public.zero_workflow_webhook_deliveries.zero_workflow_webhook_deliveries_automation_id_zero_workflow_au",
    kind: "constraint",
    sources: SNAPSHOT_AND_CATALOG,
  },
  {
    key: "constraint:public.zero_workflows.zero_workflows_agent_id_agents_id_fk",
    kind: "constraint",
    sources: SNAPSHOT_AND_CATALOG,
  },
  {
    key: "constraint:public.zero_workflow_automations.zero_workflow_automations_pkey",
    kind: "constraint",
    sources: CATALOG_ONLY,
  },
  {
    key: "constraint:public.zero_workflow_github_processed_events.zero_workflow_github_processed_events_pkey",
    kind: "constraint",
    sources: CATALOG_ONLY,
  },
  {
    key: "constraint:public.zero_workflow_strapi_automations.zero_workflow_strapi_automations_pkey",
    kind: "constraint",
    sources: CATALOG_ONLY,
  },
  {
    key: "constraint:public.zero_workflow_webhook_automations.zero_workflow_webhook_automations_pkey",
    kind: "constraint",
    sources: CATALOG_ONLY,
  },
  {
    key: "constraint:public.zero_workflow_webhook_deliveries.zero_workflow_webhook_deliveries_pkey",
    kind: "constraint",
    sources: CATALOG_ONLY,
  },
  {
    key: "constraint:public.zero_workflows.zero_workflows_pkey",
    kind: "constraint",
    sources: CATALOG_ONLY,
  },
] as const satisfies readonly PhysicalIdentitySpec[];

const acquisitionDisposition = {
  classification: "migrate",
  reason:
    "The acquisition attribution column still exposes a legacy product identity in current schema.",
  ownerIssue: "#28368",
  writerStopCondition:
    "A separately reviewed dual-column release writes only the domain-approved canonical acquisition attribution column under #28368.",
  drainEvidence:
    "MaskDB has zero non-null legacy-only attribution rows after backfill and a 7-day reporting audit has zero readers of the legacy column.",
  removalGate:
    "#28368 may contract the column only when both zero residual rows and the 7-day zero-reader reporting audit are recorded.",
} as const satisfies ManifestDisposition;

const entitlementDisposition = {
  classification: "migrate",
  reason:
    "The entitlement column and its permanent migration helper still encode the retired built-in-model brand.",
  ownerIssue: "#28368",
  writerStopCondition:
    "A separately reviewed dual-column release writes only the canonical built-in-model entitlement field and updates the permanent helper under #28368.",
  drainEvidence:
    "MaskDB has zero legacy-only entitlement rows after backfill and a 7-day API and billing audit has zero readers of restricted_vm0_models.",
  removalGate:
    "#28368 may contract the column and helper only after zero residual rows, the 7-day zero-reader audit, and exact replayed catalog verification all pass.",
} as const satisfies ManifestDisposition;

const providerDisposition = {
  classification: "migrate",
  reason:
    "The vm0 provider discriminator remains an active persisted compatibility value while consumers dual-accept built-in.",
  ownerIssue: "#28368",
  writerStopCondition:
    "The #28368 provider writer/default switch is production-accepted and all four mutable surfaces write built-in for new values.",
  drainEvidence:
    "Exact MaskDB counts on all four surfaces show zero mutable vm0 values and a 7-day production window shows zero supported legacy-provider writers.",
  removalGate:
    "#28368 may remove the vm0 acceptor only after the four zero-count queries, the 7-day zero-writer window, and a rollback build accepting built-in are recorded.",
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
    ],
    acquisitionDisposition,
  ),
  ...physicalEntries(
    [
      {
        key: "column:public.org_plan_entitlements.restricted_vm0_models",
        kind: "column",
        sources: SNAPSHOT_AND_CATALOG,
      },
      {
        key: "function:public.ensure_legacy_org_metadata_plan_entitlement()",
        kind: "function",
        sources: CATALOG_ONLY,
      },
    ],
    entitlementDisposition,
  ),
  ...physicalEntries(
    [
      {
        key: "default:public.org_model_policies.default_provider_type",
        kind: "default",
        sources: SNAPSHOT_AND_CATALOG,
      },
      {
        key: "constraint:public.org_model_policies.chk_org_model_policies_builtin_route_no_provider_id",
        kind: "constraint",
        sources: SNAPSHOT_AND_CATALOG,
      },
    ],
    providerDisposition,
  ),
  ...physicalEntries(
    [
      "agentphone_user_links",
      "chat_automation_context",
      "chat_github_context",
      "email_outbox",
      "export_jobs",
      "feishu_org_installations",
      "morning_brief_deliveries",
      "morning_brief_schedules",
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
  "public.morning_brief_deliveries.public_brand = 'vm0'",
  "public.morning_brief_schedules.public_brand = 'vm0'",
  "public.push_subscriptions.public_brand = 'vm0'",
  "public.shared_threads.public_brand = 'vm0'",
  "public.slack_chat_ingress.public_brand = 'vm0'",
  "public.slack_org_installations.public_brand = 'vm0'",
  "public.teams_org_installations.public_brand = 'vm0'",
  "public.telegram_installations.public_brand = 'vm0'",
  "public.telegram_official_user_links.public_brand = 'vm0'",
  "public.usage_pack_invitation_purchases.public_brand = 'vm0'",
] as const;

const semanticFamilyEntries = [
  {
    ...providerDisposition,
    key: "enum-discriminator-value:contract.model-provider = 'vm0'",
    kind: "enum-discriminator-value",
    members: [
      "public.agent_runs.model_provider = 'vm0'",
      "public.chat_threads.model_provider_type = 'vm0'",
      "public.model_providers.type = 'vm0'",
      "public.org_model_policies.default_provider_type = 'vm0'",
    ],
    sources: ["semantic-contract"],
  },
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
  ...physicalEntries(workflowIdentities, workflowDisposition),
  ...nonWorkflowPhysicalEntries,
  ...semanticFamilyEntries,
] as const satisfies readonly LegacyDatabaseIdentityManifestEntry[];
