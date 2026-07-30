import { describe, expect, it } from "vitest";

import { insightPermissionSchema } from "../zero-insights";

describe("Insights permission connector identity", () => {
  const basePermission = {
    label: "repo-read",
    allowed: 1,
    denied: 0,
    agentNames: ["Research agent"],
  };

  it.each([
    {
      name: "absent",
      identity: {},
      expected: {
        connectorSlug: undefined,
        connectorType: undefined,
      },
    },
    {
      name: "legacy-only",
      identity: { connectorType: "github" },
      expected: {
        connectorSlug: "github",
        connectorType: "github",
      },
    },
    {
      name: "canonical-only",
      identity: { connectorSlug: "github" },
      expected: {
        connectorSlug: "github",
        connectorType: "github",
      },
    },
    {
      name: "equal dual",
      identity: {
        connectorSlug: "github",
        connectorType: "github",
      },
      expected: {
        connectorSlug: "github",
        connectorType: "github",
      },
    },
  ])("normalizes $name input", ({ identity, expected }) => {
    const parsed = insightPermissionSchema.parse({
      ...basePermission,
      ...identity,
    });

    expect({
      connectorSlug: parsed.connectorSlug,
      connectorType: parsed.connectorType,
    }).toStrictEqual(expected);
  });

  it("rejects conflicting dual identity", () => {
    expect(
      insightPermissionSchema.safeParse({
        ...basePermission,
        connectorSlug: "github",
        connectorType: "gitlab",
      }).success,
    ).toBe(false);
  });
});
