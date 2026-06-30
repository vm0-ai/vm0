import { randomUUID } from "node:crypto";

import { command } from "ccstate";
import {
  testGenerationStateContract,
  type TestGenerationStateActionBody,
  type TestGenerationStatePricingRow,
} from "@vm0/api-contracts/contracts/test-generation-state";
import { builtInGenerationJobs } from "@vm0/db/schema/built-in-generation-job";
import { orgMembersMetadata } from "@vm0/db/schema/org-members-metadata";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { runUploadedFiles } from "@vm0/db/schema/run-uploaded-file";
import { usageEvent } from "@vm0/db/schema/usage-event";
import { usagePricing } from "@vm0/db/schema/usage-pricing";
import { userBehaviorCount } from "@vm0/db/schema/user-behavior-count";
import { and, eq, inArray, sql, type SQL } from "drizzle-orm";

import { bodyResultOf } from "../context/request";
import { request$ } from "../context/hono";
import { writeDb$, type Db } from "../external/db";
import type { RouteEntry } from "../route-entry";
import {
  isTestEndpointAllowed,
  testEndpointNotFoundResponse,
} from "./test-oauth-provider-helpers";

const actionBody$ = bodyResultOf(testGenerationStateContract.action);

type GenerationAction<TAction extends TestGenerationStateActionBody["action"]> =
  Extract<TestGenerationStateActionBody, { action: TAction }>;

function actionOk() {
  return { status: 200 as const, body: { ok: true as const } };
}

function badRequest(message: string) {
  return { status: 400 as const, body: { error: message } };
}

function pricingRowToWire(row: {
  readonly kind: string;
  readonly provider: string;
  readonly category: string;
  readonly unitPrice: number;
  readonly unitSize: number;
}): TestGenerationStatePricingRow {
  return {
    kind: row.kind,
    provider: row.provider,
    category: row.category,
    unit_price: row.unitPrice,
    unit_size: row.unitSize,
  };
}

function pricingRowFromWire(row: TestGenerationStatePricingRow) {
  return {
    kind: row.kind,
    provider: row.provider,
    category: row.category,
    unitPrice: row.unit_price,
    unitSize: row.unit_size,
  };
}

function usageEventToWire(row: typeof usageEvent.$inferSelect) {
  return {
    id: row.id,
    run_id: row.runId,
    idempotency_key: row.idempotencyKey,
    org_id: row.orgId,
    user_id: row.userId,
    kind: row.kind,
    provider: row.provider,
    category: row.category,
    quantity: row.quantity,
    credits_charged: row.creditsCharged,
    status: row.status,
    billing_error: row.billingError,
  };
}

function uploadedFileToWire(row: typeof runUploadedFiles.$inferSelect) {
  return {
    id: row.id,
    run_id: row.runId,
    source: row.source,
    external_id: row.externalId,
    user_id: row.userId,
    org_id: row.orgId,
    filename: row.filename,
    content_type: row.contentType,
    size_bytes: row.sizeBytes,
    url: row.url,
    metadata: row.metadata,
  };
}

function generationJobToWire(row: typeof builtInGenerationJobs.$inferSelect) {
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    org_id: row.orgId,
    user_id: row.userId,
    run_id: row.runId,
    request: row.request,
    result: row.result ?? null,
    error: row.error ?? null,
  };
}

async function seedFixtureForAction(
  db: Db,
  body: GenerationAction<"seed-fixture">,
  signal: AbortSignal,
) {
  const orgId = body.org_id ?? `org_${randomUUID()}`;
  const userId = body.user_id ?? `user_${randomUUID()}`;

  await db
    .insert(orgMetadata)
    .values({
      orgId,
      tier: body.tier ?? "free",
      credits: body.credits ?? 10_000,
    })
    .onConflictDoUpdate({
      target: orgMetadata.orgId,
      set: {
        tier: body.tier ?? "free",
        credits: body.credits ?? 10_000,
        updatedAt: sql`now()`,
      },
    });
  signal.throwIfAborted();

  await db
    .insert(orgMembersMetadata)
    .values({ orgId, userId })
    .onConflictDoUpdate({
      target: [orgMembersMetadata.orgId, orgMembersMetadata.userId],
      set: { updatedAt: sql`now()` },
    });
  signal.throwIfAborted();

  return {
    status: 200 as const,
    body: {
      ok: true as const,
      fixture: { org_id: orgId, user_id: userId },
    },
  };
}

