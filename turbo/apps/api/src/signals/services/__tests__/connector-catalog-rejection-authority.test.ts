import { describe, expect, it } from "vitest";

import {
  connectorCatalogAttemptReusedCachedRejection,
  connectorCatalogRejectedCandidateFingerprint,
  connectorCatalogRejectionIsReusable,
  createConnectorCatalogValidatorIdentity,
  type ConnectorCatalogRejectedCandidateIdentity,
  type ConnectorCatalogRejectionAuthority,
  type ConnectorCatalogValidatorIdentity,
} from "../connector-catalog-rejection-authority";

function candidate(): ConnectorCatalogRejectedCandidateIdentity {
  return {
    catalogVersion: "2026-07-25.1",
    catalogKey: "connectors/v1/releases/2026-07-25.1/catalog.json",
    catalogDigest: `sha256:${"a".repeat(64)}`,
    pointerEtag: '"pointer-etag"',
  };
}

function authority(
  backendVersion: string,
  buildCommitSha: string | null = null,
  rejectedCandidate: ConnectorCatalogRejectedCandidateIdentity = candidate(),
): ConnectorCatalogRejectionAuthority {
  return {
    backendVersion,
    buildCommitSha,
    candidateFingerprint:
      connectorCatalogRejectedCandidateFingerprint(rejectedCandidate),
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
      const rejectedCandidate = candidate();
      expect(
        connectorCatalogRejectionIsReusable({
          candidate: rejectedCandidate,
          authority: authority(stored, null, rejectedCandidate),
          validator: validator({ backendVersion: current }),
        }),
      ).toBe(reusable);
    },
  );

  it("requires matching build commits for equal non-production versions", () => {
    const rejectedCandidate = candidate();
    const firstCommit = "a".repeat(40);
    const secondCommit = "b".repeat(40);
    expect(
      connectorCatalogRejectionIsReusable({
        candidate: rejectedCandidate,
        authority: authority("1.319.0", firstCommit, rejectedCandidate),
        validator: validator({
          backendVersion: "1.319.0",
          buildCommitSha: firstCommit,
          production: false,
        }),
      }),
    ).toBeTruthy();
    expect(
      connectorCatalogRejectionIsReusable({
        candidate: rejectedCandidate,
        authority: authority("1.319.0", firstCommit, rejectedCandidate),
        validator: validator({
          backendVersion: "1.319.0",
          buildCommitSha: secondCommit,
          production: false,
        }),
      }),
    ).toBeFalsy();
    expect(
      connectorCatalogRejectionIsReusable({
        candidate: rejectedCandidate,
        authority: authority("1.319.0", null, rejectedCandidate),
        validator: validator({
          backendVersion: "1.319.0",
          production: false,
        }),
      }),
    ).toBeTruthy();
  });

  it("rejects missing and old-writer-mismatched authority", () => {
    const rejectedCandidate = candidate();
    expect(
      connectorCatalogRejectionIsReusable({
        candidate: rejectedCandidate,
        authority: {
          backendVersion: null,
          buildCommitSha: null,
          candidateFingerprint: null,
        },
        validator: validator({ backendVersion: "1.319.0" }),
      }),
    ).toBeFalsy();
    expect(
      connectorCatalogRejectionIsReusable({
        candidate: {
          ...rejectedCandidate,
          catalogVersion: "2026-07-25.2",
        },
        authority: authority("1.319.0", null, rejectedCandidate),
        validator: validator({ backendVersion: "1.319.0" }),
      }),
    ).toBeFalsy();
  });

  it("ignores attempt metadata preserved by an old writer", () => {
    expect(
      connectorCatalogAttemptReusedCachedRejection({
        revision: 8,
        metadataRevision: 7,
        reusedCachedRejection: true,
      }),
    ).toBeNull();
    expect(
      connectorCatalogAttemptReusedCachedRejection({
        revision: 8,
        metadataRevision: 8,
        reusedCachedRejection: false,
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
});
