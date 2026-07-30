import { getModelDisplayName } from "@vm0/core/model-display-name";
import { i18n } from "../i18n/index.ts";

const USAGE_DISPLAY_NAMES = {
  auto(): string {
    return i18n.t(($) => {
      return $.usage.displayNames.auto;
    });
  },
  finance(): string {
    return i18n.t(($) => {
      return $.usage.displayNames.finance;
    });
  },
  maps(): string {
    return i18n.t(($) => {
      return $.usage.displayNames.maps;
    });
  },
  peopleSearch(): string {
    return i18n.t(($) => {
      return $.usage.displayNames.peopleSearch;
    });
  },
  weather(): string {
    return i18n.t(($) => {
      return $.usage.displayNames.weather;
    });
  },
  webFetch(): string {
    return i18n.t(($) => {
      return $.usage.displayNames.webFetch;
    });
  },
  webSearch(): string {
    return i18n.t(($) => {
      return $.usage.displayNames.webSearch;
    });
  },
} as const;

const MANAGED_USAGE_KIND_DISPLAY_NAMES: Readonly<Record<string, () => string>> =
  {
    scrape: USAGE_DISPLAY_NAMES.webFetch,
    maps: USAGE_DISPLAY_NAMES.maps,
    "web-search": USAGE_DISPLAY_NAMES.webSearch,
    "people-search": USAGE_DISPLAY_NAMES.peopleSearch,
    finance: USAGE_DISPLAY_NAMES.finance,
    weather: USAGE_DISPLAY_NAMES.weather,
  };

// Current Settings responses retain raw usage kinds inside each provider.
// Keep provider aliases for older APIs that only return the provider so app
// and API promotions can serve different versions safely.
const MANAGED_USAGE_PROVIDER_DISPLAY_NAMES: Readonly<
  Record<string, () => string>
> = {
  firecrawl: USAGE_DISPLAY_NAMES.webFetch,
  "google-maps": USAGE_DISPLAY_NAMES.maps,
  openstreetmap: USAGE_DISPLAY_NAMES.maps,
  perplexity: USAGE_DISPLAY_NAMES.webSearch,
  apidojo: USAGE_DISPLAY_NAMES.finance,
  "google-weather": USAGE_DISPLAY_NAMES.weather,
  "google-air-quality": USAGE_DISPLAY_NAMES.weather,
};

const MODEL_DISPLAY_NAMES: Readonly<Record<string, () => string>> = {
  "vm0-model": USAGE_DISPLAY_NAMES.auto,
};

function titleCaseUsageToken(token: string): string {
  const upper = token.toUpperCase();
  if (["AI", "API", "GLM", "GPT", "ID", "SQL", "URL", "VM0"].includes(upper)) {
    return upper;
  }

  return token.charAt(0).toUpperCase() + token.slice(1);
}

function formatUsageDisplayName(value: string): string {
  const normalized = value.trim();
  if (!normalized) {
    return i18n.t(($) => {
      return $.usage.displayNames.usage;
    });
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
    return usageDisplayName();
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

  return formatUsageDisplayName(strippedModel);
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
    return managedKindDisplayName();
  }

  if (!provider || provider === "unknown") {
    return formatUsageDisplayName(kind);
  }

  const normalizedProvider = provider.trim();
  if (baseKind === "model" || baseKind === "image" || baseKind === "video") {
    return usageModelDisplayName(normalizedProvider);
  }

  const managedProviderDisplayName =
    MANAGED_USAGE_PROVIDER_DISPLAY_NAMES[normalizedProvider];
  if (managedProviderDisplayName) {
    return managedProviderDisplayName();
  }

  return formatUsageDisplayName(normalizedProvider);
}
