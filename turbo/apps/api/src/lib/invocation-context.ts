import { AsyncLocalStorage } from "node:async_hooks";

import { singleton } from "./singleton";
import { now } from "./time";

interface InvocationExecutionContext {
  waitUntil(work: Promise<unknown>): void;
}

interface InvocationResource<T> {
  readonly value: T;
  dispose(): Promise<void>;
}

interface PendingWork {
  readonly name: string;
  readonly promise: Promise<unknown>;
}

interface SettledWork {
  readonly durationMs: number;
  readonly error?: unknown;
  readonly name: string;
  readonly outcome: "fulfilled" | "rejected";
}

interface InvocationMetadata {
  readonly kind: "fetch" | "scheduled";
  readonly requestId: string;
  readonly workerVersion?: string;
}

class InvocationContext {
  readonly controller = new AbortController();
  readonly pending = new Set<PendingWork>();
  readonly resources = new Map<symbol, InvocationResource<unknown>>();
  readonly settled: SettledWork[] = [];

  constructor(
    readonly executionContext: InvocationExecutionContext,
    readonly metadata: InvocationMetadata,
  ) {}

  private async observeWaitUntil(
    name: string,
    work: Promise<unknown>,
    startedAt: number,
  ): Promise<unknown> {
    const [result] = await Promise.allSettled([work]);
    if (result?.status === "fulfilled") {
      this.settled.push({
        durationMs: Math.max(0, now() - startedAt),
        name,
        outcome: "fulfilled",
      });
      return result.value;
    }
    this.settled.push({
      durationMs: Math.max(0, now() - startedAt),
      error: result?.reason,
      name,
      outcome: "rejected",
    });
    throw result?.reason;
  }

  registerWaitUntil(name: string, work: Promise<unknown>): void {
    const startedAt = now();
    const pending: PendingWork = {
      name,
      promise: this.observeWaitUntil(name, work, startedAt),
    };
    this.pending.add(pending);
    this.executionContext.waitUntil(pending.promise);
  }

  getResource<T>(
    key: symbol,
    create: () => InvocationResource<T>,
  ): InvocationResource<T> {
    const current = this.resources.get(key);
    if (current) {
      return current as InvocationResource<T>;
    }
    const resource = create();
    this.resources.set(key, resource);
    return resource;
  }

  async finalize(): Promise<void> {
    while (this.pending.size > 0) {
      const pending = [...this.pending];
      await Promise.allSettled(
        pending.map((work) => {
          return work.promise;
        }),
      );
      for (const work of pending) {
        this.pending.delete(work);
      }
    }

    const { flushLogs, logger } = await import("./log");
    const log = logger("api:invocation");
    for (const work of this.settled) {
      const fields = {
        durationMs: work.durationMs,
        name: work.name,
        outcome: work.outcome,
        requestId: this.metadata.requestId,
        ...(work.error === undefined ? {} : { error: work.error }),
      };
      if (work.outcome === "fulfilled") {
        log.debug("waitUntil completed", fields);
      } else {
        log.error("waitUntil failed", fields);
      }
    }
    await flushLogs();

    const resources = [...this.resources.values()].reverse();
    await Promise.all(
      resources.map(async (resource) => {
        await resource.dispose();
      }),
    );
    await flushLogs();
  }
}

const invocationStorage = singleton(() => {
  return new AsyncLocalStorage<InvocationContext>();
});

export function currentInvocation(): InvocationContext | undefined {
  return invocationStorage().getStore();
}

export function currentInvocationSignal(): AbortSignal | undefined {
  return currentInvocation()?.controller.signal;
}

export function invocationResource<T>(
  key: symbol,
  create: () => InvocationResource<T>,
): InvocationResource<T> | undefined {
  return currentInvocation()?.getResource(key, create);
}

export async function runInvocation<T>(
  executionContext: InvocationExecutionContext,
  metadata: InvocationMetadata,
  run: () => Promise<T>,
): Promise<T> {
  const invocation = new InvocationContext(executionContext, metadata);
  return await invocationStorage().run(invocation, async () => {
    const [result] = await Promise.allSettled([run()]);
    executionContext.waitUntil(invocation.finalize());
    if (!result) {
      throw new Error("Invocation did not produce a settlement result");
    }
    if (result.status === "rejected") {
      throw result.reason;
    }
    return result.value;
  });
}
