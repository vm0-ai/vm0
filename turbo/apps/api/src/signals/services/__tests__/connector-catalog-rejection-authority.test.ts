import { CONNECTOR_CATALOG_VALIDATOR_VERSION } from "@okouai/connectors/connector-catalog/version";
import { describe, expect, it } from "vitest";

import { mockEnv } from "../../../lib/env";
import {
  connectorCatalogValidationAuthorityIsCurrent,
  connectorCatalogValidationAuthorityIsCurrentOrNewer,
  connectorCatalogRejectionIsReusable,
  createConnectorCatalogValidatorIdentity,
  currentConnectorCatalogValidatorIdentity,
  type ConnectorCatalogRejectionAuthority,
  type ConnectorCatalogRejectionValidatorIdentity,
  type ConnectorCatalogValidationAuthority,
  type ConnectorCatalogValidatorIdentity,
} from "../connector-catalog-validator-authority";

function acceptedAuthority(
  validatorVersion: string,
  buildCommitSha: string | null = null,
): ConnectorCatalogValidationAuthority {
  return { validatorVersion, buildCommitSha };
}

function validator(
  validatorVersion: string,
  buildCommitSha: string | null = null,
): ConnectorCatalogValidatorIdentity {
  return createConnectorCatalogValidatorIdentity({
    validatorVersion,
    buildCommitSha,
  });
}

function rejectionAuthority(
  backendVersion: string,
  buildCommitSha: string | null = null,
): ConnectorCatalogRejectionAuthority {
  return { backendVersion, buildCommitSha };
}

function rejectionValidator(
  backendVersion: string,
  buildCommitSha: string | null = null,
): ConnectorCatalogRejectionValidatorIdentity {
  return { backendVersion, buildCommitSha };
}

describe("connector catalog validator authority", () => {
  it("uses only the validator package version in production", () => {
    mockEnv("ENV", "production");

    expect(currentConnectorCatalogValidatorIdentity()).toStrictEqual({
      validatorVersion: CONNECTOR_CATALOG_VALIDATOR_VERSION,
      buildCommitSha: null,
    });
  });

  it("keeps preview authority exact to the build commit", () => {
    const commit = "c".repeat(40);
    mockEnv("ENV", "preview");
    mockEnv("GIT_COMMIT_SHA", commit);

    expect(currentConnectorCatalogValidatorIdentity()).toStrictEqual({
      validatorVersion: CONNECTOR_CATALOG_VALIDATOR_VERSION,
      buildCommitSha: commit,
    });
  });

  it("orders the connectors authority after the final standalone validator", () => {
    expect(
      connectorCatalogValidationAuthorityIsCurrentOrNewer({
        authority: acceptedAuthority("2.0.15"),
        validator: validator(CONNECTOR_CATALOG_VALIDATOR_VERSION),
      }),
    ).toBeFalsy();
    expect(
      connectorCatalogValidationAuthorityIsCurrentOrNewer({
        authority: acceptedAuthority(CONNECTOR_CATALOG_VALIDATOR_VERSION),
        validator: validator("2.0.15"),
      }),
    ).toBeTruthy();
  });

  it("fails closed when preview commit authority is unavailable", () => {
    mockEnv("ENV", "preview");
    mockEnv("GIT_COMMIT_SHA", "invalid-commit");

    expect(() => {
      currentConnectorCatalogValidatorIdentity();
    }).toThrow("Preview connector catalog authority requires a commit SHA");
  });

  it.each([
    { stored: "2.0.0", current: "1.999.999", reusable: true },
    { stored: "2.0.1", current: "2.0.0", reusable: true },
    { stored: "2.0.0", current: "2.0.0", reusable: true },
    { stored: "1.999.999", current: "2.0.0", reusable: false },
  ])(
    "orders accepted validator package $stored against $current",
    ({ stored, current, reusable }) => {
      expect(
        connectorCatalogValidationAuthorityIsCurrentOrNewer({
          authority: acceptedAuthority(stored),
          validator: validator(current),
        }),
      ).toBe(reusable);
    },
  );

  it("requires the exact package version and preview commit for current authority", () => {
    const firstCommit = "a".repeat(40);
    const secondCommit = "b".repeat(40);
    expect(
      connectorCatalogValidationAuthorityIsCurrent({
        authority: acceptedAuthority("2.0.0", firstCommit),
        validator: validator("2.0.0", firstCommit),
      }),
    ).toBeTruthy();
    expect(
      connectorCatalogValidationAuthorityIsCurrent({
        authority: acceptedAuthority("2.0.0", firstCommit),
        validator: validator("2.0.0", secondCommit),
      }),
    ).toBeFalsy();
    expect(
      connectorCatalogValidationAuthorityIsCurrent({
        authority: acceptedAuthority("2.0.0"),
        validator: validator("2.0.1"),
      }),
    ).toBeFalsy();
    expect(
      connectorCatalogValidationAuthorityIsCurrentOrNewer({
        authority: acceptedAuthority("2.0.0", firstCommit),
        validator: validator("2.0.0"),
      }),
    ).toBeFalsy();
  });

  it("keeps cached rejection authority scoped to the API release", () => {
    const commit = "a".repeat(40);
    expect(
      connectorCatalogRejectionIsReusable({
        authority: rejectionAuthority("1.319.0", commit),
        validator: rejectionValidator("1.319.0", commit),
      }),
    ).toBeTruthy();
    expect(
      connectorCatalogRejectionIsReusable({
        authority: rejectionAuthority("1.318.0", commit),
        validator: rejectionValidator("1.319.0", commit),
      }),
    ).toBeFalsy();
    expect(
      connectorCatalogRejectionIsReusable({
        authority: rejectionAuthority("1.320.0"),
        validator: rejectionValidator("1.319.0"),
      }),
    ).toBeTruthy();
  });

  it.each(["01.2.3", "1.02.3", "1.2.03", "1.2", "1.2.3-rc.1"])(
    "rejects non-core validator package version %s",
    (validatorVersion) => {
      expect(() => {
        validator(validatorVersion);
      }).toThrow(`Invalid core SemVer: ${validatorVersion}`);
    },
  );

  it("rejects malformed preview commit SHAs", () => {
    expect(() => {
      validator("2.0.0", "not-a-commit");
    }).toThrow("Invalid connector catalog validator build commit SHA");
  });
});
