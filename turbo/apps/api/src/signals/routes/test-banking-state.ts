import { command } from "ccstate";
import {
  testBankingStateContract,
  type TestBankingStateActionBody,
} from "@vm0/api-contracts/contracts/test-banking-state";
import {
  bankingAccessAuditEvents,
  bankingAccounts,
  bankingAgentEnablements,
  bankingConnections,
  type BankingConnectionStatus,
  type BankingOperationScope,
} from "@vm0/db/schema/banking";
import { and, asc, eq } from "drizzle-orm";

import { bodyResultOf } from "../context/request";
import { request$ } from "../context/hono";
import { writeDb$, type Db } from "../external/db";
import type { RouteEntry } from "../route-entry";
import {
  isTestEndpointAllowed,
  testEndpointNotFoundResponse,
} from "./test-oauth-provider-helpers";

const actionBody$ = bodyResultOf(testBankingStateContract.action);

type BankingAction<TAction extends TestBankingStateActionBody["action"]> =
  Extract<TestBankingStateActionBody, { action: TAction }>;

function actionOk(extra: Record<string, unknown> = {}) {
  return { status: 200 as const, body: { ok: true as const, ...extra } };
}

async function seedFixtureForAction(
  db: Db,
  body: BankingAction<"seed-fixture">,
  signal: AbortSignal,
) {
  const [connection] = await db
    .insert(bankingConnections)
    .values({
      orgId: body.org_id,
      userId: body.user_id,
      providerCustomerId: body.provider_customer_id,
      status: body.connection_status as BankingConnectionStatus,
      revokedAt:
        body.connection_status === "revoked" ? new Date("2026-01-01") : null,
    })
    .returning({ id: bankingConnections.id });
  signal.throwIfAborted();
  if (!connection) {
    throw new Error("seed banking fixture: connection insert returned no row");
  }

  await db.insert(bankingAccounts).values([
    {
      connectionId: connection.id,
      orgId: body.org_id,
      userId: body.user_id,
      providerAccountId: body.enabled_account_id,
      displayName: "Everyday Checking",
      institutionName: "Example Bank",
      accountType: "checking",
      accountNumberLast4: "6789",
      enabled: true,
    },
    {
      connectionId: connection.id,
      orgId: body.org_id,
      userId: body.user_id,
      providerAccountId: body.disabled_account_id,
      displayName: "Old Savings",
      institutionName: "Example Bank",
      accountType: "savings",
      accountNumberLast4: "4321",
      enabled: false,
    },
  ]);
  signal.throwIfAborted();

  await db.insert(bankingAgentEnablements).values({
    orgId: body.org_id,
    userId: body.user_id,
    agentId: body.agent_id,
    connectionId: connection.id,
    accountProviderIds: body.account_provider_ids,
    operationScopes: body.operation_scopes as BankingOperationScope[],
    allowAutomationRuns: body.allow_automation_runs,
  });
  signal.throwIfAborted();

  return actionOk({ connection_id: connection.id });
}

async function deleteFixtureForAction(
  db: Db,
  body: BankingAction<"delete-fixture">,
  signal: AbortSignal,
) {
  await db
    .delete(bankingAccessAuditEvents)
    .where(
      and(
        eq(bankingAccessAuditEvents.orgId, body.org_id),
        eq(bankingAccessAuditEvents.userId, body.user_id),
      ),
    );
  signal.throwIfAborted();
  await db
    .delete(bankingAgentEnablements)
    .where(
      and(
        eq(bankingAgentEnablements.orgId, body.org_id),
        eq(bankingAgentEnablements.userId, body.user_id),
      ),
    );
  signal.throwIfAborted();
  await db
    .delete(bankingAccounts)
    .where(
      and(
        eq(bankingAccounts.orgId, body.org_id),
        eq(bankingAccounts.userId, body.user_id),
      ),
    );
  signal.throwIfAborted();
  await db
    .delete(bankingConnections)
    .where(
      and(
        eq(bankingConnections.orgId, body.org_id),
        eq(bankingConnections.userId, body.user_id),
      ),
    );
  signal.throwIfAborted();
  return actionOk();
}

async function readAuditEventsForAction(
  db: Db,
  body: BankingAction<"read-audit-events">,
  signal: AbortSignal,
) {
  const rows = await db
    .select({
      action: bankingAccessAuditEvents.action,
      status: bankingAccessAuditEvents.status,
      failureCode: bankingAccessAuditEvents.failureCode,
      providerAccountId: bankingAccessAuditEvents.providerAccountId,
      createdAt: bankingAccessAuditEvents.createdAt,
    })
    .from(bankingAccessAuditEvents)
    .where(
      and(
        eq(bankingAccessAuditEvents.orgId, body.org_id),
        eq(bankingAccessAuditEvents.userId, body.user_id),
      ),
    )
    .orderBy(asc(bankingAccessAuditEvents.createdAt));
  signal.throwIfAborted();
  return actionOk({
    audit_events: rows.map((row) => {
      return {
        action: row.action,
        status: row.status,
        failure_code: row.failureCode,
        provider_account_id: row.providerAccountId,
      };
    }),
  });
}

const mutateBankingState$ = command(
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
      case "read-audit-events": {
        return await readAuditEventsForAction(db, body, signal);
      }
    }
  },
);

export const testBankingStateRoutes: readonly RouteEntry[] = [
  {
    route: testBankingStateContract.action,
    handler: mutateBankingState$,
  },
];
