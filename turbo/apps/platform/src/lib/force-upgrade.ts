import { getBuildVersion } from "./build-info.ts";
import { settle } from "../signals/utils.ts";

const FORCE_UPGRADE_PATH = "api/client/force-upgrade";

type ForceUpgradeFetch = (
  input: string,
  init: RequestInit,
) => Promise<Pick<Response, "json" | "ok">>;

type ForceUpgradeResponse = {
  forceUpgrade?: unknown;
};

export type ForceUpgradeCheckOptions = {
  apiBase?: string;
  fetcher?: ForceUpgradeFetch;
  version?: string | null;
};

function trimTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function normalizeForceUpgradeApiBase(
  value: string | undefined,
): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimTrailingSlash(trimmed) : null;
}

function resolveForceUpgradeApiBase(): string | null {
  const configured = import.meta.env.ATOM_URL as string | undefined;
  return normalizeForceUpgradeApiBase(configured);
}

function isForceUpgradeResponse(value: unknown): value is ForceUpgradeResponse {
  return typeof value === "object" && value !== null;
}

export function buildForceUpgradeUrl(version: string, apiBase: string): string {
  const url = new URL(FORCE_UPGRADE_PATH, `${trimTrailingSlash(apiBase)}/`);
  url.searchParams.set("version", version);
  return url.toString();
}

export async function shouldForceUpgrade(
  version: string,
  options: Pick<ForceUpgradeCheckOptions, "apiBase" | "fetcher"> = {},
): Promise<boolean> {
  const fetcher = options.fetcher ?? window.fetch.bind(window);
  const apiBase =
    options.apiBase === undefined
      ? resolveForceUpgradeApiBase()
      : normalizeForceUpgradeApiBase(options.apiBase);
  if (!apiBase) {
    return false;
  }

  const response = await fetcher(buildForceUpgradeUrl(version, apiBase), {
    cache: "no-store",
    credentials: "omit",
    method: "GET",
  });

  if (!response.ok) {
    return false;
  }

  const body: unknown = await response.json();
  return isForceUpgradeResponse(body) && body.forceUpgrade === true;
}

export async function checkForceUpgrade(
  options: ForceUpgradeCheckOptions = {},
): Promise<boolean> {
  const version = "version" in options ? options.version : getBuildVersion();
  if (!version) {
    return false;
  }

  const result = await settle(shouldForceUpgrade(version, options));
  if (!result.ok) {
    return false;
  }

  return result.value;
}
