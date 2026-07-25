import { describe, expect, it } from "vitest";

import {
  connectorCatalogRejectionIsReusable,
  createConnectorCatalogValidatorIdentity,
  type ConnectorCatalogRejectionAuthority,
  type ConnectorCatalogValidatorIdentity,
} from "../connector-catalog-rejection-authority";

function authority(
  backendVersion: string,
  buildCommitSha: string | null = null,
): ConnectorCatalogRejectionAuthority {
  return {
    backendVersion,
    buildCommitSha,
  };
}

function validator(args: {
  readonly backendVersion: string;
  readonly buildCommitSha?: string | null;
  readonly production?: boolean;
}): ConnectorCatalogValidatorIdentity {
  return createConnectorCatalogValidatorIdentity({
    backendVersion: args.backendVersion,
    buildCommitSha: args.buildCommitSha ?? null,
    production: args.production ?? true,
  });
}

describe("connector catalog rejection authority", () => {
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

  it("requires matching build commits for equal non-production versions", () => {
    const firstCommit = "a".repeat(40);
    const secondCommit = "b".repeat(40);
    expect(
      connectorCatalogRejectionIsReusable({
        authority: authority("1.319.0", firstCommit),
        validator: validator({
          backendVersion: "1.319.0",
          buildCommitSha: firstCommit,
          production: false,
        }),
      }),
    ).toBeTruthy();
    expect(
      connectorCatalogRejectionIsReusable({
        authority: authority("1.319.0", firstCommit),
        validator: validator({
          backendVersion: "1.319.0",
          buildCommitSha: secondCommit,
          production: false,
        }),
      }),
    ).toBeFalsy();
    expect(
      connectorCatalogRejectionIsReusable({
        authority: authority("1.319.0"),
        validator: validator({
          backendVersion: "1.319.0",
          production: false,
        }),
      }),
    ).toBeTruthy();
  });

  it.each(["01.2.3", "1.02.3", "1.2.03", "1.2", "1.2.3-rc.1"])(
    "rejects non-core backend version %s",
    (backendVersion) => {
      expect(() => {
        validator({ backendVersion });
      }).toThrow(`Invalid core SemVer: ${backendVersion}`);
    },
  );
});
