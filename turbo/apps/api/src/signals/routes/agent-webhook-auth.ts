import type { SandboxAuth } from "../../types/auth";
import { isSandboxToken, verifySandboxToken } from "../auth/tokens";

export const unauthorizedRunMismatch = Object.freeze({
  status: 401 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "Not authenticated or runId mismatch",
      code: "UNAUTHORIZED",
    }),
  }),
});

export function getSandboxAuthForRun(
  expectedRunId: string,
  authHeader: string | undefined,
): SandboxAuth | null {
  if (!authHeader?.startsWith("Bearer ")) {
    return null;
  }

  const token = authHeader.substring("Bearer ".length);
  if (!isSandboxToken(token)) {
    return null;
  }

  const auth = verifySandboxToken(token);
  if (!auth || auth.runId !== expectedRunId) {
    return null;
  }

  return auth;
}
