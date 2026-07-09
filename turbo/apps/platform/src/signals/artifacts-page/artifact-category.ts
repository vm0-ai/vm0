import type { ArtifactItem } from "@vm0/api-contracts/contracts/chat-threads";

export type ArtifactCategory =
  | "image"
  | "website"
  | "presentation"
  | "document"
  | "data"
  | "other";

function normalizedContentType(contentType: string): string {
  return contentType.split(";")[0]?.trim().toLowerCase() ?? "";
}

function filenameMatches(filename: string, pattern: RegExp): boolean {
  return pattern.test(filename.toLowerCase());
}

function isImageArtifact(item: ArtifactItem): boolean {
  return normalizedContentType(item.contentType).startsWith("image/");
}

function isWebsiteArtifact(item: ArtifactItem): boolean {
  const contentType = normalizedContentType(item.contentType);
  return (
    item.artifactKind === "hosted-site" ||
    (contentType === "text/html" && item.artifactKind !== "presentation-html")
  );
}

function isPresentationArtifact(item: ArtifactItem): boolean {
  const contentType = normalizedContentType(item.contentType);
  return (
    item.artifactKind === "presentation-html" ||
    filenameMatches(
      item.filename,
      /\.(ppt|pptx|pptm|potx|potm|ppsx|ppsm|odp|key)$/,
    ) ||
    contentType.includes("presentation") ||
    contentType.includes("powerpoint") ||
    contentType.includes("keynote")
  );
}

function isDataArtifact(item: ArtifactItem): boolean {
  const contentType = normalizedContentType(item.contentType);
  return (
    contentType.includes("json") ||
    contentType.includes("csv") ||
    contentType.includes("spreadsheet") ||
    contentType.includes("excel") ||
    contentType.includes("parquet") ||
    filenameMatches(
      item.filename,
      /\.(json|csv|tsv|xls|xlsx|xlsm|xlsb|xltx|xltm|ods|numbers|parquet|sqlite|sqlite3|db)$/,
    )
  );
}

function isDocumentArtifact(item: ArtifactItem): boolean {
  const contentType = normalizedContentType(item.contentType);
  return (
    !isWebsiteArtifact(item) &&
    !isPresentationArtifact(item) &&
    !isDataArtifact(item) &&
    (contentType.startsWith("text/") ||
      contentType.includes("pdf") ||
      contentType.includes("document") ||
      filenameMatches(
        item.filename,
        /\.(pdf|md|markdown|mdx|txt|log|xml|yaml|yml|doc|docx|docm|dotx|dotm|odt|rtf|pages|epub)$/,
      ))
  );
}

export function artifactMatchesCategory(
  item: ArtifactItem,
  category: ArtifactCategory | undefined | null,
): boolean {
  if (!category) {
    return true;
  }

  if (category === "image") {
    return isImageArtifact(item);
  }

  if (category === "website") {
    return isWebsiteArtifact(item);
  }

  if (category === "presentation") {
    return isPresentationArtifact(item);
  }

  if (category === "document") {
    return isDocumentArtifact(item);
  }

  if (category === "data") {
    return isDataArtifact(item);
  }

  return (
    !isImageArtifact(item) &&
    !isWebsiteArtifact(item) &&
    !isPresentationArtifact(item) &&
    !isDocumentArtifact(item) &&
    !isDataArtifact(item)
  );
}
