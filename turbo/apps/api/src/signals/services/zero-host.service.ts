import { createHash } from "node:crypto";

import { command } from "ccstate";
import { z } from "zod";
import {
  type GeneratePresentationSpeakerNotesRequest,
  type CreateHtmlEditDraftRequest,
  type HostedArtifactKind,
  type HtmlEditDraftResponse,
  type HostedSiteFilesResponse,
  type HostedSitePrepareRequest,
  type HostedSiteRedeployHtmlRequest,
  type HostedSiteRedeployPresentationHtmlRequest,
  type PresentationSpeakerNotesPatch,
  htmlEditDraftResponseSchema,
  presentationSpeakerNotesPatchSchema,
} from "@vm0/api-contracts/contracts/zero-host";
import {
  hostedDeployments,
  hostedSites,
  type HostedSiteManifest,
  type HostedSiteManifestFile,
} from "@vm0/db/schema/hosted-site";
import { and, eq, isNull } from "drizzle-orm";

import { env } from "../../lib/env";
import { type Db, writeDb$ } from "../external/db";
import { generateText } from "../external/openrouter";
import {
  copyHostedSitesS3Object,
  generateHostedSitesPresignedGetUrl,
  generateHostedSitesPresignedPutUrl,
  hostedSitesS3ObjectExists,
  putHostedSitesS3Object,
} from "../external/s3";
import { nowDate } from "../external/time";
import { safeJsonParse } from "../utils";
import { recordHostedSiteArtifact$ } from "./run-uploaded-files.service";

const PUT_URL_TTL_SECONDS = 3600;
const GET_URL_TTL_SECONDS = 3600;
const MAX_HOSTED_SITE_TOTAL_BYTES = 512 * 1024 * 1024;
const MAX_HOSTED_SITE_FILE_BYTES = 100 * 1024 * 1024;
const MAX_PUBLIC_SLUG_ATTEMPTS = 5;
const PRESENTATION_SPEAKER_NOTES_MODEL = "openai/gpt-4.1-mini";
const HTML_DOM_EDIT_MODEL = "openai/gpt-4.1-mini";
const HTML_DOM_NODE_ID_ATTR = "data-vm0-node-id";
const MAX_HTML_EDIT_SNAPSHOT_BYTES = 5 * 1024 * 1024;

const htmlDomEditPatchSchema = z.discriminatedUnion("operation", [
  z.object({
    commentId: z.string().min(1),
    targetNodeId: z.string().min(1),
    operation: z.literal("update"),
    outerHTML: z.string().min(1),
  }),
  z.object({
    commentId: z.string().min(1),
    targetNodeId: z.string().min(1),
    operation: z.literal("insert"),
    position: z.enum(["before", "after", "append_child", "prepend_child"]),
    html: z.string().min(1),
  }),
  z.object({
    commentId: z.string().min(1),
    targetNodeId: z.string().min(1),
    operation: z.literal("remove"),
  }),
]);

const htmlDomEditPatchResultSchema = z.object({
  kind: z.literal("html-dom-edit-patch"),
  version: z.literal(1),
  patches: z.array(htmlDomEditPatchSchema).min(1).max(100),
});

type HtmlDomEditPatch = z.infer<typeof htmlDomEditPatchSchema>;
type HtmlDomEditPatchResult = z.infer<typeof htmlDomEditPatchResultSchema>;

interface HtmlElementSpan {
  readonly start: number;
  readonly startTagEnd: number;
  readonly closeTagStart: number | null;
  readonly end: number;
  readonly tagName: string;
}

interface PrepareDeploymentArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly runId?: string;
  readonly body: HostedSitePrepareRequest;
}

interface CompleteDeploymentArgs {
  readonly orgId: string;
  readonly deploymentId: string;
}

interface RedeployPresentationHtmlArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly body: HostedSiteRedeployPresentationHtmlRequest;
}

interface RedeployHtmlArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly body: HostedSiteRedeployHtmlRequest;
}

interface RedeployHostedSiteIndexHtmlArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly body: HostedSiteRedeployHtmlRequest;
  readonly artifactKind: HostedArtifactKind;
}

interface GeneratePresentationSpeakerNotesArgs {
  readonly body: GeneratePresentationSpeakerNotesRequest;
}

interface CreateHtmlEditDraftArgs {
  readonly body: CreateHtmlEditDraftRequest;
}

interface HtmlEditDraftDocument {
  readonly comments: CreateHtmlEditDraftRequest["comments"];
  readonly html: string;
}

interface GetHostedSiteFilesArgs {
  readonly orgId: string;
  readonly publicSlug: string;
}

type PrepareDeploymentResult =
  | {
      readonly status: "ok";
      readonly body: {
        readonly siteId: string;
        readonly deploymentId: string;
        readonly publicSlug: string;
        readonly url: string;
        readonly uploads: readonly {
          readonly path: string;
          readonly uploadUrl: string;
        }[];
      };
    }
  | { readonly status: "bad_request"; readonly message: string }
  | { readonly status: "conflict"; readonly message: string }
  | { readonly status: "config_error"; readonly message: string };

type CompleteDeploymentResult =
  | {
      readonly status: "ok";
      readonly body: {
        readonly siteId: string;
        readonly deploymentId: string;
        readonly publicSlug: string;
        readonly url: string;
        readonly status: "ready";
      };
    }
  | { readonly status: "not_found"; readonly message: string }
  | { readonly status: "conflict"; readonly message: string }
  | { readonly status: "bad_request"; readonly message: string }
  | { readonly status: "config_error"; readonly message: string };

type RedeployPresentationHtmlResult = CompleteDeploymentResult;
type RedeployHtmlResult = CompleteDeploymentResult;

type GeneratePresentationSpeakerNotesResult =
  | { readonly status: "ok"; readonly body: PresentationSpeakerNotesPatch }
  | { readonly status: "bad_request"; readonly message: string }
  | { readonly status: "config_error"; readonly message: string };

