#!/usr/bin/env tsx

/**
 * Backfill immutable org acquisition attribution from historical first-party
 * copies in Clerk and Stripe.
 *
 * Dry-run is the default. Pass --apply to write rows that still have a null
 * acquisition_recorded_at. The update remains guarded by that null check, so
 * retries cannot overwrite a value captured by the live application.
 */

import { appendFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import {
  createClerkClient,
  type Organization,
  type OrganizationMembership,
} from "@clerk/backend";
import {
  adAttributionMetadataSchema,
  type AdAttributionMetadata,
} from "@vm0/api-contracts/contracts/zero-attribution";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { and, eq, isNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

const SIGNUP_ATTRIBUTION_KEY = "signup_attribution";
const PAGE_SIZE = 100;
const ORG_THROTTLE_MS = 250;
const CREATOR_MEMBERSHIP_WINDOW_MS = 10 * 60 * 1000;

const ATTRIBUTION_KEYS = [
  "source_type",
  "referrer_domain",
  "landing_host",
  "landing_path",
  "vm0_source",
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "vm0_campaign_id",
  "vm0_ad_group_id",
  "utm_content",
  "utm_term",
  "vm0_experiment",
  "vm0_variant",
  "lp_variant",
  "gclid",
  "gbraid",
  "wbraid",
  "ga_client_id",
  "gclid_present",
  "gbraid_present",
  "wbraid_present",
] as const satisfies readonly (keyof AdAttributionMetadata)[];

const DATABASE_FIELD_MAPPINGS = [
  ["source_type", "acquisitionSourceType"],
  ["vm0_source", "acquisitionVm0Source"],
  ["vm0_campaign_id", "acquisitionCampaignId"],
  ["vm0_ad_group_id", "acquisitionAdGroupId"],
  ["utm_campaign", "acquisitionCampaign"],
  ["utm_source", "acquisitionUtmSource"],
  ["utm_medium", "acquisitionUtmMedium"],
  ["utm_content", "acquisitionUtmContent"],
  ["utm_term", "acquisitionUtmTerm"],
  ["gclid", "acquisitionGclid"],
  ["gbraid", "acquisitionGbraid"],
  ["wbraid", "acquisitionWbraid"],
  ["ga_client_id", "acquisitionGaClientId"],
  ["landing_host", "acquisitionLandingHost"],
  ["landing_path", "acquisitionLandingPath"],
  ["referrer_domain", "acquisitionReferrerDomain"],
] as const;

const REQUIRED_DATABASE_COLUMNS = [
  "acquisition_source_type",
  "acquisition_vm0_source",
  "acquisition_campaign_id",
  "acquisition_ad_group_id",
  "acquisition_campaign",
  "acquisition_utm_source",
  "acquisition_utm_medium",
  "acquisition_utm_content",
  "acquisition_utm_term",
  "acquisition_gclid",
  "acquisition_gbraid",
  "acquisition_wbraid",
  "acquisition_ga_client_id",
  "acquisition_landing_host",
  "acquisition_landing_path",
  "acquisition_referrer_domain",
  "acquisition_recorded_at",
] as const;

type AttributionKey = keyof AdAttributionMetadata;
type DatabaseSourceKey = (typeof DATABASE_FIELD_MAPPINGS)[number][0];
type CandidateSource =
  | "clerk_creator"
  | "stripe_customer"
  | "stripe_subscription";

export interface AttributionCandidate {
  readonly source: CandidateSource;
  readonly attribution: AdAttributionMetadata;
  readonly recordedAt: Date;
}

export interface ReconciledAttribution {
  readonly attribution?: AdAttributionMetadata;
  readonly recordedAt?: Date;
  readonly sources: readonly CandidateSource[];
  readonly conflictFields: readonly AttributionKey[];
}

interface TargetOrg {
  readonly orgId: string;
  readonly stripeCustomerId: string | null;
  readonly stripeSubscriptionId: string | null;
}

type UnresolvedReason =
  | "clerk_org_missing"
  | "creator_not_current_member"
  | "creator_membership_ambiguous"
  | "creator_user_missing"
  | "creator_has_no_attribution"
  | "no_clerk_or_stripe_attribution"
  | "source_conflict";

interface OrgReport {
  readonly orgId: string;
  readonly outcome: "planned" | "updated" | "race_skipped" | "unresolved";
  readonly sources?: readonly CandidateSource[];
  readonly fields?: readonly DatabaseSourceKey[];
  readonly reason?: UnresolvedReason;
  readonly clerkReason?: Exclude<UnresolvedReason, "source_conflict">;
  readonly conflictFields?: readonly AttributionKey[];
}

interface BackfillError {
  readonly orgId: string;
  readonly source: "clerk" | "stripe" | "database";
  readonly message: string;
}

interface BackfillReport {
  readonly generatedAt: string;
  readonly mode: "dry-run" | "apply";
  readonly orgFilter: string | null;
  readonly database: {
    readonly totalOrgs: number;
    readonly alreadyAttributed: number;
    readonly targetOrgs: number;
  };
  readonly results: {
    readonly resolved: number;
    readonly updated: number;
    readonly raceSkipped: number;
    readonly unresolved: number;
    readonly errors: number;
  };
  readonly sourceCounts: Readonly<Record<CandidateSource, number>>;
  readonly fieldCounts: Readonly<Partial<Record<DatabaseSourceKey, number>>>;
  readonly unresolvedReasonCounts: Readonly<
    Partial<Record<UnresolvedReason, number>>
  >;
  readonly orgs: readonly OrgReport[];
  readonly errorDetails: readonly BackfillError[];
}

interface ClerkResolution {
  readonly candidate?: AttributionCandidate;
  readonly reason?: Exclude<UnresolvedReason, "source_conflict">;
}

interface Discovery {
  readonly target: TargetOrg;
  readonly attribution: AdAttributionMetadata;
  readonly recordedAt: Date;
  readonly sources: readonly CandidateSource[];
  readonly fields: readonly DatabaseSourceKey[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function dateFromUnknown(value: unknown): Date | undefined {
  if (typeof value !== "string" && typeof value !== "number") {
    return undefined;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

export function extractAttribution(
  value: unknown,
): AdAttributionMetadata | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const selected: Partial<Record<AttributionKey, string>> = {};
  for (const key of ATTRIBUTION_KEYS) {
    const raw = value[key];
    if (typeof raw !== "string") {
      continue;
    }
    const trimmed = raw.trim();
    if (trimmed) {
      selected[key] = trimmed;
    }
  }

  const parsed = adAttributionMetadataSchema.safeParse(selected);
  if (!parsed.success) {
    return undefined;
  }

  const fields = databaseFields(parsed.data);
  if (fields.length === 0) {
    return undefined;
  }

  // An old fallback could store only source_type=unknown. Persisting that now
  // would lock the org against a later real first-touch value without adding
  // any reporting signal.
  if (
    fields.length === 1 &&
    fields[0] === "source_type" &&
    parsed.data.source_type === "unknown"
  ) {
    return undefined;
  }

  return parsed.data;
}

export function databaseFields(
  attribution: AdAttributionMetadata,
): readonly DatabaseSourceKey[] {
  return DATABASE_FIELD_MAPPINGS.flatMap(([sourceKey]) => {
    const value = attribution[sourceKey];
    return typeof value === "string" && value.trim() ? [sourceKey] : [];
  });
}

export function likelyCreatorUserId(
  organizationCreatedAt: number,
  memberships: readonly {
    readonly createdAt: number;
    readonly userId?: string | null;
  }[],
):
  | { readonly userId: string }
  | {
      readonly reason:
        | "creator_not_current_member"
        | "creator_membership_ambiguous";
    } {
  const valid = memberships
    .filter(
      (membership): membership is { createdAt: number; userId: string } => {
        return Boolean(membership.userId);
      },
    )
    .sort((left, right) => {
      return left.createdAt - right.createdAt;
    });
  const first = valid[0];
  if (
    !first ||
    first.createdAt < organizationCreatedAt - 60_000 ||
    first.createdAt > organizationCreatedAt + CREATOR_MEMBERSHIP_WINDOW_MS
  ) {
    return { reason: "creator_not_current_member" };
  }

  if (valid[1]?.createdAt === first.createdAt) {
    return { reason: "creator_membership_ambiguous" };
  }
  return { userId: first.userId };
}

export function reconcileCandidates(
  candidates: readonly AttributionCandidate[],
): ReconciledAttribution {
  if (candidates.length === 0) {
    return { sources: [], conflictFields: [] };
  }

  const merged: Partial<Record<AttributionKey, string>> = {};
  const conflicts = new Set<AttributionKey>();
  for (const candidate of candidates) {
    for (const key of ATTRIBUTION_KEYS) {
      const incoming = candidate.attribution[key];
      if (!incoming) {
        continue;
      }
      const existing = merged[key];
      if (existing && existing !== incoming) {
        conflicts.add(key);
      } else {
        merged[key] = incoming;
      }
    }
  }

  if (conflicts.size > 0) {
    return {
      sources: candidates.map((candidate) => {
        return candidate.source;
      }),
      conflictFields: [...conflicts].sort(),
    };
  }

  const parsed = adAttributionMetadataSchema.safeParse(merged);
  if (!parsed.success) {
    throw new Error("Reconciled attribution failed schema validation");
  }
  return {
    attribution: parsed.data,
    recordedAt: new Date(
      Math.min(
        ...candidates.map((candidate) => {
          return candidate.recordedAt.getTime();
        }),
      ),
    ),
    sources: candidates.map((candidate) => {
      return candidate.source;
    }),
    conflictFields: [],
  };
}

async function collectPages<T>(
  fetchPage: (params: {
    readonly limit: number;
    readonly offset: number;
  }) => Promise<{ readonly data: T[]; readonly totalCount: number }>,
): Promise<T[]> {
  const all: T[] = [];
  for (let offset = 0; ; ) {
    const page = await fetchPage({ limit: PAGE_SIZE, offset });
    all.push(...page.data);
    offset += page.data.length;
    if (page.data.length === 0 || offset >= page.totalCount) {
      return all;
    }
    await sleep(100);
  }
}

function clerkMembershipIdentity(membership: OrganizationMembership): {
  readonly createdAt: number;
  readonly userId?: string | null;
} {
  return {
    createdAt: membership.createdAt,
    userId: membership.publicUserData?.userId,
  };
}

async function clerkCandidateForOrg(
  clerk: ReturnType<typeof createClerkClient>,
  organization: Organization | undefined,
): Promise<ClerkResolution> {
  if (!organization) {
    return { reason: "clerk_org_missing" };
  }

  const memberships = await collectPages<OrganizationMembership>((params) => {
    return clerk.organizations.getOrganizationMembershipList({
      organizationId: organization.id,
      ...params,
    });
  });
  const creator = likelyCreatorUserId(
    organization.createdAt,
    memberships.map(clerkMembershipIdentity),
  );
  if ("reason" in creator) {
    return { reason: creator.reason };
  }

  let user;
  try {
    user = await clerk.users.getUser(creator.userId);
  } catch (error) {
    if (isRecord(error) && error.status === 404) {
      return { reason: "creator_user_missing" };
    }
    throw error;
  }

  const stored = isRecord(user.privateMetadata)
    ? user.privateMetadata[SIGNUP_ATTRIBUTION_KEY]
    : undefined;
  const attribution = extractAttribution(stored);
  if (!attribution) {
    return { reason: "creator_has_no_attribution" };
  }
  const recordedAt = isRecord(stored)
    ? dateFromUnknown(stored.recorded_at)
    : undefined;
  return {
    candidate: {
      source: "clerk_creator",
      attribution,
      recordedAt: recordedAt ?? new Date(user.createdAt),
    },
  };
}

function stripeCandidate(
  source: Extract<CandidateSource, `stripe_${string}`>,
  metadata: Readonly<Record<string, string>>,
  createdSeconds: number,
  orgId: string,
): AttributionCandidate | undefined {
  if (metadata.orgId && metadata.orgId !== orgId) {
    throw new Error(
      `${source} metadata orgId does not match the database orgId`,
    );
  }
  const attribution = extractAttribution(metadata);
  return attribution
    ? {
        source,
        attribution,
        recordedAt: new Date(createdSeconds * 1000),
      }
    : undefined;
}

interface RetrievedStripeObject {
  readonly created: number;
  readonly metadata: Readonly<Record<string, string>>;
}

function stripeErrorCode(value: unknown): string | undefined {
  if (!isRecord(value) || !isRecord(value.error)) {
    return undefined;
  }
  return typeof value.error.code === "string" ? value.error.code : undefined;
}

async function retrieveStripeObject(
  stripeSecretKey: string,
  resource: "customers" | "subscriptions",
  id: string,
): Promise<RetrievedStripeObject | undefined> {
  const url = `https://api.stripe.com/v1/${resource}/${encodeURIComponent(id)}`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    let response: Response;
    try {
      response = await fetch(url, {
        headers: { Authorization: `Bearer ${stripeSecretKey}` },
      });
    } catch (error) {
      if (attempt === 3) {
        throw error;
      }
      await sleep(500 * attempt);
      continue;
    }

    const body: unknown = await response.json();
    const errorCode = stripeErrorCode(body);
    if (response.status === 404 && errorCode === "resource_missing") {
      return undefined;
    }
    if ((response.status === 429 || response.status >= 500) && attempt < 3) {
      await sleep(500 * attempt);
      continue;
    }
    if (!response.ok) {
      throw new Error(
        `Stripe ${resource} retrieval failed with HTTP ${response.status}${errorCode ? ` (${errorCode})` : ""}`,
      );
    }
    if (!isRecord(body)) {
      throw new Error(`Stripe ${resource} response was not an object`);
    }
    if (body.deleted === true) {
      return undefined;
    }
    if (typeof body.created !== "number" || !isRecord(body.metadata)) {
      throw new Error(`Stripe ${resource} response was missing metadata`);
    }
    const metadata = Object.fromEntries(
      Object.entries(body.metadata).filter(
        (entry): entry is [string, string] => {
          return typeof entry[1] === "string";
        },
      ),
    );
    return { created: body.created, metadata };
  }
  throw new Error(`Stripe ${resource} retrieval exhausted retries`);
}

async function stripeCandidatesForOrg(
  stripeSecretKey: string,
  target: TargetOrg,
): Promise<readonly AttributionCandidate[]> {
  const candidates: AttributionCandidate[] = [];

  if (target.stripeCustomerId) {
    const customer = await retrieveStripeObject(
      stripeSecretKey,
      "customers",
      target.stripeCustomerId,
    );
    const candidate = customer
      ? stripeCandidate(
          "stripe_customer",
          customer.metadata,
          customer.created,
          target.orgId,
        )
      : undefined;
    if (candidate) {
      candidates.push(candidate);
    }
  }

  if (target.stripeSubscriptionId) {
    const subscription = await retrieveStripeObject(
      stripeSecretKey,
      "subscriptions",
      target.stripeSubscriptionId,
    );
    const candidate = subscription
      ? stripeCandidate(
          "stripe_subscription",
          subscription.metadata,
          subscription.created,
          target.orgId,
        )
      : undefined;
    if (candidate) {
      candidates.push(candidate);
    }
  }

  return candidates;
}

function databaseValues(attribution: AdAttributionMetadata) {
  return {
    acquisitionSourceType: sql`COALESCE(${orgMetadata.acquisitionSourceType}, ${attribution.source_type ?? null})`,
    acquisitionVm0Source: sql`COALESCE(${orgMetadata.acquisitionVm0Source}, ${attribution.vm0_source ?? null})`,
    acquisitionCampaignId: sql`COALESCE(${orgMetadata.acquisitionCampaignId}, ${attribution.vm0_campaign_id ?? null})`,
    acquisitionAdGroupId: sql`COALESCE(${orgMetadata.acquisitionAdGroupId}, ${attribution.vm0_ad_group_id ?? null})`,
    acquisitionCampaign: sql`COALESCE(${orgMetadata.acquisitionCampaign}, ${attribution.utm_campaign ?? null})`,
    acquisitionUtmSource: sql`COALESCE(${orgMetadata.acquisitionUtmSource}, ${attribution.utm_source ?? null})`,
    acquisitionUtmMedium: sql`COALESCE(${orgMetadata.acquisitionUtmMedium}, ${attribution.utm_medium ?? null})`,
    acquisitionUtmContent: sql`COALESCE(${orgMetadata.acquisitionUtmContent}, ${attribution.utm_content ?? null})`,
    acquisitionUtmTerm: sql`COALESCE(${orgMetadata.acquisitionUtmTerm}, ${attribution.utm_term ?? null})`,
    acquisitionGclid: sql`COALESCE(${orgMetadata.acquisitionGclid}, ${attribution.gclid ?? null})`,
    acquisitionGbraid: sql`COALESCE(${orgMetadata.acquisitionGbraid}, ${attribution.gbraid ?? null})`,
    acquisitionWbraid: sql`COALESCE(${orgMetadata.acquisitionWbraid}, ${attribution.wbraid ?? null})`,
    acquisitionGaClientId: sql`COALESCE(${orgMetadata.acquisitionGaClientId}, ${attribution.ga_client_id ?? null})`,
    acquisitionLandingHost: sql`COALESCE(${orgMetadata.acquisitionLandingHost}, ${attribution.landing_host ?? null})`,
    acquisitionLandingPath: sql`COALESCE(${orgMetadata.acquisitionLandingPath}, ${attribution.landing_path ?? null})`,
    acquisitionReferrerDomain: sql`COALESCE(${orgMetadata.acquisitionReferrerDomain}, ${attribution.referrer_domain ?? null})`,
  };
}

function increment<K extends string>(
  counts: Partial<Record<K, number>>,
  key: K,
): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

function markdownTable(
  rows: readonly (readonly [string, string | number])[],
): string {
  return [
    "| Metric | Count |",
    "| --- | ---: |",
    ...rows.map(([name, count]) => {
      return `| ${name} | ${count} |`;
    }),
  ].join("\n");
}

async function writeReport(
  report: BackfillReport,
  reportPath: string | undefined,
): Promise<void> {
  if (reportPath) {
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }

  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) {
    return;
  }
  const fieldRows = Object.entries(report.fieldCounts).sort(
    ([left], [right]) => {
      return left.localeCompare(right);
    },
  );
  const reasonRows = Object.entries(report.unresolvedReasonCounts).sort(
    ([left], [right]) => {
      return left.localeCompare(right);
    },
  );
  const markdown = [
    "## Acquisition attribution backfill",
    "",
    `Mode: **${report.mode}**`,
    report.orgFilter
      ? `Org filter: \`${report.orgFilter}\``
      : "Org filter: all",
    "",
    markdownTable([
      ["Database orgs", report.database.totalOrgs],
      ["Already attributed", report.database.alreadyAttributed],
      ["Target orgs", report.database.targetOrgs],
      ["Resolved", report.results.resolved],
      ["Updated", report.results.updated],
      ["Race skipped", report.results.raceSkipped],
      ["Unresolved", report.results.unresolved],
      ["Errors", report.results.errors],
    ]),
    "",
    "### Source coverage",
    "",
    markdownTable(
      Object.entries(report.sourceCounts).map(([source, count]) => {
        return [source, count] as const;
      }),
    ),
    "",
    "### Field coverage among resolved orgs",
    "",
    markdownTable(fieldRows),
    "",
    "### Unresolved reasons",
    "",
    reasonRows.length > 0 ? markdownTable(reasonRows) : "None.",
    "",
  ].join("\n");
  await appendFile(summaryPath, markdown, "utf8");
}

async function loadClerkOrganizations(
  clerk: ReturnType<typeof createClerkClient>,
  orgId: string | undefined,
): Promise<Map<string, Organization>> {
  if (orgId) {
    try {
      const organization = await clerk.organizations.getOrganization({
        organizationId: orgId,
      });
      return new Map([[organization.id, organization]]);
    } catch (error) {
      if (isRecord(error) && error.status === 404) {
        return new Map();
      }
      throw error;
    }
  }

  const organizations = await collectPages<Organization>((params) => {
    return clerk.organizations.getOrganizationList(params);
  });
  return new Map(
    organizations.map((organization) => {
      return [organization.id, organization];
    }),
  );
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      apply: { type: "boolean", default: false },
      "org-id": { type: "string" },
      "report-path": { type: "string" },
    },
    strict: true,
  });
  const mode = values.apply ? "apply" : "dry-run";
  const orgId = values["org-id"]?.trim() || undefined;
  if (orgId && !/^org_[A-Za-z0-9]+$/.test(orgId)) {
    throw new Error("--org-id must be a Clerk organization ID");
  }

  const databaseUrl = requiredEnvironment("DATABASE_URL");
  const clerkSecretKey = requiredEnvironment("CLERK_SECRET_KEY");
  const stripeSecretKey = requiredEnvironment("STRIPE_SECRET_KEY");

  const postgresClient = postgres(databaseUrl, { max: 1 });
  const db = drizzle(postgresClient);
  try {
    const schemaRows = await postgresClient<{ column_name: string }[]>`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'org_metadata'
        AND column_name = ANY(${[...REQUIRED_DATABASE_COLUMNS]}::text[])
    `;
    const presentColumns = new Set(
      schemaRows.map((row) => {
        return row.column_name;
      }),
    );
    const missingColumns = REQUIRED_DATABASE_COLUMNS.filter((column) => {
      return !presentColumns.has(column);
    });
    if (missingColumns.length > 0) {
      throw new Error(
        `Production schema is missing acquisition columns: ${missingColumns.join(", ")}`,
      );
    }

    type DatabaseCounts = {
      total: number;
      already_attributed: number;
      partial_without_guard: number;
    };
    const countRows = orgId
      ? await postgresClient<DatabaseCounts[]>`
          SELECT
            COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE acquisition_recorded_at IS NOT NULL)::int AS already_attributed,
            COUNT(*) FILTER (
              WHERE acquisition_recorded_at IS NULL AND (
                acquisition_source_type IS NOT NULL OR
                acquisition_vm0_source IS NOT NULL OR
                acquisition_campaign_id IS NOT NULL OR
                acquisition_ad_group_id IS NOT NULL OR
                acquisition_campaign IS NOT NULL OR
                acquisition_utm_source IS NOT NULL OR
                acquisition_utm_medium IS NOT NULL OR
                acquisition_utm_content IS NOT NULL OR
                acquisition_utm_term IS NOT NULL OR
                acquisition_gclid IS NOT NULL OR
                acquisition_gbraid IS NOT NULL OR
                acquisition_wbraid IS NOT NULL OR
                acquisition_ga_client_id IS NOT NULL OR
                acquisition_landing_host IS NOT NULL OR
                acquisition_landing_path IS NOT NULL OR
                acquisition_referrer_domain IS NOT NULL
              )
            )::int AS partial_without_guard
          FROM org_metadata
          WHERE org_id = ${orgId}
        `
      : await postgresClient<DatabaseCounts[]>`
          SELECT
            COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE acquisition_recorded_at IS NOT NULL)::int AS already_attributed,
            COUNT(*) FILTER (
              WHERE acquisition_recorded_at IS NULL AND (
                acquisition_source_type IS NOT NULL OR
                acquisition_vm0_source IS NOT NULL OR
                acquisition_campaign_id IS NOT NULL OR
                acquisition_ad_group_id IS NOT NULL OR
                acquisition_campaign IS NOT NULL OR
                acquisition_utm_source IS NOT NULL OR
                acquisition_utm_medium IS NOT NULL OR
                acquisition_utm_content IS NOT NULL OR
                acquisition_utm_term IS NOT NULL OR
                acquisition_gclid IS NOT NULL OR
                acquisition_gbraid IS NOT NULL OR
                acquisition_wbraid IS NOT NULL OR
                acquisition_ga_client_id IS NOT NULL OR
                acquisition_landing_host IS NOT NULL OR
                acquisition_landing_path IS NOT NULL OR
                acquisition_referrer_domain IS NOT NULL
              )
            )::int AS partial_without_guard
          FROM org_metadata
        `;
    const counts = countRows[0] ?? {
      total: 0,
      already_attributed: 0,
      partial_without_guard: 0,
    };
    if (counts.partial_without_guard > 0) {
      throw new Error(
        `${counts.partial_without_guard} org(s) have partial acquisition fields without acquisition_recorded_at; refusing to guess first-touch ownership`,
      );
    }

    const targetWhere = orgId
      ? and(
          eq(orgMetadata.orgId, orgId),
          isNull(orgMetadata.acquisitionRecordedAt),
        )
      : isNull(orgMetadata.acquisitionRecordedAt);
    const targets: TargetOrg[] = await db
      .select({
        orgId: orgMetadata.orgId,
        stripeCustomerId: orgMetadata.stripeCustomerId,
        stripeSubscriptionId: orgMetadata.stripeSubscriptionId,
      })
      .from(orgMetadata)
      .where(targetWhere)
      .orderBy(orgMetadata.createdAt);

    console.log(
      `[${mode}] schema gate passed; ${targets.length} org(s) need attribution`,
    );

    const clerk = createClerkClient({ secretKey: clerkSecretKey });
    const organizations = await loadClerkOrganizations(clerk, orgId);
    const errors: BackfillError[] = [];
    const reports: OrgReport[] = [];
    const discoveries: Discovery[] = [];

    for (const [index, target] of targets.entries()) {
      let clerkResolution: ClerkResolution = {
        reason: "no_clerk_or_stripe_attribution",
      };
      let stripeCandidates: readonly AttributionCandidate[] = [];

      try {
        clerkResolution = await clerkCandidateForOrg(
          clerk,
          organizations.get(target.orgId),
        );
      } catch (error) {
        errors.push({
          orgId: target.orgId,
          source: "clerk",
          message: errorMessage(error),
        });
      }
      try {
        stripeCandidates = await stripeCandidatesForOrg(
          stripeSecretKey,
          target,
        );
      } catch (error) {
        errors.push({
          orgId: target.orgId,
          source: "stripe",
          message: errorMessage(error),
        });
      }

      const candidates = [
        ...(clerkResolution.candidate ? [clerkResolution.candidate] : []),
        ...stripeCandidates,
      ];
      const reconciled = reconcileCandidates(candidates);
      if (reconciled.conflictFields.length > 0) {
        reports.push({
          orgId: target.orgId,
          outcome: "unresolved",
          reason: "source_conflict",
          clerkReason: clerkResolution.reason,
          sources: reconciled.sources,
          conflictFields: reconciled.conflictFields,
        });
      } else if (reconciled.attribution && reconciled.recordedAt) {
        const fields = databaseFields(reconciled.attribution);
        discoveries.push({
          target,
          attribution: reconciled.attribution,
          recordedAt: reconciled.recordedAt,
          sources: reconciled.sources,
          fields,
        });
      } else {
        reports.push({
          orgId: target.orgId,
          outcome: "unresolved",
          reason: clerkResolution.reason ?? "no_clerk_or_stripe_attribution",
          clerkReason: clerkResolution.reason,
        });
      }

      if ((index + 1) % 100 === 0 || index + 1 === targets.length) {
        console.log(`discovered ${index + 1}/${targets.length} org(s)`);
      }
      if (index + 1 < targets.length) {
        await sleep(ORG_THROTTLE_MS);
      }
    }

    const applyBlockedByErrors = Boolean(values.apply && errors.length > 0);
    let updated = 0;
    let raceSkipped = 0;
    for (const discovery of discoveries) {
      if (!values.apply || applyBlockedByErrors) {
        reports.push({
          orgId: discovery.target.orgId,
          outcome: "planned",
          sources: discovery.sources,
          fields: discovery.fields,
        });
        continue;
      }

      const [row] = await db
        .update(orgMetadata)
        .set({
          ...databaseValues(discovery.attribution),
          acquisitionRecordedAt: discovery.recordedAt,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(orgMetadata.orgId, discovery.target.orgId),
            isNull(orgMetadata.acquisitionRecordedAt),
          ),
        )
        .returning({ orgId: orgMetadata.orgId });
      if (row) {
        updated++;
        reports.push({
          orgId: discovery.target.orgId,
          outcome: "updated",
          sources: discovery.sources,
          fields: discovery.fields,
        });
      } else {
        raceSkipped++;
        reports.push({
          orgId: discovery.target.orgId,
          outcome: "race_skipped",
          sources: discovery.sources,
          fields: discovery.fields,
        });
      }
    }

    const sourceCounts: Record<CandidateSource, number> = {
      clerk_creator: 0,
      stripe_customer: 0,
      stripe_subscription: 0,
    };
    const fieldCounts: Partial<Record<DatabaseSourceKey, number>> = {};
    for (const discovery of discoveries) {
      for (const source of discovery.sources) {
        sourceCounts[source]++;
      }
      for (const field of discovery.fields) {
        increment(fieldCounts, field);
      }
    }
    const unresolvedReasonCounts: Partial<Record<UnresolvedReason, number>> =
      {};
    for (const report of reports) {
      if (report.reason) {
        increment(unresolvedReasonCounts, report.reason);
      }
    }

    const report: BackfillReport = {
      generatedAt: new Date().toISOString(),
      mode,
      orgFilter: orgId ?? null,
      database: {
        totalOrgs: counts.total,
        alreadyAttributed: counts.already_attributed,
        targetOrgs: targets.length,
      },
      results: {
        resolved: discoveries.length,
        updated,
        raceSkipped,
        unresolved: reports.filter((item) => {
          return item.outcome === "unresolved";
        }).length,
        errors: errors.length,
      },
      sourceCounts,
      fieldCounts,
      unresolvedReasonCounts,
      orgs: [...reports].sort((left, right) => {
        return left.orgId.localeCompare(right.orgId);
      }),
      errorDetails: errors,
    };
    await writeReport(report, values["report-path"]);

    console.log(JSON.stringify(report.results));
    console.log(`field coverage: ${JSON.stringify(fieldCounts)}`);
    console.log(
      `unresolved reasons: ${JSON.stringify(unresolvedReasonCounts)}`,
    );
    if (errors.length > 0) {
      throw new Error(
        `Backfill completed discovery with ${errors.length} external-source error(s)`,
      );
    }
  } finally {
    await postgresClient.end();
  }
}

const invokedPath = process.argv[1];
if (invokedPath && fileURLToPath(import.meta.url) === resolve(invokedPath)) {
  main().catch((error: unknown) => {
    console.error(errorMessage(error));
    process.exitCode = 1;
  });
}
