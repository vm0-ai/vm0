import { computed, type Computed } from "ccstate";
import {
  createConnectorActionBlock,
  parseConnectorAuthorizeUrl,
  type ConnectorActionBlock,
} from "./connector-action-block.ts";
import {
  createPermissionActionBlock,
  parsePermissionActionUrl,
  type PermissionActionBlock,
} from "./permission-action-block.ts";

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
  | "html"
  | "file";

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
    }
  | ConnectorActionBlock
  | PermissionActionBlock;

type ChatAttachmentKind = BodyPreviewKind;

interface ChatAttachmentDescriptor {
  filename: string;
  url: string;
  contentType?: string;
}

type ExtractedPreviewUrl = {
  url: string;
  source: "markdown-link" | "bare-url" | "preview-url-line";
  title?: string;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TEXT_PREVIEW_MAX_BYTES = 65_536;
const PLATFORM_FILE_PATH_PATTERN = /^\/(?:f|artifacts)\/[^/]+\/[^/]+\/[^/]+$/;
const PLATFORM_FILE_HOST_SUFFIXES = ["vm0.ai", "vm6.ai", "vm7.ai"] as const;
const PLATFORM_FILE_CDN_HOSTS = ["cdn.vm0.io", "cdn.vm7.io"] as const;
const HOSTED_SITE_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u;
const URL_TOKEN_PATTERN = String.raw`(?:https?:\/\/|\/(?:f|artifacts)\/)[^\s<>"'()（）【】《》「」『』“”‘’，。；：！？、]+`;

// ---------------------------------------------------------------------------
// classifyChatAttachment helpers
// ---------------------------------------------------------------------------

function fileExt(filename: string): string {
  return filename.split(".").pop()?.toLowerCase() ?? "";
}

function normalizeType(contentType?: string): string {
  return (contentType ?? "").split(";")[0]?.trim().toLowerCase();
}

const CHAT_KIND_BY_CONTENT_TYPE: Readonly<Record<string, BodyPreviewKind>> = {
  "text/markdown": "markdown",
  "text/x-markdown": "markdown",
  "text/plain": "text",
  "text/tab-separated-values": "text",
  "text/xml": "text",
  "text/yaml": "text",
  "text/x-yaml": "text",
  "application/xml": "text",
  "application/yaml": "text",
  "application/x-yaml": "text",
  "application/json": "json",
  "text/csv": "csv",
  "application/pdf": "pdf",
  "text/html": "html",
} as const;

const CHAT_KIND_BY_EXTENSION: Readonly<Record<string, BodyPreviewKind>> = {
  md: "markdown",
  txt: "text",
  log: "text",
  xml: "text",
  yaml: "text",
  yml: "text",
  tsv: "text",
  json: "json",
  csv: "csv",
  pdf: "pdf",
  html: "html",
  htm: "html",
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  svg: "image",
  bmp: "image",
  avif: "image",
  heic: "image",
  heif: "image",
  tif: "image",
  tiff: "image",
  psd: "image",
  mp4: "video",
  webm: "video",
  mov: "video",
  ogv: "video",
  mp3: "audio",
  wav: "audio",
  wave: "audio",
  m4a: "audio",
  aac: "audio",
  ogg: "audio",
  oga: "audio",
  opus: "audio",
  flac: "audio",
  mpga: "audio",
} as const;

function mediaKindFromContentType(type: string): BodyPreviewKind | null {
  if (type.startsWith("image/")) {
    return "image";
  }
  if (type.startsWith("video/")) {
    return "video";
  }
  if (type.startsWith("audio/")) {
    return "audio";
  }
  return null;
}

export function classifyChatAttachment(
  attachment: ChatAttachmentDescriptor,
): ChatAttachmentKind {
  const type = normalizeType(attachment.contentType);
  const ext = fileExt(attachment.filename);
  const mediaKind = mediaKindFromContentType(type);

  if (mediaKind) {
    return mediaKind;
  }

  return (
    CHAT_KIND_BY_CONTENT_TYPE[type] ?? CHAT_KIND_BY_EXTENSION[ext] ?? "file"
  );
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
    kind === "html" ||
    kind === "file"
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
  if (kind === "file") {
    return "application/octet-stream";
  }
  return "video/*";
}

// ---------------------------------------------------------------------------
// URL / line parsing
// ---------------------------------------------------------------------------

type PlatformHostTarget = "api" | "www" | "app" | "platform";

function browserHost(): string | null {
  if (typeof location === "undefined" || !location.host) {
    return null;
  }
  return location.host;
}

function rewritePlatformHostname(
  hostname: string,
  target: PlatformHostTarget,
): string {
  return hostname.replace(/(^|-)(platform|app|www|api)\./, `$1${target}.`);
}

function addPlatformFileHostVariants(hosts: Set<string>, host: string | null) {
  if (!host) {
    return;
  }

  hosts.add(host);

  const hostUrl = `https://${host}`;
  if (!URL.canParse(hostUrl)) {
    return;
  }

  const parsed = new URL(hostUrl);
  for (const target of ["api", "www", "app", "platform"] as const) {
    parsed.hostname = rewritePlatformHostname(parsed.hostname, target);
    hosts.add(parsed.host);
  }
}

function platformFileHosts(): Set<string> {
  const hosts = new Set<string>();
  addPlatformFileHostVariants(hosts, browserHost());
  addPlatformFileHostVariants(
    hosts,
    artifactsCdnHost(import.meta.env.PUBLIC_ARTIFACTS_BASE_URL),
  );
  return hosts;
}

function isPlatformFileHostname(hostname: string): boolean {
  const isAppHost = PLATFORM_FILE_HOST_SUFFIXES.some((suffix) => {
    return hostname === suffix || hostname.endsWith(`.${suffix}`);
  });
  if (isAppHost) {
    return true;
  }
  return PLATFORM_FILE_CDN_HOSTS.some((host) => {
    return hostname === host;
  });
}

function artifactsCdnHost(baseUrl: string | undefined): string | null {
  if (!baseUrl || !URL.canParse(baseUrl)) {
    return null;
  }
  return new URL(baseUrl).host;
}

function hasExplicitUrlOrigin(url: string): boolean {
  return /^[a-z][a-z\d+\-.]*:\/\//i.test(url);
}

function isPlatformFileUrl(url: string): boolean {
  const host = browserHost();
  const baseUrl = host ? `https://${host}` : "https://vm0.local";
  if (!URL.canParse(url, baseUrl)) {
    return false;
  }
  const parsed = new URL(url, baseUrl);
  if (!PLATFORM_FILE_PATH_PATTERN.test(parsed.pathname)) {
    return false;
  }
  if (!hasExplicitUrlOrigin(url)) {
    return true;
  }
  return (
    platformFileHosts().has(parsed.host) ||
    isPlatformFileHostname(parsed.hostname)
  );
}

function normalizeHostedSiteDomain(value: string | undefined): string | null {
  const trimmed = value?.trim().toLowerCase();
  if (!trimmed) {
    return null;
  }
  if (trimmed.includes("://")) {
    if (!URL.canParse(trimmed)) {
      return null;
    }
    return new URL(trimmed).hostname;
  }
  return trimmed.replace(/^\.+|\.+$/g, "");
}

function hostedSiteDomain(): string | null {
  const domain = import.meta.env.VITE_ZERO_HOST_DOMAIN;
  return normalizeHostedSiteDomain(
    typeof domain === "string" ? domain : undefined,
  );
}

function hostedSitePublicSlug(hostname: string): string | null {
  const domain = hostedSiteDomain();
  if (!domain) {
    return null;
  }

  const suffix = `.${domain}`;
  if (!hostname.endsWith(suffix)) {
    return null;
  }

  const slug = hostname.slice(0, -suffix.length);
  return HOSTED_SITE_SLUG_PATTERN.test(slug) ? slug : null;
}

function isHostedSiteUrl(url: string): boolean {
  if (!hasExplicitUrlOrigin(url)) {
    return false;
  }

  const host = browserHost();
  const baseUrl = host ? `https://${host}` : "https://vm0.local";
  if (!URL.canParse(url, baseUrl)) {
    return false;
  }

  const parsed = new URL(url, baseUrl);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return false;
  }

  return hostedSitePublicSlug(parsed.hostname) !== null;
}