async function deleteFixtureForAction(
  db: Db,
  body: GenerationAction<"delete-fixture">,
  signal: AbortSignal,
) {
  const orgId = body.fixture.org_id;
  const userId = body.fixture.user_id;

  await db
    .delete(builtInGenerationJobs)
    .where(
      and(
        eq(builtInGenerationJobs.orgId, orgId),
        eq(builtInGenerationJobs.userId, userId),
      ),
    );
  signal.throwIfAborted();

  await db
    .delete(runUploadedFiles)
    .where(
      and(
        eq(runUploadedFiles.orgId, orgId),
        eq(runUploadedFiles.userId, userId),
      ),
    );
  signal.throwIfAborted();

  await db
    .delete(userBehaviorCount)
    .where(
      and(
        eq(userBehaviorCount.orgId, orgId),
        eq(userBehaviorCount.userId, userId),
      ),
    );
  signal.throwIfAborted();

  await db
    .delete(orgMembersMetadata)
    .where(
      and(
        eq(orgMembersMetadata.orgId, orgId),
        eq(orgMembersMetadata.userId, userId),
      ),
    );
  signal.throwIfAborted();

  await db.delete(orgMetadata).where(eq(orgMetadata.orgId, orgId));
  signal.throwIfAborted();

  return actionOk();
}

async function upsertPricingRowsForAction(
  db: Db,
  body: GenerationAction<"upsert-pricing-rows" | "restore-pricing-rows">,
  signal: AbortSignal,
) {
  if (body.rows.length === 0) {
    return actionOk();
  }

  await db
    .insert(usagePricing)
    .values(body.rows.map(pricingRowFromWire))
    .onConflictDoUpdate({
      target: [usagePricing.kind, usagePricing.provider, usagePricing.category],
      set: {
        unitPrice: sql`excluded.unit_price`,
        unitSize: sql`excluded.unit_size`,
        updatedAt: sql`now()`,
      },
    });
  signal.throwIfAborted();

  return actionOk();
}

async function ensurePricingRowForAction(
  db: Db,
  body: GenerationAction<"ensure-pricing-row">,
  signal: AbortSignal,
) {
  const [existing] = await db
    .select({
      kind: usagePricing.kind,
      provider: usagePricing.provider,
      category: usagePricing.category,
      unitPrice: usagePricing.unitPrice,
      unitSize: usagePricing.unitSize,
    })
    .from(usagePricing)
    .where(
      and(
        eq(usagePricing.kind, body.row.kind),
        eq(usagePricing.provider, body.row.provider),
        eq(usagePricing.category, body.row.category),
      ),
    )
    .limit(1);
  signal.throwIfAborted();

  if (existing) {
    return {
      status: 200 as const,
      body: {
        ok: true as const,
        inserted: false,
        pricing_rows: [pricingRowToWire(existing)],
      },
    };
  }

  await db.insert(usagePricing).values(pricingRowFromWire(body.row));
  signal.throwIfAborted();

  return {
    status: 200 as const,
    body: {
      ok: true as const,
      inserted: true,
      pricing_rows: [body.row],
    },
  };
}

async function deletePricingRowsForAction(
  db: Db,
  body: GenerationAction<"delete-pricing-rows">,
  signal: AbortSignal,
) {
  if (body.filter.categories.length === 0) {
    return {
      status: 200 as const,
      body: { ok: true as const, pricing_rows: [] },
    };
  }

  const where = and(
    eq(usagePricing.kind, body.filter.kind),
    eq(usagePricing.provider, body.filter.provider),
    inArray(usagePricing.category, body.filter.categories),
  );
  const rows = await db
    .select({
      kind: usagePricing.kind,
      provider: usagePricing.provider,
      category: usagePricing.category,
      unitPrice: usagePricing.unitPrice,
      unitSize: usagePricing.unitSize,
    })
    .from(usagePricing)
    .where(where);
  signal.throwIfAborted();

  await db.delete(usagePricing).where(where);
  signal.throwIfAborted();

  return {
    status: 200 as const,
    body: {
      ok: true as const,
      pricing_rows: rows.map(pricingRowToWire),
    },
  };
}

async function readUploadedFilesForAction(
  db: Db,
  body: GenerationAction<"read-uploaded-files">,
  signal: AbortSignal,
) {
  const conditions: SQL[] = [];
  if (body.org_id) {
    conditions.push(eq(runUploadedFiles.orgId, body.org_id));
  }
  if (body.user_id) {
    conditions.push(eq(runUploadedFiles.userId, body.user_id));
  }
  if (body.external_id) {
    conditions.push(eq(runUploadedFiles.externalId, body.external_id));
  }
  if (conditions.length === 0) {
    return badRequest("read-uploaded-files requires at least one filter");
  }

  const rows = await db
    .select()
    .from(runUploadedFiles)
    .where(and(...conditions));
  signal.throwIfAborted();

  return {
    status: 200 as const,
    body: {
      ok: true as const,
      uploaded_files: rows.map(uploadedFileToWire),
    },
  };
}

async function readUsageEventsForAction(
  db: Db,
  body: GenerationAction<"read-usage-events">,
  signal: AbortSignal,
) {
  const conditions: SQL[] = [];
  if (body.org_id) {
    conditions.push(eq(usageEvent.orgId, body.org_id));
  }
  if (body.user_id) {
    conditions.push(eq(usageEvent.userId, body.user_id));
  }
  if (body.run_id) {
    conditions.push(eq(usageEvent.runId, body.run_id));
  }
  if (body.kind) {
    conditions.push(eq(usageEvent.kind, body.kind));
  }
  if (body.provider) {
    conditions.push(eq(usageEvent.provider, body.provider));
  }
  if (body.category) {
    conditions.push(eq(usageEvent.category, body.category));
  }
  if (conditions.length === 0) {
    return badRequest("read-usage-events requires at least one filter");
  }

  const rows = await db
    .select()
    .from(usageEvent)
    .where(and(...conditions));
  signal.throwIfAborted();

  return {
    status: 200 as const,
    body: { ok: true as const, usage_events: rows.map(usageEventToWire) },
  };
}