type CreateHtmlEditDraftResult =
  | { readonly status: "ok"; readonly body: HtmlEditDraftResponse }
  | { readonly status: "bad_request"; readonly message: string }
  | { readonly status: "config_error"; readonly message: string };

type GetHostedSiteFilesResult =
  | {
      readonly status: "ok";
      readonly body: HostedSiteFilesResponse;
    }
  | { readonly status: "not_found"; readonly message: string }
  | { readonly status: "conflict"; readonly message: string }
  | { readonly status: "config_error"; readonly message: string };

type RedeployHostedSiteTargetResult =
  | {
      readonly status: "ok";
      readonly activeDeployment: HostedDeploymentRow;
      readonly site: HostedSiteRow;
    }
  | { readonly status: "not_found"; readonly message: string }
  | { readonly status: "bad_request"; readonly message: string };

interface ActiveSitePointer {
  readonly version: 1;
  readonly publicSlug: string;
  readonly siteId: string;
  readonly deploymentId: string;
  readonly prefix: string;
  readonly manifestKey: string;
  readonly spaFallback: boolean;
  readonly updatedAt: string;
}

type HostedSiteRow = typeof hostedSites.$inferSelect;
type HostedDeploymentRow = typeof hostedDeployments.$inferSelect;
type HostedSiteFile = HostedSitePrepareRequest["files"][number];

type SiteDeploymentCreationResult =
  | {
      readonly kind: "ok";
      readonly site: HostedSiteRow;
      readonly deployment: HostedDeploymentRow;
    }
  | { readonly kind: "slug_conflict" };
type CreatedSiteDeployment = Extract<
  SiteDeploymentCreationResult,
  { readonly kind: "ok" }
>;

interface CreateHostedSiteDeploymentContext {
  readonly now: Date;
  readonly publicSlug: string;
  readonly url: string;
  readonly allowExistingPublicSlug: boolean;
}

interface HostedR2Config {
  readonly bucket: string;
}

type HostedR2ConfigResult =
  | { readonly status: "ok"; readonly config: HostedR2Config }
  | { readonly status: "config_error"; readonly message: string };

function hostedR2Config(): HostedR2ConfigResult {
  const bucket = env("R2_HOSTED_SITES_BUCKET_NAME");
  if (!bucket) {
    return {
      status: "config_error",
      message: "R2_HOSTED_SITES_BUCKET_NAME is not configured",
    };
  }
  if (!env("R2_HOSTED_SITES_ACCESS_KEY_ID")) {
    return {
      status: "config_error",
      message: "R2_HOSTED_SITES_ACCESS_KEY_ID is not configured",
    };
  }
  if (!env("R2_HOSTED_SITES_SECRET_ACCESS_KEY")) {
    return {
      status: "config_error",
      message: "R2_HOSTED_SITES_SECRET_ACCESS_KEY is not configured",
    };
  }
  return { status: "ok", config: { bucket } };
}

function presentationSpeakerNotesPrompt(html: string): readonly {
  readonly role: "system" | "user";
  readonly content: string;
}[] {
  return [
    {
      role: "system",
      content:
        "You add speaker notes to the user's own HTML presentation. Treat the HTML as read-only context. Return valid JSON matching the requested schema. Write speaker notes as spoken presenter scripts in the same primary language as each slide.",
    },
    {
      role: "user",
      content: `Generate speaker notes only for empty notes in this existing HTML presentation.

Output:
- Return only JSON.
- Output shape: {"kind":"presentation-speaker-notes-patch","version":1,"slides":[{"slideId":"...","speakerNotes":"..."}]}.
- Use slide IDs from data-slide-id when present.
- If a slide has no data-slide-id, use its 1-based DOM order fallback: slide-1, slide-2, etc.
- Include every slide whose speaker notes are empty or missing.
- Leave slides with existing non-empty speaker notes out of the response.

Writing brief:
- Write each speakerNotes value as a presenter script the user can read aloud.
- Start directly with what the speaker would say.
- For cover or title slides, write a natural opening that introduces the topic, scope, and why it matters.
- For content slides, turn the visible details into a coherent spoken explanation.
- Match each slide's primary language and tone. Use plain text.

HTML:
${html}`,
    },
  ];
}

function htmlDomEditPrompt(body: HtmlEditDraftDocument): readonly {
  readonly role: "system" | "user";
  readonly content: string;
}[] {
  const comments = body.comments
    .map((comment, index) => {
      return [
        `${index + 1}. Comment ID: ${comment.id}`,
        `   Target node IDs: ${comment.targetNodeIds.join(", ")}`,
        `   Requested change: ${comment.comment}`,
      ].join("\n");
    })
    .join("\n\n");

  return [
    {
      role: "system",
      content:
        "You edit the user's own HTML document by returning compact DOM patches. Return valid JSON matching the requested schema. Do not deploy, publish, host, upload, or describe commands. Preserve existing scripts, styles, assets, layout, and language unless a comment asks for a change.",
    },
    {
      role: "user",
      content: `Create DOM patches for these comments on the existing HTML document.

Output:
- Return only JSON.
- Output shape: {"kind":"html-dom-edit-patch","version":1,"patches":[...]}.
- Each patch must include commentId, targetNodeId, operation, and the operation-specific field.
- Supported operations:
  - {"operation":"update","outerHTML":"<tag>...</tag>"} replaces the target DOM node with the updated DOM node.
  - {"operation":"insert","position":"before","html":"..."} inserts HTML before the target element.
  - {"operation":"insert","position":"after","html":"..."} inserts HTML after the target element.
  - {"operation":"insert","position":"append_child","html":"..."} appends HTML inside the target element.
  - {"operation":"insert","position":"prepend_child","html":"..."} prepends HTML inside the target element.
  - {"operation":"remove"} removes the target element.
- Use update for any change to an existing DOM node, including text, color, background, icon, attributes, classes, or nested markup.
- For update, keep the same tag when possible and include all attributes and children that should remain.
- Prefer the smallest target node that satisfies the comment.
- Do not return the complete HTML document.
- Do not include vm0-only editing attributes such as data-vm0-node-id or data-vm0-html-edit-* in returned HTML fragments.
- Do not add comment markers, overlays, annotations, explanations, or deployment commands.
- Do not add script tags in new HTML fragments.

Editing rules:
- Use the target node IDs to locate the intended elements in the HTML.
- Apply every requested change exactly once.
- Keep unrelated content and formatting as stable as practical.
- Preserve relative and absolute asset URLs.
- Preserve the page's primary language and tone.

Comments:
${comments}

HTML:
${body.html}`,
    },
  ];
}

