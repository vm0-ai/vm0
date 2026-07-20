import {
  connectorGrantCleanupError,
  connectorGrantPrimaryError,
  type ConnectorAuthProviderGrantRollbackResult,
} from "@vm0/connectors/auth-providers";

import { logger } from "../../lib/log";
import { waitUntil } from "../context/wait-until";
import { settleIncludingAbort } from "../utils";
import { ConnectorTokenPersistenceError } from "./zero-connector-data.service";

const GRANT_ROLLBACK_TIMEOUT_MS = 5000;
const L = logger("ConnectorGrantLifecycleService");

interface ConnectorGrantLifecycleContext {
  readonly connectorRef: string;
  readonly authMethodId: string;
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

export function observeConnectorGrantError(
  context: ConnectorGrantLifecycleContext,
  error: unknown,
): unknown {
  const cleanupError = connectorGrantCleanupError(error);
  if (cleanupError !== undefined) {
    L.warn("Connector provider grant cleanup failed", {
      ...context,
      operation: "cleanup_incomplete_grant",
      error: safeErrorMessage(cleanupError),
    });
  }
  return connectorGrantPrimaryError(error);
}

async function runGrantRollback(args: {
  readonly context: ConnectorGrantLifecycleContext;
  readonly rollback: (
    signal: AbortSignal,
  ) => Promise<ConnectorAuthProviderGrantRollbackResult>;
}): Promise<void> {
  const rollback = await settleIncludingAbort(
    args.rollback(AbortSignal.timeout(GRANT_ROLLBACK_TIMEOUT_MS)),
  );
  if (!rollback.ok) {
    L.warn("Connector grant rollback failed", {
      ...args.context,
      operation: "rollback_uncommitted_grant",
      error: safeErrorMessage(rollback.error),
    });
    return;
  }
  if (rollback.value.status === "unsupported") {
    L.debug("Connector grant rollback is unsupported", {
      ...args.context,
      operation: "rollback_uncommitted_grant",
    });
  }
}

export async function persistConnectorGrant<T>(args: {
  readonly context: ConnectorGrantLifecycleContext;
  readonly persist: (signal: AbortSignal) => Promise<T>;
  readonly rollback?: (
    signal: AbortSignal,
  ) => Promise<ConnectorAuthProviderGrantRollbackResult>;
}): Promise<T> {
  const persistence = await settleIncludingAbort(
    args.persist(new AbortController().signal),
  );
  if (!persistence.ok) {
    const error = persistence.error;
    if (
      error instanceof ConnectorTokenPersistenceError &&
      error.commitStatus === "not_committed" &&
      args.rollback
    ) {
      waitUntil(
        runGrantRollback({
          context: args.context,
          rollback: args.rollback,
        }),
      );
    }
    throw error instanceof ConnectorTokenPersistenceError
      ? error.originalError
      : error;
  }
  return persistence.value;
}
