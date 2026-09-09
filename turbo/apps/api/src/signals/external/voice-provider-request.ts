import { delay } from "signal-timers";

import { logger } from "../../lib/log";
import { now } from "../../lib/time";
import { onRejection } from "../utils";

const L = logger("VoiceProvider");
const MAX_ATTEMPTS = 3;
// Recovery gets its own deadline after the first rejected request. Do not
// impose this short budget on an otherwise healthy long transcription.
const RECOVERY_BUDGET_MS = 15_000;
const INITIAL_BACKOFF_MS = 1000;

interface VoiceProviderContext {
  readonly provider: "openrouter" | "fal";
  readonly model: string;
  readonly responseSchema?: string;
}

export class VoiceProviderUnavailableError extends Error {
  constructor(readonly status: number) {
    super("Voice provider recovery exhausted");
    this.name = "VoiceProviderUnavailableError";
  }
}

function isRetryableStatus(status: number): boolean {
  return (
    status === 429 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504
  );
}

function retryAfterMs(value: string | null): number | undefined {
  if (!value?.trim()) {
    return undefined;
  }
  const text = value.trim();
  const milliseconds = /^\d+(?:\.\d+)?$/u.test(text)
    ? Number(text) * 1000
    : Date.parse(text) - now();
  return Number.isFinite(milliseconds) && milliseconds >= 0
    ? milliseconds
    : undefined;
}

function exhausted(
  context: VoiceProviderContext,
  status: number,
  attempts: number,
): VoiceProviderUnavailableError {
  L.warn("Voice provider recovery exhausted", {
    ...context,
    status,
    attempts,
  });
  return new VoiceProviderUnavailableError(status);
}

/** Retry only explicit temporary HTTP failures, at the failed provider step. */
export async function requestVoiceProvider<T>(
  request: (signal: AbortSignal) => Promise<Response>,
  readResponse: (response: Response) => Promise<T>,
  context: VoiceProviderContext,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted();
  let response = await request(signal);
  signal.throwIfAborted();
  const deadline = now() + RECOVERY_BUDGET_MS;
  let attempts = 1;
  let responseSignal = signal;
  let status = response.status;
  const checkSignal = () => {
    signal.throwIfAborted();
    if (attempts > 1 && (responseSignal.aborted || now() >= deadline)) {
      throw exhausted(context, status, attempts);
    }
  };
  while (isRetryableStatus(response.status)) {
    status = response.status;
    const wait = Math.max(
      INITIAL_BACKOFF_MS * 2 ** (attempts - 1),
      retryAfterMs(response.headers.get("Retry-After")) ?? 0,
    );
    await onRejection(
      response.body?.cancel() ?? Promise.resolve(),
      checkSignal,
    );
    checkSignal();
    // A provider's long retry delay is not permission to retry earlier.
    if (attempts >= MAX_ATTEMPTS || wait >= deadline - now()) {
      throw exhausted(context, status, attempts);
    }
    await delay(wait, { signal });
    signal.throwIfAborted();
    const remaining = deadline - now();
    if (remaining <= 0) {
      throw exhausted(context, status, attempts);
    }
    responseSignal = AbortSignal.any([signal, AbortSignal.timeout(remaining)]);
    attempts += 1;
    response = await onRejection(request(responseSignal), checkSignal);
    checkSignal();
  }
  // Keep body consumption inside the recovery deadline and report success only
  // after the provider response has passed the caller's validation.
  const result = await onRejection(readResponse(response), checkSignal);
  checkSignal();
  if (response.ok && attempts > 1) {
    L.debug("Voice provider request recovered", { ...context, attempts });
  }
  return result;
}