function isHtmlEditSnapshotUrl(url: string): boolean {
  const baseUrl = new URL(env("PUBLIC_ARTIFACTS_BASE_URL"));
  if (!URL.canParse(url)) {
    return false;
  }
  const parsed = new URL(url);
  return (
    parsed.origin === baseUrl.origin &&
    parsed.pathname.startsWith("/artifacts/")
  );
}

async function loadHtmlEditDraftDocument(
  body: CreateHtmlEditDraftRequest,
  signal: AbortSignal,
): Promise<HtmlEditDraftDocument | { readonly message: string }> {
  if (body.html !== undefined) {
    return {
      comments: body.comments,
      html: body.html,
    };
  }

  if (!isHtmlEditSnapshotUrl(body.htmlSnapshotUrl)) {
    return { message: "HTML edit snapshot URL is not supported" };
  }

  const response = await fetch(body.htmlSnapshotUrl, { signal });
  signal.throwIfAborted();
  if (!response.ok) {
    return {
      message: `HTML edit snapshot could not be loaded (${response.status})`,
    };
  }

  const contentLength = Number(response.headers.get("content-length") ?? 0);
  if (contentLength > MAX_HTML_EDIT_SNAPSHOT_BYTES) {
    return { message: "HTML edit snapshot is too large" };
  }

  const html = await response.text();
  signal.throwIfAborted();
  if (
    new TextEncoder().encode(html).byteLength > MAX_HTML_EDIT_SNAPSHOT_BYTES
  ) {
    return { message: "HTML edit snapshot is too large" };
  }

  return {
    comments: body.comments,
    html,
  };
}

function jsonObjectText(value: string): string {
  const trimmed = value.trim();
  if (safeJsonParse(trimmed) !== null) {
    return trimmed;
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    return trimmed;
  }
  return trimmed.slice(start, end + 1);
}

function parsePresentationSpeakerNotesPatch(
  text: string,
): PresentationSpeakerNotesPatch | null {
  const parsed = safeJsonParse(jsonObjectText(text));
  const result = presentationSpeakerNotesPatchSchema.safeParse(parsed);
  return result.success ? result.data : null;
}

function parseHtmlDomEditPatchResult(
  text: string,
): HtmlDomEditPatchResult | null {
  const parsed = safeJsonParse(jsonObjectText(text));
  const result = htmlDomEditPatchResultSchema.safeParse(parsed);
  return result.success ? result.data : null;
}

function findTagEnd(html: string, start: number): number {
  let quote: '"' | "'" | null = null;
  for (let index = start; index < html.length; index += 1) {
    const char = html[index];
    if (quote) {
      if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === ">") {
      return index;
    }
  }
  return -1;
}

function isWhitespaceChar(char: string | undefined): boolean {
  return (
    char === " " ||
    char === "\n" ||
    char === "\r" ||
    char === "\t" ||
    char === "\f"
  );
}

function isTagNameStartChar(char: string | undefined): boolean {
  return (
    char !== undefined &&
    ((char >= "A" && char <= "Z") || (char >= "a" && char <= "z"))
  );
}

function isTagNameChar(char: string | undefined): boolean {
  return (
    isTagNameStartChar(char) ||
    (char !== undefined && char >= "0" && char <= "9") ||
    char === ":" ||
    char === "-" ||
    char === "_"
  );
}

function isAttributeNameChar(char: string | undefined): boolean {
  return (
    char !== undefined &&
    !isWhitespaceChar(char) &&
    char !== "=" &&
    char !== "/" &&
    char !== ">"
  );
}

function isSelfClosingStartTag(tagSource: string): boolean {
  return /\/\s*>$/.test(tagSource);
}

function isVoidElement(tagName: string): boolean {
  return [
    "area",
    "base",
    "br",
    "col",
    "embed",
    "hr",
    "img",
    "input",
    "link",
    "meta",
    "param",
    "source",
    "track",
    "wbr",
  ].includes(tagName.toLowerCase());
}

interface ParsedHtmlTag {
  readonly isClosing: boolean;
  readonly nameEnd: number;
  readonly tagName: string;
}

interface HtmlTagMatch {
  readonly end: number;
  readonly isClosing: boolean;
  readonly source: string;
  readonly start: number;
  readonly tagName: string;
}

function parseHtmlTagSource(tagSource: string): ParsedHtmlTag | null {
  let index = 1;
  while (isWhitespaceChar(tagSource[index])) {
    index += 1;
  }

  const isClosing = tagSource[index] === "/";
  if (isClosing) {
    index += 1;
    while (isWhitespaceChar(tagSource[index])) {
      index += 1;
    }
  }

  if (!isTagNameStartChar(tagSource[index])) {
    return null;
  }

  const nameStart = index;
  index += 1;
  while (isTagNameChar(tagSource[index])) {
    index += 1;
  }

  return {
    isClosing,
    nameEnd: index,
    tagName: tagSource.slice(nameStart, index),
  };
}

