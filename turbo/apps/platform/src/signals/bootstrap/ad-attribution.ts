import {
  ACQUISITION_ATTRIBUTION_COOKIE,
  SOURCE_TYPES,
  type AdAttributionMetadata,
  type SourceType,
} from "@vm0/api-contracts/contracts/zero-attribution";

const AD_ATTRIBUTION_SOURCE_PARAM = "vm0_source";

const STORED_AD_ATTRIBUTION_KEY = "vm0.adAttribution";

const AD_ATTRIBUTION_PARAMS = [
  "source_type",
  "referrer_domain",
  "landing_host",
  "landing_path",
  AD_ATTRIBUTION_SOURCE_PARAM,
  "gclid",
  "gbraid",
  "wbraid",
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_content",
  "utm_term",
  "vm0_experiment",
  "vm0_variant",
  "lp_variant",
] as const;

const STRIPE_METADATA_PARAMS = [
  "referrer_domain",
  "landing_host",
  "landing_path",
  AD_ATTRIBUTION_SOURCE_PARAM,
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_content",
  "utm_term",
  "vm0_experiment",
  "vm0_variant",
  "lp_variant",
] as const;

const STRIPE_CLICK_ID_PRESENT_PARAMS = [
  ["gclid", "gclid_present"],
  ["gbraid", "gbraid_present"],
  ["wbraid", "wbraid_present"],
] as const;

function getSessionStorage(): Storage | null {
  if (typeof window === "undefined") {
    return null;
  }

  return window.sessionStorage;
}

function collectAttributionParams(
  searchParams: URLSearchParams,
): URLSearchParams {
  const attributionParams = new URLSearchParams();

  for (const param of AD_ATTRIBUTION_PARAMS) {
    for (const value of searchParams.getAll(param)) {
      attributionParams.append(param, value);
    }
  }

  return attributionParams;
}

function isSourceType(value: string | null): value is SourceType {
  return SOURCE_TYPES.some((candidate) => {
    return candidate === value;
  });
}

function getCookieString(): string {
  if (typeof document === "undefined") {
    return "";
  }
  return document.cookie;
}

function readCookie(name: string, cookieString: string): string | null {
  for (const part of cookieString.split(";")) {
    const trimmed = part.trim();
    if (!trimmed) {
      continue;
    }
    const eq = trimmed.indexOf("=");
    const key = eq === -1 ? trimmed : trimmed.slice(0, eq);
    if (key === name) {
      return decodeURIComponent(trimmed.slice(eq + 1));
    }
  }
  return null;
}

// First-touch attribution forwarded across the www.vm0.ai -> app.vm0.ai hop in
// the shared .vm0.ai cookie. Re-collected through the whitelist so only known
// params are persisted.
function collectAttributionFromCookie(cookieString: string): string {
  const stored = readCookie(ACQUISITION_ATTRIBUTION_COOKIE, cookieString);
  if (!stored) {
    return "";
  }
  return collectAttributionParams(new URLSearchParams(stored)).toString();
}

export function recordAdAttribution(
  searchParams: URLSearchParams,
  storage: Storage | null = getSessionStorage(),
  cookieString: string = getCookieString(),
): void {
  if (!storage) {
    return;
  }

  // First-touch: once captured this session, never overwrite.
  if (storage.getItem(STORED_AD_ATTRIBUTION_KEY)) {
    return;
  }

  // Prefer params on the current URL (an ad pointing straight at the app),
  // otherwise fall back to the shared .vm0.ai cookie set by the marketing site.
  const serializedAttribution =
    collectAttributionParams(searchParams).toString() ||
    collectAttributionFromCookie(cookieString);
  if (!serializedAttribution) {
    return;
  }

  storage.setItem(STORED_AD_ATTRIBUTION_KEY, serializedAttribution);
}

export function applyStoredAdAttribution(
  url: URL,
  storage: Storage | null = getSessionStorage(),
): void {
  if (!storage) {
    return;
  }

  const stored = storage.getItem(STORED_AD_ATTRIBUTION_KEY);
  if (!stored) {
    return;
  }

  const attributionParams = new URLSearchParams(stored);
  for (const param of AD_ATTRIBUTION_PARAMS) {
    if (url.searchParams.has(param)) {
      continue;
    }

    for (const value of attributionParams.getAll(param)) {
      url.searchParams.append(param, value);
    }
  }
}

export function getStoredAdAttributionMetadata(
  storage: Storage | null = getSessionStorage(),
): AdAttributionMetadata | undefined {
  if (!storage) {
    return undefined;
  }

  const stored = storage.getItem(STORED_AD_ATTRIBUTION_KEY);
  if (!stored) {
    return undefined;
  }

  const attributionParams = new URLSearchParams(stored);
  const metadata: AdAttributionMetadata = {};

  const sourceType = attributionParams.get("source_type");
  if (isSourceType(sourceType)) {
    metadata.source_type = sourceType;
  }

  for (const param of STRIPE_METADATA_PARAMS) {
    const value = attributionParams.get(param);
    if (value) {
      metadata[param] = value;
    }
  }

  for (const [clickIdParam, metadataParam] of STRIPE_CLICK_ID_PRESENT_PARAMS) {
    const value = attributionParams.get(clickIdParam);
    if (value) {
      metadata[clickIdParam] = value;
      metadata[metadataParam] = "true";
    }
  }

  return Object.keys(metadata).length > 0 ? metadata : undefined;
}
