import { randomUUID } from "node:crypto";

import {
  zeroSecretsByNameContract,
  zeroSecretsContract,
} from "@vm0/api-contracts/contracts/zero-secrets";
import type { SecretResponse } from "@vm0/api-contracts/contracts/secrets";

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

export interface ZeroSecretRouteFixture {
  readonly userId: string;
  readonly orgId: string;
  readonly name: string;
}

interface SetZeroSecretRouteOptions {
  readonly value?: string;
  readonly description?: string;
}

interface CreateZeroSecretRouteOptions extends SetZeroSecretRouteOptions {
  readonly userId?: string;
  readonly orgId?: string;
  readonly name?: string;
}

export function authHeaders(): { readonly authorization: string } {
  return { authorization: "Bearer clerk-session" };
}

export async function setZeroSecretThroughApi(
  context: TestContext,
  setSession: SetSession,
  fixture: ZeroSecretRouteFixture,
  options: SetZeroSecretRouteOptions = {},
): Promise<SecretResponse> {
  setSession(fixture.userId, fixture.orgId, "org:admin");
  const client = setupApp({ context })(zeroSecretsContract);
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

export async function createZeroSecretThroughApi(
  context: TestContext,
  setSession: SetSession,
  options: CreateZeroSecretRouteOptions = {},
): Promise<ZeroSecretRouteFixture> {
  const fixture = {
    userId: options.userId ?? `user_${randomUUID().slice(0, 8)}`,
    orgId: options.orgId ?? `org_${randomUUID().slice(0, 8)}`,
    name: options.name ?? `SECRET_${randomUUID().slice(0, 8).toUpperCase()}`,
  };

  await setZeroSecretThroughApi(context, setSession, fixture, options);
  return fixture;
}

export async function deleteZeroSecretThroughApi(
  context: TestContext,
  setSession: SetSession,
  fixture: ZeroSecretRouteFixture,
): Promise<void> {
  setSession(fixture.userId, fixture.orgId, "org:admin");
  const client = setupApp({ context })(zeroSecretsByNameContract);
  await accept(
    client.delete({
      params: { name: fixture.name },
      headers: authHeaders(),
    }),
    [204, 404],
  );
}

export async function listZeroSecretsThroughApi(
  context: TestContext,
): Promise<readonly SecretResponse[]> {
  const client = setupApp({ context })(zeroSecretsContract);
  const response = await accept(
    client.list({
      headers: authHeaders(),
    }),
    [200],
  );
  return response.body.secrets;
}
