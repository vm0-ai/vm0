import { createHash } from "node:crypto";

import type { SimpleStreamOptions } from "@earendil-works/pi-ai";

/**
 * Stable token marking a provider error body this boundary replaced.
 *
 * Guest-agent recognizes the same token when it projects a Pi terminal result
 * and classifies the failure, so the spelling is a cross-language contract.
 * Keep it in sync with `UPSTREAM_NON_API_RESPONSE_MARKER` in
 * `crates/guest-agent/src/upstream_error_text.rs`.
 */
export const UPSTREAM_NON_API_RESPONSE_MARKER = "upstream_non_api_response";

/** Only the leading bytes decide whether a failed body is a markup document. */
const MARKUP_PROBE_CHARS = 512;

/** A UTF-8 code point needs at most four bytes in the bounded probe. */
const MARKUP_PROBE_BYTES = MARKUP_PROBE_CHARS * 4;

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
  return describeUpstreamNonApiResponseMetadata({
    status: args.status,
    contentType: args.contentType,
    bytes,
    digest,
  });
}

function describeUpstreamNonApiResponseMetadata(args: {
  readonly status: number;
  readonly contentType: string | null;
  readonly bytes: number;
  readonly digest: string;
}): string {
  return [
    UPSTREAM_NON_API_RESPONSE_MARKER,
    `status=${args.status}`,
    `content_type=${contentTypeFamily(args.contentType)}`,
    `bytes=${args.bytes}`,
    `digest=${args.digest}`,
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
 * Replay the bounded prefix already inspected at the provider boundary, then
 * continue from the original reader on demand.
 *
 * Reading a `tee()` inspection branch while leaving its sibling unconsumed
 * queues every later chunk in that sibling. Keeping one reader avoids that
 * hidden full-document buffer: only the probe prefix is retained before the
 * caller starts consuming the returned response.
 */
function replayInspectedBody(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  inspected: readonly Uint8Array[],
): ReadableStream<Uint8Array> {
  let inspectedIndex = 0;
  let readerReleased = false;
  const releaseReader = () => {
    if (!readerReleased) {
      readerReleased = true;
      reader.releaseLock();
    }
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (inspectedIndex < inspected.length) {
        controller.enqueue(inspected[inspectedIndex]);
        inspectedIndex += 1;
        return;
      }

      try {
        const next = await reader.read();
        if (next.done) {
          controller.close();
          releaseReader();
          return;
        }
        controller.enqueue(next.value);
      } catch (error) {
        controller.error(error);
        releaseReader();
      }
    },
    async cancel(reason) {
      if (readerReleased) {
        return;
      }
      try {
        await reader.cancel(reason);
      } finally {
        releaseReader();
      }
    },
  });
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

    // A non-markup provider error must keep streaming exactly as supplied. Use
    // one reader rather than `tee()`: an unconsumed tee sibling would queue the
    // complete markup document while this branch hashes it. The returned
    // non-markup stream replays only this bounded inspected prefix, then reads
    // the original body on demand.
    const reader = response.body.getReader();
    const inspected: Uint8Array[] = [];
    const hasher = createHash("sha256");
    const decoder = new TextDecoder();
    let bytes = 0;
    let inspectedBytes = 0;
    let probe = "";
    let markup: boolean | undefined;

    try {
      while (markup === undefined) {
        const next = await reader.read();
        if (next.done) {
          probe = `${probe}${decoder.decode()}`
            .trimStart()
            .slice(0, MARKUP_PROBE_CHARS);
          markup = isMarkupDocumentBody(probe);
          break;
        }

        inspected.push(next.value);
        bytes += next.value.byteLength;
        hasher.update(next.value);
        const remainingProbeBytes = MARKUP_PROBE_BYTES - inspectedBytes;
        const segment = next.value.subarray(
          0,
          Math.max(0, remainingProbeBytes),
        );
        inspectedBytes += segment.byteLength;
        probe = `${probe}${decoder.decode(segment, { stream: true })}`
          .trimStart()
          .slice(0, MARKUP_PROBE_CHARS);
        if (probe.length > 0 && !probe.startsWith("<")) {
          markup = false;
        } else if (isMarkupDocumentBody(probe)) {
          markup = true;
        } else if (
          inspectedBytes === MARKUP_PROBE_BYTES ||
          probe.length === MARKUP_PROBE_CHARS
        ) {
          // The bounded probe did not identify a document. Preserve this
          // opaque error rather than waiting for an arbitrarily long stream.
          markup = false;
        }
      }

      if (!markup) {
        return new Response(replayInspectedBody(reader, inspected), {
          headers: response.headers,
          status: response.status,
          statusText: response.statusText,
        });
      }

      // Do not retain the raw probe once it is known to be markup. Continue
      // through the same reader to count and hash the discarded document.
      inspected.length = 0;
      for (;;) {
        const next = await reader.read();
        if (next.done) {
          break;
        }
        bytes += next.value.byteLength;
        hasher.update(next.value);
      }
    } finally {
      // The replay stream owns this reader after a non-markup return. Every
      // other path has finished with it here, including probe/read failures.
      if (markup !== false) {
        reader.releaseLock();
      }
    }

    const headers = replayableHeaders(response.headers);
    headers.set("content-type", "application/json");
    return new Response(
      JSON.stringify({
        error: {
          type: UPSTREAM_NON_API_RESPONSE_MARKER,
          message: describeUpstreamNonApiResponseMetadata({
            status: response.status,
            contentType: response.headers.get("content-type"),
            bytes,
            digest: hasher.digest("hex").slice(0, DIGEST_CHARS),
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
