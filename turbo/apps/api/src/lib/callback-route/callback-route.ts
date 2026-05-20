import { command, computed, state, type Command } from "ccstate";
import { eq } from "drizzle-orm";
import { agentRunCallbacks } from "@vm0/db/schema/agent-run-callback";
import { agentRuns } from "@vm0/db/schema/agent-run";

import { request$ } from "../../signals/context/hono";
import type { SignalRouteHandler } from "../../signals/context/route";
import { db$ } from "../../signals/external/db";
import { decryptPersistentSecretValue } from "../../signals/services/crypto.utils";
import { userFeatureSwitchContext } from "../../signals/services/feature-switches.service";
import { safeJsonParse } from "../../signals/utils";
import { verifyCallbackRequest } from "../event-consumer/verify-signature";

/**
 * Parsed and verified run-callback request data.
 *
 * Mirrors `apps/web/src/lib/infra/callback/verify-callback.ts#VerifiedCallback`
 * so route handlers ported from web see the same envelope shape. Re-export
 * with a route-specific payload generic from a consumer when needed.
 */
interface VerifiedCallback<P = unknown> {
  /** Present only when the dispatcher includes callbackId (new behavior). */
  readonly callbackId?: string;
  readonly runId: string;
  readonly status: "completed" | "failed" | "progress";
  readonly result?: Record<string, unknown>;
  readonly error?: string;
  readonly payload: P;
}

interface CallbackErrorResponse {
  readonly status: 400 | 401 | 404;
  readonly body: { readonly error: string };
}

interface CallbackRequestBody {
  readonly callbackId?: string;
  readonly runId?: string;
  readonly status: "completed" | "failed" | "progress";
  readonly result?: Record<string, unknown>;
  readonly error?: string;
  readonly payload: unknown;
}

const callbackPayloadState$ = state<VerifiedCallback<unknown> | null>(null);

/**
 * Verified callback envelope, available inside a `callbackRoute` scope.
 *
 * Follows the same set/read pattern as `eventConsumerPayload$` and
 * `authContext$`. Route handlers narrow `payload` to their route-specific
 * shape via a local parse function — the primitive is payload-agnostic.
 */
export const callbackPayload$ = computed((get): VerifiedCallback<unknown> => {
  const payload = get(callbackPayloadState$);
  if (!payload) {
    throw new Error("callbackPayload$ accessed outside a callbackRoute scope");
  }
  return payload;
});

function isCommand<T>(
  handler$: SignalRouteHandler<T>,
): handler$ is Command<T, [AbortSignal]> {
  return "write" in handler$;
}

/**
 * Wrap an inner handler with per-callback HMAC verification.
 *
 * Reads the raw request body (single-shot stream consumption), parses the
 * JSON envelope, looks up the `agent_run_callbacks` row by `callbackId` (PK,
 * preferred) or `runId` (fallback), decrypts the per-callback secret, verifies
 * `X-VM0-Signature` / `X-VM0-Timestamp`, and exposes the verified envelope via
 * `callbackPayload$`.
 *
 * Mirrors `apps/web/src/lib/infra/callback/verify-callback.ts#verifyCallback`
 * exactly so error responses are byte-equivalent during the rollout window.
 */
export function callbackRoute<T>(
  handler$: SignalRouteHandler<T>,
): Command<Promise<T | CallbackErrorResponse>, [AbortSignal]> {
  return command(
    async (
      { get, set },
      signal: AbortSignal,
    ): Promise<T | CallbackErrorResponse> => {
      const req = get(request$);
      const rawBody = await req.text();
      signal.throwIfAborted();

      const parsed = safeJsonParse(rawBody);
      if (!parsed || typeof parsed !== "object") {
        return { status: 400, body: { error: "Invalid JSON body" } };
      }
      const body = parsed as CallbackRequestBody;

      if (!body.runId) {
        return { status: 400, body: { error: "Missing runId" } };
      }
      const runId = body.runId;
      const { callbackId } = body;

      const db = get(db$);
      const [record] = callbackId
        ? await db
            .select({
              encryptedSecret: agentRunCallbacks.encryptedSecret,
              orgId: agentRuns.orgId,
              userId: agentRuns.userId,
            })
            .from(agentRunCallbacks)
            .innerJoin(agentRuns, eq(agentRuns.id, agentRunCallbacks.runId))
            .where(eq(agentRunCallbacks.id, callbackId))
            .limit(1)
        : await db
            .select({
              encryptedSecret: agentRunCallbacks.encryptedSecret,
              orgId: agentRuns.orgId,
              userId: agentRuns.userId,
            })
            .from(agentRunCallbacks)
            .innerJoin(agentRuns, eq(agentRuns.id, agentRunCallbacks.runId))
            .where(eq(agentRunCallbacks.runId, runId))
            .limit(1);
      signal.throwIfAborted();

      if (!record) {
        return { status: 404, body: { error: "Callback not found" } };
      }

      const secret = await decryptPersistentSecretValue(
        record.encryptedSecret,
        await get(userFeatureSwitchContext(record.orgId, record.userId)),
      );
      signal.throwIfAborted();

      const verification = verifyCallbackRequest(
        rawBody,
        secret,
        req.header("X-VM0-Signature") ?? null,
        req.header("X-VM0-Timestamp") ?? null,
      );
      if (!verification.valid) {
        return {
          status: 401,
          body: { error: verification.error ?? "Invalid signature" },
        };
      }

      set(callbackPayloadState$, {
        callbackId,
        runId,
        status: body.status,
        result: body.result,
        error: body.error,
        payload: body.payload,
      });

      return isCommand(handler$)
        ? await set(handler$, signal)
        : await get(handler$);
    },
  );
}
