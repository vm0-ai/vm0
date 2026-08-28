import { describe, expect, it } from "vitest";

import {
  connectorCatalogValidationRevision,
  connectorCatalogValidationRevisionFromMembers,
} from "../connector-catalog-validation-revision";

describe("connector catalog validation revision", () => {
  it("is deterministic across member order", () => {
    const members = [
      { path: "validator/schema.ts", content: "schema" },
      { path: "external/zod/version", content: "4.3.6" },
    ];

    expect(connectorCatalogValidationRevisionFromMembers(members)).toBe(
      connectorCatalogValidationRevisionFromMembers([...members].reverse()),
    );
  });

  it.each([
    {
      name: "path",
      changed: [
        { path: "validator/renamed.ts", content: "schema" },
        { path: "external/zod/version", content: "4.3.6" },
      ],
    },
    {
      name: "content",
      changed: [
        { path: "validator/schema.ts", content: "changed schema" },
        { path: "external/zod/version", content: "4.3.6" },
      ],
    },
    {
      name: "dependency version",
      changed: [
        { path: "validator/schema.ts", content: "schema" },
        { path: "external/zod/version", content: "4.4.0" },
      ],
    },
  ])("changes when $name changes", ({ changed }) => {
    const unchanged = [
      { path: "validator/schema.ts", content: "schema" },
      { path: "external/zod/version", content: "4.3.6" },
    ];

    expect(connectorCatalogValidationRevisionFromMembers(changed)).not.toBe(
      connectorCatalogValidationRevisionFromMembers(unchanged),
    );
  });

  it("computes the repository validation surface revision", () => {
    expect(connectorCatalogValidationRevision()).toMatch(/^[a-f0-9]{40}$/u);
  });
});
