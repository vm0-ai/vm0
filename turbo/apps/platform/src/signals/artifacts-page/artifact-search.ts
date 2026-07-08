import type { ArtifactItem } from "@vm0/api-contracts/contracts/chat-threads";

export function normalizedSearchTokens(
  query: string | undefined,
): readonly string[] {
  const normalized = query?.trim().toLowerCase();
  if (!normalized) {
    return [];
  }
  return normalized.split(/\s+/).filter((token) => {
    return token.length > 0;
  });
}

export function artifactSearchText(item: ArtifactItem): string {
  return [item.filename, item.contentType, item.artifactKind ?? ""]
    .join("\n")
    .toLowerCase();
}
