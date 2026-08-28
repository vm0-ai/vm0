import { getBuildVersion, normalizeBuildCommitSha } from "../../lib/build-info";
import { env } from "../../lib/env";

const CORE_SEMVER_REGEX =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u;
const VALIDATION_REVISION_REGEX = /^[a-f0-9]{40}$/u;
const PRODUCTION_VALIDATION_REVISION_PREFIX = "cc01";
const PRODUCTION_SOURCE_REVISION_LENGTH = 24;

export interface ConnectorCatalogValidationAuthority {
  readonly backendVersion: string;
  /** Stored in the legacy catalog_validation_build_commit_sha column. */
  readonly validationRevision: string | null;
}

export interface ConnectorCatalogValidatorIdentity {
  readonly backendVersion: string;
  readonly validationRevision: string | null;
}

export type ConnectorCatalogRejectionAuthority =
  ConnectorCatalogValidationAuthority;

interface CoreSemVer {
  readonly major: bigint;
  readonly minor: bigint;
  readonly patch: bigint;
}

const MAX_NODE_VERSION_COMPONENT = 65_535n;

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
  if (
    identity.validationRevision !== null &&
    !VALIDATION_REVISION_REGEX.test(identity.validationRevision)
  ) {
    throw new Error(
      `Invalid connector catalog validation revision: ${identity.validationRevision}`,
    );
  }
  return identity;
}

function nodeVersionAuthorityPrefix(nodeVersion: string): string {
  const parsed = parseCoreSemVer(nodeVersion);
  // Keep the exact runtime version ordered ahead of the digest so overlapping
  // platform runtime rollouts converge on the newer validator authority.
  return [parsed.major, parsed.minor, parsed.patch]
    .map((component) => {
      if (component > MAX_NODE_VERSION_COMPONENT) {
        throw new Error(`Unsupported Node version: ${nodeVersion}`);
      }
      return component.toString(16).padStart(4, "0");
    })
    .join("");
}

function productionValidationRevision(): string | null {
  if (typeof __CONNECTOR_CATALOG_VALIDATION_REVISION__ !== "string") {
    return null;
  }
  const nodeVersion = process.versions.node;
  const nodeVersionPrefix = nodeVersionAuthorityPrefix(nodeVersion);
  return (
    PRODUCTION_VALIDATION_REVISION_PREFIX +
    __CONNECTOR_CATALOG_VALIDATION_REVISION__.slice(
      0,
      PRODUCTION_SOURCE_REVISION_LENGTH,
    ) +
    nodeVersionPrefix
  );
}

function productionValidationRevisionParts(
  revision: string | null,
): { readonly sourceRevision: string; readonly nodeVersion: string } | null {
  if (
    revision === null ||
    !revision.startsWith(PRODUCTION_VALIDATION_REVISION_PREFIX)
  ) {
    return null;
  }
  const sourceRevisionStart = PRODUCTION_VALIDATION_REVISION_PREFIX.length;
  const nodeVersionStart =
    sourceRevisionStart + PRODUCTION_SOURCE_REVISION_LENGTH;
  return {
    sourceRevision: revision.slice(sourceRevisionStart, nodeVersionStart),
    nodeVersion: revision.slice(nodeVersionStart),
  };
}

export function currentConnectorCatalogValidatorIdentity(): ConnectorCatalogValidatorIdentity {
  const production = env("ENV") === "production";
  return createConnectorCatalogValidatorIdentity({
    backendVersion: getBuildVersion(),
    validationRevision: production
      ? productionValidationRevision()
      : normalizeBuildCommitSha(env("GIT_COMMIT_SHA")),
  });
}

function validationRevisionMatches(args: {
  readonly authority: ConnectorCatalogValidationAuthority;
  readonly validator: ConnectorCatalogValidatorIdentity;
}): boolean {
  return (
    args.authority.validationRevision !== null &&
    args.authority.validationRevision === args.validator.validationRevision
  );
}

export function connectorCatalogValidationAuthorityIsCurrent(args: {
  readonly authority: ConnectorCatalogValidationAuthority;
  readonly validator: ConnectorCatalogValidatorIdentity;
}): boolean {
  return (
    validationRevisionMatches(args) ||
    (compareCoreSemVer(
      args.authority.backendVersion,
      args.validator.backendVersion,
    ) === 0 &&
      args.authority.validationRevision === args.validator.validationRevision)
  );
}

export function connectorCatalogValidationAuthorityIsCurrentOrNewer(args: {
  readonly authority: ConnectorCatalogValidationAuthority;
  readonly validator: ConnectorCatalogValidatorIdentity;
}): boolean {
  if (
    args.authority.validationRevision === null &&
    args.validator.validationRevision !== null
  ) {
    return false;
  }
  if (
    args.authority.validationRevision !== null &&
    args.validator.validationRevision === null
  ) {
    return true;
  }
  if (validationRevisionMatches(args)) {
    return true;
  }
  const versionOrder = compareCoreSemVer(
    args.authority.backendVersion,
    args.validator.backendVersion,
  );
  if (versionOrder !== 0) {
    return versionOrder > 0;
  }
  if (args.authority.validationRevision === args.validator.validationRevision) {
    return true;
  }
  const authorityProduction = productionValidationRevisionParts(
    args.authority.validationRevision,
  );
  const validatorProduction = productionValidationRevisionParts(
    args.validator.validationRevision,
  );
  // Processes from the same source build do not trust different runtimes, but
  // an ordered Node version prevents a platform runtime rollout from
  // alternating DB writes. Different source builds still require a backend
  // version boundary because their hashes have no chronological ordering.
  return (
    authorityProduction !== null &&
    validatorProduction !== null &&
    authorityProduction.sourceRevision === validatorProduction.sourceRevision &&
    authorityProduction.nodeVersion > validatorProduction.nodeVersion
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
    args.authority.validationRevision === args.validator.validationRevision
  );
}
