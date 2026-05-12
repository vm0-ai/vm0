import { timingSafeEqual } from "node:crypto";

import { command } from "ccstate";

import { env } from "../../lib/env";
import { logger } from "../../lib/log";
import { waitUntil } from "../context/wait-until";
import {
  cliTokenRecord,
  updateCliTokenLastUsedAt$,
} from "../services/auth.service";
import { isPatToken, isSandboxToken, verifyCliToken } from "./tokens";

const L = logger("RunnerAuth");

const OFFICIAL_RUNNER_TOKEN_PREFIX = "vm0_official_";

export type RunnerAuthContext =
  | {
      readonly type: "user";
      readonly userId: string;
    }
  | { readonly type: "official-runner" };

function validateOfficialRunnerSecret(providedSecret: string): boolean {
  const expectedSecret = env("OFFICIAL_RUNNER_SECRET");
  const provided = Buffer.from(providedSecret, "utf8");
  const expected = Buffer.from(expectedSecret, "utf8");

  if (provided.length !== expected.length) {
    return false;
  }

  return timingSafeEqual(provided, expected);
}

export const runnerAuth$ = command(
  async (
    { get, set },
    authHeader: string | undefined,
    signal: AbortSignal,
  ): Promise<RunnerAuthContext | null> => {
    if (!authHeader?.startsWith("Bearer ")) {
      return null;
    }

    const token = authHeader.slice("Bearer ".length);

    if (isPatToken(token) || isSandboxToken(token)) {
      const cliAuth = verifyCliToken(token);
      if (!cliAuth) {
        if (isSandboxToken(token)) {
          L.debug("Rejected non-CLI sandbox JWT token on runner endpoint");
        }
        return null;
      }

      const resolved = await get(cliTokenRecord(cliAuth));
      signal.throwIfAborted();
      if (!resolved) {
        return null;
      }

      waitUntil(set(updateCliTokenLastUsedAt$, cliAuth.tokenId, signal));
      return { type: "user", userId: resolved.userId };
    }

    if (!token.startsWith(OFFICIAL_RUNNER_TOKEN_PREFIX)) {
      return null;
    }

    const secret = token.slice(OFFICIAL_RUNNER_TOKEN_PREFIX.length);
    if (!validateOfficialRunnerSecret(secret)) {
      L.warn("Invalid official runner secret");
      return null;
    }

    return { type: "official-runner" };
  },
);
