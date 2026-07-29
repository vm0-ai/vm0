import {
  parseCustomConnectorProposalUrl,
  parseConnectorAuthorizeUrl,
  type ConnectorActionDescriptor,
  type ConnectorSignals,
  type CustomConnectorActionDescriptor,
  type CustomConnectorSignals,
} from "./connector-action-block.ts";
import {
  parsePermissionActionUrl,
  permissionActionResourceKey,
  type PermissionActionDescriptor,
} from "./permission-action-block.ts";
import {
  parseComputerUseAuthorizationUrl,
  type ComputerUseAuthorizationDescriptor,
  type ComputerUseAuthorizationSignals,
} from "./computer-use-authorization-block.ts";
import {
  parsePlanUpgradeUrl,
  type PlanUpgradeDescriptor,
  type PlanUpgradeSignals,
} from "./plan-upgrade-block.ts";
import type {
  ArtifactDescriptor,
  ArtifactKind,
  ArtifactSignals,
} from "./artifact-card-signals.ts";
import type { PermissionSignals } from "./permission-card-signals.ts";
import {
  parseMailDraftUrl,
  type MailDraftDescriptor,
  type MailDraftSignals,
} from "./mail-draft.ts";
import {
  parseBrowserSessionUrl,
  type BrowserSessionDescriptor,
  type BrowserSessionSignals,
} from "./browser-session-block.ts";
import {
  resolvePublicArtifactsBaseUrl,
  resolveZeroHostDomain,
} from "../../lib/platform-host.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BodyPreviewKind = ArtifactKind;

export type BodyRenderBlock =
  | {
      type: "markdown";
      id: string;
      content: string;
    }
  | {
      type: "artifact";
      resourceKey: string;
      signals: ArtifactSignals;
    }
  | {
      type: "connector-action";
      resourceKey: string;
      signals: ConnectorSignals;
    }
  | {
      type: "custom-connector-action";
      resourceKey: string;
      signals: CustomConnectorSignals;
    }
  | {
      type: "permission-action";
      resourceKey: string;
      signals: PermissionSignals;
    }
  | {
      type: "computer-use-authorization";
      resourceKey: string;
      signals: ComputerUseAuthorizationSignals;
    }
  | {
      type: "plan-upgrade";
      resourceKey: string;
      signals: PlanUpgradeSignals;
    }
  | {
      type: "mail-draft";
      resourceKey: string;
      signals: MailDraftSignals;
    }
  | {
      type: "browser-session";
      resourceKey: string;
      signals: BrowserSessionSignals;
    };

export type ParsedBodyBlock =
  | Extract<BodyRenderBlock, { type: "markdown" }>
  | {
      type: "artifact";
      resourceKey: string;
      descriptor: ArtifactDescriptor;
    }
  | {
      type: "connector-action";
      resourceKey: string;
      descriptor: ConnectorActionDescriptor;
    }
  | {
      type: "custom-connector-action";
      resourceKey: string;
      descriptor: CustomConnectorActionDescriptor;
    }
  | {
      type: "permission-action";
      resourceKey: string;
      descriptor: PermissionActionDescriptor;
    }
  | {
      type: "computer-use-authorization";
      resourceKey: string;
      descriptor: ComputerUseAuthorizationDescriptor;
    }
  | {
      type: "plan-upgrade";
      resourceKey: string;
      descriptor: PlanUpgradeDescriptor;
    }
  | {
      type: "mail-draft";
      resourceKey: string;
      descriptor: MailDraftDescriptor;
    }
  | {
      type: "browser-session";
      resourceKey: string;
      descriptor: BrowserSessionDescriptor;
    };

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

