import { describe, expect, it } from "vitest";

import { connectorCatalogFilteredAuthMethodSchema } from "../connector-catalog-diagnostics";

describe("connector catalog diagnostics contract", () => {
  it("supports the ref-to-slug receiver transition without divergent identities", () => {
    const method = {
      authMethodId: "oauth",
      reasons: ["missing-revoke-provider"],
    };

    expect(
      connectorCatalogFilteredAuthMethodSchema.safeParse({
        ...method,
        connectorRef: "github",
      }).success,
    ).toBeTruthy();
    expect(
      connectorCatalogFilteredAuthMethodSchema.safeParse({
        ...method,
        connectorSlug: "github",
        connectorRef: "github",
      }).success,
    ).toBeTruthy();
    expect(
      connectorCatalogFilteredAuthMethodSchema.safeParse({
        ...method,
        connectorSlug: "gitlab",
        connectorRef: "github",
      }).success,
    ).toBeFalsy();
  });
});
