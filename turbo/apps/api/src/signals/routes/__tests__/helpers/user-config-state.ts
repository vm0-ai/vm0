import {
  testUserConfigStateContract,
  type TestUserConfigStateActionBody,
  type TestUserConfigStateActionResponse,
} from "@vm0/api-contracts/contracts/test-user-config-state";

import { accept, setupApp } from "../../../../__tests__/test-helpers";
import type { TestContext } from "../../../../__tests__/test-context";
import { testUserConfigStateRoutes } from "../../test-user-config-state";

interface UserScope {
  readonly orgId: string;
  readonly userId: string;
}

async function postAction(
  context: TestContext,
  body: TestUserConfigStateActionBody,
): Promise<TestUserConfigStateActionResponse> {
  const response = await accept(
    setupApp({
      context,
      routes: testUserConfigStateRoutes,
    })(testUserConfigStateContract).action({ body }),
    [200],
  );
  return response.body;
}

export async function seedUserSecret(
  context: TestContext,
  args: UserScope & {
    readonly name: string;
    readonly value: string;
    readonly description?: string | null;
  },
): Promise<void> {
  await postAction(context, {
    action: "set-secret",
    org_id: args.orgId,
    user_id: args.userId,
    name: args.name,
    value: args.value,
    description: args.description ?? null,
  });
}

export async function seedUserVariable(
  context: TestContext,
  args: UserScope & {
    readonly name: string;
    readonly value: string;
    readonly description?: string | null;
  },
): Promise<void> {
  await postAction(context, {
    action: "set-variable",
    org_id: args.orgId,
    user_id: args.userId,
    name: args.name,
    value: args.value,
    description: args.description ?? null,
  });
}

export async function readUserSecrets(
  context: TestContext,
  args: UserScope,
): Promise<NonNullable<TestUserConfigStateActionResponse["secrets"]>> {
  const response = await postAction(context, {
    action: "list-secrets",
    org_id: args.orgId,
    user_id: args.userId,
  });
  return response.secrets ?? [];
}
