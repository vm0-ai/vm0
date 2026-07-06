import { command } from "ccstate";
import type {
  TestOnboardingStatusStateActionBody,
  TestOnboardingStatusStateActionResponse,
  TestOnboardingStatusStateFixture,
} from "@vm0/api-contracts/contracts/test-onboarding-status-state";

import { createAppWithRoutes } from "../../../../app-factory-core";
import { testOnboardingStatusStateRoutes } from "../../test-onboarding-status-state";

const ONBOARDING_STATUS_STATE_ROUTE = "/api/test/onboarding-status-state";

interface DefaultAgentValues {
  readonly displayName?: string | null;
  readonly description?: string | null;
  readonly sound?: string | null;
}

interface OnboardingSeedValues {
  readonly defaultAgent?: DefaultAgentValues;
  readonly onboardingPaymentPending?: boolean;
  readonly onboardingComplete?: boolean;
  readonly tier?: string;
}

export interface OnboardingStatusFixture {
  readonly orgId: string;
  readonly userId: string;
  readonly composeId: string | null;
}

function requestOnboardingStatusState(
  signal: AbortSignal,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const app = createAppWithRoutes({
    signal,
    routes: testOnboardingStatusStateRoutes,
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
  body: TestOnboardingStatusStateActionBody,
): Promise<TestOnboardingStatusStateActionResponse> {
  const response = await requestOnboardingStatusState(
    signal,
    `${ONBOARDING_STATUS_STATE_ROUTE}/action`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  signal.throwIfAborted();
  expectOk(response, `onboarding status state action ${body.action}`);
  signal.throwIfAborted();
  const result =
    await readJson<TestOnboardingStatusStateActionResponse>(response);
  signal.throwIfAborted();
  return result;
}

function fixtureFromWire(
  fixture: TestOnboardingStatusStateFixture,
): OnboardingStatusFixture {
  return {
    orgId: fixture.org_id,
    userId: fixture.user_id,
    composeId: fixture.compose_id,
  };
}

function fixtureToWire(
  fixture: OnboardingStatusFixture,
): TestOnboardingStatusStateFixture {
  return {
    org_id: fixture.orgId,
    user_id: fixture.userId,
    compose_id: fixture.composeId,
  };
}

function seedValuesToWire(
  values: OnboardingSeedValues,
): TestOnboardingStatusStateActionBody {
  return {
    action: "seed-org",
    default_agent: values.defaultAgent
      ? {
          display_name: values.defaultAgent.displayName,
          description: values.defaultAgent.description,
          sound: values.defaultAgent.sound,
        }
      : undefined,
    onboarding_payment_pending: values.onboardingPaymentPending,
    onboarding_complete: values.onboardingComplete,
    tier: values.tier,
  };
}

export const seedOnboardingStatusOrg$ = command(
  async (
    _,
    values: OnboardingSeedValues,
    signal: AbortSignal,
  ): Promise<OnboardingStatusFixture> => {
    const response = await postAction(signal, seedValuesToWire(values));
    if (!response.fixture) {
      throw new Error("seedOnboardingStatusOrg$: response missing fixture");
    }
    return fixtureFromWire(response.fixture);
  },
);

export const deleteOnboardingStatusOrg$ = command(
  async (
    _,
    fixture: OnboardingStatusFixture,
    signal: AbortSignal,
  ): Promise<void> => {
    await postAction(signal, {
      action: "delete-org",
      fixture: fixtureToWire(fixture),
    });
  },
);
