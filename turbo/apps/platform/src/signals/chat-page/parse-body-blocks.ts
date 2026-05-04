import { computed, type Computed } from "ccstate";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BodyPreviewKind =
  | "image"
  | "video"
  | "audio"
  | "markdown"
  | "text"
  | "json"
  | "csv"
  | "pdf"
  | "html";

export type BodyRenderBlock =
  | {
      type: "markdown";
      id: string;
      content: string;
    }
  | {
      type: "preview";
      id: string;
      preview: {
        filename: string;
        url: string;
        kind: BodyPreviewKind;
        text$?: Computed<Promise<string>>;
      };
    };

type ChatAttachmentKind =
  | "image"
  | "video"
  | "audio"
  | "markdown"
  | "text"
  | "json"
  | "csv"
  | "pdf"
  | "html"
  | "file";

interface ChatAttachmentDescriptor {
  filename: string;
  url: string;
  contentType?: string;
}

type ExtractedPreviewUrl = {
  url: string;
  source: "markdown-link" | "bare-url" | "platform-file-line";
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TEXT_PREVIEW_MAX_BYTES = 65_536;

// ---------------------------------------------------------------------------
// classifyChatAttachment helpers
// ---------------------------------------------------------------------------

function fileExt(filename: string): string {
  return filename.split(".").pop()?.toLowerCase() ?? "";
}

function normalizeType(contentType?: string): string {
  return (contentType ?? "").split(";")[0]?.trim().toLowerCase();
}

export function classifyChatAttachment(
  attachment: ChatAttachmentDescriptor,
): ChatAttachmentKind {
  const type = normalizeType(attachment.contentType);
  const ext = fileExt(attachment.filename);

  if (type.startsWith("image/")) {
    return "image";
  }
  if (type.startsWith("video/")) {
    return "video";
  }
  if (type.startsWith("audio/")) {
    return "audio";
  }

  if (type === "text/markdown" || ext === "md") {
    return "markdown";
  }
  if (type === "text/plain" || ext === "txt") {
    return "text";
  }
  if (type === "application/json" || ext === "json") {
    return "json";
  }
  if (type === "text/csv" || ext === "csv") {
    return "csv";
  }
  if (type === "application/pdf" || ext === "pdf") {
    return "pdf";
  }
  if (type === "text/html" || ext === "html" || ext === "htm") {
    return "html";
  }

  if (
    ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif"].includes(ext)
  ) {
    return "image";
  }
  if (["mp4", "webm", "mov", "ogv"].includes(ext)) {
    return "video";
  }
  if (
    ["mp3", "wav", "m4a", "aac", "ogg", "oga", "opus", "flac", "mpga"].includes(
      ext,
    )
  ) {
    return "audio";
  }

  return "file";
}

function filenameFromUrl(url: string): string {
  const path = url.split("?")[0].split("#")[0];
  const last = path.split("/").pop();
  if (!last || last.length === 0) {
    return "file";
  }
  return last;
}

function isBodyPreviewKind(kind: string): kind is BodyPreviewKind {
  return (
    kind === "image" ||
    kind === "video" ||
    kind === "audio" ||
    kind === "markdown" ||
    kind === "text" ||
    kind === "json" ||
    kind === "csv" ||
    kind === "pdf" ||
    kind === "html"
  );
}

export function contentTypeForBodyPreviewKind(kind: BodyPreviewKind): string {
  if (kind === "markdown") {
    return "text/markdown";
  }
  if (kind === "text") {
    return "text/plain";
  }
  if (kind === "json") {
    return "application/json";
  }
  if (kind === "csv") {
    return "text/csv";
  }
  if (kind === "pdf") {
    return "application/pdf";
  }
  if (kind === "html") {
    return "text/html";
  }
  if (kind === "image") {
    return "image/*";
  }
  if (kind === "audio") {
    return "audio/*";
  }
  return "video/*";
}

// ---------------------------------------------------------------------------
// URL / line parsing
// ---------------------------------------------------------------------------

function isPlatformFileUrl(url: string): boolean {
  const baseUrl = "https://vm0.local";
  if (!URL.canParse(url, baseUrl)) {
    return false;
  }
  const parsed = new URL(url, baseUrl);
  return /^\/f\/[^/]+\/[^/]+\/[^/]+$/.test(parsed.pathname);
}

function stripMarkdownLineDecorations(value: string): string {
  let candidate = value
    .trim()
    .replace(/^(?:>\s*)+/, "")
    .replace(/^(?:[-*+]\s+|\d+[.)]\s+)/, "")
    .trim();
  const wrappers: [string, string][] = [
    ["**", "**"],
    ["__", "__"],
    ["*", "*"],
    ["_", "_"],
    ["~~", "~~"],
    ["`", "`"],
    ["<", ">"],
    ["(", ")"],
    ["（", "）"],
  ];

  let changed = true;
  while (changed) {
    changed = false;
    for (const [prefix, suffix] of wrappers) {
      if (candidate.startsWith(prefix) && candidate.endsWith(suffix)) {
        candidate = candidate
          .slice(prefix.length, candidate.length - suffix.length)
          .trim();
        changed = true;
        break;
      }
    }
  }

  return candidate;
}

