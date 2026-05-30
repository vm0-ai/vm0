const AD_ATTRIBUTION_SOURCE_PARAM = "vm0_source";

const STORED_AD_ATTRIBUTION_KEY = "vm0.adAttribution";

const AD_ATTRIBUTION_PARAMS = [
  AD_ATTRIBUTION_SOURCE_PARAM,
  "gclid",
  "gbraid",
  "wbraid",
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_content",
  "utm_term",
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

export function recordAdAttribution(
  searchParams: URLSearchParams,
  storage: Storage | null = getSessionStorage(),
): void {
  if (!storage) {
    return;
  }

  const attributionParams = collectAttributionParams(searchParams);
  const serializedAttribution = attributionParams.toString();
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