function startTagAttributeValue(
  tagSource: string,
  attributeName: string,
): string | null {
  const parsed = parseHtmlTagSource(tagSource);
  if (!parsed || parsed.isClosing) {
    return null;
  }

  let index = parsed.nameEnd;
  while (index < tagSource.length) {
    while (isWhitespaceChar(tagSource[index])) {
      index += 1;
    }
    if (tagSource[index] === "/" || tagSource[index] === ">") {
      return null;
    }

    const nameStart = index;
    while (isAttributeNameChar(tagSource[index])) {
      index += 1;
    }
    const name = tagSource.slice(nameStart, index);
    while (isWhitespaceChar(tagSource[index])) {
      index += 1;
    }

    let value = "";
    if (tagSource[index] === "=") {
      index += 1;
      while (isWhitespaceChar(tagSource[index])) {
        index += 1;
      }
      const quote = tagSource[index];
      if (quote === '"' || quote === "'") {
        index += 1;
        const valueStart = index;
        while (index < tagSource.length && tagSource[index] !== quote) {
          index += 1;
        }
        value = tagSource.slice(valueStart, index);
        if (tagSource[index] === quote) {
          index += 1;
        }
      } else {
        const valueStart = index;
        while (
          index < tagSource.length &&
          !isWhitespaceChar(tagSource[index]) &&
          tagSource[index] !== ">"
        ) {
          index += 1;
        }
        value = tagSource.slice(valueStart, index);
      }
    }

    if (name === attributeName) {
      return value;
    }
  }

  return null;
}

function findStartTagWithAttributeValue(
  html: string,
  attributeName: string,
  attributeValue: string,
): HtmlTagMatch | null {
  let searchStart = 0;
  while (searchStart < html.length) {
    const start = html.indexOf("<", searchStart);
    if (start === -1) {
      return null;
    }
    const end = findTagEnd(html, start);
    if (end === -1) {
      return null;
    }
    const source = html.slice(start, end + 1);
    const parsed = parseHtmlTagSource(source);
    if (
      parsed &&
      !parsed.isClosing &&
      startTagAttributeValue(source, attributeName) === attributeValue
    ) {
      return {
        end,
        isClosing: false,
        source,
        start,
        tagName: parsed.tagName,
      };
    }
    searchStart = end + 1;
  }
  return null;
}

function findNextTagByName(
  html: string,
  tagName: string,
  from: number,
): HtmlTagMatch | null {
  const normalizedTagName = tagName.toLowerCase();
  let searchStart = from;
  while (searchStart < html.length) {
    const start = html.indexOf("<", searchStart);
    if (start === -1) {
      return null;
    }
    const end = findTagEnd(html, start);
    if (end === -1) {
      return null;
    }
    const source = html.slice(start, end + 1);
    const parsed = parseHtmlTagSource(source);
    if (parsed && parsed.tagName.toLowerCase() === normalizedTagName) {
      return {
        end,
        isClosing: parsed.isClosing,
        source,
        start,
        tagName: parsed.tagName,
      };
    }
    searchStart = end + 1;
  }
  return null;
}

function findHtmlElementSpan(
  html: string,
  targetNodeId: string,
): HtmlElementSpan | null {
  const startTag = findStartTagWithAttributeValue(
    html,
    HTML_DOM_NODE_ID_ATTR,
    targetNodeId,
  );
  if (!startTag) {
    return null;
  }
  if (
    isVoidElement(startTag.tagName) ||
    isSelfClosingStartTag(startTag.source)
  ) {
    return {
      start: startTag.start,
      startTagEnd: startTag.end,
      closeTagStart: null,
      end: startTag.end + 1,
      tagName: startTag.tagName,
    };
  }

  let searchStart = startTag.end + 1;
  let depth = 1;
  let match: HtmlTagMatch | null;
  while ((match = findNextTagByName(html, startTag.tagName, searchStart))) {
    if (match.isClosing) {
      depth -= 1;
      if (depth === 0) {
        return {
          start: startTag.start,
          startTagEnd: startTag.end,
          closeTagStart: match.start,
          end: match.end + 1,
          tagName: startTag.tagName,
        };
      }
      searchStart = match.end + 1;
      continue;
    }
    if (!isSelfClosingStartTag(match.source) && !isVoidElement(match.tagName)) {
      depth += 1;
    }
    searchStart = match.end + 1;
  }
  return null;
}

function assertSafeHtmlFragment(html: string): string | null {
  if (/<\s*script\b/i.test(html)) {
    return "HTML DOM edit patches cannot add script tags";
  }
  return null;
}

function applyHtmlDomEditPatch(
  html: string,
  patch: HtmlDomEditPatch,
): { readonly html: string } | { readonly message: string } {
  const span = findHtmlElementSpan(html, patch.targetNodeId);
  if (!span) {
    return {
      message: `HTML edit target was not found: ${patch.targetNodeId}`,
    };
  }

  if (patch.operation === "update") {
    const unsafe = assertSafeHtmlFragment(patch.outerHTML);
    if (unsafe) {
      return { message: unsafe };
    }
    return {
      html: `${html.slice(0, span.start)}${patch.outerHTML}${html.slice(
        span.end,
      )}`,
    };
  }
  if (patch.operation === "remove") {
    return {
      html: `${html.slice(0, span.start)}${html.slice(span.end)}`,
    };
  }

  const unsafe = assertSafeHtmlFragment(patch.html);
  if (unsafe) {
    return { message: unsafe };
  }
  if (patch.position === "before") {
    return {
      html: `${html.slice(0, span.start)}${patch.html}${html.slice(
        span.start,
      )}`,
    };
  }
  if (patch.position === "after") {
    return {
      html: `${html.slice(0, span.end)}${patch.html}${html.slice(span.end)}`,
    };
  }
  if (span.closeTagStart === null) {
    return {
      message: `HTML edit target cannot contain children: ${patch.targetNodeId}`,
    };
  }
  if (patch.position === "append_child") {
    return {
      html: `${html.slice(0, span.closeTagStart)}${patch.html}${html.slice(
        span.closeTagStart,
      )}`,
    };
  }
  return {
    html: `${html.slice(0, span.startTagEnd + 1)}${patch.html}${html.slice(
      span.startTagEnd + 1,
    )}`,
  };
}