type OpenMarkdownFence = {
  marker: "`" | "~";
  length: number;
  lines: string[];
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PLATFORM_FILE_PATH_PATTERN = /^\/(?:f|artifacts)\/[^/]+\/[^/]+\/[^/]+$/;
const PLATFORM_FILE_HOST_SUFFIXES = ["vm0.ai", "vm6.ai", "vm7.ai"] as const;
const PLATFORM_FILE_CDN_HOSTS = ["cdn.vm0.io", "cdn.vm7.io"] as const;
const HOSTED_SITE_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u;
const URL_TOKEN_PATTERN = String.raw`(?:https?:\/\/|\/(?:f|artifacts|browsers)\/|\/mail\/drafts\/|\/\?settings=billing&billingView=)[^\s<>"'()（）【】《》「」『』“”‘’，。；：！？、]+`;

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
    artifactsCdnHost(resolvePublicArtifactsBaseUrl()),
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

function hostedSitePublicSlug(hostname: string): string | null {
  const domain = resolveZeroHostDomain();
  const normalizedHostname = hostname.toLowerCase();
  const suffix = `.${domain}`;
  if (!normalizedHostname.endsWith(suffix)) {
    return null;
  }

  const slug = normalizedHostname.slice(0, -suffix.length);
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

function markdownImageLine(url: string, alt: string): string {
  const escapedAlt = alt
    .replace(/\\/g, String.raw`\\`)
    .replace(/\]/g, String.raw`\]`);
  return `![${escapedAlt}](${url})`;
}

type ExtractedPreviewLineRender =
  | {
      renderKind: "markdown";
      line: string;
    }
  | {
      renderKind: "preview";
      preview: {
        filename: string;
        url: string;
        kind: BodyPreviewKind;
      };
    };

function renderExtractedPreviewLine(
  extracted: ExtractedPreviewUrl,
  line: string,
): ExtractedPreviewLineRender {
  const { title, url } = extracted;
  const attachment = previewAttachmentFromUrl(url, title);
  const kind = classifyChatAttachment(attachment);

  if (
    extracted.source === "markdown-link" &&
    (kind === "image" || kind === "video")
  ) {
    return { renderKind: "markdown", line };
  }

  if (kind === "image" && isPreviewableChatUrl(url)) {
    return {
      renderKind: "markdown",
      line: markdownImageLine(url, attachment.filename),
    };
  }

  if (isBodyPreviewKind(kind) && isPreviewableChatUrl(url)) {
    return {
      renderKind: "preview",
      preview: { filename: attachment.filename, url, kind },
    };
  }

  return { renderKind: "markdown", line };
}

function renderFencedHostedSitePreview(
  contentLines: readonly string[],
): ExtractedPreviewLineRender | null {
  const nonEmptyLines = contentLines.filter((line) => {
    return line.trim().length > 0;
  });
  if (nonEmptyLines.length !== 1) {
    return null;
  }

  const line = nonEmptyLines[0]!;
  const extracted = extractPreviewUrlFromLine(line);
  if (!extracted || !isHostedSiteUrl(extracted.url)) {
    return null;
  }

  const rendered = renderExtractedPreviewLine(extracted, line);
  return rendered.renderKind === "preview" && rendered.preview.kind === "html"
    ? rendered
    : null;
}

type MarkdownFenceLineResult =
  | {
      kind: "pending";
      openFence: OpenMarkdownFence | null;
    }
  | {
      kind: "markdown";
      openFence: null;
      lines: readonly string[];
    }
  | {
      kind: "preview";
      openFence: null;
      preview: {
        filename: string;
        url: string;
        kind: BodyPreviewKind;
      };
    };

function renderOpenMarkdownFence(
  openFence: OpenMarkdownFence,
  previews: boolean,
): MarkdownFenceLineResult {
  const renderedFence = previews
    ? renderFencedHostedSitePreview(openFence.lines.slice(1))
    : null;

  if (renderedFence?.renderKind === "preview") {
    return {
      kind: "preview",
      openFence: null,
      preview: renderedFence.preview,
    };
  }

  return { kind: "markdown", openFence: null, lines: openFence.lines };
}

function parseMarkdownFenceLine(
  line: string,
  openFence: OpenMarkdownFence | null,
  previews: boolean,
): MarkdownFenceLineResult | null {
  const trimmedLine = line.trim();
  const fenceMatch = trimmedLine.match(/^(`{3,}|~{3,})/);
  if (!fenceMatch) {
    if (!openFence) {
      return null;
    }

    openFence.lines.push(line);
    return { kind: "pending", openFence };
  }

  const fence = fenceMatch[1]!;
  const marker = fence.startsWith("`") ? "`" : "~";
  if (!openFence) {
    return {
      kind: "pending",
      openFence: { marker, length: fence.length, lines: [line] },
    };
  }

  if (openFence.marker !== marker || fence.length < openFence.length) {
    openFence.lines.push(line);
    return { kind: "pending", openFence };
  }

  const result = renderOpenMarkdownFence(openFence, previews);
  if (result.kind === "markdown") {
    return { ...result, lines: [...openFence.lines, line] };
  }

  return result;
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

function createActionBlockFromLine(line: string): Extract<
  ParsedBodyBlock,
  {
    type:
      | "connector-action"
      | "custom-connector-action"
      | "permission-action"
      | "computer-use-authorization"
      | "plan-upgrade"
      | "mail-draft"
      | "browser-session";
  }
> | null {
  const url = extractActionUrlFromLine(line);
  if (!url) {
    return null;
  }

  const connectorAction = parseConnectorAuthorizeUrl(url);
  if (connectorAction) {
    return {
      type: "connector-action",
      resourceKey: connectorAction.originalUrl,
      descriptor: connectorAction,
    };
  }

  const customConnectorAction = parseCustomConnectorProposalUrl(url);
  if (customConnectorAction) {
    return {
      type: "custom-connector-action",
      resourceKey: customConnectorAction.originalUrl,
      descriptor: customConnectorAction,
    };
  }

  const permissionAction = parsePermissionActionUrl(url);
  if (permissionAction) {
    return {
      type: "permission-action",
      resourceKey: permissionActionResourceKey(permissionAction),
      descriptor: permissionAction,
    };
  }

  const computerUseAuthorization = parseComputerUseAuthorizationUrl(url);
  if (computerUseAuthorization) {
    return {
      type: "computer-use-authorization",
      resourceKey: computerUseAuthorization.href,
      descriptor: computerUseAuthorization,
    };
  }

  const planUpgrade = parsePlanUpgradeUrl(url);
  if (planUpgrade) {
    return {
      type: "plan-upgrade",
      resourceKey: planUpgrade.href,
      descriptor: planUpgrade,
    };
  }

  const mailDraft = parseMailDraftUrl(url);
  if (mailDraft) {
    return {
      type: "mail-draft",
      resourceKey: mailDraft.mailDraftId,
      descriptor: mailDraft,
    };
  }

  const browserSession = parseBrowserSessionUrl(url, line);
  if (browserSession) {
    return {
      type: "browser-session",
      resourceKey: browserSession.fallbackMarkdown,
      descriptor: browserSession,
    };
  }

  return null;
}

function retainedConnectorActionMarkdown(
  line: string,
  action: ConnectorActionDescriptor,
): string | null {
  const candidate = stripMarkdownLineDecorations(line);
  const standaloneMarkdownLink = candidate.match(
    new RegExp(String.raw`^\[([^\]]+)\]\((${URL_TOKEN_PATTERN})\)$`),
  );
  const standaloneBareUrl = candidate.match(
    new RegExp(`^(${URL_TOKEN_PATTERN})$`),
  );
  if (standaloneMarkdownLink || standaloneBareUrl) {
    return null;
  }

  return line.replace(
    new RegExp(String.raw`\[([^\]]+)\]\((${URL_TOKEN_PATTERN})\)`),
    (match: string, label: string, url: string) => {
      return trimPreviewUrl(url) === action.originalUrl ? label : match;
    },
  );
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

export function parseBodyBlocks(
  content: string,
  options: { previews?: boolean } = {},
): {
  cleanContent: string;
  blocks: ParsedBodyBlock[];
} {
  const previews = options.previews ?? true;
  const blocks: ParsedBodyBlock[] = [];
  const lines = content.split("\n");
  const tableRowIndexes = markdownTableRowIndexes(lines);
  const keptLines: string[] = [];
  const markdownBuffer: string[] = [];
  let blockSequence = 0;
  let openFence: OpenMarkdownFence | null = null;
  const nextMarkdownBlockId = () => {
    blockSequence += 1;
    return `markdown-${blockSequence}`;
  };

  const flushMarkdownBuffer = () => {
    const joined = markdownBuffer.join("\n").trim();
    if (joined) {
      blocks.push({
        type: "markdown",
        id: nextMarkdownBlockId(),
        content: joined,
      });
    }
    markdownBuffer.length = 0;
  };

  const pushMarkdownLines = (nextLines: readonly string[]) => {
    markdownBuffer.push(...nextLines);
    keptLines.push(...nextLines);
  };

  const pushPreviewBlock = (
    preview: Extract<MarkdownFenceLineResult, { kind: "preview" }>["preview"],
  ) => {
    flushMarkdownBuffer();
    blocks.push({
      type: "artifact",
      resourceKey: preview.url,
      descriptor: preview,
    });
  };

  const applyFenceLineResult = (result: MarkdownFenceLineResult) => {
    openFence = result.openFence;
    if (result.kind === "markdown") {
      pushMarkdownLines(result.lines);
      return;
    }
    if (result.kind === "preview") {
      pushPreviewBlock(result.preview);
    }
  };

  for (const [lineIndex, line] of lines.entries()) {
    const fenceResult = parseMarkdownFenceLine(line, openFence, previews);
    if (fenceResult) {
      applyFenceLineResult(fenceResult);
      continue;
    }

    if (tableRowIndexes.has(lineIndex)) {
      markdownBuffer.push(line);
      keptLines.push(line);
      continue;
    }

    const actionBlock = previews ? createActionBlockFromLine(line) : null;
    if (actionBlock) {
      if (actionBlock.type === "connector-action") {
        const retainedMarkdown = retainedConnectorActionMarkdown(
          line,
          actionBlock.descriptor,
        );
        if (retainedMarkdown) {
          pushMarkdownLines([retainedMarkdown]);
        }
      }
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

    const renderedLine = renderExtractedPreviewLine(extracted, line);
    if (renderedLine.renderKind === "markdown") {
      markdownBuffer.push(renderedLine.line);
      keptLines.push(renderedLine.line);
      continue;
    }

    flushMarkdownBuffer();
    blocks.push({
      type: "artifact",
      resourceKey: renderedLine.preview.url,
      descriptor: renderedLine.preview,
    });
  }

  if (openFence) {
    applyFenceLineResult(renderOpenMarkdownFence(openFence, previews));
  }
  flushMarkdownBuffer();

  const cleanContent = keptLines.join("\n").trim();

  return {
    cleanContent,
    blocks,
  };
}
