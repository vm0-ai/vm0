/**
 * Classification rules and the cleanup baseline for residual `zero` and `vm0`
 * names in tracked source. #31813 owns this file; #31801 owns the workstreams
 * that shrink the baseline.
 *
 * A boundary rule states why an occurrence is approved. Anything a rule does
 * not approve must appear in the baseline with an owning workstream, which is
 * the reviewable moment this guard exists to create.
 */

export const RESIDUAL_BRAND_BOUNDARY_CATEGORIES = [
  "immutable-history",
  "physical-schema-identity",
  "dual-brand-product-contract",
  "wire-and-persisted-value",
  "persisted-artifact-provenance",
  "immutable-static-asset-key",
  "protocol-compatibility",
  "desktop-identity",
  "external-identity",
  "semantic-non-brand",
  "out-of-scope",
] as const;

export type ResidualBrandBoundaryCategory =
  (typeof RESIDUAL_BRAND_BOUNDARY_CATEGORIES)[number];

export interface ResidualBrandBoundaryFileRule {
  readonly category: ResidualBrandBoundaryCategory;
  /** Migration files also define the physical identifiers other files quote. */
  readonly harvestsDatabaseIdentifiers?: true;
  readonly id: string;
  readonly paths: RegExp;
  readonly reason: string;
}

export interface ResidualBrandBoundaryOccurrenceRule {
  /** Matched against the line text that precedes the token. */
  readonly after?: RegExp;
  readonly before?: RegExp;
  readonly category: ResidualBrandBoundaryCategory;
  readonly id: string;
  /** Matched against the whole line the token appears on. */
  readonly line?: RegExp;
  /** Matched against an identifier discovered in the committed migrations. */
  readonly matchesDatabaseIdentifier?: true;
  readonly paths?: RegExp;
  readonly reason: string;
  readonly tokenPattern?: RegExp;
  readonly tokens?: readonly string[];
}

export interface ResidualBrandNameWorkstream {
  readonly id: string;
  readonly ownerIssue: `#${number}`;
  readonly title: string;
}

export interface ResidualBrandNameBaselineEntry {
  readonly name: string;
  readonly ownerIssue: `#${number}`;
  readonly reason: string;
  readonly workstream: string;
}

export const RESIDUAL_BRAND_BOUNDARY_FILE_RULES = [
  {
    category: "out-of-scope",
    id: "out-of-scope/rust-crates",
    paths: /^crates\//u,
    reason:
      "#31813 enforces nothing on the Rust workspace; crate, binary, and package identities are renamed by their own release-compatible slice.",
  },
  {
    category: "out-of-scope",
    id: "out-of-scope/vendored-bundles",
    paths: /(?:^|\/)dist\//u,
    reason:
      "Vendored and generated bundles are build output, not authored source, and are replaced wholesale by their upstream.",
  },
  {
    category: "out-of-scope",
    id: "out-of-scope/residual-brand-name-guard",
    paths: /^turbo\/packages\/eslint-rules\/scripts\/residual-brand-name-/u,
    reason:
      "The classifier and its baseline quote every name they track, so scanning them would make the guard satisfy itself.",
  },
  {
    category: "immutable-history",
    id: "immutable-history/package-changelog",
    paths: /(?:^|\/)CHANGELOG\.md$/u,
    reason:
      "Release-please owns changelog contents and they describe what shipped under the earlier name; editing them rewrites history.",
  },
  {
    category: "immutable-history",
    id: "immutable-history/mailmap",
    paths: /^\.mailmap$/u,
    reason:
      "Author identity mapping records addresses that existed at commit time and must keep matching the commit objects.",
  },
  {
    category: "physical-schema-identity",
    harvestsDatabaseIdentifiers: true,
    id: "physical-schema-identity/database-migrations",
    paths: /^turbo\/packages\/db\/src\/migrations\//u,
    reason:
      "Applied migrations and their Drizzle snapshots are the physical schema; they are append-only and define the relation, index, constraint, and column names the rest of the repository quotes.",
  },
  {
    category: "physical-schema-identity",
    id: "physical-schema-identity/database-identity-inventory",
    paths: /^turbo\/packages\/db\/scripts\/legacy-database-identity-/u,
    reason:
      "The database identity inventory, manifest, and test are the source-of-truth tooling for the same problem at the storage layer and #31813 must not modify them.",
  },
  {
    category: "desktop-identity",
    id: "desktop-identity/desktop-app",
    paths: /^turbo\/apps\/desktop\//u,
    reason:
      "Desktop keeps a supported Zero product identity during the Computer Use migration and rollback window, owned by #26364, #26368, and #26370.",
  },
  {
    category: "external-identity",
    id: "external-identity/infrastructure-automation",
    paths: /^(?:ansible|bin|docker|scripts|\.devcontainer)\//u,
    reason:
      "Provisioning, container, and operator scripts name deployed hosts, images, systemd units, and filesystem paths that only an infrastructure migration can rename.",
  },
  {
    category: "external-identity",
    id: "external-identity/ci-definitions",
    paths: /^\.github\//u,
    reason:
      "Workflow, action, and CI monitoring script names bind to deployed runners, repository secrets, and metric series that exist outside this repository.",
  },
  {
    category: "external-identity",
    id: "external-identity/cloudflare-deployment-manifest",
    paths: /(?:^|\/)wrangler\.jsonc?$/u,
    reason:
      "Worker names, routes, and R2 bucket names in a Wrangler manifest are deployed Cloudflare resources that a source rename cannot move.",
  },
] as const satisfies readonly ResidualBrandBoundaryFileRule[];

