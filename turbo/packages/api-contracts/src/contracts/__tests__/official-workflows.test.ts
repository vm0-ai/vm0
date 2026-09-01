import { describe, expect, it } from "vitest";

import {
  officialWorkflowAcceptedBlueprintSchema,
  officialWorkflowBlueprintSchema,
} from "../official-workflow-catalog";
import {
  officialWorkflowCatalogDetailSchema,
  officialWorkflowInstallationDefinitionSchema,
} from "../official-workflows";

const REVISION = "a".repeat(64);
const FINGERPRINT = "b".repeat(64);

const blueprint = {
  key: "daily-brief",
  parameters: [
    {
      key: "topic",
      type: "string" as const,
      format: "text" as const,
      required: true,
    },
    {
      key: "max-items",
      type: "integer" as const,
      required: true,
      default: 10,
    },
    {
      key: "include-weekends",
      type: "boolean" as const,
      required: true,
      default: false,
    },
  ],
  desiredState: {
    kind: "schedule" as const,
    schedule: {
      type: "loop" as const,
      intervalSeconds: 3600,
    },
  },
  runtime: { resultEmail: true },
  fingerprint: FINGERPRINT,
};

describe("Official Workflow product contracts", () => {
  it("represents retained retired catalog detail", () => {
    const detail = {
      name: "team-brief",
      revision: REVISION,
      lifecycle: "retired" as const,
      displayName: "Team Brief",
      description: "A retained Official Workflow revision.",
      blueprints: [blueprint],
      presentation: { category: "productivity", order: 1 },
      workflow: {
        displayName: "Team Brief",
        description: "A retained Official Workflow revision.",
        instruction: "Prepare the brief.",
        files: [{ path: "references/context.md", content: "Context" }],
      },
    };

    expect(officialWorkflowCatalogDetailSchema.parse(detail)).toStrictEqual(
      detail,
    );
  });

  it("carries every declared parameter type in authoritative installation metadata", () => {
    const definition = {
      name: "team-brief",
      revision: REVISION,
      lifecycle: "active" as const,
      blueprints: [blueprint],
    };

    expect(
      officialWorkflowInstallationDefinitionSchema.parse(definition),
    ).toStrictEqual(definition);
    expect(
      officialWorkflowInstallationDefinitionSchema.safeParse({
        ...definition,
        lifecycle: "unavailable",
      }).success,
    ).toBe(false);
  });

  it("reads legacy accepted timezone derivations without allowing new source declarations", () => {
    const legacyBlueprint = {
      key: "daily-brief",
      parameters: [
        {
          key: "timezone",
          type: "string" as const,
          format: "timezone" as const,
          required: true,
          derivation: { kind: "user-timezone" as const },
        },
      ],
      desiredState: {
        kind: "schedule" as const,
        schedule: {
          type: "cron" as const,
          cronExpression: "0 8 * * *",
          timezone: { parameter: "timezone" },
        },
      },
      runtime: { resultEmail: true },
    };

    expect(
      officialWorkflowAcceptedBlueprintSchema.safeParse({
        ...legacyBlueprint,
        fingerprint: FINGERPRINT,
      }).success,
    ).toBe(true);
    expect(
      officialWorkflowBlueprintSchema.safeParse(legacyBlueprint).success,
    ).toBe(false);
  });
});
