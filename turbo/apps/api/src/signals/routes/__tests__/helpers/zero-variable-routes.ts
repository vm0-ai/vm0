import { randomUUID } from "node:crypto";

import {
  zeroVariablesByNameContract,
  zeroVariablesContract,
} from "@vm0/api-contracts/contracts/zero-secrets";
import type { VariableResponse } from "@vm0/api-contracts/contracts/variables";

import {
  accept,
  setupApp,
  type TestContext,
} from "../../../../__tests__/test-helpers";

type ClerkOrgRole = "org:admin" | "org:member";

type SetSession = (
  userId: string,
  orgId: string | null,
  orgRole?: ClerkOrgRole,
) => void;

export interface ZeroVariableRouteFixture {
  readonly userId: string;
  readonly orgId: string;
  readonly name: string;
}

interface SetZeroVariableRouteOptions {
  readonly value?: string;
  readonly description?: string;
}

interface CreateZeroVariableRouteOptions extends SetZeroVariableRouteOptions {
  readonly userId?: string;
  readonly orgId?: string;
  readonly name?: string;
}

export function authHeaders(): { readonly authorization: string } {
  return { authorization: "Bearer clerk-session" };
}

export async function setZeroVariableThroughApi(
  context: TestContext,
  setSession: SetSession,
  fixture: ZeroVariableRouteFixture,
  options: SetZeroVariableRouteOptions = {},
): Promise<VariableResponse> {
  setSession(fixture.userId, fixture.orgId, "org:admin");
  const client = setupApp({ context })(zeroVariablesContract);
  const response = await accept(
    client.set({
      headers: authHeaders(),
      body: {
        name: fixture.name,
        value: options.value ?? `value-${fixture.name}`,
        ...(options.description !== undefined
          ? { description: options.description }
          : {}),
      },
    }),
    [200],
  );
  return response.body;
}

export async function createZeroVariableThroughApi(
  context: TestContext,
  setSession: SetSession,
  options: CreateZeroVariableRouteOptions = {},
): Promise<ZeroVariableRouteFixture> {
  const fixture = {
    userId: options.userId ?? `user_${randomUUID().slice(0, 8)}`,
    orgId: options.orgId ?? `org_${randomUUID().slice(0, 8)}`,
    name: options.name ?? `VAR_${randomUUID().slice(0, 8).toUpperCase()}`,
  };

  await setZeroVariableThroughApi(context, setSession, fixture, options);
  return fixture;
}

export async function deleteZeroVariableThroughApi(
  context: TestContext,
  setSession: SetSession,
  fixture: ZeroVariableRouteFixture,
): Promise<void> {
  setSession(fixture.userId, fixture.orgId, "org:admin");
  const client = setupApp({ context })(zeroVariablesByNameContract);
  await accept(
    client.delete({
      params: { name: fixture.name },
      headers: authHeaders(),
    }),
    [204, 404],
  );
}

export async function listZeroVariablesThroughApi(
  context: TestContext,
): Promise<readonly VariableResponse[]> {
  const client = setupApp({ context })(zeroVariablesContract);
  const response = await accept(
    client.list({
      headers: authHeaders(),
    }),
    [200],
  );
  return response.body.variables;
}
