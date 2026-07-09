import { command } from "ccstate";
import type {
  TestRelationshipStateActionBody,
  TestRelationshipStateActionResponse,
  TestRelationshipStateFixture,
} from "@vm0/api-contracts/contracts/test-relationship-state";

import { createAppWithRoutes } from "../../../../app-factory-core";
import { testRelationshipStateRoutes } from "../../test-relationship-state";

const RELATIONSHIP_STATE_ROUTE = "/api/test/relationship-state";

export interface RelationshipFixture {
  readonly orgId: string;
  readonly userId: string;
}

export interface RelationshipAliasRaceTrigger {
  readonly displayName: string;
  readonly functionName: string;
  readonly identityKey: string;
  readonly triggerName: string;
}

function requestRelationshipState(
  signal: AbortSignal,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const app = createAppWithRoutes({
    signal,
    routes: testRelationshipStateRoutes,
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
  body: TestRelationshipStateActionBody,
): Promise<TestRelationshipStateActionResponse> {
  const response = await requestRelationshipState(
    signal,
    `${RELATIONSHIP_STATE_ROUTE}/action`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  signal.throwIfAborted();
  expectOk(response, `relationship state action ${body.action}`);
  signal.throwIfAborted();
  const result = await readJson<TestRelationshipStateActionResponse>(response);
  signal.throwIfAborted();
  return result;
}

function fixtureToWire(
  fixture: RelationshipFixture,
): TestRelationshipStateFixture {
  return { org_id: fixture.orgId, user_id: fixture.userId };
}

export const deleteRelationshipRowsForFixture$ = command(
  async (
    _,
    fixture: RelationshipFixture,
    signal: AbortSignal,
  ): Promise<void> => {
    await postAction(signal, {
      action: "delete-relationships",
      fixture: fixtureToWire(fixture),
    });
  },
);

export const seedRelationshipRows$ = command(
  async (
    _,
    args: { readonly fixture: RelationshipFixture; readonly count: number },
    signal: AbortSignal,
  ): Promise<void> => {
    await postAction(signal, {
      action: "seed-relationships",
      fixture: fixtureToWire(args.fixture),
      count: args.count,
    });
  },
);

export const seedRuntimeInjectionMemoryRows$ = command(
  async (
    _,
    fixture: RelationshipFixture,
    signal: AbortSignal,
  ): Promise<void> => {
    await postAction(signal, {
      action: "seed-runtime-injection-memories",
      fixture: fixtureToWire(fixture),
    });
  },
);

export const seedRuntimeInjectionWindowMemoryRows$ = command(
  async (
    _,
    fixture: RelationshipFixture,
    signal: AbortSignal,
  ): Promise<void> => {
    await postAction(signal, {
      action: "seed-runtime-injection-window-memories",
      fixture: fixtureToWire(fixture),
    });
  },
);

export const createRelationshipAliasRaceTrigger$ = command(
  async (
    _,
    args: {
      readonly fixture: RelationshipFixture;
      readonly trigger: RelationshipAliasRaceTrigger;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    await postAction(signal, {
      action: "create-alias-race-trigger",
      fixture: fixtureToWire(args.fixture),
      display_name: args.trigger.displayName,
      identity_key: args.trigger.identityKey,
      function_name: args.trigger.functionName,
      trigger_name: args.trigger.triggerName,
    });
  },
);

export const deleteRelationshipAliasRaceTrigger$ = command(
  async (
    _,
    trigger: Pick<RelationshipAliasRaceTrigger, "functionName" | "triggerName">,
    signal: AbortSignal,
  ): Promise<void> => {
    await postAction(signal, {
      action: "delete-alias-race-trigger",
      function_name: trigger.functionName,
      trigger_name: trigger.triggerName,
    });
  },
);