function hostedSiteAttachment(
  url: string,
  title?: string,
): ChatAttachmentDescriptor | null {
  const host = browserHost();
  const baseUrl = host ? `https://${host}` : "https://vm0.local";
  if (!URL.canParse(url, baseUrl)) {
    return null;
  }

  const parsed = new URL(url, baseUrl);
  const publicSlug = hostedSitePublicSlug(parsed.hostname);
  if (!publicSlug) {
    return null;
  }

  return {
    filename: title?.trim() || url,
    url,
    contentType: "text/html",
  };
}

function isPreviewableChatUrl(url: string): boolean {
  return isPlatformFileUrl(url) || isHostedSiteUrl(url);
}

export function previewAttachmentFromUrl(
  url: string,
  title?: string,
): ChatAttachmentDescriptor {
  const hosted = hostedSiteAttachment(url, title);
  if (hosted) {
    return hosted;
  }

  const filename = filenameFromUrl(url);
  const trimmedTitle = title?.trim();
  if (trimmedTitle && /\.(?:html|htm)$/i.test(filename)) {
    return { filename: trimmedTitle, url, contentType: "text/html" };
  }
  return { filename, url };
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
    new RegExp(String.raw`^\[([^\]]+)\]\((${URL_TOKEN_PATTERN})\)$`),
  );
  const bareUrlMatch = candidate.match(new RegExp(`^(${URL_TOKEN_PATTERN})$`));
  if (markdownLinkMatch?.[2]) {
    return {
      url: trimPreviewUrl(markdownLinkMatch[2]),
      source: "markdown-link",
      title: markdownLinkMatch[1]?.trim(),
    };
  }
  if (bareUrlMatch?.[1]) {
    return {
      url: trimPreviewUrl(bareUrlMatch[1]),
      source: "bare-url",
    };
  }

  const urls = Array.from(
    candidate.matchAll(new RegExp(URL_TOKEN_PATTERN, "g")),
    (match) => {
      return trimPreviewUrl(match[0]);
    },
  ).filter((url, index, list) => {
    return url.length > 0 && list.indexOf(url) === index;
  });

  if (urls.length === 1 && isPreviewableChatUrl(urls[0]!)) {
    return {
      url: urls[0]!,
      source: "preview-url-line",
    };
  }

  return null;
}

