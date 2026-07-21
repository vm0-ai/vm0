import {
  testConnectorCredentialStorageStateContract,
  type TestConnectorCredentialStorageStateActionBody,
  type TestConnectorCredentialStorageStateActionResponse,
} from "@vm0/api-contracts/contracts/test-connector-credential-storage-state";

import { accept, setupApp } from "../../../../__tests__/test-helpers";
import type { TestContext } from "../../../../__tests__/test-context";
import { testConnectorCredentialStorageStateRoutes } from "../../test-connector-credential-storage-state";

async function postAction(
  context: TestContext,
  body: TestConnectorCredentialStorageStateActionBody,
): Promise<TestConnectorCredentialStorageStateActionResponse> {
  const response = await accept(
    setupApp({
      context,
      routes: testConnectorCredentialStorageStateRoutes,
    })(testConnectorCredentialStorageStateContract).action({
      body,
    }),
    [200],
  );
  return response.body;
}

export async function readConnectorCredentialStorageState(
  context: TestContext,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly connectorRef: string;
    readonly secretNames?: readonly string[];
    readonly variableNames?: readonly string[];
  },
): Promise<TestConnectorCredentialStorageStateActionResponse> {
  return await postAction(context, {
    action: "read",
    org_id: args.orgId,
    user_id: args.userId,
    connector_ref: args.connectorRef,
    secret_names: [...(args.secretNames ?? [])],
    variable_names: [...(args.variableNames ?? [])],
  });
}

export async function seedOwnedConnectorSecret(
  context: TestContext,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly connectorRef: string;
    readonly authMethod: string;
    readonly storageVersion: number;
    readonly name: string;
    readonly encryptedValue: string;
    readonly description: string | null;
  },
): Promise<string> {
  const response = await postAction(context, {
    action: "seed-owned-secret",
    org_id: args.orgId,
    user_id: args.userId,
    connector_ref: args.connectorRef,
    auth_method: args.authMethod,
    storage_version: args.storageVersion,
    name: args.name,
    encrypted_value: args.encryptedValue,
    description: args.description,
  });
  if (!response.connector_id) {
    throw new Error("Connector storage test fixture id was not returned");
  }
  return response.connector_id;
}

export async function seedConnectorStorageRow(
  context: TestContext,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly connectorRef: string;
    readonly authMethod: string;
    readonly storageVersion: number;
  },
): Promise<string> {
  const response = await postAction(context, {
    action: "seed-connector",
    org_id: args.orgId,
    user_id: args.userId,
    connector_ref: args.connectorRef,
    auth_method: args.authMethod,
    storage_version: args.storageVersion,
  });
  if (!response.connector_id) {
    throw new Error("Connector storage test fixture id was not returned");
  }
  return response.connector_id;
}

export async function setConnectorCredentialStorageState(
  context: TestContext,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly connectorRef: string;
    readonly storageVersion: number;
    readonly tokenExpiresAt?: string | null;
  },
): Promise<void> {
  await postAction(context, {
    action: "set-connector-state",
    org_id: args.orgId,
    user_id: args.userId,
    connector_ref: args.connectorRef,
    storage_version: args.storageVersion,
    ...(args.tokenExpiresAt === undefined
      ? {}
      : { token_expires_at: args.tokenExpiresAt }),
  });
}

export async function setConnectorSecretOwner(
  context: TestContext,
  args: {
    readonly connectorId: string;
    readonly name: string;
    readonly orgId: string;
    readonly userId: string;
  },
): Promise<void> {
  await postAction(context, {
    action: "set-secret-owner",
    connector_id: args.connectorId,
    name: args.name,
    org_id: args.orgId,
    user_id: args.userId,
  });
}

export async function setConnectorVariableOwner(
  context: TestContext,
  args: {
    readonly connectorId: string;
    readonly name: string;
    readonly orgId: string;
    readonly userId: string;
  },
): Promise<void> {
  await postAction(context, {
    action: "set-variable-owner",
    connector_id: args.connectorId,
    name: args.name,
    org_id: args.orgId,
    user_id: args.userId,
  });
}
