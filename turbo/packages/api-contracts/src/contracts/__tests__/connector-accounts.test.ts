import { describe, expect, it } from "vitest";

import {
  connectorAccountDisplayNameSchema,
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

  it("distinguishes add from exact reconnect intent", () => {
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
});
