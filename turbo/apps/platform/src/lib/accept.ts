import { toast } from "@vm0/ui/components/ui/sonner";
import { isAbortError, onRejection } from "../signals/utils.ts";
import { isNetworkRequestError } from "./network-error.ts";

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

interface AcceptOptions {
  readonly showErrorToast?: boolean;
}

/**
 * Awaits a typed API response and returns it if the status code is in `codes`.
 * Otherwise throws an `ApiError` and, by default, shows a toast. A 401 is
 * never toasted because the authenticated clients own sign-in recovery.
 *
 * Browser network failures propagate without showing their raw error message.
 *
 * When `signal` is provided, a rejection after that signal aborts propagates
 * as cancellation without showing a toast.
 *
 * Best-effort background work may disable the error toast while preserving the
 * same typed response handling and thrown error.
 */
async function accept<
  T extends { status: number; body: unknown },
  S extends number,
>(
  promise: Promise<T>,
  codes: S[],
  signal?: AbortSignal,
  options: AcceptOptions = {},
): Promise<Extract<T, { status: S }>> {
  const showErrorToast = options.showErrorToast ?? true;
  const result = await onRejection(promise, (error) => {
    if (!isAbortError(error)) {
      signal?.throwIfAborted();
      if (showErrorToast && !isNetworkRequestError(error)) {
        toast.error(requestErrorMessage(error));
      }
    }
  });
  if ((codes as number[]).includes(result.status)) {
    return result as Extract<T, { status: S }>;
  }
  const { message, code } = extractError(result.body, result.status);
  if (showErrorToast && result.status !== 401) {
    toast.error(message);
  }
  throw new ApiError(message, code, result.status);
}

export { ApiError, accept };
