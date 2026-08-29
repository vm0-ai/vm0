import {
  createChildAbortController,
  createDeferredPromise,
  settle,
  withCleanup,
} from "../signals/utils.ts";
import type {
  SharedDatabaseBridge,
  SharedDatabaseHeartbeat,
} from "./bridge.ts";
import type {
  SharedDatabaseDataKey,
  SharedDatabaseQuery,
  SharedDatabaseQueryResult,
} from "./data-key.ts";
import {
  SHARED_DATABASE_AUTH_BLOCKED_ERROR_NAME,
  type SharedDatabaseHeartbeatResult,
} from "./protocol.ts";

interface AuthenticationRecoveryAttempt {
  readonly rejectedToken: string;
  readonly work: Promise<boolean>;
}

function isAuthenticationBlockedError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.name === SHARED_DATABASE_AUTH_BLOCKED_ERROR_NAME
  );
}

function waitForSharedWork<T>(
  work: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted();
  const waitController = createChildAbortController(signal);
  const aborted = createDeferredPromise<never>(waitController.signal);
  return withCleanup(Promise.race([work, aborted.promise]), () => {
    waitController.abort(
      new DOMException("Shared database auth recovery completed", "AbortError"),
    );
  });
}

export class AuthRecoveringSharedDatabaseBridge implements SharedDatabaseBridge {
  private heartbeatRegistration: SharedDatabaseHeartbeat | null = null;
  private activeRecovery: Promise<boolean> | null = null;
  private lastRecovery: AuthenticationRecoveryAttempt | null = null;
  private retryingQueries = 0;

  constructor(
    private readonly bridge: SharedDatabaseBridge,
    private readonly forceRefreshToken: (
      signal: AbortSignal,
    ) => Promise<string | null>,
    private readonly rootSignal: AbortSignal,
  ) {}

  async heartbeat(
    heartbeat: SharedDatabaseHeartbeat,
    signal: AbortSignal,
  ): Promise<SharedDatabaseHeartbeatResult> {
    this.heartbeatRegistration = heartbeat;
    return await this.bridge.heartbeat(heartbeat, signal);
  }

  async query<TKey extends SharedDatabaseDataKey>(
    query: SharedDatabaseQuery<TKey>,
    signal: AbortSignal,
  ): Promise<SharedDatabaseQueryResult<TKey>> {
    const first = await settle(this.bridge.query(query, signal), signal);
    if (first.ok) {
      return first.value;
    }
    if (!isAuthenticationBlockedError(first.error)) {
      throw first.error;
    }

    const recovered = await this.recoverAuthentication(signal);
    if (!recovered) {
      throw first.error;
    }

    const retryToken = this.requireHeartbeatRegistration().identity.token;
    this.retryingQueries += 1;
    const retry = await withCleanup(
      settle(this.bridge.query(query, signal), signal),
      () => {
        this.retryingQueries -= 1;
      },
    );
    if (retry.ok) {
      return retry.value;
    }
    if (isAuthenticationBlockedError(retry.error)) {
      this.lastRecovery = {
        rejectedToken: retryToken,
        work: Promise.resolve(false),
      };
    }
    throw retry.error;
  }

  async on(
    dataKey: SharedDatabaseDataKey,
    callback: () => void,
    signal: AbortSignal,
  ): Promise<void> {
    await this.bridge.on(dataKey, callback, signal);
  }

  async authenticationRequired(): Promise<void> {
    if (this.retryingQueries > 0) {
      return;
    }
    await this.recoverAuthentication(this.rootSignal);
  }

  private recoverAuthentication(signal: AbortSignal): Promise<boolean> {
    const heartbeat = this.requireHeartbeatRegistration();
    const work = this.authenticationRecoveryWork(heartbeat);
    return waitForSharedWork(work, signal);
  }

  private requireHeartbeatRegistration(): SharedDatabaseHeartbeat {
    if (!this.heartbeatRegistration) {
      throw new Error("Shared database heartbeat is required first");
    }
    return this.heartbeatRegistration;
  }

  private authenticationRecoveryWork(
    rejectedHeartbeat: SharedDatabaseHeartbeat,
  ): Promise<boolean> {
    if (this.activeRecovery) {
      return this.activeRecovery;
    }
    if (this.lastRecovery?.rejectedToken === rejectedHeartbeat.identity.token) {
      return this.lastRecovery.work;
    }

    const recovery = withCleanup(
      this.runAuthenticationRecovery(rejectedHeartbeat),
      () => {
        if (this.activeRecovery === recovery) {
          this.activeRecovery = null;
        }
      },
    );
    this.activeRecovery = recovery;
    this.lastRecovery = {
      rejectedToken: rejectedHeartbeat.identity.token,
      work: recovery,
    };
    return recovery;
  }

  private async runAuthenticationRecovery(
    rejectedHeartbeat: SharedDatabaseHeartbeat,
  ): Promise<boolean> {
    const token = await this.forceRefreshToken(this.rootSignal);
    this.rootSignal.throwIfAborted();
    if (!token || token === rejectedHeartbeat.identity.token) {
      return false;
    }
    await this.heartbeat(
      {
        ...rejectedHeartbeat,
        identity: { ...rejectedHeartbeat.identity, token },
      },
      this.rootSignal,
    );
    return true;
  }
}