function stripHtmlDomEditAttributes(html: string): string {
  return html.replace(
    /\s+data-vm0-(?:node-id|html-edit-[\w-]+)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?/g,
    "",
  );
}

function applyHtmlDomEditPatches(params: {
  readonly html: string;
  readonly patchResult: HtmlDomEditPatchResult;
}): { readonly html: string } | { readonly message: string } {
  let html = params.html;
  for (const patch of params.patchResult.patches) {
    const result = applyHtmlDomEditPatch(html, patch);
    if ("message" in result) {
      return result;
    }
    html = result.html;
  }
  return { html: stripHtmlDomEditAttributes(html) };
}

function publicUrl(publicSlug: string): string {
  return `${env("ZERO_HOST_SCHEME")}://${publicSlug}.${env("ZERO_HOST_DOMAIN")}`;
}

function publicSlugFromHostedSiteUrl(value: string): string | null {
  if (!URL.canParse(value)) {
    return null;
  }
  const url = new URL(value);
  const hostDomain = env("ZERO_HOST_DOMAIN");
  if (url.hostname === hostDomain || !url.hostname.endsWith(`.${hostDomain}`)) {
    return null;
  }
  const publicSlug = url.hostname.slice(0, -(hostDomain.length + ".".length));
  return publicSlug || null;
}

function activePointerKey(publicSlug: string): string {
  return `sites/${publicSlug}/active.json`;
}

function deploymentPrefix(publicSlug: string, deploymentId: string): string {
  return `sites/${publicSlug}/deployments/${deploymentId}`;
}

function orgSlugHash(orgId: string): string {
  return createHash("sha256").update(orgId).digest("hex").substring(0, 8);
}

function randomSlugSuffix(): string {
  return crypto.randomUUID().replaceAll("-", "").substring(0, 8);
}

function publicSlugForSite(
  site: string,
  orgId: string,
  slugSuffix: string,
): string {
  return `${site}-${orgSlugHash(orgId)}-${slugSuffix}`;
}

function fileKey(prefix: string, path: string): string {
  return `${prefix}${path}`;
}

function isSafeSitePath(path: string): boolean {
  if (!path.startsWith("/") || path.startsWith("//")) {
    return false;
  }
  if (path.includes("\\") || path.includes("\0")) {
    return false;
  }
  const segments = path.split("/").filter((segment) => {
    return segment.length > 0;
  });
  return !segments.some((segment) => {
    return segment === "." || segment === "..";
  });
}

function hashJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function contentHash(files: readonly HostedSiteManifestFile[]): string {
  const hash = createHash("sha256");
  for (const file of [...files].sort((a, b) => {
    return a.path.localeCompare(b.path);
  })) {
    hash.update(file.path);
    hash.update("\0");
    hash.update(file.sha256);
    hash.update("\0");
    hash.update(String(file.size));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function hostedSiteFileForContent(
  path: string,
  content: string,
  contentType: string,
): HostedSitePrepareRequest["files"][number] {
  const bytes = Buffer.from(content, "utf8");
  return {
    path,
    size: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    contentType,
  };
}

async function findHostedSiteRedeployTarget(
  writeDb: Db,
  args: {
    readonly artifactKind: HostedArtifactKind;
    readonly orgId: string;
    readonly publicSlug: string;
  },
  signal: AbortSignal,
): Promise<RedeployHostedSiteTargetResult> {
  const [site] = await writeDb
    .select()
    .from(hostedSites)
    .where(
      and(
        eq(hostedSites.publicSlug, args.publicSlug),
        eq(hostedSites.orgId, args.orgId),
        isNull(hostedSites.deletedAt),
      ),
    )
    .limit(1);
  signal.throwIfAborted();

  if (!site) {
    return { status: "not_found", message: "Hosted site not found" };
  }
  if (!site.activeDeploymentId) {
    return {
      status: "bad_request",
      message: "Hosted site has no active deployment",
    };
  }

  const [activeDeployment] = await writeDb
    .select()
    .from(hostedDeployments)
    .where(
      and(
        eq(hostedDeployments.id, site.activeDeploymentId),
        eq(hostedDeployments.orgId, args.orgId),
      ),
    )
    .limit(1);
  signal.throwIfAborted();

  if (!activeDeployment) {
    return {
      status: "not_found",
      message: "Active hosted deployment not found",
    };
  }
  if (activeDeployment.manifest.artifactKind !== args.artifactKind) {
    const label =
      args.artifactKind === "presentation-html"
        ? "presentation HTML artifact"
        : "hosted-site HTML artifact";
    return {
      status: "bad_request",
      message: `Hosted site is not a ${label}`,
    };
  }
  return { status: "ok", activeDeployment, site };
}

function validateFiles(
  files: readonly HostedSitePrepareRequest["files"][number][],
): string | null {
  const seen = new Set<string>();
  let totalSize = 0;
  for (const file of files) {
    if (!isSafeSitePath(file.path)) {
      return `Invalid hosted-site path: ${file.path}`;
    }
    if (seen.has(file.path)) {
      return `Duplicate hosted-site path: ${file.path}`;
    }
    seen.add(file.path);
    if (file.size > MAX_HOSTED_SITE_FILE_BYTES) {
      return `Hosted-site file too large: ${file.path}`;
    }
    totalSize += file.size;
    if (totalSize > MAX_HOSTED_SITE_TOTAL_BYTES) {
      return "Hosted-site deployment is too large";
    }
  }
  if (!seen.has("/index.html")) {
    return "Hosted-site deployment must include /index.html";
  }
  return null;
}

function buildManifest(args: {
  readonly deploymentId: string;
  readonly siteId: string;
  readonly publicSlug: string;
  readonly artifactKind: HostedArtifactKind;
  readonly spaFallback: boolean;
  readonly files: readonly HostedSiteFile[];
  readonly createdAt: Date;
}): HostedSiteManifest {
  const manifestFiles: Record<string, HostedSiteManifestFile> = {};
  for (const file of args.files) {
    manifestFiles[file.path] = {
      path: file.path,
      size: file.size,
      sha256: file.sha256,
      contentType: file.contentType,
      immutable: file.immutable,
    };
  }
  return {
    version: 1,
    deploymentId: args.deploymentId,
    siteId: args.siteId,
    publicSlug: args.publicSlug,
    createdAt: args.createdAt.toISOString(),
    artifactKind: args.artifactKind,
    spaFallback: args.spaFallback,
    files: manifestFiles,
  };
}

function hostedSiteArtifactArgs(deployment: HostedDeploymentRow) {
  const artifactKind = deployment.manifest.artifactKind ?? "hosted-site";
  return {
    runId: deployment.runId,
    userId: deployment.userId,
    orgId: deployment.orgId,
    artifactKind,
    siteId: deployment.siteId,
    deploymentId: deployment.id,
    publicSlug: deployment.manifest.publicSlug,
    url: deployment.url,
    fileCount: deployment.fileCount,
    sizeBytes: deployment.sizeBytes,
    entrypoint: deployment.entrypoint,
    spaFallback: deployment.spaFallback,
  };
}

function createHostedSiteDeployment(
  writeDb: Db,
  args: PrepareDeploymentArgs,
  context: CreateHostedSiteDeploymentContext,
): Promise<SiteDeploymentCreationResult> {
  return writeDb.transaction(async (tx) => {
    const [existingPublicSite] = await tx
      .select()
      .from(hostedSites)
      .where(
        and(
          eq(hostedSites.publicSlug, context.publicSlug),
          isNull(hostedSites.deletedAt),
        ),
      )
      .limit(1);

    if (
      existingPublicSite &&
      (!context.allowExistingPublicSlug ||
        existingPublicSite.orgId !== args.orgId ||
        existingPublicSite.slug !== args.body.site)
    ) {
      return { kind: "slug_conflict" };
    }

    const [site] = await tx
      .insert(hostedSites)
      .values({
        orgId: args.orgId,
        userId: args.userId,
        slug: args.body.site,
        publicSlug: context.publicSlug,
        createdFromRunId: args.runId,
        updatedAt: context.now,
      })
      .onConflictDoUpdate({
        target: [hostedSites.orgId, hostedSites.slug],
        set: { publicSlug: context.publicSlug, updatedAt: context.now },
      })
      .returning();
    if (!site) {
      throw new Error("Failed to create hosted site");
    }

    const deploymentId = crypto.randomUUID();
    const prefix = deploymentPrefix(context.publicSlug, deploymentId);
    const manifest = buildManifest({
      deploymentId,
      siteId: site.id,
      publicSlug: context.publicSlug,
      artifactKind: args.body.artifactKind,
      spaFallback: args.body.spaFallback,
      files: args.body.files,
      createdAt: context.now,
    });
    const files = Object.values(manifest.files);
    const [deployment] = await tx
      .insert(hostedDeployments)
      .values({
        id: deploymentId,
        siteId: site.id,
        orgId: args.orgId,
        userId: args.userId,
        runId: args.runId,
        status: "uploading",
        r2Prefix: prefix,
        manifest,
        manifestHash: hashJson(manifest),
        contentHash: contentHash(files),
        entrypoint: "/index.html",
        spaFallback: args.body.spaFallback,
        fileCount: files.length,
        sizeBytes: files.reduce((sum, file) => {
          return sum + file.size;
        }, 0),
        url: context.url,
        updatedAt: context.now,
      })
      .returning();
    if (!deployment) {
      throw new Error("Failed to create hosted deployment");
    }

    return { kind: "ok", site, deployment };
  });
}

export const prepareHostedSiteDeployment$ = command(
  async (
    { get, set },
    args: PrepareDeploymentArgs,
    signal: AbortSignal,
  ): Promise<PrepareDeploymentResult> => {
    const hostedR2 = hostedR2Config();
    if (hostedR2.status === "config_error") {
      return hostedR2;
    }

    const fileError = validateFiles(args.body.files);
    if (fileError) {
      return { status: "bad_request", message: fileError };
    }

    const writeDb = set(writeDb$);
    const now = nowDate();
    let siteAndDeployment: CreatedSiteDeployment | null = null;
    let publicSlug = "";
    let url = "";

    if (args.body.slugSuffix) {
      publicSlug = publicSlugForSite(
        args.body.site,
        args.orgId,
        args.body.slugSuffix,
      );
      url = publicUrl(publicSlug);
      const result = await createHostedSiteDeployment(writeDb, args, {
        now,
        publicSlug,
        url,
        allowExistingPublicSlug: true,
      });
      signal.throwIfAborted();
      if (result.kind === "slug_conflict") {
        return {
          status: "conflict",
          message: `Hosted site slug is already in use: ${publicSlug}`,
        };
      }
      siteAndDeployment = result;
    } else {
      for (let attempt = 0; attempt < MAX_PUBLIC_SLUG_ATTEMPTS; attempt += 1) {
        publicSlug = publicSlugForSite(
          args.body.site,
          args.orgId,
          randomSlugSuffix(),
        );
        url = publicUrl(publicSlug);
        const result = await createHostedSiteDeployment(writeDb, args, {
          now,
          publicSlug,
          url,
          allowExistingPublicSlug: false,
        });
        signal.throwIfAborted();
        if (result.kind === "ok") {
          siteAndDeployment = result;
          break;
        }
      }
    }

    if (!siteAndDeployment) {
      return {
        status: "conflict",
        message: "Unable to allocate a unique hosted site slug",
      };
    }

    const uploads = await Promise.all(
      Object.values(siteAndDeployment.deployment.manifest.files).map(
        async (file) => {
          const uploadUrl = await get(
            generateHostedSitesPresignedPutUrl(
              hostedR2.config.bucket,
              fileKey(siteAndDeployment.deployment.r2Prefix, file.path),
              file.contentType,
              PUT_URL_TTL_SECONDS,
              true,
            ),
          );
          return { path: file.path, uploadUrl };
        },
      ),
    );
    signal.throwIfAborted();

    return {
      status: "ok",
      body: {
        siteId: siteAndDeployment.site.id,
        deploymentId: siteAndDeployment.deployment.id,
        publicSlug,
        url,
        uploads,
      },
    };
  },
);

export const completeHostedSiteDeployment$ = command(
  async (
    { get, set },
    args: CompleteDeploymentArgs,
    signal: AbortSignal,
  ): Promise<CompleteDeploymentResult> => {
    const hostedR2 = hostedR2Config();
    if (hostedR2.status === "config_error") {
      return hostedR2;
    }

    const writeDb = set(writeDb$);
    const [deployment] = await writeDb
      .select()
      .from(hostedDeployments)
      .where(
        and(
          eq(hostedDeployments.id, args.deploymentId),
          eq(hostedDeployments.orgId, args.orgId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();

    if (!deployment) {
      return { status: "not_found", message: "Hosted deployment not found" };
    }
    if (deployment.status !== "uploading" && deployment.status !== "ready") {
      return {
        status: "conflict",
        message: `Hosted deployment is ${deployment.status}`,
      };
    }

    const missingPath = await (async () => {
      for (const file of Object.values(deployment.manifest.files)) {
        const exists = await get(
          hostedSitesS3ObjectExists(
            hostedR2.config.bucket,
            fileKey(deployment.r2Prefix, file.path),
          ),
        );
        signal.throwIfAborted();
        if (!exists) {
          return file.path;
        }
      }
      return null;
    })();
    signal.throwIfAborted();

    if (missingPath) {
      return {
        status: "bad_request",
        message: `Hosted deployment file was not uploaded: ${missingPath}`,
      };
    }

    const manifestKey = `${deployment.r2Prefix}/manifest.json`;
    await get(
      putHostedSitesS3Object(
        hostedR2.config.bucket,
        manifestKey,
        JSON.stringify(deployment.manifest, null, 2),
        "application/json",
      ),
    );
    signal.throwIfAborted();

    const readyAt = nowDate();
    await writeDb.transaction(async (tx) => {
      await tx
        .update(hostedDeployments)
        .set({
          status: "ready",
          readyAt,
          updatedAt: readyAt,
          error: null,
        })
        .where(eq(hostedDeployments.id, deployment.id));
      await tx
        .update(hostedSites)
        .set({
          activeDeploymentId: deployment.id,
          updatedAt: readyAt,
        })
        .where(eq(hostedSites.id, deployment.siteId));
    });
    signal.throwIfAborted();

    const pointer: ActiveSitePointer = {
      version: 1,
      publicSlug: deployment.manifest.publicSlug,
      siteId: deployment.siteId,
      deploymentId: deployment.id,
      prefix: deployment.r2Prefix,
      manifestKey,
      spaFallback: deployment.spaFallback,
      updatedAt: readyAt.toISOString(),
    };
    await get(
      putHostedSitesS3Object(
        hostedR2.config.bucket,
        activePointerKey(deployment.manifest.publicSlug),
        JSON.stringify(pointer, null, 2),
        "application/json",
      ),
    );
    signal.throwIfAborted();

    await set(
      recordHostedSiteArtifact$,
      hostedSiteArtifactArgs(deployment),
      signal,
    );
    signal.throwIfAborted();

    return {
      status: "ok",
      body: {
        siteId: deployment.siteId,
        deploymentId: deployment.id,
        publicSlug: deployment.manifest.publicSlug,
        url: deployment.url,
        status: "ready",
      },
    };
  },
);

export const getHostedSiteFiles$ = command(
  async (
    { get, set },
    args: GetHostedSiteFilesArgs,
    signal: AbortSignal,
  ): Promise<GetHostedSiteFilesResult> => {
    const writeDb = set(writeDb$);
    const [site] = await writeDb
      .select()
      .from(hostedSites)
      .where(
        and(
          eq(hostedSites.publicSlug, args.publicSlug),
          eq(hostedSites.orgId, args.orgId),
          isNull(hostedSites.deletedAt),
        ),
      )
      .limit(1);
    signal.throwIfAborted();

    if (!site) {
      return { status: "not_found", message: "Hosted site not found" };
    }
    if (!site.activeDeploymentId) {
      return {
        status: "conflict",
        message: "Hosted site has no active deployment",
      };
    }

    const [deployment] = await writeDb
      .select()
      .from(hostedDeployments)
      .where(
        and(
          eq(hostedDeployments.id, site.activeDeploymentId),
          eq(hostedDeployments.siteId, site.id),
          eq(hostedDeployments.orgId, args.orgId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();

    if (!deployment) {
      return {
        status: "not_found",
        message: "Active hosted deployment not found",
      };
    }
    if (deployment.status !== "ready") {
      return {
        status: "conflict",
        message: `Hosted deployment is ${deployment.status}`,
      };
    }

    const manifestFiles = Object.values(deployment.manifest.files).sort(
      (a, b) => {
        return a.path.localeCompare(b.path);
      },
    );
    signal.throwIfAborted();

    const hostedR2 = hostedR2Config();
    if (hostedR2.status === "config_error") {
      return hostedR2;
    }

    const files = await Promise.all(
      manifestFiles.map(async (file) => {
        const downloadUrl = await get(
          generateHostedSitesPresignedGetUrl(
            hostedR2.config.bucket,
            fileKey(deployment.r2Prefix, file.path),
            GET_URL_TTL_SECONDS,
            true,
          ),
        );
        return { ...file, downloadUrl };
      }),
    );
    signal.throwIfAborted();

    return {
      status: "ok",
      body: {
        siteId: site.id,
        deploymentId: deployment.id,
        publicSlug: site.publicSlug,
        url: deployment.url,
        fileCount: deployment.fileCount,
        size: deployment.sizeBytes,
        files,
      },
    };
  },
);

const redeployHostedSiteIndexHtml$ = command(
  async (
    { get, set },
    args: RedeployHostedSiteIndexHtmlArgs,
    signal: AbortSignal,
  ): Promise<CompleteDeploymentResult> => {
    const hostedR2 = hostedR2Config();
    if (hostedR2.status === "config_error") {
      return hostedR2;
    }

    const publicSlug = publicSlugFromHostedSiteUrl(args.body.url);
    if (!publicSlug) {
      return {
        status: "bad_request",
        message: "URL is not a hosted site URL",
      };
    }

    const writeDb = set(writeDb$);
    const target = await findHostedSiteRedeployTarget(
      writeDb,
      {
        artifactKind: args.artifactKind,
        orgId: args.orgId,
        publicSlug,
      },
      signal,
    );
    if (target.status !== "ok") {
      return target;
    }
    const { activeDeployment, site } = target;

    const indexFile = hostedSiteFileForContent(
      "/index.html",
      args.body.html,
      "text/html; charset=utf-8",
    );
    const files = [
      indexFile,
      ...Object.values(activeDeployment.manifest.files).filter((file) => {
        return file.path !== indexFile.path;
      }),
    ];
    const fileError = validateFiles(files);
    if (fileError) {
      return { status: "bad_request", message: fileError };
    }

    const now = nowDate();
    const result = await createHostedSiteDeployment(
      writeDb,
      {
        orgId: args.orgId,
        userId: args.userId,
        body: {
          site: site.slug,
          artifactKind: args.artifactKind,
          spaFallback: activeDeployment.spaFallback,
          files,
        },
      },
      {
        now,
        publicSlug,
        url: publicUrl(publicSlug),
        allowExistingPublicSlug: true,
      },
    );
    signal.throwIfAborted();

    if (result.kind === "slug_conflict") {
      return {
        status: "conflict",
        message: `Hosted site slug is already in use: ${publicSlug}`,
      };
    }

    await Promise.all(
      files
        .filter((file) => {
          return file.path !== indexFile.path;
        })
        .map((file) => {
          return get(
            copyHostedSitesS3Object(
              hostedR2.config.bucket,
              fileKey(activeDeployment.r2Prefix, file.path),
              fileKey(result.deployment.r2Prefix, file.path),
            ),
          );
        }),
    );
    signal.throwIfAborted();

    await get(
      putHostedSitesS3Object(
        hostedR2.config.bucket,
        fileKey(result.deployment.r2Prefix, indexFile.path),
        Buffer.from(args.body.html, "utf8"),
        indexFile.contentType,
      ),
    );
    signal.throwIfAborted();

    return set(
      completeHostedSiteDeployment$,
      {
        orgId: args.orgId,
        deploymentId: result.deployment.id,
      },
      signal,
    );
  },
);

export const redeployPresentationHtml$ = command(
  (
    { set },
    args: RedeployPresentationHtmlArgs,
    signal: AbortSignal,
  ): Promise<RedeployPresentationHtmlResult> => {
    return set(
      redeployHostedSiteIndexHtml$,
      {
        ...args,
        artifactKind: "presentation-html",
      },
      signal,
    );
  },
);

export const redeployHtml$ = command(
  (
    { set },
    args: RedeployHtmlArgs,
    signal: AbortSignal,
  ): Promise<RedeployHtmlResult> => {
    return set(
      redeployHostedSiteIndexHtml$,
      {
        ...args,
        artifactKind: "hosted-site",
      },
      signal,
    );
  },
);

export const generatePresentationSpeakerNotes$ = command(
  async (
    _,
    args: GeneratePresentationSpeakerNotesArgs,
    signal: AbortSignal,
  ): Promise<GeneratePresentationSpeakerNotesResult> => {
    const generated = await generateText(
      PRESENTATION_SPEAKER_NOTES_MODEL,
      presentationSpeakerNotesPrompt(args.body.html),
      4096,
    );
    signal.throwIfAborted();
    if (!generated) {
      return {
        status: "config_error",
        message: "Speaker notes generation is not configured",
      };
    }
    const patch = parsePresentationSpeakerNotesPatch(generated);
    if (!patch) {
      return {
        status: "bad_request",
        message: "Speaker notes generation returned invalid JSON",
      };
    }
    return { status: "ok", body: patch };
  },
);

export const createHtmlEditDraft$ = command(
  async (
    _,
    args: CreateHtmlEditDraftArgs,
    signal: AbortSignal,
  ): Promise<CreateHtmlEditDraftResult> => {
    const document = await loadHtmlEditDraftDocument(args.body, signal);
    if ("message" in document) {
      return {
        status: "bad_request",
        message: document.message,
      };
    }

    const generated = await generateText(
      HTML_DOM_EDIT_MODEL,
      htmlDomEditPrompt(document),
      8192,
    );
    signal.throwIfAborted();
    if (!generated) {
      return {
        status: "config_error",
        message: "HTML edit generation is not configured",
      };
    }
    const patchResult = parseHtmlDomEditPatchResult(generated);
    if (!patchResult) {
      return {
        status: "bad_request",
        message: "HTML edit generation returned invalid patch JSON",
      };
    }
    const applied = applyHtmlDomEditPatches({
      html: document.html,
      patchResult,
    });
    if ("message" in applied) {
      return {
        status: "bad_request",
        message: applied.message,
      };
    }
    const result = htmlEditDraftResponseSchema.parse({
      kind: "html-edit-draft",
      version: 1,
      html: applied.html,
    });
    return { status: "ok", body: result };
  },
);