export const RESIDUAL_BRAND_BOUNDARY_OCCURRENCE_RULES = [
  {
    category: "physical-schema-identity",
    id: "physical-schema-identity/committed-migration-identifier",
    matchesDatabaseIdentifier: true,
    reason:
      "The name is a relation, index, constraint, trigger, function, or column identifier defined by a committed migration; renaming it is a database change owned by the legacy database identity manifest.",
  },
  {
    category: "physical-schema-identity",
    id: "physical-schema-identity/migration-file-name",
    reason:
      "Applied migration file names are recorded in the Drizzle journal and in the applied-migration table; renaming one re-runs or orphans a migration.",
    tokenPattern: /^\d{4}_[a-z0-9_]*(?:zero|vm0)[a-z0-9_]*$/u,
  },
  {
    category: "immutable-static-asset-key",
    id: "immutable-static-asset-key/platform-static-asset",
    line: /views\/zero-page\//u,
    reason:
      "static.vm0.io is append-only, so a published asset key can never be rewritten; only a new key beside it is possible.",
    tokens: ["zero-page"],
  },
  {
    category: "immutable-static-asset-key",
    id: "immutable-static-asset-key/content-addressed-asset",
    reason:
      "A content-hash suffix marks an already published append-only asset key; a rename would point at an object that does not exist.",
    tokenPattern: /^(?:vm0|zero)(?:-[a-z0-9]+)*-[0-9a-f]{12}$/u,
  },
  {
    before: /static\.vm0\.io\/$/u,
    category: "immutable-static-asset-key",
    id: "immutable-static-asset-key/static-asset-path",
    reason:
      "The first path segment of an append-only static.vm0.io URL is part of the published object key.",
    tokens: ["vm0"],
  },
  {
    after: /^\.(?:ai|io)(?![A-Za-z0-9])/u,
    category: "external-identity",
    id: "external-identity/brand-domain",
    reason:
      "vm0.ai and vm0.io are live domains behind production traffic, published links, and mail addresses.",
    tokens: ["VM0", "vm0"],
  },
  {
    before: /vm0-ai\/$/u,
    category: "external-identity",
    id: "external-identity/repository-slug",
    reason:
      "vm0-ai/vm0 is the GitHub repository path used by clones, links, and the API.",
    tokens: ["vm0"],
  },
  {
    category: "external-identity",
    id: "external-identity/github-organization",
    reason:
      "GitHub organization and repository slugs are external identities that a rename inside this repository cannot change.",
    tokenPattern:
      /^vm0-(?:ai|connectors|dev|e2e|marketing|skills|team-skills)(?:-\d+)?$/u,
  },
  {
    category: "external-identity",
    id: "external-identity/clerk-production-topology",
    reason:
      "The Clerk production instance origin is registered with Clerk and served to browsers; #31813 records it as an external identity.",
    tokens: ["VM0_CLERK_PRIMARY_APP_ORIGIN"],
  },
  {
    after: /^\/(?:default|large|test)(?![A-Za-z0-9])/u,
    category: "wire-and-persisted-value",
    id: "wire-and-persisted-value/runner-profile-and-model-id",
    reason:
      "vm0/default, vm0/large, and vm0/test are queued runner profiles and persisted model ids shared with supported Runner releases.",
    tokens: ["vm0"],
  },
  {
    category: "wire-and-persisted-value",
    id: "wire-and-persisted-value/brand-header",
    reason:
      "Branded request and response headers are read by deployed clients, workers, and callback senders.",
    tokenPattern: /^x-(?:vm0|zero)-[a-z0-9-]+$/iu,
  },
  {
    category: "wire-and-persisted-value",
    id: "wire-and-persisted-value/op-log-action-type",
    reason:
      "Dispatch action types are written to the persisted op log and queried operationally; R2 owns the operational-query decision that would allow renaming them.",
    tokenPattern:
      /^(?:api_dispatch_[a-z0-9_]*(?:zero|vm0)[a-z0-9_]*|(?:en|de)queue_zero_run)$/u,
  },
  {
    category: "wire-and-persisted-value",
    id: "wire-and-persisted-value/acquisition-attribution-parameter",
    reason:
      "Ad attribution parameters are emitted by live campaigns and persisted with the acquiring org; the campaign side cannot be redeployed retroactively.",
    tokens: [
      "vm0_ad_group_id",
      "vm0_campaign_id",
      "vm0_environment",
      "vm0_experiment",
      "vm0_source",
      "vm0_variant",
    ],
  },
  {
    category: "wire-and-persisted-value",
    id: "wire-and-persisted-value/credential-prefix",
    reason:
      "Issued credentials carry these prefixes for their whole lifetime and are matched by prefix when authenticating.",
    tokens: ["vm0_official_", "vm0_pat_", "vm0_sandbox_"],
  },
  {
    category: "wire-and-persisted-value",
    id: "wire-and-persisted-value/persisted-resource-id",
    reason:
      "Conflict codes, official workflow ids, and generation resource ids are persisted or returned to clients that match them literally.",
    tokens: ["vm0-illustration", "vm0-org-linked", "zapier-vm0-migration"],
  },
  {
    category: "wire-and-persisted-value",
    id: "wire-and-persisted-value/billing-status-key",
    paths: /^turbo\/packages\/api-contracts\/src\/contracts\/billing\.ts$/u,
    reason:
      "restrictedVm0Models is a response key in billingStatusResponseSchema that already-loaded browser code reads; the TypeScript vocabulary around it stays with R3.",
    tokens: ["restrictedVm0Models"],
  },
  {
    category: "persisted-artifact-provenance",
    id: "persisted-artifact-provenance/official-generation-marker",
    reason:
      "Generation services persist these provenance markers on stored artifacts and artifact-catalog.service.ts reads them back for artifacts that already exist.",
    tokenPattern:
      /^zero-(?:official-(?:image|video|voice|website)|joggai-avatar-video|internal-intro-video-(?:presenter|voice))$/u,
  },
  {
    category: "dual-brand-product-contract",
    id: "dual-brand-product-contract/public-brand-value",
    line: /\b(?:PUBLIC_BRANDS|PublicBrand|publicBrandSchema|publicBrand|public_brand|setupPublicBrand|setup_public_brand)\b/u,
    reason:
      "VM0 remains a supported public presentation brand, so the brand discriminator keeps both values until #27750 records the product decision.",
    tokens: ["VM0", "Vm0", "Zero", "vm0", "zero"],
  },
  {
    category: "dual-brand-product-contract",
    id: "dual-brand-product-contract/brand-presentation",
    line: /\b(?:assistantName|brandName|brandDisplayName|BRAND_NAME|brandContact|brandDomain|brandHost)\b/u,
    reason:
      "Brand presentation strings are the product surface the dual-brand contract exists to serve, and their tests assert the VM0 values.",
    tokens: ["VM0", "Vm0", "Zero", "vm0", "zero"],
  },
  {
    category: "protocol-compatibility",
    id: "protocol-compatibility/zero-host-domain",
    line: /ZERO_HOST_DOMAIN/u,
    reason:
      "The Zero host domain is served by the deployed host worker; #26701 and #28278 own retiring it and #31801 records its test value as an approved boundary.",
    tokens: ["zero-sites"],
  },
  {
    before: /\/api\/$/u,
    category: "protocol-compatibility",
    id: "protocol-compatibility/legacy-api-prefix",
    reason:
      "/api/zero/** stays routable for deployed CLI, Runner, and integration callers; #26701 and #28278 own its retirement.",
    tokens: ["zero"],
  },
  {
    category: "protocol-compatibility",
    id: "protocol-compatibility/zero-scope-environment",
    reason:
      "ZERO_* variables are read from deployed environments and Zero-scope tokens; renaming one is a deployment change owned by #26701 and #28278.",
    tokenPattern: /^ZERO_[A-Z0-9_]+$/u,
  },
  {
    category: "desktop-identity",
    id: "desktop-identity/desktop-product-line",
    reason:
      "Desktop product and update-line identities are matched by installed clients; #26364, #26368, and #26370 own the hard stop.",
    tokenPattern:
      /^(?:DESKTOP_[A-Z0-9_]*ZERO(?:_[A-Z0-9_]+)?|[Dd]esktopZero[A-Za-z0-9]*)$/u,
  },
  {
    category: "desktop-identity",
    id: "desktop-identity/desktop-bundle-id",
    line: /ai\.vm0\.zero\.desktop/u,
    reason:
      "The macOS and Windows bundle identifier is baked into installed applications and their update feeds.",
    tokens: ["vm0", "zero"],
  },
  {
    category: "semantic-non-brand",
    id: "semantic-non-brand/english-number-word",
    reason:
      "The name uses zero as the number, not as the brand, so a brand rename must leave it alone.",
    tokenPattern:
      /^(?:all-zero|leading-zero|near-zero|no-zero-fractions|non-?zero|non_?zero(?:_[a-z0-9_]+)?|zero-(?:amount|based|budget|cost|credit|filled|height|incident|length|lint|padded|price|quantity|row|size|sized|tolerance|width)|zero(?:Count|OrMore|OrOne)|isNegativeZero|zero100)$/iu,
  },
] as const satisfies readonly ResidualBrandBoundaryOccurrenceRule[];

