const CORE_SEMVER_REGEX =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u;
const BUILD_COMMIT_SHA_REGEX = /^[a-f0-9]{40}$/u;

export interface ConnectorCatalogValidationAuthority {
  readonly validatorVersion: string;
  readonly buildCommitSha: string | null;
}

export type ConnectorCatalogValidatorIdentity =
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
  parseCoreSemVer(identity.validatorVersion);
  if (
    identity.buildCommitSha !== null &&
    !BUILD_COMMIT_SHA_REGEX.test(identity.buildCommitSha)
  ) {
    throw new Error(
      `Invalid connector catalog validator build commit SHA: ${identity.buildCommitSha}`,
    );
  }
  return identity;
}

export function connectorCatalogValidationAuthorityIsCurrent(args: {
  readonly authority: ConnectorCatalogValidationAuthority;
  readonly validator: ConnectorCatalogValidatorIdentity;
}): boolean {
  return (
    compareCoreSemVer(
      args.authority.validatorVersion,
      args.validator.validatorVersion,
    ) === 0 && args.authority.buildCommitSha === args.validator.buildCommitSha
  );
}

export function connectorCatalogValidationAuthorityIsCurrentOrNewer(args: {
  readonly authority: ConnectorCatalogValidationAuthority;
  readonly validator: ConnectorCatalogValidatorIdentity;
}): boolean {
  const versionOrder = compareCoreSemVer(
    args.authority.validatorVersion,
    args.validator.validatorVersion,
  );
  if (versionOrder !== 0) {
    return versionOrder > 0;
  }
  return args.authority.buildCommitSha === args.validator.buildCommitSha;
}
