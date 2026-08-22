import { describe, expect, it } from "vitest";

import {
  connectorAccountsContract,
  connectorAccountDisplayNameSchema,
  connectorAccountListQuerySchema,
  connectorAccountMutationIntentSchema,
  connectorAccountSelectionSchema,
  connectorAccountTargetSchema,
} from "../connector-accounts";

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

  it("requires one target for bounded account detail queries", () => {
    expect(
      connectorAccountListQuerySchema.parse({
        kind: "builtin",
        connectorSlug: "github",
        limit: "100",
        search: "  work  ",
      }),
    ).toStrictEqual({
      kind: "builtin",
      connectorSlug: "github",
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
        kind: "builtin",
        connectorSlug: "github",
        limit: 101,
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
