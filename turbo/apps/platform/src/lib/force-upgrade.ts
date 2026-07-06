import { getBuildVersion } from "./build-info.ts";
import { settle } from "../signals/utils.ts";

const DEFAULT_FORCE_UPGRADE_API_BASE = "https://atom-api.vm6.ai";
// eslint-disable-next-line ccstate/no-non-zero-api -- external Atom public endpoint, not a vm0 API contract route
const FORCE_UPGRADE_PATH = "/api/client/force-upgrade";

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

function resolveForceUpgradeApiBase(): string {
  const configured = import.meta.env.VITE_ATOM_API_URL as string | undefined;
  const apiBase = configured?.trim() || DEFAULT_FORCE_UPGRADE_API_BASE;
  return trimTrailingSlash(apiBase);
}

function isForceUpgradeResponse(value: unknown): value is ForceUpgradeResponse {
  return typeof value === "object" && value !== null;
}

export function buildForceUpgradeUrl(
  version: string,
  apiBase = resolveForceUpgradeApiBase(),
): string {
  const url = new URL(FORCE_UPGRADE_PATH, `${trimTrailingSlash(apiBase)}/`);
  url.searchParams.set("version", version);
  return url.toString();
}

export async function shouldForceUpgrade(
  version: string,
  options: Pick<ForceUpgradeCheckOptions, "apiBase" | "fetcher"> = {},
): Promise<boolean> {
  const fetcher = options.fetcher ?? window.fetch.bind(window);
  const response = await fetcher(buildForceUpgradeUrl(version, options.apiBase), {
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