function extractActionUrlFromLine(line: string): string | null {
  const candidate = stripMarkdownLineDecorations(line);
  const markdownLinkMatch = candidate.match(
    new RegExp(String.raw`^\[([^\]]+)\]\((${URL_TOKEN_PATTERN})\)$`),
  );
  const bareUrlMatch = candidate.match(new RegExp(`^(${URL_TOKEN_PATTERN})$`));
  if (markdownLinkMatch?.[2]) {
    return trimPreviewUrl(markdownLinkMatch[2]);
  }
  if (bareUrlMatch?.[1]) {
    return trimPreviewUrl(bareUrlMatch[1]);
  }

  const urls = Array.from(
    candidate.matchAll(new RegExp(URL_TOKEN_PATTERN, "g")),
    (match) => {
      return trimPreviewUrl(match[0]);
    },
  ).filter((url, index, list) => {
    return url.length > 0 && list.indexOf(url) === index;
  });

  return urls.length === 1 ? urls[0]! : null;
}

function createActionBlockFromLine(
  line: string,
  id: (type: BodyRenderBlock["type"]) => string,
): ConnectorActionBlock | PermissionActionBlock | null {
  const url = extractActionUrlFromLine(line);
  if (!url) {
    return null;
  }

  const connectorAction = parseConnectorAuthorizeUrl(url);
  if (connectorAction) {
    return createConnectorActionBlock(id("connector-action"), connectorAction);
  }

  const permissionAction = parsePermissionActionUrl(url);
  if (permissionAction) {
    return createPermissionActionBlock(
      id("permission-action"),
      permissionAction,
    );
  }

  return null;
}