export const RESIDUAL_BRAND_NAME_WORKSTREAMS = [
  {
    id: "R1",
    ownerIssue: "#31802",
    title: "Platform and UI stylesheet vocabulary",
  },
  {
    id: "R2",
    ownerIssue: "#31801",
    title: "API dispatch telemetry vocabulary",
  },
  {
    id: "R3",
    ownerIssue: "#31801",
    title: "Vm0 model and entitlement TypeScript vocabulary",
  },
  {
    id: "R4",
    ownerIssue: "#26877",
    title: "Legacy zero run vocabulary",
  },
  {
    id: "R5",
    ownerIssue: "#31801",
    title: "Production-code residual identifiers",
  },
  {
    id: "R6",
    ownerIssue: "#31801",
    title: "Test-only and fixture naming",
  },
  {
    id: "R7",
    ownerIssue: "#31801",
    title: "data-vm0-* DOM attributes",
  },
  {
    id: "R9",
    ownerIssue: "#31801",
    title: "Stale comments, prose, and bare brand literals",
  },
] as const satisfies readonly ResidualBrandNameWorkstream[];

type BaselineDisposition = Pick<
  ResidualBrandNameBaselineEntry,
  "ownerIssue" | "reason" | "workstream"
>;

function baselineNames(
  names: readonly string[],
  disposition: BaselineDisposition,
): readonly ResidualBrandNameBaselineEntry[] {
  return names.map((name) => {
    return { ...disposition, name };
  });
}

