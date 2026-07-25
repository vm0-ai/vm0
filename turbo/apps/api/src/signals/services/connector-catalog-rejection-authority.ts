import { createHash } from "node:crypto";

const CORE_SEMVER_REGEX =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u;

export interface ConnectorCatalogRejectedCandidateIdentity {
  readonly catalogVersion: string | null;
  readonly catalogKey: string | null;
  readonly catalogDigest: string | null;
  readonly pointerEtag: string | null;
}

export interface ConnectorCatalogValidatorIdentity {
  readonly backendVersion: string;
  readonly buildCommitSha: string | null;
  readonly production: boolean;
}

export interface ConnectorCatalogRejectionAuthority {
  readonly backendVersion: string | null;
  readonly buildCommitSha: string | null;
  readonly candidateFingerprint: string | null;
}

interface CoreSemVer {
  readonly major: bigint;
  readonly minor: bigint;
  readonly patch: bigint;
}

function parseCoreSemVer(version: string): CoreSemVer {
  const match = CORE_SEMVER_REGEX.exec(version);
  const major = match?.[1];
  const minor = match?.[2];
  const patch = match?.[3];
  if (major === undefined || minor === undefined || patch === undefined) {
    throw new Error(`Invalid core SemVer: ${version}`);
  }
  return {
    major: BigInt(major),
    minor: BigInt(minor),
    patch: BigInt(patch),
  };
}

function compareCoreSemVer(left: string, right: string): -1 | 0 | 1 {
  const leftVersion = parseCoreSemVer(left);
  const rightVersion = parseCoreSemVer(right);
  if (leftVersion.major !== rightVersion.major) {
    return leftVersion.major < rightVersion.major ? -1 : 1;
  }
  if (leftVersion.minor !== rightVersion.minor) {
    return leftVersion.minor < rightVersion.minor ? -1 : 1;
  }
  if (leftVersion.patch !== rightVersion.patch) {
    return leftVersion.patch < rightVersion.patch ? -1 : 1;
  }
  return 0;
}

export function createConnectorCatalogValidatorIdentity(
  identity: ConnectorCatalogValidatorIdentity,
): ConnectorCatalogValidatorIdentity {
  parseCoreSemVer(identity.backendVersion);
  return identity;
}

export function connectorCatalogRejectedCandidateFingerprint(
  candidate: ConnectorCatalogRejectedCandidateIdentity,
): string {
  const encoded = JSON.stringify([
    candidate.catalogVersion,
    candidate.catalogKey,
    candidate.catalogDigest,
    candidate.pointerEtag,
  ]);
  return `sha256:${createHash("sha256").update(encoded).digest("hex")}`;
}

export function connectorCatalogAttemptReusedCachedRejection(args: {
  readonly revision: number;
  readonly metadataRevision: number | null;
  readonly reusedCachedRejection: boolean | null;
}): boolean | null {
  return args.metadataRevision === args.revision
    ? args.reusedCachedRejection
    : null;
}

export function connectorCatalogRejectionIsReusable(args: {
  readonly candidate: ConnectorCatalogRejectedCandidateIdentity;
  readonly authority: ConnectorCatalogRejectionAuthority;
  readonly validator: ConnectorCatalogValidatorIdentity;
}): boolean {
  if (
    args.authority.backendVersion === null ||
    args.authority.candidateFingerprint === null ||
    args.authority.candidateFingerprint !==
      connectorCatalogRejectedCandidateFingerprint(args.candidate)
  ) {
    return false;
  }

  const versionOrder = compareCoreSemVer(
    args.authority.backendVersion,
    args.validator.backendVersion,
  );
  if (versionOrder !== 0) {
    return versionOrder > 0;
  }
  return (
    args.validator.production ||
    args.authority.buildCommitSha === args.validator.buildCommitSha
  );
}
