import { getModelDisplayName } from "@vm0/core/model-display-name";

const CONNECTOR_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  firecrawl: "Web Fetch",
  perplexity: "Web Search",
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
  if (!provider || provider === "unknown") {
    return formatUsageIdentifier(kind);
  }

  const normalizedProvider = provider.trim();
  const baseKind = usageKindBase(kind);
  if (baseKind === "connector") {
    const connectorDisplayName = CONNECTOR_DISPLAY_NAMES[normalizedProvider];
    if (connectorDisplayName) {
      return connectorDisplayName;
    }
  }

  if (baseKind === "model" || baseKind === "image" || baseKind === "video") {
    return usageModelDisplayName(normalizedProvider);
  }

  return formatUsageIdentifier(normalizedProvider);
}