function trimPreviewUrl(value: string): string {
  let url = value.trim();
  let previous = "";
  while (url !== previous) {
    previous = url;
    url = url
      .replace(/[*_~`]+$/g, "")
      .replace(/[)\]}>.,，。；;:：!！?？]+$/g, "");
  }
  return url;
}

function extractPreviewUrlFromLine(line: string): ExtractedPreviewUrl | null {
  const candidate = stripMarkdownLineDecorations(line);
  const markdownLinkMatch = candidate.match(
    /^\[([^\]]+)\]\((https?:\/\/[^)\s]+|\/f\/[^)\s]+)\)$/,
  );
  const bareUrlMatch = candidate.match(/^(https?:\/\/\S+|\/f\/\S+)$/);
  if (markdownLinkMatch?.[2]) {
    return {
      url: trimPreviewUrl(markdownLinkMatch[2]),
      source: "markdown-link",
    };
  }
  if (bareUrlMatch?.[1]) {
    return {
      url: trimPreviewUrl(bareUrlMatch[1]),
      source: "bare-url",
    };
  }

  const urls = Array.from(
    candidate.matchAll(/(?:https?:\/\/|\/f\/)[^\s<>"']+/g),
    (match) => {
      return trimPreviewUrl(match[0]);
    },
  ).filter((url, index, list) => {
    return url.length > 0 && list.indexOf(url) === index;
  });

  if (urls.length === 1 && isPlatformFileUrl(urls[0]!)) {
    return {
      url: urls[0]!,
      source: "platform-file-line",
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Block parsing (pure — no computeds)
// ---------------------------------------------------------------------------

export function parseBodyRenderBlocks(content: string): {
  cleanContent: string;
  blocks: BodyRenderBlock[];
} {
  const blocks: BodyRenderBlock[] = [];
  const lines = content.split("\n");
  const keptLines: string[] = [];
  const markdownBuffer: string[] = [];
  let blockSequence = 0;
  let openFence: {
    marker: "`" | "~";
    length: number;
  } | null = null;
  const nextBlockId = (type: BodyRenderBlock["type"]) => {
    blockSequence += 1;
    return `${type}-${blockSequence}`;
  };

  const flushMarkdownBuffer = () => {
    const joined = markdownBuffer.join("\n").trim();
    if (joined) {
      blocks.push({
        type: "markdown",
        id: nextBlockId("markdown"),
        content: joined,
      });
    }
    markdownBuffer.length = 0;
  };

  for (const line of lines) {
    const trimmedLine = line.trim();
    const fenceMatch = trimmedLine.match(/^(`{3,}|~{3,})/);
    if (fenceMatch) {
      const fence = fenceMatch[1];
      const marker = fence.startsWith("`") ? "`" : "~";
      if (
        openFence &&
        openFence.marker === marker &&
        fence.length >= openFence.length
      ) {
        openFence = null;
      } else if (!openFence) {
        openFence = { marker, length: fence.length };
      }
      markdownBuffer.push(line);
      keptLines.push(line);
      continue;
    }

    if (openFence) {
      markdownBuffer.push(line);
      keptLines.push(line);
      continue;
    }

    const extracted = extractPreviewUrlFromLine(line);
    if (!extracted) {
      markdownBuffer.push(line);
      keptLines.push(line);
      continue;
    }

    const { url } = extracted;
    const filename = filenameFromUrl(url);
    const kind = classifyChatAttachment({ filename, url });

    if (
      extracted.source === "markdown-link" &&
      (kind === "image" || kind === "video")
    ) {
      markdownBuffer.push(line);
      keptLines.push(line);
      continue;
    }

    if (isBodyPreviewKind(kind)) {
      // Only render platform /f/ file URLs as inline preview cards.
      // External URLs stay as plain markdown links so the recipient
      // isn't misled into thinking the file was uploaded to vm0.
      if (!isPlatformFileUrl(url)) {
        markdownBuffer.push(line);
        keptLines.push(line);
        continue;
      }
      flushMarkdownBuffer();
      blocks.push({
        type: "preview",
        id: nextBlockId("preview"),
        preview: { filename, url, kind },
      });
      continue;
    }

    markdownBuffer.push(line);
    keptLines.push(line);
  }

  flushMarkdownBuffer();

  return {
    cleanContent: keptLines.join("\n").trim(),
    blocks,
  };
}

// ---------------------------------------------------------------------------
// Text preview fetch (no AbortSignal — managed by computed lifecycle)
// ---------------------------------------------------------------------------

async function readLimitedText(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    return "";
  }

  const chunks: Uint8Array[] = [];
  let received = 0;
  let reachedLimit = false;

  while (received < TEXT_PREVIEW_MAX_BYTES) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    const remaining = TEXT_PREVIEW_MAX_BYTES - received;
    const chunk =
      value.byteLength > remaining ? value.slice(0, remaining) : value;
    chunks.push(chunk);
    received += chunk.byteLength;
    if (received >= TEXT_PREVIEW_MAX_BYTES) {
      reachedLimit = true;
      break;
    }
  }

  if (reachedLimit) {
    await reader.cancel();
  }

  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function toRawUrl(url: string): string {
  if (!URL.canParse(url, window.location.origin)) {
    const hashIndex = url.indexOf("#");
    const base = hashIndex === -1 ? url : url.slice(0, hashIndex);
    const hash = hashIndex === -1 ? "" : url.slice(hashIndex);
    if (base.includes("raw=1")) {
      return url;
    }
    return `${base}${base.includes("?") ? "&" : "?"}raw=1${hash}`;
  }

  const parsed = new URL(url, window.location.origin);
  if (parsed.searchParams.get("raw") !== "1") {
    parsed.searchParams.set("raw", "1");
  }
  return parsed.toString();
}

export async function fetchPreviewText(
  url: string,
  signal?: AbortSignal,
): Promise<string> {
  const response = await fetch(toRawUrl(url), {
    headers: { Range: `bytes=0-${String(TEXT_PREVIEW_MAX_BYTES - 1)}` },
    signal,
  });
  if (!response.ok) {
    throw new Error(`HTTP ${String(response.status)}`);
  }
  return readLimitedText(response);
}

export const EMPTY_TEXT$ = computed(() => {
  return Promise.resolve("");
});

function needsTextPreview(kind: BodyPreviewKind): boolean {
  return kind === "text" || kind === "json";
}

function getTextPreview$(url: string): Computed<Promise<string>> {
  const self = getTextPreview$ as typeof getTextPreview$ & {
    _cache?: Map<string, Computed<Promise<string>>>;
  };
  if (!self._cache) {
    self._cache = new Map();
  }
  let c = self._cache.get(url);
  if (!c) {
    c = computed(() => {
      return fetchPreviewText(url);
    });
    self._cache.set(url, c);
  }
  return c;
}

export function enrichBlocksWithTextPreviews(
  blocks: BodyRenderBlock[],
): BodyRenderBlock[] {
  return blocks.map((block) => {
    if (block.type === "preview" && needsTextPreview(block.preview.kind)) {
      return {
        ...block,
        preview: {
          ...block.preview,
          text$: getTextPreview$(block.preview.url),
        },
      };
    }
    return block;
  });
}
