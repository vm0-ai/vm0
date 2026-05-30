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
  "vm0_experiment",
  "vm0_variant",
  "lp_variant",
] as const;

const STRIPE_METADATA_PARAMS = [
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

type AdAttributionMetadata = Partial<
  Record<(typeof STRIPE_METADATA_PARAMS)[number], string> &
    Record<(typeof STRIPE_CLICK_ID_PRESENT_PARAMS)[number][1], "true">
>;

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

  for (const param of STRIPE_METADATA_PARAMS) {
    const value = attributionParams.get(param);
    if (value) {
      metadata[param] = value;
    }
  }

  for (const [clickIdParam, metadataParam] of STRIPE_CLICK_ID_PRESENT_PARAMS) {
    if (attributionParams.has(clickIdParam)) {
      metadata[metadataParam] = "true";
    }
  }

  return Object.keys(metadata).length > 0 ? metadata : undefined;
}
