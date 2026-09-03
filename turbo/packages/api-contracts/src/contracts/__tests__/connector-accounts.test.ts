import { describe, expect, it } from "vitest";

import {
  CONNECTOR_ACCOUNT_INSPECTION_MAX_SELECTIONS,
  connectorAccountsContract,
  connectorAccountDisplayNameSchema,
  connectorAccountListQuerySchema,
  connectorAccountMutationIntentSchema,
  connectorAccountSelectionSchema,
  connectorAccountTargetSchema,
} from "../connector-accounts";
import { chatThreadConnectorSelectionContract } from "../chat-threads";
import {
  connectorExternalCodeSessionContract,
  connectorManualGrantContract,
  connectorNoAuthGrantContract,
  connectorOauthDeviceAuthSessionContract,
  connectorOauthStartContract,
  connectorOpenIdStartContract,
} from "../connectors";
import {
  customConnectorOAuth2Contract,
  customConnectorValuesContract,
} from "../custom-connectors";

const connectionId = "00000000-0000-4000-8000-000000276861";
const customConnectorId = "00000000-0000-4000-8000-000000276862";

describe("connector account contracts", () => {
  it("normalizes bounded user-authored labels", () => {
    expect(connectorAccountDisplayNameSchema.parse("  Work account  ")).toBe(
      "Work account",
    );
    expect(connectorAccountDisplayNameSchema.safeParse("   ").success).toBe(
      false,
    );
    expect(
      connectorAccountDisplayNameSchema.safeParse("a".repeat(256)).success,
    ).toBe(false);
  });

  it("accepts exactly one built-in or custom target identity", () => {
    expect(
      connectorAccountTargetSchema.parse({
        kind: "builtin",
        connectorSlug: "github",
      }),
    ).toStrictEqual({ kind: "builtin", connectorSlug: "github" });
    expect(
      connectorAccountTargetSchema.parse({
        kind: "custom",
        customConnectorId,
      }),
    ).toStrictEqual({ kind: "custom", customConnectorId });
    expect(
      connectorAccountTargetSchema.safeParse({
        kind: "builtin",
        connectorSlug: "github",
        customConnectorId,
      }).success,
    ).toBe(false);
  });

  it("distinguishes single-account, add, and exact reconnect intent", () => {
    expect(
      connectorAccountMutationIntentSchema.parse({
        intent: "single-account",
      }),
    ).toStrictEqual({ intent: "single-account" });
    expect(
      connectorAccountMutationIntentSchema.safeParse({
        intent: "single-account",
        connectionId,
      }).success,
    ).toBe(false);
    expect(
      connectorAccountMutationIntentSchema.parse({
        intent: "add",
        displayName: "  Personal  ",
      }),
    ).toStrictEqual({ intent: "add", displayName: "Personal" });
    expect(
      connectorAccountMutationIntentSchema.safeParse({
        intent: "reconnect",
      }).success,
    ).toBe(false);
    expect(
      connectorAccountMutationIntentSchema.parse({
        intent: "reconnect",
        connectionId,
      }),
    ).toStrictEqual({ intent: "reconnect", connectionId });
  });

  it("requires account intent on app-owned connection mutations", () => {
    expect(
      connectorOauthStartContract.start.body.safeParse({
        authMethod: "oauth",
      }).success,
    ).toBe(false);
    expect(
      connectorOpenIdStartContract.start.body.safeParse({
        authMethod: "openid",
      }).success,
    ).toBe(false);
    expect(
      connectorNoAuthGrantContract.connect.body.safeParse({
        authMethod: "none",
      }).success,
    ).toBe(false);
    expect(
      connectorOauthDeviceAuthSessionContract.create.body.safeParse({
        authMethod: "oauth-device",
      }).success,
    ).toBe(false);
    expect(
      connectorExternalCodeSessionContract.create.body.safeParse({
        authMethod: "external-code",
      }).success,
    ).toBe(false);
    expect(customConnectorOAuth2Contract.start.body.safeParse({}).success).toBe(
      false,
    );
    expect(
      customConnectorValuesContract.set.body.safeParse({ values: [] }).success,
    ).toBe(false);
  });

  it("preserves manual grant inputs and declares the CLI retirement response", () => {
    expect(
      connectorManualGrantContract.connect.body.safeParse({
        authMethod: "api-token",
        values: { apiKey: "test" },
      }).success,
    ).toBe(true);
    expect(
      connectorManualGrantContract.connect.body.safeParse({
        authMethod: "api-token",
        account: { intent: "single-account" },
        values: { apiKey: "test" },
      }).success,
    ).toBe(true);
    expect(
      connectorManualGrantContract.connect.body.safeParse({
        authMethod: "api-token",
        account: { intent: "add", displayName: "Work" },
        values: { apiKey: "test" },
      }).success,
    ).toBe(true);
    expect(
      connectorManualGrantContract.connect.body.safeParse({
        authMethod: "api-token",
        account: { intent: "reconnect", connectionId },
        values: { apiKey: "test" },
      }).success,
    ).toBe(true);
    expect(
      connectorManualGrantContract.connect.responses[426].safeParse({
        error: {
          message: "Update the CLI to connect this connector",
          code: "CLI_CONNECTOR_ACCOUNT_INTENT_RETIRED",
        },
      }).success,
    ).toBe(true);
  });

  it("binds a selection to one exact connection and target", () => {
    expect(
      connectorAccountSelectionSchema.parse({
        connectionId,
        target: { kind: "custom", customConnectorId },
      }),
    ).toStrictEqual({
      connectionId,
      target: { kind: "custom", customConnectorId },
    });
  });

  it("bounds exact account inspection batches", () => {
    const selection = {
      connectionId,
      target: { kind: "builtin" as const, connectorSlug: "github" },
    };
    expect(
      connectorAccountsContract.inspect.body.safeParse({
        selections: Array.from(
          { length: CONNECTOR_ACCOUNT_INSPECTION_MAX_SELECTIONS },
          () => {
            return selection;
          },
        ),
      }).success,
    ).toBe(true);
    expect(
      connectorAccountsContract.inspect.body.safeParse({
        selections: Array.from(
          { length: CONNECTOR_ACCOUNT_INSPECTION_MAX_SELECTIONS + 1 },
          () => {
            return selection;
          },
        ),
      }).success,
    ).toBe(false);
  });

  it("requires batched selected account details on thread selection reads", () => {
    const response = chatThreadConnectorSelectionContract.get.responses[200];
    expect(
      response.safeParse({ selections: [], selectedConnections: [] }).success,
    ).toBe(true);
    expect(response.safeParse({ selections: [] }).success).toBe(false);
  });

  it("requires one target for bounded account detail queries", () => {
    expect(
      connectorAccountListQuerySchema.parse({
        kind: "builtin",
        connectorSlug: "github",
        includeScopeMismatch: "true",
        limit: "100",
        search: "  work  ",
      }),
    ).toStrictEqual({
      kind: "builtin",
      connectorSlug: "github",
      includeScopeMismatch: "true",
      limit: 100,
      search: "work",
    });
    expect(
      connectorAccountListQuerySchema.safeParse({
        kind: "custom",
        connectorSlug: "github",
        customConnectorId,
      }).success,
    ).toBe(false);
    expect(
      connectorAccountListQuerySchema.safeParse({
        kind: "custom",
        customConnectorId,
        includeScopeMismatch: "true",
      }).success,
    ).toBe(false);
    expect(
      connectorAccountListQuerySchema.safeParse({
        kind: "builtin",
        connectorSlug: "github",
        limit: 101,
      }).success,
    ).toBe(false);
  });

  it("keeps scope mismatch enrichment optional for legacy account lists", () => {
    const connection = {
      id: connectionId,
      target: { kind: "builtin" as const, connectorSlug: "github" },
      authMethod: "oauth",
      displayName: null,
      isDefault: true,
      externalId: null,
      externalUsername: "octocat",
      externalEmail: null,
      oauthScopes: ["repo"],
      connectionStatus: "connected" as const,
      reconnectReason: null,
      tokenExpiresAt: null,
      createdAt: "2026-09-03T00:00:00.000Z",
      updatedAt: "2026-09-03T00:00:00.000Z",
    };
    const response = connectorAccountsContract.connections.responses[200];

    expect(
      response.parse({ connections: [connection], nextCursor: null }),
    ).toStrictEqual({ connections: [connection], nextCursor: null });
    expect(
      response.parse({
        connections: [{ ...connection, scopeMismatch: true }],
        nextCursor: null,
        defaultConnection: { ...connection, scopeMismatch: true },
      }),
    ).toStrictEqual({
      connections: [{ ...connection, scopeMismatch: true }],
      nextCursor: null,
      defaultConnection: { ...connection, scopeMismatch: true },
    });
  });

  it("requires an exact target for one account read", () => {
    expect(
      connectorAccountsContract.connection.query.parse({
        kind: "builtin",
        connectorSlug: "github",
      }),
    ).toStrictEqual({ kind: "builtin", connectorSlug: "github" });
    expect(
      connectorAccountsContract.connection.query.safeParse({
        kind: "builtin",
        connectorSlug: "github",
        customConnectorId,
      }).success,
    ).toBe(false);
  });

  it("binds scope diff to an exact built-in account and slug", () => {
    expect(
      connectorAccountsContract.scopeDiff.pathParams.parse({ connectionId }),
    ).toStrictEqual({ connectionId });
    expect(
      connectorAccountsContract.scopeDiff.query.parse({
        connectorSlug: "github",
      }),
    ).toStrictEqual({ connectorSlug: "github" });
    expect(
      connectorAccountsContract.scopeDiff.query.safeParse({
        connectorSlug: "github",
        customConnectorId,
      }).success,
    ).toBe(false);
  });

  it("accepts only an exact target for account deletion", () => {
    expect(
      connectorAccountsContract.delete.body.parse({
        target: { kind: "builtin", connectorSlug: "github" },
      }),
    ).toStrictEqual({
      target: { kind: "builtin", connectorSlug: "github" },
    });
    expect(
      connectorAccountsContract.delete.body.safeParse({
        target: { kind: "builtin", connectorSlug: "github" },
        selectionResolution: { kind: "clear" },
      }).success,
    ).toBe(false);
  });

  it("accepts only a target for safe single-account disconnect", () => {
    expect(
      connectorAccountsContract.disconnectSingleAccount.body.parse({
        target: { kind: "builtin", connectorSlug: "github" },
      }),
    ).toStrictEqual({
      target: { kind: "builtin", connectorSlug: "github" },
    });
    expect(
      connectorAccountsContract.disconnectSingleAccount.body.parse({
        target: { kind: "custom", customConnectorId },
      }),
    ).toStrictEqual({ target: { kind: "custom", customConnectorId } });
    expect(
      connectorAccountsContract.disconnectSingleAccount.body.safeParse({
        target: { kind: "builtin", connectorSlug: "github" },
        connectionId,
      }).success,
    ).toBe(false);
  });
});
