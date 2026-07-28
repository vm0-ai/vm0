import { getBuildVersion, normalizeBuildCommitSha } from "../../lib/build-info";
import { env } from "../../lib/env";

const CORE_SEMVER_REGEX =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u;

export interface ConnectorCatalogValidationAuthority {
  readonly backendVersion: string;
  readonly buildCommitSha: string | null;
}

export interface ConnectorCatalogValidatorIdentity {
  readonly backendVersion: string;
  readonly buildCommitSha: string | null;
  readonly production: boolean;
}

export type ConnectorCatalogRejectionAuthority =
  ConnectorCatalogValidationAuthority;

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

export function currentConnectorCatalogValidatorIdentity(): ConnectorCatalogValidatorIdentity {
  const production = env("ENV") === "production";
  return createConnectorCatalogValidatorIdentity({
    backendVersion: getBuildVersion(),
    buildCommitSha: production
      ? null
      : normalizeBuildCommitSha(env("GIT_COMMIT_SHA")),
    production,
  });
}

export function connectorCatalogValidationAuthorityIsCurrent(args: {
  readonly authority: ConnectorCatalogValidationAuthority;
  readonly validator: ConnectorCatalogValidatorIdentity;
}): boolean {
  return (
    compareCoreSemVer(
      args.authority.backendVersion,
      args.validator.backendVersion,
    ) === 0 && args.authority.buildCommitSha === args.validator.buildCommitSha
  );
}

export function connectorCatalogValidationAuthorityIsCurrentOrNewer(args: {
  readonly authority: ConnectorCatalogValidationAuthority;
  readonly validator: ConnectorCatalogValidatorIdentity;
}): boolean {
  const versionOrder = compareCoreSemVer(
    args.authority.backendVersion,
    args.validator.backendVersion,
  );
  return (
    versionOrder > 0 ||
    (versionOrder === 0 &&
      args.authority.buildCommitSha === args.validator.buildCommitSha)
  );
}

export function connectorCatalogRejectionIsReusable(args: {
  readonly authority: ConnectorCatalogRejectionAuthority;
  readonly validator: ConnectorCatalogValidatorIdentity;
}): boolean {
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
