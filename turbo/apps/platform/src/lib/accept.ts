import { toast } from "@vm0/ui/components/ui/sonner";
import { isAbortError, onRejection } from "../signals/utils.ts";

class ApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(message: string, code: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
  }
}

function extractError(
  body: unknown,
  status: number,
): { message: string; code: string } {
  if (
    body !== null &&
    typeof body === "object" &&
    "error" in body &&
    body.error !== null &&
    typeof body.error === "object" &&
    "message" in body.error &&
    typeof body.error.message === "string"
  ) {
    const code =
      "code" in body.error && typeof body.error.code === "string"
        ? body.error.code
        : "UNKNOWN";
    return { message: body.error.message, code };
  }
  return { message: `HTTP ${status}`, code: "UNKNOWN" };
}

function requestErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Request failed";
}

function isNetworkRequestError(error: unknown): boolean {
  return (
    error instanceof TypeError &&
    (error.message === "Failed to fetch" ||
      error.message === "Load failed" ||
      error.message.startsWith("NetworkError"))
  );
}

/**
 * Awaits a typed API response and returns it if the status code is in `codes`.
 * Otherwise shows a toast and throws an `ApiError`.
 *
 * Browser network failures propagate without showing their raw error message.
 *
 * When `signal` is provided, a rejection after that signal aborts propagates
 * as cancellation without showing a toast.
 */
async function accept<
  T extends { status: number; body: unknown },
  S extends number,
>(
  promise: Promise<T>,
  codes: S[],
  signal?: AbortSignal,
): Promise<Extract<T, { status: S }>> {
  const result = await onRejection(promise, (error) => {
    if (!isAbortError(error)) {
      signal?.throwIfAborted();
      if (!isNetworkRequestError(error)) {
        toast.error(requestErrorMessage(error));
      }
    }
  });
  if ((codes as number[]).includes(result.status)) {
    return result as Extract<T, { status: S }>;
  }
  const { message, code } = extractError(result.body, result.status);
  toast.error(message);
  throw new ApiError(message, code, result.status);
}

export { ApiError, accept };