async function readGenerationJobsForAction(
  db: Db,
  body: GenerationAction<"read-generation-jobs">,
  signal: AbortSignal,
) {
  const conditions: SQL[] = [];
  if (body.id) {
    conditions.push(eq(builtInGenerationJobs.id, body.id));
  }
  if (body.org_id) {
    conditions.push(eq(builtInGenerationJobs.orgId, body.org_id));
  }
  if (body.user_id) {
    conditions.push(eq(builtInGenerationJobs.userId, body.user_id));
  }
  if (conditions.length === 0) {
    return badRequest("read-generation-jobs requires at least one filter");
  }

  const rows = await db
    .select()
    .from(builtInGenerationJobs)
    .where(and(...conditions));
  signal.throwIfAborted();

  return {
    status: 200 as const,
    body: {
      ok: true as const,
      generation_jobs: rows.map(generationJobToWire),
    },
  };
}

async function readOrgCreditsForAction(
  db: Db,
  body: GenerationAction<"read-org-credits">,
  signal: AbortSignal,
) {
  const [row] = await db
    .select({ credits: orgMetadata.credits })
    .from(orgMetadata)
    .where(eq(orgMetadata.orgId, body.org_id))
    .limit(1);
  signal.throwIfAborted();

  return {
    status: 200 as const,
    body: { ok: true as const, org_credits: row?.credits ?? null },
  };
}

async function seedBehaviorCountForAction(
  db: Db,
  body: GenerationAction<"seed-behavior-count">,
  signal: AbortSignal,
) {
  await db
    .insert(userBehaviorCount)
    .values({
      orgId: body.org_id,
      userId: body.user_id,
      behaviorKey: body.behavior_key,
      count: body.count,
    })
    .onConflictDoUpdate({
      target: [
        userBehaviorCount.orgId,
        userBehaviorCount.userId,
        userBehaviorCount.behaviorKey,
      ],
      set: { count: body.count, lastAt: sql`now()` },
    });
  signal.throwIfAborted();

  return actionOk();
}

async function readBehaviorCountsForAction(
  db: Db,
  body: GenerationAction<"read-behavior-counts">,
  signal: AbortSignal,
) {
  const conditions = [
    eq(userBehaviorCount.orgId, body.org_id),
    eq(userBehaviorCount.userId, body.user_id),
  ];
  if (body.behavior_key) {
    conditions.push(eq(userBehaviorCount.behaviorKey, body.behavior_key));
  }

  const rows = await db
    .select({
      behaviorKey: userBehaviorCount.behaviorKey,
      count: userBehaviorCount.count,
    })
    .from(userBehaviorCount)
    .where(and(...conditions));
  signal.throwIfAborted();

  return {
    status: 200 as const,
    body: {
      ok: true as const,
      behavior_counts: rows.map((row) => {
        return { behavior_key: row.behaviorKey, count: row.count };
      }),
    },
  };
}

const mutateGenerationState$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!isTestEndpointAllowed(get(request$))) {
      return testEndpointNotFoundResponse();
    }

    const bodyResult = await get(actionBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const db = set(writeDb$);
    const body = bodyResult.data;

    switch (body.action) {
      case "seed-fixture": {
        return await seedFixtureForAction(db, body, signal);
      }
      case "delete-fixture": {
        return await deleteFixtureForAction(db, body, signal);
      }
      case "upsert-pricing-rows": {
        return await upsertPricingRowsForAction(db, body, signal);
      }
      case "ensure-pricing-row": {
        return await ensurePricingRowForAction(db, body, signal);
      }
      case "delete-pricing-rows": {
        return await deletePricingRowsForAction(db, body, signal);
      }
      case "restore-pricing-rows": {
        return await upsertPricingRowsForAction(db, body, signal);
      }
      case "read-uploaded-files": {
        return await readUploadedFilesForAction(db, body, signal);
      }
      case "read-usage-events": {
        return await readUsageEventsForAction(db, body, signal);
      }
      case "read-generation-jobs": {
        return await readGenerationJobsForAction(db, body, signal);
      }
      case "read-org-credits": {
        return await readOrgCreditsForAction(db, body, signal);
      }
      case "seed-behavior-count": {
        return await seedBehaviorCountForAction(db, body, signal);
      }
      case "read-behavior-counts": {
        return await readBehaviorCountsForAction(db, body, signal);
      }
    }
  },
);

export const testGenerationStateRoutes: readonly RouteEntry[] = [
  {
    route: testGenerationStateContract.action,
    handler: mutateGenerationState$,
  },
];
