import { computed, type Computed } from "ccstate";

export type TextPreviewKind = "markdown" | "text" | "json" | "csv";
export type TextPreviewComputed = Computed<Promise<string>>;

const TEXT_PREVIEW_MAX_BYTES = 65_536;

export function isTextPreviewKind(kind: string): kind is TextPreviewKind {
  return (
    kind === "markdown" || kind === "text" || kind === "json" || kind === "csv"
  );
}

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

export async function fetchPreviewText(
  url: string,
  signal?: AbortSignal,
): Promise<string> {
  const response = await fetch(url, {
    headers: { Range: `bytes=0-${String(TEXT_PREVIEW_MAX_BYTES - 1)}` },
    signal,
  });
  if (!response.ok) {
    throw new Error(`HTTP ${String(response.status)}`);
  }
  return readLimitedText(response);
}

export function createTextPreviewComputed(url: string): TextPreviewComputed {
  return computed((_get, { signal }) => {
    return fetchPreviewText(url, signal);
  });
}

export function createTextPreviewComputedFromBlob(
  blob: Blob,
): TextPreviewComputed {
  return computed(async (_get, { signal }) => {
    signal.throwIfAborted();
    const text = await blob.slice(0, TEXT_PREVIEW_MAX_BYTES).text();
    signal.throwIfAborted();
    return text;
  });
}
