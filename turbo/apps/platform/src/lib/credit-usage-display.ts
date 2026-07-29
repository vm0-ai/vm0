import { getModelDisplayName } from "@vm0/core/model-display-name";

const MANAGED_USAGE_KIND_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  scrape: "Web Fetch",
  maps: "Maps",
  "web-search": "Web Search",
  "people-search": "People Search",
  finance: "Finance",
  weather: "Weather",
};

// Current Settings responses retain raw usage kinds inside each provider.
// Keep provider aliases for older APIs that only return the provider so app
// and API promotions can serve different versions safely.
const MANAGED_USAGE_PROVIDER_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  firecrawl: "Web Fetch",
  "google-maps": "Maps",
  openstreetmap: "Maps",
  perplexity: "Web Search",
  apidojo: "Finance",
  "google-weather": "Weather",
  "google-air-quality": "Weather",
};

const MODEL_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  "vm0-model": "Auto",
};

function titleCaseUsageToken(token: string): string {
  const upper = token.toUpperCase();
  if (["AI", "API", "GLM", "GPT", "ID", "SQL", "URL", "VM0"].includes(upper)) {
    return upper;
  }

  return token.charAt(0).toUpperCase() + token.slice(1);
}

function formatUsageIdentifier(value: string): string {
  const normalized = value.trim();
  if (!normalized) {
    return "Usage";
  }

  return normalized
    .split(/[/._-]+/)
    .filter((token) => {
      return token.length > 0;
    })
    .map(titleCaseUsageToken)
    .join(" ");
}

function stripUsageProviderPrefix(value: string): string {
  const normalized = value.trim();
  if (normalized.startsWith("fal-ai/")) {
    return normalized.slice("fal-ai/".length);
  }
  if (normalized.startsWith("bytedance/")) {
    return normalized.slice("bytedance/".length);
  }
  if (normalized.startsWith("dreamina-")) {
    return normalized.slice("dreamina-".length);
  }
  return normalized;
}

function usageModelDisplayName(model: string): string {
  const usageDisplayName = MODEL_DISPLAY_NAMES[model];
  if (usageDisplayName) {
    return usageDisplayName;
  }

  const directDisplayName = getModelDisplayName(model);
  if (directDisplayName !== model) {
    return directDisplayName;
  }

  const strippedModel = stripUsageProviderPrefix(model);
  const strippedDisplayName = getModelDisplayName(strippedModel);
  if (strippedDisplayName !== strippedModel) {
    return strippedDisplayName;
  }

  return formatUsageIdentifier(strippedModel);
}

function usageKindBase(kind: string): string {
  return kind.split("/", 1)[0];
}

export function getCreditUsageDisplayName(
  kind: string,
  provider: string,
): string {
  const baseKind = usageKindBase(kind);
  const managedKindDisplayName = MANAGED_USAGE_KIND_DISPLAY_NAMES[baseKind];
  if (managedKindDisplayName) {
    return managedKindDisplayName;
  }

  if (!provider || provider === "unknown") {
    return formatUsageIdentifier(kind);
  }

  const normalizedProvider = provider.trim();
  if (baseKind === "model" || baseKind === "image" || baseKind === "video") {
    return usageModelDisplayName(normalizedProvider);
  }

  const managedProviderDisplayName =
    MANAGED_USAGE_PROVIDER_DISPLAY_NAMES[normalizedProvider];
  if (managedProviderDisplayName) {
    return managedProviderDisplayName;
  }

  return formatUsageIdentifier(normalizedProvider);
}