function splitMarkdownTableRow(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.includes("|")) {
    return null;
  }

  const cells: string[] = [];
  let current = "";
  let escaped = false;
  for (const char of trimmed) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      current += char;
      escaped = true;
      continue;
    }
    if (char === "|") {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  cells.push(current.trim());

  if (cells[0] === "") {
    cells.shift();
  }
  if (cells.at(-1) === "") {
    cells.pop();
  }

  return cells.length >= 2 ? cells : null;
}

function isMarkdownTableSeparator(line: string): boolean {
  const cells = splitMarkdownTableRow(line);
  return (
    cells !== null &&
    cells.every((cell) => {
      return /^:?-{3,}:?$/.test(cell.replace(/\s+/g, ""));
    })
  );
}

function isMarkdownTableContentRow(line: string): boolean {
  const cells = splitMarkdownTableRow(line);
  return (
    cells !== null &&
    cells.some((cell) => {
      return cell.length > 0;
    })
  );
}

function markdownTableRowIndexes(lines: string[]): Set<number> {
  const indexes = new Set<number>();
  for (let index = 0; index < lines.length - 1; index += 1) {
    if (
      isMarkdownTableContentRow(lines[index]!) &&
      isMarkdownTableSeparator(lines[index + 1]!)
    ) {
      indexes.add(index);
      indexes.add(index + 1);

      for (
        let rowIndex = index + 2;
        rowIndex < lines.length && isMarkdownTableContentRow(lines[rowIndex]!);
        rowIndex += 1
      ) {
        indexes.add(rowIndex);
      }
    }
  }
  return indexes;
}

// ---------------------------------------------------------------------------
// Block parsing
// ---------------------------------------------------------------------------

export function parseBodyRenderBlocks(
  content: string,
  options: { previews?: boolean } = {},
): {
  cleanContent: string;
  blocks: BodyRenderBlock[];
} {
  const previews = options.previews ?? true;
  const blocks: BodyRenderBlock[] = [];
  const lines = content.split("\n");
  const tableRowIndexes = markdownTableRowIndexes(lines);
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

  for (const [lineIndex, line] of lines.entries()) {
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

    if (tableRowIndexes.has(lineIndex)) {
      markdownBuffer.push(line);
      keptLines.push(line);
      continue;
    }

    const actionBlock = createActionBlockFromLine(line, nextBlockId);
    if (actionBlock) {
      flushMarkdownBuffer();
      blocks.push(actionBlock);
      continue;
    }

    const extracted = previews ? extractPreviewUrlFromLine(line) : null;
    if (!extracted) {
      markdownBuffer.push(line);
      keptLines.push(line);
      continue;
    }

    const { title, url } = extracted;
    const attachment = previewAttachmentFromUrl(url, title);
    const kind = classifyChatAttachment(attachment);

    if (
      extracted.source === "markdown-link" &&
      (kind === "image" || kind === "video")
    ) {
      markdownBuffer.push(line);
      keptLines.push(line);
      continue;
    }

    if (isBodyPreviewKind(kind)) {
      // Only render platform-managed files and hosted sites as inline previews.
      // Other external URLs stay as plain markdown links.
      if (!isPreviewableChatUrl(url)) {
        markdownBuffer.push(line);
        keptLines.push(line);
        continue;
      }
      flushMarkdownBuffer();
      blocks.push({
        type: "preview",
        id: nextBlockId("preview"),
        preview: { filename: attachment.filename, url, kind },
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
  return url;
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
