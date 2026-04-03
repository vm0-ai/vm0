import { toast } from "@vm0/ui/components/ui/sonner";

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

async function accept<
  T extends { status: number; body: unknown },
  S extends number,
>(
  promise: Promise<T>,
  codes: S[],
  options?: { toast?: boolean },
): Promise<Extract<T, { status: S }>> {
  const result = await promise;
  if ((codes as number[]).includes(result.status)) {
    return result as Extract<T, { status: S }>;
  }
  const { message, code } = extractError(result.body, result.status);
  if (options?.toast !== false) {
    toast.error(message);
  }
  throw new ApiError(message, code, result.status);
}

export { ApiError, accept };
