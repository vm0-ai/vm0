import type { AttachmentArtifactMetadata } from "../../signals/zero-page/zero-attachment-chips.ts";

type ArtifactDisplayKind =
  | "markdown"
  | "text"
  | "json"
  | "csv"
  | "html"
  | "pdf"
  | "image"
  | "video"
  | "audio"
  | "file";

type ArtifactTitleMetadata = Pick<
  AttachmentArtifactMetadata,
  "artifactKind" | "contentType" | "createdAt" | "filename" | "size"
>;

function fileExtension(filename: string): string | null {
  const extension = filename.split(".").pop();
  if (!extension || extension === filename) {
    return null;
  }
  return extension.toUpperCase();
}

function contentTypeFormat(contentType: string): string | null {
  const subtype = contentType.split("/")[1]?.split(";")[0]?.trim();
  if (!subtype) {
    return null;
  }
  if (subtype === "jpeg") {
    return "JPG";
  }
  if (subtype === "plain") {
    return "TXT";
  }
  if (subtype === "mpeg") {
    return "MP3";
  }
  return subtype.toUpperCase();
}

function isPresentationExtension(extension: string): boolean {
  switch (extension) {
    case "KEY":
    case "ODP":
    case "PPT":
    case "PPTX": {
      return true;
    }
    default: {
      return false;
    }
  }
}

function isCodeExtension(extension: string): boolean {
  switch (extension) {
    case "CSS":
    case "GO":
    case "HTML":
    case "JS":
    case "JSX":
    case "PY":
    case "RB":
    case "RS":
    case "TS":
    case "TSX": {
      return true;
    }
    default: {
      return false;
    }
  }
}

function artifactFormat(meta: ArtifactTitleMetadata): string | null {
  return fileExtension(meta.filename) ?? contentTypeFormat(meta.contentType);
}

function formatArtifactBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ["KB", "MB", "GB"] as const;
  let value = bytes / 1024;
  for (let i = 0; i < units.length; i++) {
    const unit = units[i]!;
    if (value < 1024 || i === units.length - 1) {
      return `${value.toFixed(value >= 10 ? 0 : 1)} ${unit}`;
    }
    value = value / 1024;
  }
  return `${bytes} B`;
}

function formatArtifactGeneratedTime(value: string): string {
  return new Date(value).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function artifactKindTitle(
  kind: ArtifactDisplayKind,
  filename: string,
  artifactKind: ArtifactTitleMetadata["artifactKind"],
): string {
  if (artifactKind === "presentation-html") {
    return "Presentation";
  }
  const extension = fileExtension(filename);
  if (extension && isPresentationExtension(extension)) {
    return "Presentation";
  }
  if (extension && isCodeExtension(extension)) {
    return kind === "html" ? "Hosted site" : "Code";
  }

  switch (kind) {
    case "markdown":
    case "pdf":
    case "text": {
      return "Document";
    }
    case "json":
    case "csv": {
      return "Data";
    }
    case "html": {
      return "Hosted site";
    }
    case "image": {
      return "Image";
    }
    case "video": {
      return "Video";
    }
    case "audio": {
      return "Audio";
    }
    case "file": {
      return "File";
    }
  }
}

export function artifactFallbackSubtitle(
  kind: ArtifactDisplayKind,
  filename: string,
): string {
  return artifactKindTitle(kind, filename, undefined);
}

export function artifactTitleSubtitle(
  kind: ArtifactDisplayKind,
  meta: ArtifactTitleMetadata,
): string {
  const parts = [artifactKindTitle(kind, meta.filename, meta.artifactKind)];
  const format = artifactFormat(meta);
  if (format && parts[0] !== "Hosted site") {
    parts.push(format);
  }
  parts.push(formatArtifactBytes(meta.size));
  parts.push(`Generated ${formatArtifactGeneratedTime(meta.createdAt)}`);
  return parts.join(" · ");
}
