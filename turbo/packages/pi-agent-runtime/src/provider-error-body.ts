import type { SimpleStreamOptions } from "@earendil-works/pi-ai";

/**
 * Restate an opaque provider error body as the adapter's own JSON envelope.
 *
 * A model request can be answered by a gateway rather than the provider: an
 * Envoy local reply (`no healthy upstream`) or an edge HTML error page. The
 * upstream adapters reduce such a body to its raw text and drop the HTTP
 * status, so the terminal assistant error carries no stage evidence, no retry
 * classifier recognizes it, and a single transient answer ends the whole run.
 *
 * This boundary only rewrites a body that is not already JSON, so every
 * provider-authored error envelope keeps reaching its existing classifier
 * unchanged.
 */

/** Largest error body buffered before normalization is abandoned. */
const MAX_BUFFERED_ERROR_BODY_BYTES = 64 * 1024;
/** Longest upstream phrase retained in the normalized message. */
const MAX_PRESERVED_SNIPPET_CHARS = 200;
/** Marker that carries the observed status into the terminal error text. */
const PROVIDER_HTTP_STATUS_MARKER = "provider HTTP";
/** Statuses whose responses must not carry a body. */
const NULL_BODY_STATUSES: ReadonlySet<number> = new Set([204, 205, 304]);

interface BufferedErrorBody {
  readonly bytes: Uint8Array;
  readonly truncated: boolean;
}

async function bufferErrorBody(
  body: ReadableStream<Uint8Array>,
): Promise<BufferedErrorBody> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) {
        break;
      }
      chunks.push(result.value);
      size += result.value.byteLength;
      if (size > MAX_BUFFERED_ERROR_BODY_BYTES) {
        // An oversized error body is passed through untouched, so cancelling
        // the remainder would truncate what the adapter still parses.
        await reader.cancel();
        return { bytes: concatChunks(chunks, size), truncated: true };
      }
    }
  } finally {
    reader.releaseLock();
  }
  return { bytes: concatChunks(chunks, size), truncated: false };
}

function concatChunks(chunks: readonly Uint8Array[], size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function isJsonBody(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/** Reduce markup and layout to the one phrase worth keeping for diagnosis. */
function providerErrorSnippet(text: string): string {
  const withoutMarkup = text
    .replaceAll(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/giu, " ")
    .replaceAll(/<[^>]*>/gu, " ");
  const collapsed = withoutMarkup.replaceAll(/\s+/gu, " ").trim();
  return collapsed.length > MAX_PRESERVED_SNIPPET_CHARS
    ? `${collapsed.slice(0, MAX_PRESERVED_SNIPPET_CHARS)}...`
    : collapsed;
}

/** Build the terminal message an opaque provider body would otherwise lose. */
function providerHttpErrorMessage(status: number, body: string): string {
  const snippet = providerErrorSnippet(body);
  return snippet
    ? `${PROVIDER_HTTP_STATUS_MARKER} ${status}: ${snippet}`
    : `${PROVIDER_HTTP_STATUS_MARKER} ${status}`;
}

function jsonEnvelopeHeaders(headers: Headers): Headers {
  const rewritten = new Headers(headers);
  // The buffered bytes are already decoded and re-sized by this boundary.
  rewritten.delete("content-length");
  rewritten.delete("content-encoding");
  rewritten.set("content-type", "application/json");
  return rewritten;
}

/** Wrap a fetch so opaque provider error bodies keep their observed status. */
export function preserveProviderErrorStatus(
  fetchImpl: NonNullable<SimpleStreamOptions["fetch"]>,
): NonNullable<SimpleStreamOptions["fetch"]> {
  return async (input, init) => {
    const response = await fetchImpl(input, init);
    if (
      response.ok ||
      response.body === null ||
      NULL_BODY_STATUSES.has(response.status)
    ) {
      return response;
    }
    const { bytes, truncated } = await bufferErrorBody(response.body);
    const text = new TextDecoder().decode(bytes);
    if (truncated || isJsonBody(text)) {
      return new Response(bytes, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    }
    const envelope = {
      error: {
        message: providerHttpErrorMessage(response.status, text),
        type: "http_error",
      },
    };
    return new Response(JSON.stringify(envelope), {
      status: response.status,
      statusText: response.statusText,
      headers: jsonEnvelopeHeaders(response.headers),
    });
  };
}
