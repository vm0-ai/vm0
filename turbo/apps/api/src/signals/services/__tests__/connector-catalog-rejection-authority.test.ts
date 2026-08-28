import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { connectorCatalogValidationRevision } from "../../../build-config/connector-catalog-validation-revision";
import { mockEnv } from "../../../lib/env";
import {
  connectorCatalogValidationAuthorityIsCurrent,
  connectorCatalogValidationAuthorityIsCurrentOrNewer,
  connectorCatalogRejectionIsReusable,
  createConnectorCatalogValidatorIdentity,
  currentConnectorCatalogValidatorIdentity,
  type ConnectorCatalogRejectionAuthority,
  type ConnectorCatalogValidatorIdentity,
} from "../connector-catalog-validator-authority";

function authority(
  backendVersion: string,
  validationRevision: string | null = null,
): ConnectorCatalogRejectionAuthority {
  return {
    backendVersion,
    validationRevision,
  };
}

function validator(args: {
  readonly backendVersion: string;
  readonly validationRevision?: string | null;
}): ConnectorCatalogValidatorIdentity {
  return createConnectorCatalogValidatorIdentity({
    backendVersion: args.backendVersion,
    validationRevision: args.validationRevision ?? null,
  });
}

describe("connector catalog rejection authority", () => {
  it("uses the injected validation revision in production", () => {
    mockEnv("ENV", "production");
    const expectedRevision = createHash("sha256")
      .update("validation-source\0", "utf8")
      .update(connectorCatalogValidationRevision(), "utf8")
      .update("\0runtime-node\0", "utf8")
      .update(process.versions.node, "utf8")
      .digest("hex")
      .slice(0, 40);

    expect(currentConnectorCatalogValidatorIdentity().validationRevision).toBe(
      expectedRevision,
    );
  });

  it("keeps commit authority outside production builds", () => {
    const commit = "c".repeat(40);
    mockEnv("ENV", "preview");
    mockEnv("GIT_COMMIT_SHA", commit);

    expect(currentConnectorCatalogValidatorIdentity().validationRevision).toBe(
      commit,
    );
  });

  it.each([
    { stored: "2.0.0", current: "1.999.999", reusable: true },
    { stored: "1.320.0", current: "1.319.999", reusable: true },
    { stored: "1.319.1", current: "1.319.0", reusable: true },
    { stored: "1.319.0", current: "1.319.0", reusable: true },
    { stored: "1.318.9", current: "1.319.0", reusable: false },
  ])(
    "orders production authority $stored against $current",
    ({ stored, current, reusable }) => {
      expect(
        connectorCatalogRejectionIsReusable({
          authority: authority(stored),
          validator: validator({ backendVersion: current }),
        }),
      ).toBe(reusable);
    },
  );

  it("requires matching revisions for equal versions", () => {
    const firstRevision = "a".repeat(40);
    const secondRevision = "b".repeat(40);
    expect(
      connectorCatalogRejectionIsReusable({
        authority: authority("1.319.0", firstRevision),
        validator: validator({
          backendVersion: "1.319.0",
          validationRevision: firstRevision,
        }),
      }),
    ).toBeTruthy();
    expect(
      connectorCatalogRejectionIsReusable({
        authority: authority("1.319.0", firstRevision),
        validator: validator({
          backendVersion: "1.319.0",
          validationRevision: secondRevision,
        }),
      }),
    ).toBeFalsy();
    expect(
      connectorCatalogRejectionIsReusable({
        authority: authority("1.319.0"),
        validator: validator({
          backendVersion: "1.319.0",
        }),
      }),
    ).toBeTruthy();
  });

  it("reuses an equal revision across backends only for accepted catalogs", () => {
    const revision = "a".repeat(40);
    const stored = authority("1.318.0", revision);
    const current = validator({
      backendVersion: "1.319.0",
      validationRevision: revision,
    });

    expect(
      connectorCatalogValidationAuthorityIsCurrent({
        authority: stored,
        validator: current,
      }),
    ).toBeTruthy();
    expect(
      connectorCatalogValidationAuthorityIsCurrentOrNewer({
        authority: stored,
        validator: current,
      }),
    ).toBeTruthy();
    expect(
      connectorCatalogRejectionIsReusable({
        authority: stored,
        validator: current,
      }),
    ).toBeFalsy();
  });

  it("keeps changed and legacy revisions ordered by backend version", () => {
    const current = validator({
      backendVersion: "1.319.0",
      validationRevision: "b".repeat(40),
    });

    expect(
      connectorCatalogValidationAuthorityIsCurrent({
        authority: authority("1.318.0", "a".repeat(40)),
        validator: current,
      }),
    ).toBeFalsy();
    expect(
      connectorCatalogValidationAuthorityIsCurrent({
        authority: authority("1.318.0"),
        validator: current,
      }),
    ).toBeFalsy();
    expect(
      connectorCatalogValidationAuthorityIsCurrentOrNewer({
        authority: authority("1.320.0", "a".repeat(40)),
        validator: current,
      }),
    ).toBeTruthy();
    expect(
      connectorCatalogValidationAuthorityIsCurrentOrNewer({
        authority: authority("1.318.0", "a".repeat(40)),
        validator: current,
      }),
    ).toBeFalsy();
  });

  it.each(["01.2.3", "1.02.3", "1.2.03", "1.2", "1.2.3-rc.1"])(
    "rejects non-core backend version %s",
    (backendVersion) => {
      expect(() => {
        validator({ backendVersion });
      }).toThrow(`Invalid core SemVer: ${backendVersion}`);
    },
  );

  it("rejects malformed validation revisions", () => {
    expect(() => {
      validator({
        backendVersion: "1.2.3",
        validationRevision: "not-a-revision",
      });
    }).toThrow("Invalid connector catalog validation revision");
  });
});
