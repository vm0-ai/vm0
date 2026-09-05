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
    id: "out-of-scope/brand-name-classification-source",
    paths:
      /^(?:turbo\/packages\/eslint-rules\/scripts\/residual-brand-name-|docs\/residual-platform-brand-names\.md$)/u,
    reason:
      "The classifier, its baseline, and the #31816 classification this manifest consumes all quote every name they describe, so scanning them would make the guard satisfy itself.",
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
    id: "immutable-history/typecheck-memory-experiment-log",
    paths: /^turbo\/docs\/typecheck-memory-experiments\.md$/u,
    reason:
      "A dated measurement log. Every tsconfig chunk, route binding, and test file it quotes is the name that existed when the measurement ran, and the tsconfigs and CI jobs it names no longer exist; rewriting them would make each recorded number describe an experiment that was never run. The document states this in its own header note.",
  },
  {
    category: "immutable-history",
    id: "immutable-history/one-off-migration-runbook",
    paths: /^turbo\/packages\/db\/scripts\/migrations\/[^/]+\/README\.md$/u,
    reason:
      "A runbook for a one-off migration that has already been executed against production; it records the relations, columns, and counts that existed at execution time, so editing a name there falsifies the record of what ran.",
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

/**
 * Test suites, fixtures, mocks, and the e2e harness. #31883 scopes its rules to
 * this set so a name approved because a test asserts it stays approved only
 * where a test asserts it.
 */
const TEST_AND_FIXTURE_PATHS =
  /(?:^e2e\/|(?:^|\/)(?:__tests__|test-fixtures|mocks)\/|(?:^|\/)test-[^/]*\.ts$|\.(?:test|spec|suite)\.[cm]?tsx?$|\.bats$)/u;

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
    after: /^\.(?:AI|bot|dev|slack\.com|workers\.dev)(?![A-Za-z0-9])/u,
    category: "external-identity",
    id: "external-identity/brand-service-domain",
    reason:
      "vm0.bot is the production mail sending domain, vm0.dev and vm0.workers.dev are the deployed tunnel and Cloudflare preview origins, vm0.slack.com is the workspace, and VM0.AI is the live domain spelled inside an address; none of them moves when this repository changes.",
    tokens: ["VM0", "vm0"],
  },
  {
    after: /^\.(?:invalid|local|test)(?![A-Za-z0-9])/u,
    category: "external-identity",
    id: "external-identity/reserved-brand-hostname",
    reason:
      "RFC 2606 and RFC 6761 reserved names stand in for the deployed vm0 origins so host-derived brand, cookie, and redirect behaviour is exercised without reaching them; the fixture host carries the identity of the origin it represents and can only move with it.",
    tokens: ["vm0"],
  },
  {
    after: /^\.yaml(?![A-Za-z0-9])/u,
    category: "external-identity",
    id: "external-identity/compose-manifest-file-name",
    reason:
      "vm0.yaml is the compose manifest a user keeps in their own repository, so the file name is theirs and renaming the literal here only makes the guidance wrong.",
    tokens: ["vm0"],
  },
  {
    category: "external-identity",
    id: "external-identity/url-encoded-repository-slug",
    reason:
      "Trendshift indexes this repository under the percent-encoded vm0-ai%2Fvm0 path, so the badge label resolves against their service rather than against anything here.",
    tokens: ["2Fvm0"],
  },
  {
    category: "external-identity",
    id: "external-identity/secret-manager-vault-path",
    line: /\bop:\/\//u,
    reason:
      "A 1Password op:// reference names an item in the shared developer vault; the path exists outside this repository and a source edit only breaks the lookup.",
    tokens: ["vm0"],
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
    id: "external-identity/external-tool-identifier",
    reason:
      "The linter defines no-zero-fractions and Cloudflare serves zero-design-color.sites.vm0.io, so a source edit renames nothing and only disables the rule or breaks the link.",
    tokens: ["no-zero-fractions", "zero-design-color"],
  },
  {
    category: "external-identity",
    id: "external-identity/mermaid-lite-published-version",
    paths: /^turbo\/packages\/mermaid-lite\/package\.json$/u,
    reason:
      "11.16.1-vm0.3 identifies the already published Mermaid-derived build. A source-only rename would claim a package version that was never published and break consumers that select the exact version identity.",
    tokens: ["1-vm0"],
  },
  {
    category: "external-identity",
    id: "external-identity/slack-channel-name",
    paths: /^turbo\/apps\/platform\/src\/views\/okou-page\/ideation-data\.ts$/u,
    reason:
      "#all-vm0 is the existing Slack channel named in the workflow prompt. Slack owns that channel identity, so changing the prompt token without renaming the channel makes the generated workflow post to a destination that does not exist.",
    tokens: ["all-vm0"],
  },
  {
    category: "external-identity",
    id: "external-identity/developer-container-hostname",
    paths: /^turbo\/scripts\/test-rebuild-snapshot\.sh$/u,
    reason:
      "vm01 is the developer-container hostname and /workspaces/vm01 mount selected by this operator script, matching the same externally configured hostname used by the root dcvnc and dcpf helpers. Renaming only this reference makes the script change into a directory that is not mounted.",
    tokens: ["vm01"],
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
    after: /^\.(?:db|pg)\.[a-z]/u,
    category: "wire-and-persisted-value",
    id: "wire-and-persisted-value/database-telemetry-attribute",
    reason:
      "vm0.db.* are OpenTelemetry span attribute names already ingested by Axiom and vm0.pg.pool-query-span is the context key carrying them; renaming one silently empties every saved query, dashboard, and alert built on the field.",
    tokens: ["vm0"],
  },
  {
    after: /^\.pi-memory\./u,
    category: "wire-and-persisted-value",
    id: "wire-and-persisted-value/pi-memory-archive-key",
    reason:
      "The Pi memory phase-2 manifest and selection keys are written into stored archives, so a reader has to keep matching the key already on disk.",
    tokens: ["vm0"],
  },
  {
    after: /^\.(?:adAttribution|authV2\.|googleAds|signupAttributionRecorded)/u,
    category: "wire-and-persisted-value",
    id: "wire-and-persisted-value/browser-storage-key",
    reason:
      "These are localStorage keys held on the user's own device; renaming one strands the attribution, conversion, and resend-cooldown state it holds, the same failure docs/residual-platform-brand-names.md records for the zero-* persisted keys.",
    tokens: ["vm0"],
  },
  {
    category: "wire-and-persisted-value",
    id: "wire-and-persisted-value/client-persisted-identity",
    reason:
      "The name is an IndexedDB database or localStorage key held on the user's own device, so a rename silently strands the state it holds; docs/residual-platform-brand-names.md records the decision and the removal gate for each.",
    tokens: ["zero-install-banner-dismissed", "zero-intro-video-drafts"],
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
    id: "wire-and-persisted-value/google-drive-artifact-app-properties",
    paths:
      /^turbo\/apps\/api\/src\/signals\/(?:services\/google-drive-artifact-sync\.service\.ts|routes\/__tests__\/(?:chat-threads\.bdd|integrations-slack-upload-complete)\.test\.ts)$/u,
    reason:
      "vm0Artifact, vm0ThreadId, vm0RunId, and vm0FileId are appProperties keys written onto files in users' Google Drive accounts. Artifact status lookup queries the first two keys and reads the latter two to recover each run/file pair. Those files live outside every system this repository can migrate, so changing any key makes every previously synced artifact unfindable and causes the sync to upload duplicates; the route tests deliberately spell the persisted keys to prove compatibility with files written by earlier deploys.",
    tokens: ["vm0Artifact", "vm0FileId", "vm0RunId", "vm0ThreadId"],
  },
  {
    category: "wire-and-persisted-value",
    id: "wire-and-persisted-value/design-system-resource-id",
    paths: /^turbo\/packages\/core\/src\/resource-registry\.ts$/u,
    reason:
      "atelier-zero is both the persisted design-system:atelier-zero identifier and its published design-systems/atelier-zero source path. Existing resource selections and the published asset cannot be rewritten by changing this registry, so both identity segments must remain exact.",
    tokens: ["atelier-zero"],
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
    category: "dual-brand-product-contract",
    id: "dual-brand-product-contract/vm0-brand-mark-component",
    paths:
      /^turbo\/apps\/platform\/src\/views\/components\/product-brand-mark\.tsx$/u,
    reason:
      "Vm0BrandMark is the VM0 half of ProductBrandMark's live two-brand branch, paired with the Okou wordmark path selected when brandName is not VM0. Its brand discriminator is intentional while VM0 remains supported.",
    tokens: ["Vm0BrandMark"],
  },
  {
    category: "dual-brand-product-contract",
    id: "dual-brand-product-contract/vm0-logo-assets",
    paths: /^turbo\/apps\/platform\/src\//u,
    reason:
      "platformVm0LogoImg and platformVm0LogoDarkImg point specifically at the VM0 logo asset files and are selected only for VM0 presentation surfaces. Dropping the discriminator would obscure which live brand asset each constant carries rather than retire a stale prefix.",
    tokens: ["platformVm0LogoDarkImg", "platformVm0LogoImg"],
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
    category: "protocol-compatibility",
    id: "protocol-compatibility/retired-zero-scope-payload",
    paths: /^turbo\/apps\/api\/src\/signals\/auth\/tokens\.ts$/u,
    reason:
      "RetiredZeroScopePayload names the exact retired zero token-scope shape that the test signer keeps reachable so verification can reject legacy tokens. #26701 owns removing that protocol compatibility object; renaming it ahead of the scope would hide what compatibility path the type represents.",
    tokens: ["RetiredZeroScopePayload"],
  },
  {
    category: "protocol-compatibility",
    id: "protocol-compatibility/zero-host-domain-property",
    paths: /^turbo\/apps\/platform\/src\/lib\/platform-host\.ts$/u,
    reason:
      "zeroHostDomain carries the deployed sites.vm0.io or sites.vm7.io value corresponding to the ZERO_HOST_DOMAIN protocol contract. #26701 and #28278 own retiring that host contract, so the property keeps naming the compatibility value until the protocol is removed.",
    tokens: ["zeroHostDomain"],
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
      /^(?:all-zero|leading-zero|near-zero|non-?zero|non_?zero(?:_[a-z0-9_]+)?|zero-(?:amount|based|budget|cost|credit|filled|height|incident|length|lint|padded|price|quantity|row|size|sized|tolerance|width)|zero-usage|zero(?:Count|OrMore|OrOne)|isNegativeZero|zero100)$/iu,
  },
  {
    category: "semantic-non-brand",
    id: "semantic-non-brand/numeric-zero-identifiers",
    reason:
      "zeroBlock tests that every byte in a tar block equals numeric 0, while checkpointZero records a scheduler checkpoint at the unchanged previous boundary so its measured duration is zero. In both identifiers Zero is the number, not the retired product name.",
    tokens: ["checkpointZero", "zeroBlock"],
  },
  {
    category: "semantic-non-brand",
    id: "semantic-non-brand/english-zero-phrases",
    reason:
      "zero-copy is the established English term for transferring ownership without copying bytes, and brand-from-zero means building a brand from scratch in an image-style description. Neither phrase uses Zero as a product name.",
    tokens: ["brand-from-zero", "zero-copy"],
  },
  {
    after:
      /^\s+(?:NULLs|additional|arguments|audio|balance|blocking|candidates|chunks|commits|creditExpiry|credits|delay|duration|elapsed|fill|final|for|items|legacy|lint|mutation|or\s+more|org\s+credits|outbound|props|remaining|rows|segments|state|tolerance|unresolved|visible|warnings)(?![A-Za-z0-9_-])/u,
    category: "semantic-non-brand",
    id: "semantic-non-brand/english-number-quantity",
    reason:
      "The word counts the noun that follows it — zero rows, zero credits, zero segments, zero lint warnings — so it is the numeral and a brand rename must leave it alone. The list is closed on purpose: nouns the brand also takes, such as token, scope, capability, and Desktop, are deliberately absent.",
    tokens: ["zero"],
  },
  {
    after: /^\s+(?:Lint|Tolerance|lint|tolerance)(?![A-Za-z0-9_-])/u,
    category: "semantic-non-brand",
    id: "semantic-non-brand/english-number-heading",
    reason:
      "Title-cased headings and bullets in the contributor guides say Zero Tolerance and Zero Lint; the capital is sentence casing of the numeral, not the assistant.",
    tokens: ["Zero"],
  },
  {
    before:
      /\b(?:budget|charged|count\s+to|drop\s+to|drops\s+to|fell\s+to|mean|means|reach|reached|reaches|sequence|than|toward|towards|values\s+to|was)\s+$/u,
    category: "semantic-non-brand",
    id: "semantic-non-brand/english-number-terminal",
    reason:
      "The word is the quantity a verb or comparison lands on — reaches zero, fell to zero, greater than zero — with no noun after it to key on, so the preceding phrase is what identifies the numeral.",
    tokens: ["zero"],
  },
  {
    before: /\b(?:da|do)\s+$/u,
    category: "semantic-non-brand",
    id: "semantic-non-brand/translated-number-word",
    reason:
      "Italian da zero and Portuguese do zero mean from scratch in the translated onboarding copy; the word is the numeral in those locales and is not the brand at all.",
    tokens: ["zero"],
  },
  {
    category: "semantic-non-brand",
    id: "semantic-non-brand/cardinality-enum-value",
    line: /Cardinality\b/u,
    reason:
      "The connector selection cardinality enum spells its counts zero, one, and multiple; the member is the numeral in a three-value set.",
    tokens: ["zero"],
  },
  {
    category: "semantic-non-brand",
    id: "semantic-non-brand/book-title",
    line: /\bZERO TO ONE\b/u,
    reason:
      "Zero to One is the book title inside an image-generation prompt fixture, so the word is the numeral in a quoted phrase.",
    tokens: ["ZERO"],
  },
  {
    category: "external-identity",
    id: "external-identity/runner-host-filesystem-identity",
    reason:
      "vm0-runner names the /etc and /var/lib directories and the systemd unit prefix the Ansible playbooks manage on deployed hosts, and vm0-exec is the /sys/fs/cgroup hierarchy crates/guest-contracts pins; both are renamed by an infrastructure migration, never by a source edit.",
    tokens: ["vm0-exec", "vm0-runner"],
  },
  {
    category: "wire-and-persisted-value",
    id: "wire-and-persisted-value/addon-event-envelope",
    reason:
      "VM0_ADDON_EVENT is the line prefix the mitmproxy addon writes to stderr and crates/runner parses back; the two processes ship separately, so the prefix is a wire contract between them.",
    tokens: ["VM0_ADDON_EVENT"],
  },
  {
    after: /^:non-transactional(?![A-Za-z0-9-])/u,
    category: "wire-and-persisted-value",
    id: "wire-and-persisted-value/migration-directive-marker",
    reason:
      "-- vm0:non-transactional is read out of committed migration SQL by the migration runner to decide whether to open a transaction; the marker text is part of files that have already been applied.",
    tokens: ["vm0"],
  },
  {
    after: /^:[a-z0-9-]+(?:[:.][a-z0-9-]+)*(?![A-Za-z0-9])/u,
    category: "wire-and-persisted-value",
    id: "wire-and-persisted-value/namespaced-key",
    reason:
      "A vm0: prefixed key outlives the deploy that writes it: a versioned localStorage entry on the user's own device, a window event name already-loaded page code is still listening for, or the domain-separation prefix an applied migration hashed into a fingerprint that its verification script has to reproduce byte for byte. Renaming either side of one of these silently splits the pair instead of failing.",
    tokens: ["vm0"],
  },
  {
    before: /static\\?\.vm0\\?\.io\\?\/$/u,
    category: "immutable-static-asset-key",
    id: "immutable-static-asset-key/static-asset-path-pattern",
    reason:
      "The same first path segment of an append-only static.vm0.io object key, written with the escapes a regular expression literal needs; the pattern has to keep matching keys that are already published.",
    tokens: ["vm0"],
  },
  {
    before: /["'`]\.$/u,
    category: "external-identity",
    id: "external-identity/dot-vm0-directory",
    reason:
      "A .vm0 directory is owned outside this package: ~/.vm0 is the guest-agent workspace crates/guest-agent creates in the sandbox and excludes from artifact archives, and .vm0/official-workflow-definition.json is the manifest path an official workflow repository publishes. Both are read by name from somewhere this repository cannot edit.",
    tokens: ["vm0"],
  },
  {
    category: "desktop-identity",
    id: "desktop-identity/desktop-preload-global",
    reason:
      "vm0DesktopAuth and vm0DesktopComputerUse are the contextBridge globals turbo/apps/desktop exposes to the renderer; the desktop app is a desktop-identity boundary and the testing guide only names what it exposes.",
    tokens: ["vm0DesktopAuth", "vm0DesktopComputerUse"],
  },
  {
    category: "protocol-compatibility",
    id: "protocol-compatibility/legacy-backend-url-variable",
    reason:
      "VM0_API_BACKEND_URL is the legacy environment variable the migration note exists to record; the document names it precisely so operators can recognise the contract that is being retired, and #26701 and #28278 own the cutoff.",
    tokens: ["VM0_API_BACKEND_URL"],
  },
  {
    category: "external-identity",
    id: "external-identity/api-service-deployment-identity",
    reason:
      "vm0-api is the API service's identity in three places outside this repository: the OpenTelemetry service.name and tracer name every span Axiom has already ingested is filed under, the Vercel project slug in the log URL e2e/helpers/runner-chat.bash prints, and the vm0-api.vm6.ai internal origin lib/internal-api-url.ts dials. None of the three moves when this repository changes.",
    tokens: ["vm0-api"],
  },
  {
    category: "external-identity",
    id: "external-identity/design-file-slug",
    reason:
      "VM0-Cloud is the title segment of the Figma design file URL the UI package README and its stylesheet header cite; the file lives in Figma and the segment only resolves against their service.",
    tokens: ["VM0-Cloud"],
  },
  {
    category: "external-identity",
    id: "external-identity/axiom-dataset",
    reason:
      "Axiom datasets are provisioned in Axiom, not here. vm0-traces, vm0-web-logs, vm0-sandbox-op-log, and vm0-client-telemetry-prod are the names ingestion writes to and every saved query, dashboard, and monitor reads from, so renaming one starts writing to a dataset that does not exist and leaves the recorded history stranded under the old name.",
    tokens: [
      "vm0-client-telemetry-prod",
      "vm0-sandbox-op-log",
      "vm0-traces",
      "vm0-web-logs",
    ],
  },
  {
    category: "external-identity",
    id: "external-identity/third-party-client-identity",
    reason:
      "Each name identifies this client to a third party that keys behaviour on it: web:vm0-reddit-connector:v1.0 is the User-Agent Reddit's API terms require and rate-limit by, vm0-stripe-connector is the device name the CLI authorization flow registers on the Stripe account, and vm0-zero-maps/1.0 is the User-Agent the OpenStreetMap usage policy requires. Changing one re-identifies this client to a service that has already recorded the old value.",
    tokens: ["vm0-reddit-connector", "vm0-stripe-connector", "vm0-zero-maps"],
  },
  {
    category: "external-identity",
    id: "external-identity/skills-repository-source",
    reason:
      "VM0_SKILLS_REPO holds vm0-ai/vm0-skills and VM0_SKILLS_REF holds the ref the resource registry fetches video templates and illustration styles from. The repository is a GitHub identity this repository cannot rename, so the constants keep naming what they point at.",
    tokens: ["VM0_SKILLS_REF", "VM0_SKILLS_REPO"],
  },
  {
    category: "wire-and-persisted-value",
    id: "wire-and-persisted-value/stored-secret-kms-encryption-context",
    reason:
      "vm0-stored-secret is the purpose field of KMS_ENCRYPTION_CONTEXT, the KMS encryption context passed to every stored-secret encrypt and decrypt. Encryption context is authenticated additional data, so KMS fails a decrypt whose context does not match the one used to encrypt. Changing this string makes every stored secret already in the database undecryptable, including the custom-connector credentials the executed 012 backfill wrote with the identical constant. It cannot be renamed at all, only retired by re-encrypting every ciphertext under a new context.",
    tokens: ["vm0-stored-secret"],
  },
  {
    category: "wire-and-persisted-value",
    id: "wire-and-persisted-value/stored-secret-envelope-prefix",
    reason:
      "vm0secret:v1: is the literal prefix every stored-secret envelope already in the database begins with, and decodeStoredSecretEnvelope refuses a value that does not start with it. The API service, its encryption test helper, and the executed 012 backfill each pin the same prefix, so a rename strands the stored ciphertexts rather than failing loudly.",
    tokens: ["vm0secret"],
  },
  {
    category: "wire-and-persisted-value",
    id: "wire-and-persisted-value/browser-cookie-name",
    reason:
      "vm0_artifact_preview is the artifact-preview WAF cookie and vm0_attribution is the acquisition attribution cookie. Both are already set in browsers this deploy cannot reach, and the reader only ever sees the name the writer used when it set them.",
    tokens: ["vm0_artifact_preview", "vm0_attribution"],
  },
  {
    category: "wire-and-persisted-value",
    id: "wire-and-persisted-value/authorization-request-url-prefix",
    reason:
      "The browser and Computer Use authorization services build their authorization URLs from these prefixes, so the prefix is part of every link already handed to a user or an agent run and is matched again when that link is opened.",
    tokens: [
      "vm0_browser_authorization_request",
      "vm0_computer_use_authorization_request",
    ],
  },
  {
    category: "wire-and-persisted-value",
    id: "wire-and-persisted-value/opaque-token-prefix",
    reason:
      "generateOpaqueToken bakes these prefixes into the Computer Use host tokens it issues, and computer-use.bdd.test.ts asserts an issued token matches /^vm0_computer_use_host_/. An issued token carries its prefix for its whole lifetime and the stopped-host token is stored only as a hash, so neither can be rewritten after the fact.",
    tokens: ["vm0_computer_use_host", "vm0_computer_use_host_stopped"],
  },
  {
    category: "wire-and-persisted-value",
    id: "wire-and-persisted-value/stripe-metadata-key",
    reason:
      "vm0_org_delete_at and vm0_org_delete_org_id are metadata keys written onto Stripe objects. Stripe holds the key names, the org-deletion billing service reads them back from objects earlier deploys created, and a rename silently stops matching the metadata already stored there.",
    tokens: ["vm0_org_delete_at", "vm0_org_delete_org_id"],
  },
  {
    category: "wire-and-persisted-value",
    id: "wire-and-persisted-value/stripe-idempotency-key",
    reason:
      "vm0-payment-method-portal-v1 is the idempotency key for creating the payment-method billing portal configuration. Stripe deduplicates against the key it has already recorded, so changing the string makes the create call execute a second time and produce a duplicate configuration instead of returning the existing one.",
    tokens: ["vm0-payment-method-portal-v1"],
  },
  {
    category: "wire-and-persisted-value",
    id: "wire-and-persisted-value/documented-credential-format",
    reason:
      "The cli_tokens.token column comment shows the shape of the values the column already holds, and vm0_pat_ is an approved credential prefix issued tokens keep for life. Rewriting the example would describe a token format that was never issued.",
    tokens: ["vm0_pat_xxxxx"],
  },
  {
    category: "wire-and-persisted-value",
    id: "wire-and-persisted-value/pi-handoff-control-record",
    reason:
      "vm0_pi_api_first_turn_boundary is the control-record type the CLI's Pi agent loop emits and crates/guest-agent recognises by string comparison. The guest agent ships inside sandbox images built and rolled out separately from the CLI, so the two sides cannot change the literal in the same deploy.",
    tokens: ["vm0_pi_api_first_turn_boundary"],
  },
  {
    category: "wire-and-persisted-value",
    id: "wire-and-persisted-value/firewall-hostname-policy-version",
    reason:
      "vm0-uts46-16.0-v1 is FIREWALL_HOSTNAME_POLICY_VERSION, the identity of the hostname policy the API applies before firewall values cross to a runner. It is recorded in the committed base-URL validation contract and quoted in the rejection messages callers receive, and the constant's own documentation says the version changes only after a deliberate Unicode-data and runner-compatibility review.",
    tokens: ["vm0-uts46-16"],
  },
  {
    category: "wire-and-persisted-value",
    id: "wire-and-persisted-value/external-workspace-folder-name",
    reason:
      "vm0-artifact is the Drive root folder name the artifact sync resolves by name in the user's own Google Drive before creating it. Those folders already exist in accounts this repository cannot edit, so a rename starts a second folder tree beside the one holding every artifact synced so far.",
    tokens: ["vm0-artifact"],
  },
  {
    category: "wire-and-persisted-value",
    id: "wire-and-persisted-value/browser-provider-profile-name",
    reason:
      "vm0-browser-profile-<threadId> is the profile name created in the Browser Use provider's own records. The provider holds every profile already created under that name and this repository cannot rewrite them, so a rename splits the operator-visible profile list across two names.",
    tokens: ["vm0-browser-profile"],
  },
  {
    category: "wire-and-persisted-value",
    id: "wire-and-persisted-value/chat-offline-database-name",
    reason:
      "vm0-chat-<userId>-<orgId> is the IndexedDB database name held on the user's own device. Renaming it opens an empty database beside the one holding the cached chat history, the same failure docs/residual-platform-brand-names.md records for the zero-* persisted keys.",
    tokens: ["vm0-chat"],
  },
  {
    category: "wire-and-persisted-value",
    id: "wire-and-persisted-value/renamed-feature-switch-key",
    paths: /^turbo\/packages\/db\/scripts\//u,
    reason:
      "zeroDebug is the feature-switch key stored in the user_feature_switches JSONB column before migration 0977 renamed it. The verification script seeds the literal legacy key so the rename has something to rewrite; changing it there would make the script verify a migration path production never took.",
    tokens: ["zeroDebug"],
  },
  {
    category: "dual-brand-product-contract",
    id: "dual-brand-product-contract/brand-scoped-constant",
    reason:
      "Each constant holds the VM0 brand's own value beside an Okou counterpart in the same file: VM0_APP_METADATA next to OKOU_APP_METADATA, VM0_PRODUCTION_DOMAIN next to OKOU_PRODUCTION_DOMAIN, and PRODUCTION_VM0_AUTH_REDIRECT_ORIGINS next to the okou.ai satellite redirect pattern. The VM0 in the name is the brand discriminator that makes the pair readable, and VM0 stays a supported public presentation brand until #27750 records the product decision.",
    tokens: [
      "PRODUCTION_VM0_AUTH_REDIRECT_ORIGINS",
      "VM0_APP_METADATA",
      "VM0_PRODUCTION_DOMAIN",
    ],
  },
  {
    category: "dual-brand-product-contract",
    id: "dual-brand-product-contract/brand-selected-literal",
    reason:
      "vm0-data-export.zip is the filename dataExportFilename returns for the vm0 public brand, chosen against okou-data-export.zip on the line above it; it is the VM0 half of a brand-selected pair rather than a name left behind.",
    tokens: ["vm0-data-export"],
  },
  {
    category: "dual-brand-product-contract",
    id: "dual-brand-product-contract/hyphenated-brand-adjective",
    reason:
      "The supported brand word used as an adjective in prose and contract documentation: a VM0-hosted file, a VM0-managed guest directory, a vm0-owned type or host, the VM0-brand hosted site, the VM0-primary Clerk branch, vm0-style illustrations. Each reads correctly while VM0 remains a supported public presentation brand and retires with the brand rather than ahead of it, exactly as the bare brand word does.",
    tokens: [
      "VM0-brand",
      "VM0-hosted",
      "VM0-managed",
      "VM0-owned",
      "VM0-primary",
      "vm0-owned",
      "vm0-style",
    ],
  },
  {
    category: "protocol-compatibility",
    id: "protocol-compatibility/zero-scope-environment-prefix",
    reason:
      'ZERO_ is the prefix itself rather than one variable. agent-run-create.service.ts and the agent execution plan match key.startsWith("ZERO_") against environments and stored run templates that deployed clients wrote, and the cutover notes name the ZERO_* family so operators can recognise it. The prefix retires with those variables under #26701 and #28278.',
    tokens: ["ZERO_"],
  },
  {
    category: "wire-and-persisted-value",
    id: "wire-and-persisted-value/connector-scope-source",
    reason:
      "zero_agent is an emitted API dispatch telemetry value for connector-scope provenance. Existing traces and operational queries read the stored value, so changing it requires a telemetry-contract migration rather than a source-only rename.",
    tokens: ["zero_agent"],
  },
  {
    category: "immutable-history",
    id: "immutable-history/retired-run-event-name",
    line: /replaces vm0_start\/vm0_result\/vm0_error events/u,
    paths: /^turbo\/packages\/api-contracts\/src\/contracts\/runs\.ts$/u,
    reason:
      "The run-state schema comment names the three run events it replaced. Those events are retired and were never re-emitted under another name, so rewriting the note would claim the schema replaced something that never existed.",
    tokens: ["vm0_error", "vm0_result", "vm0_start"],
  },
  {
    category: "immutable-history",
    id: "immutable-history/executed-migration-script",
    paths: /^turbo\/packages\/db\/scripts\/migrations\/[^/]+\//u,
    reason:
      "A one-off migration script that has already been executed against production; its source is the record of what ran, for the same reason the README beside it is one. The named columns and relations were the physical identities those scripts read or wrote when they ran.",
    tokens: [
      "acquisition_vm0_source",
      "zeroAgentId",
      "zero_agents",
      "zero_runs",
      "zero_workflows",
    ],
  },
  {
    category: "physical-schema-identity",
    id: "physical-schema-identity/legacy-relation-name-prefix",
    paths: /^turbo\/packages\/db\/scripts\//u,
    reason:
      "idx_zero_, zero_, and zero_workflow_ are the prefixes of physical index, primary key, check, and relation names committed migrations created. The workflow compatibility script derives each canonical name by stripping the prefix and counts RENAME statements by matching it, so the literal has to keep spelling the identifiers that are in the database.",
    tokens: ["idx_zero_", "zero_", "zero_workflow_"],
  },
  {
    category: "physical-schema-identity",
    id: "physical-schema-identity/legacy-relation-name",
    paths: /^turbo\/packages\/db\/scripts\//u,
    reason:
      "Each is a physical name a committed migration created: the zero_agent_schedules relation the executed 006 cleanup deletes from, the zero_workflow_agents relation the executed 007 backfill records as dropped, the agent_runs_workflow_automation_id_zero_workflow_automations_id_ foreign key the stage-2 scripts assert on, and archive_zero_workflows and zero_workflows_archive, deliberate near-miss spellings of zero_workflows inside a probe routine that exists to prove the catalog scanner does not match them.",
    tokens: [
      "agent_runs_workflow_automation_id_zero_workflow_automations_id_",
      "archive_zero_workflows",
      "zero_agent_schedules",
      "zero_workflow_agents",
      "zero_workflows_archive",
    ],
  },
  {
    category: "physical-schema-identity",
    id: "physical-schema-identity/retired-database-contract",
    paths:
      /^(?:turbo\/packages\/db\/scripts\/(?:test-agent-run-built-in-model-key-permanent|test-migration-consistency-schema|test-org-metadata-acquisition-first-party-source-permanent|test-org-plan-entitlement-restriction-permanent)\.ts|turbo\/packages\/db\/src\/__tests__\/agent-run-schema\.test\.ts)$/u,
    reason:
      "Permanent database validators name these retired relations, indexes, triggers, and columns to prove they stay absent from the canonical schema and its live readers. Rewriting an expected historical identity would stop the validator from checking the object that production actually retired.",
    tokens: [
      "acquisition_vm0_source",
      "idx_zero_runs_chat_thread_id",
      "idx_zero_runs_goal",
      "idx_zero_runs_workflow_automation",
      "restricted_vm0_models",
      "sync_zero_run_metadata_to_agent_runs",
      "vm0_model_key_id",
      "zero_runs",
      "zero_runs_pkey",
    ],
  },
  {
    category: "physical-schema-identity",
    id: "physical-schema-identity/retired-relation-source-guard",
    paths:
      /^turbo\/apps\/api\/src\/signals\/services\/__tests__\/agent-draft-write\.service\.test\.ts$/u,
    reason:
      "The test names the retired zero_agent_drafts relation in a negative source assertion so runtime writers cannot accidentally reintroduce relation-specific compatibility SQL.",
    tokens: ["zero_agent_drafts"],
  },
  {
    category: "physical-schema-identity",
    id: "physical-schema-identity/legacy-column-property-mirror",
    paths: /^turbo\/packages\/db\/scripts\//u,
    reason:
      'acquisitionVm0Source is the Drizzle property for the physical column acquisition_vm0_source in the previous-release schema the first-party-source expansion script pins, and that script asserts the executed 011 backfill still contains the literal ["vm0_source", "acquisitionVm0Source"] while no application file matches it. The column is still the legacy half of the expand/contract, so the property has to keep naming it.',
    tokens: ["acquisitionVm0Source"],
  },
  {
    category: "physical-schema-identity",
    id: "physical-schema-identity/legacy-relation-result-alias",
    paths: /^turbo\/packages\/db\/scripts\//u,
    reason:
      "zeroDigest and zeroOnly are result-set aliases for values computed from the physical relation zero_runs: the digest of its rows and the count of rows present only in it. #31819 records that a local name whose SQL genuinely targets zero_runs keeps its name, because renaming it would make the code read as though it targeted the canonical table.",
    tokens: ["zeroDigest", "zeroOnly"],
  },
  {
    category: "semantic-non-brand",
    id: "semantic-non-brand/synthetic-sql-placeholder",
    paths: /^turbo\/packages\/eslint-rules\/src\//u,
    reason:
      'prefer-drizzle-apis substitutes "vm0_table_<n>" and "vm0_column_<n>" into a SQL template before parsing it, then recognises them again by /^vm0_table_\\d+$/ and /^vm0_column_\\d+$/ in the parse tree. The prefix is a reserved namespace whose only job is to be a spelling no real relation or column uses — a collision would make the rule approve an expression it never checked — so it is not the brand used as a name. Nothing outside this file observes it, and renaming the writer and both readers together would change no behaviour.',
    tokens: ["vm0_column_", "vm0_table_"],
  },
  {
    category: "immutable-history",
    id: "immutable-history/retired-route-test-reference",
    paths: TEST_AND_FIXTURE_PATHS,
    reason:
      "Each name is a deleted route test file quoted by the BDD suite that replaced it: host-maps.bdd.test.ts records zero-host.test.ts and zero-maps.test.ts, org-team.bdd.test.ts records zero-org*, zero-team, and zero-default-agent plus the zero-maps precedent it reuses, and run-cron.bdd.test.ts points at zero-workflow-automations.test.ts and zero-workflow-automation-scheduler.test.ts. Those files carried those names when they were deleted, so rewriting the reference names a file that never existed and breaks the only trail back to the coverage each suite absorbed. #31801 already excludes historical test-file references in BDD headers from prefix sweeps.",
    tokens: [
      "zero-default-agent",
      "zero-host",
      "zero-maps",
      "zero-org",
      "zero-team",
      "zero-workflow-automation-scheduler",
      "zero-workflow-automations",
    ],
  },
  {
    category: "immutable-history",
    id: "immutable-history/retired-zero-page-test-path",
    paths: /^turbo\/packages\/eslint-rules\/src\/ccstate\/__tests__\//u,
    reason:
      "The RuleTester filenames quote the retired signals/zero-page and views/zero-page source layout as historical test inputs. They preserve the path shape that existed when the rules were introduced; live views/zero-page asset keys are separately protected by immutable-static-asset-key/platform-static-asset.",
    tokens: ["zero-page"],
  },
  {
    category: "immutable-history",
    id: "immutable-history/retired-runner-claim-feature-flag",
    paths: TEST_AND_FIXTURE_PATHS,
    reason:
      "zeroWebSearch is a retired feature-flag key, and run-lifecycle.bdd.test.ts asserts the runner claim payload does not carry it. The assertion only guards against reintroducing the key runners once received; renaming it would make the test prove the absence of a key that was never sent.",
    tokens: ["zeroWebSearch"],
  },
  {
    category: "external-identity",
    id: "external-identity/axiom-dataset-environment-name",
    reason:
      "axiom.ts builds every dataset name as vm0-<base>-${AXIOM_DATASET_SUFFIX}, so these are the dev datasets provisioned in Axiom that log.ts, sandbox-op-log.ts, and the telemetry ingest actually write to. The tests pin them because the name is the contract: the op-log MSW handler only accepts events addressed to vm0-sandbox-op-log-dev, and getAxiomTokenEnvNameForApl picks AXIOM_TOKEN_SESSIONS by matching agent-run-events inside the dataset name. A renamed literal would describe a dataset that does not exist and stop exercising that routing.",
    tokens: [
      "vm0-agent-run-events-dev",
      "vm0-sandbox-op-log-dev",
      "vm0-sandbox-telemetry-network-dev",
      "vm0-web-logs-dev",
    ],
  },
  {
    category: "external-identity",
    id: "external-identity/clerk-ci-account-marker",
    paths: TEST_AND_FIXTURE_PATHS,
    reason:
      "vm0CiTest is the private_metadata key e2e/playwright/lib/clerk-api.ts writes onto the Clerk organizations it creates and reads back to recognise the accounts it owns. The metadata already sits on organizations in the shared CI Clerk instance, which no source edit reaches, so renaming the key makes the harness stop recognising its own accounts and leaves them behind uncollected.",
    tokens: ["vm0CiTest"],
  },
  {
    category: "external-identity",
    id: "external-identity/repository-slug-case-variant",
    paths: TEST_AND_FIXTURE_PATHS,
    reason:
      "VM0-AI/VM0 is the vm0-ai/vm0 repository slug spelled in a different case, configured on a GitHub automation while the webhook beside it delivers the lowercase form; the case difference is what the test asserts is matched. Renaming it either loses the case-insensitivity coverage or renames a GitHub identity this repository cannot move.",
    tokens: ["VM0-AI"],
  },
  {
    category: "external-identity",
    id: "external-identity/local-test-database",
    paths: TEST_AND_FIXTURE_PATHS,
    reason:
      "vm0_test is the database in the DATABASE_URL fallback the API test environment uses when the variable is unset. The database already exists on developer machines and test clusters that this repository cannot create, so renaming the literal makes every such environment fail to connect instead of failing a test.",
    tokens: ["vm0_test"],
  },
  {
    category: "external-identity",
    id: "external-identity/negated-live-identity",
    paths: TEST_AND_FIXTURE_PATHS,
    reason:
      "non-vm0 negates a live identity rather than naming a stale one: the internal-account gate admits vm0.ai addresses and rejects everything else, and the dispatch guard rejects a compose pinned outside the vm0/* runner-group namespace that supported Runner releases subscribe to. Both retire with the thing they negate, not before it.",
    tokens: ["non-vm0"],
  },
  {
    category: "wire-and-persisted-value",
    id: "wire-and-persisted-value/credential-format-fixture",
    paths: TEST_AND_FIXTURE_PATHS,
    reason:
      "A fixture credential that begins with an issued token prefix. vm0_official_, vm0_pat_, and vm0_sandbox_ are matched by prefix when authenticating, the browser and Computer Use authorization URLs are built from vm0_browser_authorization_request_ and vm0_computer_use_authorization_request_, and generateOpaqueToken bakes vm0_computer_use_host_ into every host token it issues. The prefix is the whole point of each fixture: computer-use.bdd.test.ts asserts an issued token matches /^vm0_computer_use_host_/, and the malformed-token cases only reach the decoder because they carry a prefix it recognises. Rewriting the prefix makes the fixture describe a credential shape that was never issued.",
    tokenPattern:
      /^vm0_(?:official|pat|sandbox|browser_authorization_request|computer_use_authorization_request|computer_use_host)_[A-Za-z0-9_.-]*$/u,
  },
  {
    category: "wire-and-persisted-value",
    id: "wire-and-persisted-value/brand-header-signing-helper",
    paths: TEST_AND_FIXTURE_PATHS,
    reason:
      "Vm0SignatureHeaders and vm0SignatureHeaders are named for the two headers they produce, x-vm0-signature and x-vm0-timestamp, which are an approved brand-header boundary that deployed callback senders and consumers read. The identifier is the header pair's name in TypeScript, so it moves when the headers move and reads wrongly the moment it does not.",
    tokens: ["Vm0SignatureHeaders", "vm0SignatureHeaders"],
  },
  {
    category: "protocol-compatibility",
    id: "protocol-compatibility/legacy-instruction-profile-marker",
    paths: TEST_AND_FIXTURE_PATHS,
    reason:
      "nZERO_PROFILE is how the tokenizer reads the newline-prefixed <!-- ZERO_PROFILE marker inside the instruction fixture. instructions-frontmatter.ts still strips that exact marker from instruction content written before the rename, so the fixture has to keep spelling it; the marker itself is already an approved ZERO_* boundary.",
    tokens: ["nZERO_PROFILE"],
  },
  {
    category: "protocol-compatibility",
    id: "protocol-compatibility/zero-host-domain-test-value",
    paths: TEST_AND_FIXTURE_PATHS,
    reason:
      "The hosted-site BDD suite asserts the URL a site gets under ZERO_HOST_DOMAIN, whose test value #31801 already records as an approved boundary; the assertion spells the domain out instead of naming the variable, so it is the same boundary one line further from its constant.",
    tokens: ["zero-sites"],
  },
  {
    category: "desktop-identity",
    id: "desktop-identity/desktop-release-artifact",
    paths: TEST_AND_FIXTURE_PATHS,
    reason:
      "Zero-darwin-arm64-1.2.3.zip is the published Desktop release artifact attached to a GitHub release, and desktop-updates.test.ts uses it to prove the final Okou feed refuses to serve a Zero artifact. The asset exists under that filename on a release this repository cannot rewrite, and #26364, #26368, and #26370 own Desktop identity.",
    tokens: ["Zero-darwin-arm64-1"],
  },
  {
    category: "semantic-non-brand",
    id: "semantic-non-brand/zero-quantity-fixture",
    paths: TEST_AND_FIXTURE_PATHS,
    reason:
      "Every one of these spells the number, not the brand. zeroBlueprintName is a workflow definition published with zero blueprints and zeroInstalled is the installation it produces; zeroBudgetAutomation has autonomyBudget 0 and zeroQueue has estimatedTimePerRun 0; sequenceZero and sequenceZeroRow are sequence 0 beside sequenceOne and sequenceTwo; zeroResidual is the offset of the assertion that zero legacy discriminators remain; zeros is the leading zeros of a non-canonical IPv4 address; zero-size-timecode-scale is a WebM timecode scale of 0; and zero-proration, inv_zero_, user_zero_, mem_zero_, ii_zero_invite_, in_zero_invite_, in_zero_upgrade_, and in_zero_upgrade_lines_ are the Stripe and Clerk ids of the fully discounted, zero-amount invitation and upgrade scenarios. coupon_test_zero100 and cs_zero100_ derive from the live ZERO100 one-time campaign code, where the numeral is the price the campaign leaves; api-test-lifecycle-zero and api-test-zero are the definition names zeroBlueprintName builds. A brand rename must leave all of them alone.",
    tokens: [
      "api-test-lifecycle-zero",
      "api-test-zero",
      "coupon_test_zero100",
      "cs_zero100_",
      "ii_zero_invite_",
      "in_zero_invite_",
      "in_zero_upgrade_",
      "in_zero_upgrade_lines_",
      "inv_zero_",
      "mem_zero_",
      "sequenceZero",
      "sequenceZeroRow",
      "user_zero_",
      "zero-proration",
      "zero-size-timecode-scale",
      "zeroBlueprintName",
      "zeroBudgetAutomation",
      "zeroInstalled",
      "zeroQueue",
      "zeroResidual",
      "zeros",
    ],
  },
  {
    category: "dual-brand-product-contract",
    id: "dual-brand-product-contract/branded-test-binding",
    paths: TEST_AND_FIXTURE_PATHS,
    reason:
      'The VM0 half of a dual-brand assertion, named for the brand the request carries and paired in the same test with an okou* sibling: prepareHostedSite(actor, vm0Body, "vm0") beside createdOnOkou, vm0Response against okouResponse in the host worker and the billing suites, vm0Conflict beside okouConflict, vm0State and vm0StateString holding publicBrand "vm0" beside okouStateString, vm0Guidance asserting app.vm0.ai and not app.okou.ai, vm0-feishu-app-icon.png as the VM0 spelling of `${brandName.toLowerCase()}-feishu-app-icon.png`, customZero as an agent a user deliberately named Zero, and VM0_INSTALL_STATE as literally JSON.stringify({ publicBrand: "vm0" }). Renaming the VM0 side while the Okou side keeps its brand name destroys the pairing the test exists to express, and VM0 stays a supported public presentation brand until #27750 records the product decision.',
    tokens: [
      "VM0_INSTALL_STATE",
      "bdd-vm0-brand",
      "bdd-vm0-github-code",
      "createdOnVm0",
      "customZero",
      "vm0-feishu-app-icon",
      "vm0-invite",
      "vm0Actor",
      "vm0Agent",
      "vm0Body",
      "vm0Call",
      "vm0Callback",
      "vm0CallbackLocation",
      "vm0CallbackQuery",
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
      "vm0Onboarding",
      "vm0Preview",
      "vm0Replay",
      "vm0ReplayUrl",
      "vm0Response",
      "vm0RunDriveSync",
      "vm0RunToken",
      "vm0Sent",
      "vm0SignedState",
      "vm0Site",
      "vm0Snapshot",
      "vm0State",
      "vm0StateString",
      "vm0Update",
      "vm0UpdateQuery",
    ],
  },
  {
    category: "wire-and-persisted-value",
    id: "wire-and-persisted-value/queued-automation-payload-key-order-field",
    paths:
      /^turbo\/apps\/api\/src\/signals\/services\/workflow-automation-context\.service\.ts$/u,
    reason:
      "__vm0EventPayloadObjectKeyOrderV1 is the reserved field persistedWorkflowAutomationEventPayload writes into every automation event payload before it is queued, and the payload is stored in chat_automation_context.event_payload while the event waits to be claimed. It is not a read-only compatibility branch: the field is written on admission, parsed back out of the stored row at claim time, and stripped from the payload root so the reproduced agent prompt matches the pre-queue one byte for byte. Renaming the constant makes new code look for a key the queued rows do not carry, so the key-order parse fails, the restore returns null, and the drain consumes each of those events as invalid instead of launching it — every automation admitted before the deploy is discarded. Removal gate, the persisted-state surface of docs/fallback.md section 7: no unrevoked input.automation chat event with a null run_id has a chat_automation_context.event_payload still carrying the old key.",
    tokens: ["__vm0EventPayloadObjectKeyOrderV1"],
  },
  {
    category: "wire-and-persisted-value",
    id: "wire-and-persisted-value/queued-automation-legacy-message-field",
    paths:
      /^turbo\/apps\/api\/src\/signals\/services\/(?:workflow-automation-context\.service\.ts|__tests__\/workflow-automation-context\.test\.ts)$/u,
    reason:
      "__vm0UserFriendlyAutomationMessageV1 is a reserved field an earlier deploy wrote into automation event payloads, kept only so the payload restore can strip it from the root of a stored payload at claim time; the comment above the constant already states that drain condition. The agent prompt renders the restored payload with JSON.stringify, so renaming the constant stops the old key from being recognised and leaks it into the prompt built from every queued row that still carries it. The rollout test beside it spells the same literal into a payload so the strip has something to strip, the way the verification script does for the renamed feature-switch key above. Removal gate, the persisted-state surface of docs/fallback.md section 7 and the gate the comment names: the constant, its strip, and that test are deleted together once no unrevoked input.automation chat event with a null run_id has a chat_automation_context.event_payload carrying the field.",
    tokens: ["__vm0UserFriendlyAutomationMessageV1"],
  },
  {
    category: "wire-and-persisted-value",
    id: "wire-and-persisted-value/advisory-lock-key",
    paths: /^turbo\/apps\/api\/src\/signals\/services\/browser\.service\.ts$/u,
    reason:
      "zero_browser:<chatThreadId> and zero_browser_profile:<chatThreadId> are the strings the managed browser service hashes with hashtext to derive its pg_advisory_xact_lock keys — the first serialising every transaction that mutates a thread's browser session, the second serialising that thread's profile creation. The lock identity is the hash of the string, so during a rolling deploy instances on the old and the new code compute different keys for the same chat thread, both acquire successfully, and the mutual exclusion the lock exists to provide is absent for the whole rollout window. No test observes it because the defect needs two code versions running at once. Removal condition, and the reason this is not a rename: one release must take both the old and the new lock in the same transaction, and only the release after the instances holding both have finished draining may drop the old one.",
    tokens: ["zero_browser", "zero_browser_profile"],
  },
  {
    category: "wire-and-persisted-value",
    id: "wire-and-persisted-value/model-provider-placeholder-sentinel",
    paths:
      /^turbo\/packages\/api-contracts\/src\/contracts\/model-provider-firewalls\.ts$/u,
    reason:
      "ws_VM0_PLACEHOLDER_DO_NOT_TRUST and rt_VM0_PLACEHOLDER_DO_NOT_TRUST are the CHATGPT_ACCOUNT_ID and CHATGPT_REFRESH_TOKEN placeholder markers substituted for the real credential on the way to a runner. packages/api-contracts/src/rust-bindings/generate.ts copies the same literals into crates/api-contracts/src/generated/constants.rs, and that crate ships inside runner and sandbox images built and rolled out separately from the API, so a rename has to regenerate the Rust constants and land both halves in one batch while any runner in the mixed-version window still sees a marker value it does not recognise. #31813 enforces nothing on crates/, so this rule approves only the TypeScript half of a literal whose other half is out of scope.",
    tokens: [
      "rt_VM0_PLACEHOLDER_DO_NOT_TRUST",
      "ws_VM0_PLACEHOLDER_DO_NOT_TRUST",
    ],
  },
  {
    category: "dual-brand-product-contract",
    id: "dual-brand-product-contract/supported-brand-word",
    reason:
      "The bare brand word is the VM0 and Zero identity itself: the assistant name the product renders, the presentation brand carried on runs, tokens, artifacts, and titles, the zero scope and /api/zero vocabulary deployed clients still speak, and the prose that names any of them. VM0 stays a supported public presentation brand until #27750 records the product decision, so these read correctly today and retire with the brand rather than ahead of it. The numeral senses are separated out by the semantic-non-brand rules above, and every longer identifier built on the brand stays outside this rule because the token must match exactly.",
    tokens: ["VM0", "Vm0", "ZERO", "Zero", "vm0", "zero"],
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
      "vm0-main-stylesheet",
      "vm0-main-stylesheet-loader",
      "vm0-shadow-preview-root",
      "zero-card",
    ],
    {
      ownerIssue: "#31802",
      reason:
        "Platform and UI stylesheet vocabulary: class names, keyframes, and custom properties left behind by the #31802 design-token sweep, removable together with the rules that declare them.",
      workstream: "R1",
    },
  ),
  ...baselineNames([], {
    ownerIssue: "#31801",
    reason:
      "TypeScript vocabulary around the dispatch telemetry action types; it is renameable without touching the persisted action strings, and R2 stays blocked until the operational-query decision is recorded.",
    workstream: "R2",
  }),
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
      "vm0_api_keys",
      "vm0PrimaryCandidate",
      "vm0UsageCredits",
      "zero-me-model-providers",
      "zero-model-providers",
      "zeroUsageEvent",
    ],
    {
      ownerIssue: "#31801",
      reason:
        "Vm0 model, key, and entitlement TypeScript vocabulary; R3 renames it after R4 lands because both edit the same BDD test files.",
      workstream: "R3",
    },
  ),
  ...baselineNames(["zero-run-fixture", "zero_runs_"], {
    ownerIssue: "#26877",
    reason:
      "Legacy zero run vocabulary in TypeScript identifiers, comments, and fixture strings; #26877 owns replacing it with agent run terminology.",
    workstream: "R4",
  }),
  ...baselineNames(
    [
      "ClaimedVm0Run",
      "createClaimedVm0Run",
      "createVm0Run",
      "releaseVm0DeepSeekKey",
      "vm0-backed",
      "vm0-key-bdd-dev-seed",
      "vm0-key-bdd-fake",
      "vm0Observation",
      "vm0Prompt",
      "vm0Rejected",
      "vm0Send",
    ],
    {
      ownerIssue: "#31801",
      reason:
        '#31883 located this name and found it is not fixture vocabulary but the built-in provider vocabulary R3 owns: each one names a run, prompt, admission observation, or BDD execution key created with modelProvider "built-in", and they sit beside VM0_BDD_API_KEY_PREFIXES, acquireBddVm0ApiKey, and releaseBddVm0ApiKey, which R3 already holds. Renaming them apart from the Vm0 model vocabulary would split one rename across two slices.',
      workstream: "R3",
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
  ...baselineNames([], {
    ownerIssue: "#31801",
    reason:
      "Bare brand literals and stale prose in comments, documentation, and user-facing copy; #31856 classified all 32 names, so every remaining occurrence is either an approved boundary above or was rewritten because it described something that no longer exists.",
    workstream: "R9",
  }),
  ...baselineNames(
    [
      "data-vm0",
      "data-vm0-edit-id",
      "data-vm0-node-id",
      "vm0EditId",
      "vm0NodeId",
    ],
    {
      ownerIssue: "#31824",
      reason:
        "Legacy data-vm0-* edit-protocol readers kept for deck HTML that was stored or externally generated before the okou rename; vm0EditId and vm0NodeId name the values read from those legacy attributes. #31824 drops the complete compatibility path once no such deck remains.",
      workstream: "R7",
    },
  ),
  ...baselineNames(["vm0-deck-metadata"], {
    ownerIssue: "#31824",
    reason:
      "The legacy deck metadata script id the presentation preview still reads for deck HTML stored or externally generated before the okou rename; #31815 kept it deliberately and #31824 drops it together with the data-vm0-* readers beside it.",
    workstream: "R7",
  }),
] as const satisfies readonly ResidualBrandNameBaselineEntry[];
