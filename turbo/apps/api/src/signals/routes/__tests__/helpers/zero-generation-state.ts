import type {
  TestGenerationStateActionBody,
  TestGenerationStateActionResponse,
  TestGenerationStateBehaviorCountRow,
  TestGenerationStateFixture,
  TestGenerationStateGenerationJobRow,
  TestGenerationStatePricingRow,
  TestGenerationStateUploadedFileRow,
  TestGenerationStateUsageEventRow,
} from "@vm0/api-contracts/contracts/test-generation-state";

import { createAppWithRoutes } from "../../../../app-factory-core";
import { testGenerationStateRoutes } from "../../test-generation-state";

const GENERATION_STATE_ROUTE = "/api/test/generation-state";

export interface GenerationFixture {
  readonly orgId: string;
  readonly userId: string;
}

export interface GenerationPricingRow {
  readonly kind: string;
  readonly provider: string;
  readonly category: string;
  readonly unitPrice: number;
  readonly unitSize: number;
}

export interface GenerationUploadedFile {
  readonly id: string;
  readonly runId: string;
  readonly source: string;
  readonly externalId: string;
  readonly userId: string;
  readonly orgId: string | null;
  readonly filename: string | null;
  readonly contentType: string | null;
  readonly sizeBytes: number | null;
  readonly url: string | null;
  readonly metadata: unknown;
}

export interface GenerationUsageEvent {
  readonly id: string;
  readonly runId: string | null;
  readonly idempotencyKey: string;
  readonly orgId: string;
  readonly userId: string;
  readonly kind: string;
  readonly provider: string;
  readonly category: string;
  readonly quantity: number;
  readonly creditsCharged: number | null;
  readonly status: string;
  readonly billingError: string | null;
}

export interface GenerationJob {
  readonly id: string;
  readonly type: string;
  readonly status: string;
  readonly orgId: string;
  readonly userId: string;
  readonly runId: string | null;
  readonly request: unknown;
  readonly result: unknown | null;
  readonly error: unknown | null;
}

export interface BehaviorCount {
  readonly behaviorKey: string;
  readonly count: number;
}

function requestGenerationState(
  signal: AbortSignal,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const app = createAppWithRoutes({
    signal,
    routes: testGenerationStateRoutes,
  });
  return Promise.resolve(app.request(path, init));
}

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

function expectOk(response: Response, operation: string): void {
  if (response.ok) {
    return;
  }
  throw new Error(`${operation} failed with ${response.status}`);
}

async function postAction(
  signal: AbortSignal,
  body: TestGenerationStateActionBody,
): Promise<TestGenerationStateActionResponse> {
  const response = await requestGenerationState(
    signal,
    `${GENERATION_STATE_ROUTE}/action`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  signal.throwIfAborted();
  expectOk(response, `generation state action ${body.action}`);
  signal.throwIfAborted();
  const result = await readJson<TestGenerationStateActionResponse>(response);
  signal.throwIfAborted();
  return result;
}

function fixtureFromWire(
  fixture: TestGenerationStateFixture,
): GenerationFixture {
  return {
    orgId: fixture.org_id,
    userId: fixture.user_id,
  };
}

function fixtureToWire(fixture: GenerationFixture): TestGenerationStateFixture {
  return {
    org_id: fixture.orgId,
    user_id: fixture.userId,
  };
}

function pricingRowFromWire(
  row: TestGenerationStatePricingRow,
): GenerationPricingRow {
  return {
    kind: row.kind,
    provider: row.provider,
    category: row.category,
    unitPrice: row.unit_price,
    unitSize: row.unit_size,
  };
}

function pricingRowToWire(
  row: GenerationPricingRow,
): TestGenerationStatePricingRow {
  return {
    kind: row.kind,
    provider: row.provider,
    category: row.category,
    unit_price: row.unitPrice,
    unit_size: row.unitSize,
  };
}

function uploadedFileFromWire(
  row: TestGenerationStateUploadedFileRow,
): GenerationUploadedFile {
  return {
    id: row.id,
    runId: row.run_id,
    source: row.source,
    externalId: row.external_id,
    userId: row.user_id,
    orgId: row.org_id,
    filename: row.filename,
    contentType: row.content_type,
    sizeBytes: row.size_bytes,
    url: row.url,
    metadata: row.metadata,
  };
}

function usageEventFromWire(
  row: TestGenerationStateUsageEventRow,
): GenerationUsageEvent {
  return {
    id: row.id,
    runId: row.run_id,
    idempotencyKey: row.idempotency_key,
    orgId: row.org_id,
    userId: row.user_id,
    kind: row.kind,
    provider: row.provider,
    category: row.category,
    quantity: row.quantity,
    creditsCharged: row.credits_charged,
    status: row.status,
    billingError: row.billing_error,
  };
}

function generationJobFromWire(
  row: TestGenerationStateGenerationJobRow,
): GenerationJob {
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    orgId: row.org_id,
    userId: row.user_id,
    runId: row.run_id,
    request: row.request,
    result: row.result,
    error: row.error,
  };
}

function behaviorCountFromWire(
  row: TestGenerationStateBehaviorCountRow,
): BehaviorCount {
  return {
    behaviorKey: row.behavior_key,
    count: row.count,
  };
}

export async function seedGenerationFixture(
  signal: AbortSignal,
  options: {
    readonly credits?: number;
    readonly tier?: string;
  },
): Promise<GenerationFixture> {
  const response = await postAction(signal, {
    action: "seed-fixture",
    credits: options.credits,
    tier: options.tier,
  });
  if (!response.fixture) {
    throw new Error("seedGenerationFixture: response missing fixture");
  }
  return fixtureFromWire(response.fixture);
}

