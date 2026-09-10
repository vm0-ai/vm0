import { createHash } from "node:crypto";

import type { SimpleStreamOptions } from "@earendil-works/pi-ai";

/**
 * Stable token marking a provider error body this boundary replaced.
 *
 * Guest-agent recognizes the same token when it projects a Pi terminal result
 * and classifies the failure, so the spelling is a cross-language contract.
 * Keep it in sync with `PI_UPSTREAM_NON_API_RESPONSE_MARKER` in
 * `crates/guest-agent/src/failure_patterns.rs`.
 */
export const UPSTREAM_NON_API_RESPONSE_MARKER = "upstream_non_api_response";

/** Only the leading bytes decide whether a failed body is a markup document. */
const MARKUP_PROBE_CHARS = 512;

/** Enough to group repeated pages in logs without republishing any of one. */
const DIGEST_CHARS = 8;

type ContentTypeFamily = "json" | "html" | "text" | "other" | "unknown";

function contentTypeFamily(header: string | null): ContentTypeFamily {
  const normalized = header?.trim().toLowerCase() ?? "";
  if (normalized.length === 0) {
    return "unknown";
  }
  if (normalized.includes("json")) {
    return "json";
  }
  if (normalized.includes("html")) {
    return "html";
  }
  return normalized.startsWith("text/") ? "text" : "other";
}

/**
 * Recognize a markup document from the body itself.
 *
 * A gateway, captive portal or branded status page can serve markup under any
 * declared content type, so the body decides and the header only annotates.
 */
export function isMarkupDocumentBody(body: string): boolean {
  const head = body.trimStart().slice(0, MARKUP_PROBE_CHARS).toLowerCase();
  if (!head.startsWith("<")) {
    return false;
  }
  return (
    head.includes("<!doctype html") ||
    head.includes("<html") ||
    head.includes("<body") ||
    head.includes("<svg")
  );
}

/** Describe a discarded upstream document without republishing any of it. */
export function describeUpstreamNonApiResponse(args: {
  readonly status: number;
  readonly contentType: string | null;
  readonly body: string;
}): string {
  const bytes = new TextEncoder().encode(args.body).length;
  const digest = createHash("sha256")
    .update(args.body, "utf8")
    .digest("hex")
    .slice(0, DIGEST_CHARS);
  return [
    UPSTREAM_NON_API_RESPONSE_MARKER,
    `status=${args.status}`,
    `content_type=${contentTypeFamily(args.contentType)}`,
    `bytes=${bytes}`,
    `digest=${digest}`,
  ].join(" ");
}

function replayableHeaders(headers: Headers): Headers {
  const replayable = new Headers(headers);
  // The body was decoded and is re-sent as plain bytes; the transfer-encoding
  // metadata of the original response no longer describes it.
  replayable.delete("content-length");
  replayable.delete("content-encoding");
  return replayable;
}

/**
 * Replace a markup error body with a bounded, API-shaped description.
 *
 * Provider adapters compose their terminal `errorMessage` from a failed
 * response body. When an upstream answers with an HTML page instead of an API
 * error, that whole document becomes the run's failure text, and truncation
 * downstream keeps only its stylesheet and logo markup. This boundary keeps
 * the transport status and content type, drops the document, and leaves
 * successful responses, streamed bodies and genuine API errors untouched.
 */
export function guardPiUpstreamErrorBody(
  fetchImpl: NonNullable<SimpleStreamOptions["fetch"]>,
): NonNullable<SimpleStreamOptions["fetch"]> {
  return async (input, init) => {
    const response = await fetchImpl(input, init);
    if (response.ok || response.body === null) {
      return response;
    }
    const body = await response.text();
    if (!isMarkupDocumentBody(body)) {
      // Genuine provider errors keep their exact text; only the framing that
      // the consumed body invalidated is rebuilt.
      return new Response(body, {
        headers: replayableHeaders(response.headers),
        status: response.status,
        statusText: response.statusText,
      });
    }
    const headers = replayableHeaders(response.headers);
    headers.set("content-type", "application/json");
    return new Response(
      JSON.stringify({
        error: {
          type: UPSTREAM_NON_API_RESPONSE_MARKER,
          message: describeUpstreamNonApiResponse({
            status: response.status,
            contentType: response.headers.get("content-type"),
            body,
          }),
        },
      }),
      {
        headers,
        status: response.status,
        statusText: response.statusText,
      },
    );
  };
}
