import type {
  TestBankingStateActionBody,
  TestBankingStateActionResponse,
  TestBankingStateAuditEvent,
} from "@vm0/api-contracts/contracts/test-banking-state";

import { createAppWithRoutes } from "../../../../app-factory-core";
import type { TestContext } from "../../../../__tests__/test-context";
import { testBankingStateRoutes } from "../../test-banking-state";

const BANKING_STATE_ROUTE = "/api/test/banking-state";

interface SeedBankingStateInput {
  readonly orgId: string;
  readonly userId: string;
  readonly agentId: string;
  readonly providerCustomerId: string;
  readonly enabledAccountId: string;
  readonly disabledAccountId: string;
  readonly operationScopes: readonly string[];
  readonly accountProviderIds: readonly string[];
  readonly allowAutomationRuns: boolean;
  readonly connectionStatus: string;
}

interface BankingAuditEvent {
  readonly action: string;
  readonly status: string;
  readonly failureCode: string | null;
  readonly providerAccountId: string | null;
}

function requestBankingState(
  context: TestContext,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const app = createAppWithRoutes({
    signal: context.signal,
    routes: testBankingStateRoutes,
  });
  return Promise.resolve(app.request(path, init));
}

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

async function expectOk(response: Response, operation: string): Promise<void> {
  if (response.ok) {
    return;
  }
  throw new Error(`${operation} failed with ${response.status}`);
}

async function postAction(
  context: TestContext,
  body: TestBankingStateActionBody,
): Promise<TestBankingStateActionResponse> {
  const response = await requestBankingState(
    context,
    `${BANKING_STATE_ROUTE}/action`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  await expectOk(response, `banking state action ${body.action}`);
  return await readJson<TestBankingStateActionResponse>(response);
}

function auditEventFromWire(
  row: TestBankingStateAuditEvent,
): BankingAuditEvent {
  return {
    action: row.action,
    status: row.status,
    failureCode: row.failure_code,
    providerAccountId: row.provider_account_id,
  };
}

export async function seedBankingState(
  context: TestContext,
  input: SeedBankingStateInput,
): Promise<{ readonly connectionId: string }> {
  const response = await postAction(context, {
    action: "seed-fixture",
    org_id: input.orgId,
    user_id: input.userId,
    agent_id: input.agentId,
    provider_customer_id: input.providerCustomerId,
    enabled_account_id: input.enabledAccountId,
    disabled_account_id: input.disabledAccountId,
    operation_scopes: [...input.operationScopes],
    account_provider_ids: [...input.accountProviderIds],
    allow_automation_runs: input.allowAutomationRuns,
    connection_status: input.connectionStatus,
  });
  if (!response.connection_id) {
    throw new Error("seedBankingState missing connection_id");
  }
  return { connectionId: response.connection_id };
}

export async function deleteBankingState(
  context: TestContext,
  input: { readonly orgId: string; readonly userId: string },
): Promise<void> {
  await postAction(context, {
    action: "delete-fixture",
    org_id: input.orgId,
    user_id: input.userId,
  });
}

export async function readBankingAuditEventsState(
  context: TestContext,
  input: { readonly orgId: string; readonly userId: string },
): Promise<readonly BankingAuditEvent[]> {
  const response = await postAction(context, {
    action: "read-audit-events",
    org_id: input.orgId,
    user_id: input.userId,
  });
  return (response.audit_events ?? []).map(auditEventFromWire);
}
