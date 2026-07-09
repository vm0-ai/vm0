import { command } from "ccstate";
import {
  testUsageStateContract,
  type TestUsageStateActionBody,
} from "@vm0/api-contracts/contracts/test-usage-state";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { usagePricing } from "@vm0/db/schema/usage-pricing";
import { and, eq } from "drizzle-orm";

import { bodyResultOf } from "../context/request";
import { request$ } from "../context/hono";
import { writeDb$, type Db } from "../external/db";
import type { RouteEntry } from "../route-entry";
import {
  isTestEndpointAllowed,
  testEndpointNotFoundResponse,
} from "./test-oauth-provider-helpers";

const actionBody$ = bodyResultOf(testUsageStateContract.action);

type UsageAction<TAction extends TestUsageStateActionBody["action"]> = Extract<
  TestUsageStateActionBody,
  { action: TAction }
>;

function actionOk() {
  return { status: 200 as const, body: { ok: true as const } };
}

async function seedUsagePricingForAction(
  db: Db,
  body: UsageAction<"seed-usage-pricing">,
  signal: AbortSignal,
) {
  await db
    .insert(usagePricing)
    .values({
      kind: body.kind ?? "connector",
      provider: body.provider,
      category: body.category,
      unitPrice: body.unit_price,
      unitSize: body.unit_size,
    })
    .onConflictDoUpdate({
      target: [usagePricing.kind, usagePricing.provider, usagePricing.category],
      set: {
        unitPrice: body.unit_price,
        unitSize: body.unit_size,
      },
    });
  signal.throwIfAborted();
  return actionOk();
}

async function deleteUsagePricingForAction(
  db: Db,
  body: UsageAction<"delete-usage-pricing">,
  signal: AbortSignal,
) {
  await db
    .delete(usagePricing)
    .where(
      and(
        eq(usagePricing.kind, body.kind ?? "connector"),
        eq(usagePricing.provider, body.provider),
        eq(usagePricing.category, body.category),
      ),
    );
  signal.throwIfAborted();
  return actionOk();
}

async function setCreditBalanceForAction(
  db: Db,
  body: UsageAction<"set-credit-balance">,
  signal: AbortSignal,
) {
  await db
    .update(orgMetadata)
    .set({ credits: body.credits })
    .where(eq(orgMetadata.orgId, body.org_id));
  signal.throwIfAborted();
  return actionOk();
}

const mutateUsageState$ = command(async ({ get, set }, signal: AbortSignal) => {
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
    case "seed-usage-pricing": {
      return await seedUsagePricingForAction(db, body, signal);
    }
    case "delete-usage-pricing": {
      return await deleteUsagePricingForAction(db, body, signal);
    }
    case "set-credit-balance": {
      return await setCreditBalanceForAction(db, body, signal);
    }
  }
});

export const testUsageStateRoutes: readonly RouteEntry[] = [
  {
    route: testUsageStateContract.action,
    handler: mutateUsageState$,
  },
];