export async function deleteGenerationFixture(
  signal: AbortSignal,
  fixture: GenerationFixture,
): Promise<void> {
  await postAction(signal, {
    action: "delete-fixture",
    fixture: fixtureToWire(fixture),
  });
}

export async function upsertGenerationPricingRows(
  signal: AbortSignal,
  rows: readonly GenerationPricingRow[],
): Promise<void> {
  await postAction(signal, {
    action: "upsert-pricing-rows",
    rows: rows.map(pricingRowToWire),
  });
}

export async function ensureGenerationPricingRow(
  signal: AbortSignal,
  row: GenerationPricingRow,
): Promise<{
  readonly pricing: GenerationPricingRow;
  readonly inserted: boolean;
}> {
  const response = await postAction(signal, {
    action: "ensure-pricing-row",
    row: pricingRowToWire(row),
  });
  const pricing = response.pricing_rows?.[0];
  if (!pricing || response.inserted === undefined) {
    throw new Error("ensureGenerationPricingRow: response missing pricing");
  }
  return {
    pricing: pricingRowFromWire(pricing),
    inserted: response.inserted,
  };
}

export async function deleteGenerationPricingRows(
  signal: AbortSignal,
  filter: {
    readonly kind: string;
    readonly provider: string;
    readonly categories: readonly string[];
  },
): Promise<readonly GenerationPricingRow[]> {
  const response = await postAction(signal, {
    action: "delete-pricing-rows",
    filter: {
      kind: filter.kind,
      provider: filter.provider,
      categories: [...filter.categories],
    },
  });
  return (response.pricing_rows ?? []).map(pricingRowFromWire);
}

export async function restoreGenerationPricingRows(
  signal: AbortSignal,
  rows: readonly GenerationPricingRow[],
): Promise<void> {
  await postAction(signal, {
    action: "restore-pricing-rows",
    rows: rows.map(pricingRowToWire),
  });
}

export async function readGenerationUploadedFiles(
  signal: AbortSignal,
  filter: {
    readonly orgId?: string;
    readonly userId?: string;
    readonly externalId?: string;
  },
): Promise<readonly GenerationUploadedFile[]> {
  const response = await postAction(signal, {
    action: "read-uploaded-files",
    org_id: filter.orgId,
    user_id: filter.userId,
    external_id: filter.externalId,
  });
  return (response.uploaded_files ?? []).map(uploadedFileFromWire);
}

export async function readGenerationUsageEvents(
  signal: AbortSignal,
  filter: {
    readonly orgId?: string;
    readonly userId?: string;
    readonly runId?: string;
    readonly kind?: string;
    readonly provider?: string;
    readonly category?: string;
  },
): Promise<readonly GenerationUsageEvent[]> {
  const response = await postAction(signal, {
    action: "read-usage-events",
    org_id: filter.orgId,
    user_id: filter.userId,
    run_id: filter.runId,
    kind: filter.kind,
    provider: filter.provider,
    category: filter.category,
  });
  return (response.usage_events ?? []).map(usageEventFromWire);
}

export async function readGenerationJobs(
  signal: AbortSignal,
  filter: {
    readonly id?: string;
    readonly orgId?: string;
    readonly userId?: string;
  },
): Promise<readonly GenerationJob[]> {
  const response = await postAction(signal, {
    action: "read-generation-jobs",
    id: filter.id,
    org_id: filter.orgId,
    user_id: filter.userId,
  });
  return (response.generation_jobs ?? []).map(generationJobFromWire);
}

export async function readGenerationOrgCredits(
  signal: AbortSignal,
  orgId: string,
): Promise<number | null> {
  const response = await postAction(signal, {
    action: "read-org-credits",
    org_id: orgId,
  });
  return response.org_credits ?? null;
}

export async function seedGenerationBehaviorCount(
  signal: AbortSignal,
  fixture: GenerationFixture,
  behaviorKey: string,
  count: number,
): Promise<void> {
  await postAction(signal, {
    action: "seed-behavior-count",
    org_id: fixture.orgId,
    user_id: fixture.userId,
    behavior_key: behaviorKey,
    count,
  });
}

export async function seedGenerationRunBuiltInAdmissions(
  signal: AbortSignal,
  args: {
    readonly runId: string;
    readonly entries: readonly {
      readonly kind: string;
      readonly status?: string;
      readonly expiresAt: Date;
    }[];
  },
): Promise<void> {
  await postAction(signal, {
    action: "seed-run-built-in-admissions",
    run_id: args.runId,
    entries: args.entries.map((entry) => {
      return {
        kind: entry.kind,
        status: entry.status,
        expires_at: entry.expiresAt.toISOString(),
      };
    }),
  });
}

export async function readGenerationBehaviorCounts(
  signal: AbortSignal,
  fixture: GenerationFixture,
  behaviorKey?: string,
): Promise<readonly BehaviorCount[]> {
  const response = await postAction(signal, {
    action: "read-behavior-counts",
    org_id: fixture.orgId,
    user_id: fixture.userId,
    behavior_key: behaviorKey,
  });
  return (response.behavior_counts ?? []).map(behaviorCountFromWire);
}

export async function readGenerationBehaviorCount(
  signal: AbortSignal,
  fixture: GenerationFixture,
  behaviorKey: string,
): Promise<number> {
  const rows = await readGenerationBehaviorCounts(signal, fixture, behaviorKey);
  return rows[0]?.count ?? 0;
}
