import { timingSafeEqual } from "node:crypto";

import { command } from "ccstate";

import { authorization$ } from "../context/hono";
import { waitUntil } from "../context/wait-until";
import { env } from "../external/env";
import {
  cliTokenRecord,
  updateCliTokenLastUsedAt$,
} from "../services/auth.service";
import { isPatToken, isSandboxToken, verifyCliToken } from "./tokens";

const OFFICIAL_RUNNER_TOKEN_PREFIX = "vm0_official_";

type RunnerAuthContext =
  | {
      readonly type: "user";
      readonly userId: string;
    }
  | { readonly type: "official-runner" };

function validateOfficialRunnerSecret(providedSecret: string): boolean {
  const expectedSecret = env("OFFICIAL_RUNNER_SECRET");

  const providedBuffer = Buffer.from(providedSecret, "utf8");
  const expectedBuffer = Buffer.from(expectedSecret, "utf8");
  if (providedBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return timingSafeEqual(providedBuffer, expectedBuffer);
}

export const runnerAuth$ = command(
  async (
    { get, set },
    signal: AbortSignal,
  ): Promise<RunnerAuthContext | null> => {
    const authHeader = get(authorization$);
    if (!authHeader?.startsWith("Bearer ")) {
      return null;
    }

    const token = authHeader.substring(7);

    if (isPatToken(token) || isSandboxToken(token)) {
      const cliAuth = verifyCliToken(token);
      if (!cliAuth) {
        return null;
      }

      const resolved = await get(cliTokenRecord(cliAuth));
      if (!resolved) {
        return null;
      }

      waitUntil(set(updateCliTokenLastUsedAt$, cliAuth.tokenId, signal));

      return { type: "user" as const, userId: resolved.userId };
    }

    if (token.startsWith(OFFICIAL_RUNNER_TOKEN_PREFIX)) {
      const secret = token.substring(OFFICIAL_RUNNER_TOKEN_PREFIX.length);
      return validateOfficialRunnerSecret(secret)
        ? { type: "official-runner" as const }
        : null;
    }

    return null;
  },
);
