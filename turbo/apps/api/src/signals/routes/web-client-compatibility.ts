import { command } from "ccstate";
import { z } from "zod";
import {
  appVersionSchema,
  webClientCompatibilityContract,
  type WebClientCompatibilityRouteResponse,
} from "@vm0/api-contracts/contracts";

import compatibilityConfig from "../../lib/web-client-compatibility.json";
import { setResHeader$ } from "../context/hono";
import { queryOf } from "../context/request";

type AppVersion = {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: readonly string[];
};

const APP_VERSION_PATTERN =
  /^(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)(?:-(?<prerelease>[0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u;

const webClientCompatibilityConfigSchema = z.object({
  minimumSupportedVersion: appVersionSchema,
});

const { minimumSupportedVersion } =
  webClientCompatibilityConfigSchema.parse(compatibilityConfig);
const webClientCompatibilityQuery$ = queryOf(
  webClientCompatibilityContract.get,
);

function parseAppVersion(version: string): AppVersion {
  const match = APP_VERSION_PATTERN.exec(version);
  if (!match?.groups) {
    throw new Error(`Invalid app version: ${version}`);
  }

  return {
    major: Number(match.groups.major),
    minor: Number(match.groups.minor),
    patch: Number(match.groups.patch),
    prerelease: match.groups.prerelease?.split(".") ?? [],
  };
}

function compareIdentifiers(left: string, right: string): number {
  const leftNumeric = /^\d+$/u.test(left);
  const rightNumeric = /^\d+$/u.test(right);

  if (leftNumeric && rightNumeric) {
    return Number(left) - Number(right);
  }
  if (leftNumeric) {
    return -1;
  }
  if (rightNumeric) {
    return 1;
  }
  return left.localeCompare(right);
}

function compareAppVersions(left: string, right: string): number {
  const parsedLeft = parseAppVersion(left);
  const parsedRight = parseAppVersion(right);

  const releaseComparison =
    parsedLeft.major - parsedRight.major ||
    parsedLeft.minor - parsedRight.minor ||
    parsedLeft.patch - parsedRight.patch;
  if (releaseComparison !== 0) {
    return releaseComparison;
  }

  if (parsedLeft.prerelease.length === 0) {
    return parsedRight.prerelease.length === 0 ? 0 : 1;
  }
  if (parsedRight.prerelease.length === 0) {
    return -1;
  }

  const length = Math.max(
    parsedLeft.prerelease.length,
    parsedRight.prerelease.length,
  );
  for (let index = 0; index < length; index += 1) {
    const leftIdentifier = parsedLeft.prerelease[index];
    const rightIdentifier = parsedRight.prerelease[index];
    if (leftIdentifier === undefined) {
      return -1;
    }
    if (rightIdentifier === undefined) {
      return 1;
    }

    const comparison = compareIdentifiers(leftIdentifier, rightIdentifier);
    if (comparison !== 0) {
      return comparison;
    }
  }

  return 0;
}

function isSupportedWebClientVersion(version: string): boolean {
  return compareAppVersions(version, minimumSupportedVersion) >= 0;
}

export const webClientCompatibility$ = command(
  ({ get, set }, _signal: AbortSignal): WebClientCompatibilityRouteResponse => {
    const query = get(webClientCompatibilityQuery$);

    set(setResHeader$, "Cache-Control", "no-store");

    return {
      status: 200,
      body: {
        minimumSupportedVersion,
        supported: isSupportedWebClientVersion(query.version),
      },
    };
  },
);
