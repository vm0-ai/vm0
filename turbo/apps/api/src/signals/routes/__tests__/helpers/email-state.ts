import type {
  TestEmailStateActionBody,
  TestEmailStateActionResponse,
} from "@vm0/api-contracts/contracts/test-email-state";

import { createAppWithRoutes } from "../../../../app-factory-core";
import type { TestContext } from "../../../../__tests__/test-context";
import { testEmailStateRoutes } from "../../test-email-state";

const EMAIL_STATE_ROUTE = "/api/test/email-state";

interface SeedEmailOutboxOptions {
  readonly subject: string;
  readonly to: string;
  readonly status?: string;
  readonly attempts?: number;
  readonly createdAt?: Date;
  readonly nextRetryAt?: Date | null;
}

interface EmailOutboxRow {
  readonly status: string;
  readonly attempts: number;
  readonly lastError: string | null;
}

function requestEmailState(
  context: TestContext,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const app = createAppWithRoutes({
    signal: context.signal,
    routes: testEmailStateRoutes,
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
  body: TestEmailStateActionBody,
): Promise<TestEmailStateActionResponse> {
  const response = await requestEmailState(
    context,
    `${EMAIL_STATE_ROUTE}/action`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  await expectOk(response, `email state action ${body.action}`);
  return await readJson<TestEmailStateActionResponse>(response);
}

function dateToWire(value: Date | null | undefined): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  return value ? value.toISOString() : null;
}

export async function seedEmailOutboxState(
  context: TestContext,
  options: SeedEmailOutboxOptions,
): Promise<void> {
  await postAction(context, {
    action: "seed-outbox",
    subject: options.subject,
    to: options.to,
    status: options.status,
    attempts: options.attempts,
    created_at: dateToWire(options.createdAt) ?? undefined,
    next_retry_at: dateToWire(options.nextRetryAt),
  });
}

export async function deleteEmailOutboxBySubjectState(
  context: TestContext,
  subject: string,
): Promise<void> {
  await postAction(context, {
    action: "delete-outbox-by-subject",
    subject,
  });
}

export async function touchEmailOutboxState(
  context: TestContext,
  subject: string,
  createdAt?: Date,
): Promise<void> {
  await postAction(context, {
    action: "touch-outbox",
    subject,
    created_at: dateToWire(createdAt) ?? undefined,
  });
}

export async function readEmailOutboxBySubjectState(
  context: TestContext,
  subject: string,
): Promise<EmailOutboxRow | null> {
  const response = await postAction(context, {
    action: "get-outbox-by-subject",
    subject,
  });
  const row = response.outbox_row as
    | {
        readonly status: string;
        readonly attempts: number;
        readonly last_error: string | null;
      }
    | null
    | undefined;
  return row
    ? {
        status: row.status,
        attempts: row.attempts,
        lastError: row.last_error,
      }
    : null;
}

export async function seedEmailSuppressionState(
  context: TestContext,
  address: string,
): Promise<void> {
  await postAction(context, {
    action: "seed-suppression",
    email: address,
  });
}

export async function deleteEmailSuppressionState(
  context: TestContext,
  address: string,
): Promise<void> {
  await postAction(context, {
    action: "delete-suppression",
    email: address,
  });
}