export const RESIDUAL_BRAND_NAME_BASELINE = [
  ...baselineNames(
    [
      "owf-diagram-node-zero",
      "owf-diagram-zero-icon",
      "vm0-main-stylesheet",
      "vm0-main-stylesheet-loader",
      "vm0-shadow-preview-root",
      "workflow-zero-left",
      "workflow-zero-size",
      "zero-block-pop",
      "zero-card",
      "zero-dialog-blur-in",
      "zero-dialog-content-in",
      "zero-dialog-content-out",
      "zero-dialog-overlay-in",
      "zero-dialog-overlay-out",
      "zero-locator-landed",
      "zero-nav-recent-label",
      "zero-realtime-status-reveal",
      "zero-shimmer",
      "zero-thinking-in",
      "zero-thinking-spinner-frame",
    ],
    {
      ownerIssue: "#31802",
      reason:
        "Platform and UI stylesheet vocabulary: class names, keyframes, and custom properties left behind by the #31802 design-token sweep, removable together with the rules that declare them.",
      workstream: "R1",
    },
  ),
  ...baselineNames(
    [
      "API_DISPATCH_ZERO_INTERNAL_ENTRYPOINT_ACTION_TYPES",
      "API_DISPATCH_ZERO_PRE_CREATE_ACTION_TYPES",
      "API_DISPATCH_ZERO_WEB_CHAT_PRE_CREATE_ACTION_TYPES",
    ],
    {
      ownerIssue: "#31801",
      reason:
        "TypeScript vocabulary around the dispatch telemetry action types; it is renameable without touching the persisted action strings, and R2 stays blocked until the operational-query decision is recorded.",
      workstream: "R2",
    },
  ),
  ...baselineNames(
    [
      "VM0ClerkProvider",
      "VM0_BDD_API_KEY_PREFIXES",
      "acquireBddVm0ApiKey",
      "buildVm0ApiKeys",
      "cn_preview_zero_usage_pack_removal",
      "delete-vm0-built-in-candidate-cooldown",
      "delete-vm0-built-in-model-key",
      "price_test_zero100",
      "releaseBddVm0ApiKey",
      "resolve-vm0-built-in-model-route",
      "restrictedVm0Models",
      "seed-vm0-built-in-default-model-key",
      "seed-vm0-built-in-model-candidate-keys",
      "seed-vm0-built-in-model-key",
      "seedZeroUsageEvents",
      "set-vm0-built-in-candidate-cooldown",
      "vm0-built-in",
      "vm0AllowanceActor",
      "vm0BuiltInModelActionResponse",
      "vm0BuiltInModelKeyFixture",
      "vm0BuiltInModelKeyFixtureLabel",
      "vm0BuiltInModelKeyFixtureLabelSchema",
      "vm0BuiltInModelKeyRows",
      "vm0Model",
      "vm0ModelKeyId",
      "vm0ModelProviderEnvironment",
      "vm0Policy",
      "vm0PrimaryCandidate",
      "vm0Provider",
      "vm0UsageCredits",
      "zero-built-in-generation",
      "zero-me-model-providers",
      "zero-model-providers",
      "zero-usage",
      "zeroUsageEvent",
    ],
    {
      ownerIssue: "#31801",
      reason:
        "Vm0 model, key, and entitlement TypeScript vocabulary; R3 renames it after R4 lands because both edit the same BDD test files.",
      workstream: "R3",
    },
  ),
  ...baselineNames(
    [
      "Zero-run",
      "conflictZeroRunId",
      "danglingZeroRunId",
      "goalZeroRunId",
      "zero-run",
      "zero-run-fixture",
      "zeroRunGoalId",
      "zeroRunGroupId",
      "zeroRunId",
      "zeroRunRows",
      "zeroRuns",
      "zero_runs-only",
      "zero_runs_",
    ],
    {
      ownerIssue: "#26877",
      reason:
        "Legacy zero run vocabulary in TypeScript identifiers, comments, and fixture strings; #26877 owns replacing it with agent run terminology.",
      workstream: "R4",
    },
  ),
  ...baselineNames(
    [
      "1-vm0",
      "PRODUCTION_VM0_AUTH_REDIRECT_ORIGINS",
      "RetiredZeroScopePayload",
      "SharedWorkerVM0State",
      "VM0-Cloud",
      "VM0-DEVICE",
      "VM0-brand",
      "VM0-hosted",
      "VM0-managed",
      "VM0-owned",
      "VM0-primary",
      "VM0ClerkBootstrap",
      "VM0ClerkBootstrapLoadOptions",
      "VM0Global",
      "VM0_APP_METADATA",
      "VM0_ONBOARDING_PATH",
      "VM0_PRODUCTION_DOMAIN",
      "VM0_SKILLS_REF",
      "VM0_SKILLS_REPO",
      "Vm0BrandMark",
      "ZERO_",
      "ZeroChatEventRowsPage",
      "ZeroChatEventSendResult",
      "ZeroChatEventSnapshotResult",
      "ZeroChatThreadCreateResult",
      "ZeroChatThreadEventsResult",
      "ZeroConnectorCatalogListResponse",
      "ZeroConnectorCatalogStatusResponse",
      "ZeroConnectorListResponse",
      "__VM0_CLERK_BROWSER_SCRIPT_URL__",
      "__VM0_CLERK_PRODUCTION_PRIMARY_APP_DOMAIN__",
      "__VM0_FIREWALL_BASE_URL_VALIDATION",
      "__vm0-dev-artifact-fetch",
      "__vm0ClerkBootstrap",
      "__vm0EventPayloadObjectKeyOrderV1",
      "__vm0PlausibleLoadScheduled",
      "__vm0UserFriendlyAutomationMessageV1",
      "_vm0",
      "_vm0Cursor",
      "acquisitionVm0Source",
      "agent_runs_workflow_automation_id_zero_workflow_automations_id_",
      "all-vm0",
      "archive_zero_workflows",
      "atelier-zero",
      "brand-from-zero",
      "buildVm0OnboardingEntryUrl",
      "buildZeroCreateAgentRunArgs",
      "checkpointZero",
      "createAgentRunAfterZeroPreCreate",
      "e2e-zero-bot",
      "idx_zero_",
      "isVm0Host",
      "loadZeroAgent",
      "measureZeroPreCreate",
      "platformVm0LogoDarkImg",
      "platformVm0LogoImg",
      "reconcileZeroBrowsersWithScope",
      "rt_VM0_PLACEHOLDER_DO_NOT_TRUST",
      "talk-to-zero",
      "vm0-api",
      "vm0-api-skill",
      "vm0-api-volume",
      "vm0-api-volume-validation",
      "vm0-artifact",
      "vm0-browser-profile",
      "vm0-chat",
      "vm0-clerk-core-script",
      "vm0-clerk-edge-session",
      "vm0-client-telemetry-prod",
      "vm0-data-export",
      "vm0-deck-metadata",
      "vm0-dev-artifact-fetch-proxy",
      "vm0-host",
      "vm0-key-anthropic",
      "vm0-key-default",
      "vm0-key-moonshot",
      "vm0-key-runtime-fixture",
      "vm0-migration-runner",
      "vm0-owned",
      "vm0-payment-method-portal-v1",
      "vm0-reddit-connector",
      "vm0-sandbox-op-log",
      "vm0-stage2-runner",
      "vm0-stored-secret",
      "vm0-stripe-connector",
      "vm0-style",
      "vm0-test",
      "vm0-traces",
      "vm0-user-linked",
      "vm0-uts46-16",
      "vm0-web-logs",
      "vm0-zero-maps",
      "vm01",
      "vm0Artifact",
      "vm0EditId",
      "vm0FileId",
      "vm0HappyDomIframeLoadPatched",
      "vm0HappyDomIframeNoisePatched",
      "vm0ImageStyleSource",
      "vm0NodeId",
      "vm0OriginalWrite",
      "vm0Preference",
      "vm0Run",
      "vm0RunId",
      "vm0Theme",
      "vm0Thread",
      "vm0ThreadId",
      "vm0_artifact_preview",
      "vm0_attribution",
      "vm0_browser_authorization_request",
      "vm0_column_",
      "vm0_computer_use_authorization_request",
      "vm0_computer_use_host",
      "vm0_computer_use_host_stopped",
      "vm0_e2e_bot",
      "vm0_error",
      "vm0_org_delete_at",
      "vm0_org_delete_org_id",
      "vm0_pat_xxxxx",
      "vm0_pi_api_first_turn_boundary",
      "vm0_result",
      "vm0_start",
      "vm0_table_",
      "vm0secret",
      "withoutLegacyZeroEntries",
      "ws_VM0_PLACEHOLDER_DO_NOT_TRUST",
      "zero-agent-name",
      "zero-attachment-url",
      "zero-chat",
      "zero-chat-composer",
      "zero-copy",
      "zero-design-color",
      "zero-install-banner-dismissed",
      "zero-intro-video-drafts",
      "zero-page",
      "zeroAgentId",
      "zeroBlock",
      "zeroDebug",
      "zeroDigest",
      "zeroHostDomain",
      "zeroOnly",
      "zeroResidual",
      "zero_",
      "zero_agent_schedules",
      "zero_browser",
      "zero_browser_profile",
      "zero_workflow_",
      "zero_workflow_agents",
      "zero_workflows_archive",
    ],
    {
      ownerIssue: "#31801",
      reason:
        "Production-code residual identifier that no boundary rule approves; R5 triages it against this classifier and either renames it or promotes it to a boundary rule with evidence.",
      workstream: "R5",
    },
  ),
  ...baselineNames(
    [
      "2Fzero",
      "ClaimedVm0Run",
      "VM0-AI",
      "VM0E2E0001",
      "VM0_INSTALL_STATE",
      "Vm0SignatureHeaders",
      "Zero-darwin-arm64-1",
      "Zero-token",
      "ZeroAgentEventsQuery",
      "ZeroNetworkLogsQuery",
      "adminZero",
      "api-test-lifecycle-zero",
      "api-test-zero",
      "api-test-zero-scoped-runtime-run",
      "api-test-zero-scoped-runtime-setup",
      "bdd-vm0-brand",
      "bdd-vm0-direct",
      "bdd-vm0-github-code",
      "buildFakeZeroJwt",
      "coupon_test_zero100",
      "createClaimedVm0Run",
      "createVm0Run",
      "createdOnVm0",
      "cs_zero100_",
      "customZero",
      "ii_zero_invite_",
      "in_zero_invite_",
      "in_zero_upgrade_",
      "in_zero_upgrade_lines_",
      "inv_zero_",
      "mem_zero_",
      "memberZero",
      "nZERO_PROFILE",
      "non-vm0",
      "not-a-zero-token",
      "official_zero_bot",
      "org-from-zero-token",
      "org_zero",
      "orphanZero",
      "releaseVm0DeepSeekKey",
      "run_zero",
      "run_zero_social_missing_capability",
      "run_zero_web_search_missing_capability",
      "seedZeroMembership",
      "sequenceZero",
      "sequenceZeroRow",
      "test-run-lifecycle-zero-scoped-runtime",
      "test-zero-token",
      "user_zero",
      "user_zero_",
      "user_zero_connectors_oauth_start_",
      "vm0-agent-run-events-dev",
      "vm0-agent-run-events-shared-test",
      "vm0-api-origin",
      "vm0-api-seeded-skill",
      "vm0-api-test",
      "vm0-api-test-other",
      "vm0-api-test-tarball",
      "vm0-backed",
      "vm0-bdd-garbage-host-token",
      "vm0-captured-request-body",
      "vm0-feishu-app-icon",
      "vm0-gmail-automation",
      "vm0-invite",
      "vm0-key-bdd-dev-seed",
      "vm0-key-bdd-fake",
      "vm0-pi-compaction-rpc",
      "vm0-pi-launch",
      "vm0-pi-retry-rpc",
      "vm0-pi-sandbox-first-rpc",
      "vm0-pi-settled-rpc",
      "vm0-pi-terra-handoff-rpc",
      "vm0-player",
      "vm0-request-log-shared-test",
      "vm0-run-context-shared-test",
      "vm0-sandbox-op-log-dev",
      "vm0-sandbox-telemetry-network-dev",
      "vm0-secrets-test",
      "vm0-test-chat-event-snapshots",
      "vm0-timing-secret-value",
      "vm0-timing-sensitive-ping",
      "vm0-udp-probe",
      "vm0-web-logs-dev",
      "vm0Actor",
      "vm0Agent",
      "vm0Body",
      "vm0Call",
      "vm0Callback",
      "vm0CallbackLocation",
      "vm0CallbackQuery",
      "vm0CiTest",
      "vm0Conflict",
      "vm0CreatedOnOkouApi",
      "vm0DriveClient",
      "vm0Email",
      "vm0EncodedState",
      "vm0Endpoint",
      "vm0Error",
      "vm0FallbackReturnUrl",
      "vm0Fixture",
      "vm0Guidance",
      "vm0HostHelp",
      "vm0HostHelpJson",
      "vm0Ingress",
      "vm0Install",
      "vm0Installation",
      "vm0Messages",
      "vm0Observation",
      "vm0Onboarding",
      "vm0Preview",
      "vm0PreviewCache",
      "vm0Prompt",
      "vm0Rejected",
      "vm0Replay",
      "vm0ReplayUrl",
      "vm0Response",
      "vm0RunDriveSync",
      "vm0RunToken",
      "vm0Send",
      "vm0Sent",
      "vm0SignatureHeaders",
      "vm0SignedState",
      "vm0Site",
      "vm0Snapshot",
      "vm0State",
      "vm0StateString",
      "vm0Update",
      "vm0UpdateQuery",
      "vm0_browser_authorization_request_",
      "vm0_browser_authorization_request_test",
      "vm0_computer_use_authorization_request_test",
      "vm0_computer_use_host_",
      "vm0_missing_db_instrumentation_table",
      "vm0_official_abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
      "vm0_official_credentials",
      "vm0_official_too-short",
      "vm0_pat_garbage",
      "vm0_pat_header",
      "vm0_pat_not-a-valid-jwt",
      "vm0_sandbox_a",
      "vm0_sandbox_e30",
      "vm0_sandbox_header",
      "vm0_sandbox_not-a-real-token",
      "vm0_sandbox_only-one-part",
      "vm0_test",
      "vm0unknown",
      "zero-default-agent",
      "zero-host",
      "zero-mail-code",
      "zero-mail-reconnect-code",
      "zero-mail-replacement-account-code",
      "zero-maps",
      "zero-org",
      "zero-proration",
      "zero-scoped",
      "zero-sites",
      "zero-size-timecode-scale",
      "zero-team",
      "zero-test-agent",
      "zero-token",
      "zero-workflow-automation-scheduler",
      "zero-workflow-automations",
      "zeroAdmin",
      "zeroAgentReadHeaders",
      "zeroBare",
      "zeroBareMe",
      "zeroBearer",
      "zeroBlueprintName",
      "zeroBudgetAutomation",
      "zeroCapabilityHeaders",
      "zeroCapabilityToken",
      "zeroDenied",
      "zeroHeaders",
      "zeroInstalled",
      "zeroMember",
      "zeroMocks",
      "zeroNetwork",
      "zeroOrphan",
      "zeroQueue",
      "zeroSandboxHeaders",
      "zeroWebSearch",
      "zeroWrite",
      "zeroWriteMe",
      "zeros",
      "zmmp-vm0-rejected",
      "zmp-vm0",
    ],
    {
      ownerIssue: "#31801",
      reason:
        "Test-only or fixture naming; R6 renames it once the production vocabulary it mirrors has moved.",
      workstream: "R6",
    },
  ),
  ...baselineNames(
    ["data-vm0-chat-message", "data-vm0-editable", "data-vm0-slide"],
    {
      ownerIssue: "#31801",
      reason:
        "data-vm0-* DOM attribute read by the platform, the app worker, or a test helper; R7 renames the attribute together with every reader.",
      workstream: "R7",
    },
  ),
  ...baselineNames(
    [
      "2Fvm0",
      "VM0",
      "VM0_ADDON_EVENT",
      "VM0_API_BACKEND_URL",
      "ZERO",
      "Zero",
      "__vm0ReactCommitProfiler",
      "routes-zero-a-g",
      "routes-zero-h-r",
      "routes-zero-s-z",
      "vm0",
      "vm0-exec",
      "vm0-measure-memory",
      "vm0-runner",
      "vm0-transition-validator",
      "vm0DesktopAuth",
      "vm0DesktopComputerUse",
      "vm0DraftId",
      "zero",
      "zero-connectors-oauth-start",
      "zero-email",
      "zero-image-io-generate",
      "zero-slack-browser-connect",
      "zero-slack-oauth",
      "zero-video-io-generate",
      "zero-voice-io-post",
      "zero-web-download",
      "zeroComputerUseRoutes",
      "zeroEmailCallbackRoutes",
      "zeroHostRoutes",
      "zeroMapsRoutes",
      "zero_workflow_triggers",
    ],
    {
      ownerIssue: "#31801",
      reason:
        "Bare brand literal or stale prose left in comments, documentation, and user-facing copy; R9 sweeps it and R5 or R6 pick up whatever the sweep proves is code.",
      workstream: "R9",
    },
  ),
  ...baselineNames(["data-vm0", "data-vm0-edit-id", "data-vm0-node-id"], {
    ownerIssue: "#31824",
    reason:
      "Legacy data-vm0-* edit-protocol reader kept for deck HTML that was stored or externally generated before the okou rename; #31824 drops it once no such deck remains.",
    workstream: "R7",
  }),
] as const satisfies readonly ResidualBrandNameBaselineEntry[];
