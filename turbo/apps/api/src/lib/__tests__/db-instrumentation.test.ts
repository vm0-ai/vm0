import { context, SpanStatusCode, type Tracer } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { Pool, type PoolClient, type PoolConfig } from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import { instrumentPgPool } from "../db-instrumentation";
import { env } from "../env";

const ACQUIRE_DURATION_ATTRIBUTE = "vm0.db.pool.acquire.duration_ms";
const ACQUIRE_PATH_ATTRIBUTE = "vm0.db.pool.acquire.path";

type AcquirePath = "idle" | "new" | "queued";

function expectAcquisition(span: ReadableSpan, path: AcquirePath): void {
  expect(span.attributes[ACQUIRE_PATH_ATTRIBUTE]).toBe(path);
  const duration = span.attributes[ACQUIRE_DURATION_ATTRIBUTE];
  expect(typeof duration).toBe("number");
  if (typeof duration !== "number") {
    throw new Error("Acquisition duration is not numeric");
  }
  expect(duration).toBeGreaterThanOrEqual(0);
}

function captureRejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      return undefined;
    },
    (error: unknown) => {
      return error;
    },
  );
}

describe("instrumentPgPool", () => {
  let exporter: InMemorySpanExporter;
  let provider: BasicTracerProvider;
  let tracer: Tracer;
  let pools: Pool[];

  function createPool(config: PoolConfig = {}): Pool {
    const pool = instrumentPgPool(
      new Pool({
        allowExitOnIdle: true,
        connectionString: env("DATABASE_URL"),
        idleTimeoutMillis: 0,
        max: 1,
        ...config,
      }),
      tracer,
    );
    pools.push(pool);
    return pool;
  }

  function findSpan(statement: string): ReadableSpan {
    const span = exporter.getFinishedSpans().find((candidate) => {
      return candidate.attributes["db.statement"] === statement;
    });
    if (!span) {
      throw new Error(`No span found for statement: ${statement}`);
    }
    return span;
  }

  function findNamedSpan(name: string): ReadableSpan {
    const span = exporter.getFinishedSpans().find((candidate) => {
      return candidate.name === name;
    });
    if (!span) {
      throw new Error(`No span found with name: ${name}`);
    }
    return span;
  }

  function runUnderParent<T>(
    parentName: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    return tracer.startActiveSpan(parentName, (span) => {
      return operation().finally(() => {
        span.end();
      });
    });
  }

  beforeAll(() => {
    const contextManager = new AsyncLocalStorageContextManager().enable();
    expect(context.setGlobalContextManager(contextManager)).toBeTruthy();
  });

  beforeEach(() => {
    exporter = new InMemorySpanExporter();
    provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    tracer = provider.getTracer("db-instrumentation-test");
    pools = [];
  });

  afterEach(async () => {
    await Promise.all(
      pools.map((pool) => {
        return pool.end();
      }),
    );
    await provider.shutdown();
  });

  afterAll(() => {
    context.disable();
  });

  it("attributes new, idle, and queued acquisition to each query span", async () => {
    const pool = createPool();
    const newStatement = "SELECT 101 AS new_path";
    const idleStatement = "SELECT 102 AS idle_path";
    const queuedStatement = "SELECT 103 AS queued_path";

    const newResult = await pool.query(newStatement);
    const idleResult = await pool.query(idleStatement);

    const heldClient = await pool.connect();
    const queuedQuery = pool.query(queuedStatement);
    const waitingCount = pool.waitingCount;
    heldClient.release();
    const queuedResult = await queuedQuery;

    expect(waitingCount).toBe(1);
    expect(newResult.rowCount).toBe(1);
    expect(idleResult.rowCount).toBe(1);
    expect(queuedResult.rowCount).toBe(1);
    expectAcquisition(findSpan(newStatement), "new");
    expectAcquisition(findSpan(idleStatement), "idle");
    expectAcquisition(findSpan(queuedStatement), "queued");
  });

  it("reserves idle and new capacity for earlier synchronous queries", async () => {
    const pool = createPool({ max: 2 });
    const warmStatement = "SELECT 104 AS warm_pool";
    const idleStatement = "SELECT 105 AS burst_idle";
    const newStatement = "SELECT 106 AS burst_new";
    const queuedStatement = "SELECT 107 AS burst_queued";

    await pool.query(warmStatement);
    const idleQuery = pool.query(idleStatement);
    const newQuery = pool.query(newStatement);
    const queuedQuery = pool.query(queuedStatement);
    const waitingCount = pool.waitingCount;

    const [idleResult, newResult, queuedResult] = await Promise.all([
      idleQuery,
      newQuery,
      queuedQuery,
    ]);

    expect(waitingCount).toBe(3);
    expect(idleResult.rowCount).toBe(1);
    expect(newResult.rowCount).toBe(1);
    expect(queuedResult.rowCount).toBe(1);
    expectAcquisition(findSpan(warmStatement), "new");
    expectAcquisition(findSpan(idleStatement), "idle");
    expectAcquisition(findSpan(newStatement), "new");
    expectAcquisition(findSpan(queuedStatement), "queued");
  });

  it("keeps concurrent queued measurements on their originating traces", async () => {
    const pool = createPool();
    const heldClient = await pool.connect();
    const statementA = "SELECT 201 AS queued_a";
    const statementB = "SELECT 202 AS queued_b";

    const queryA = runUnderParent("parent-a", () => {
      return pool.query(statementA);
    });
    const queryB = runUnderParent("parent-b", () => {
      return pool.query(statementB);
    });
    const waitingCount = pool.waitingCount;

    heldClient.release();
    await Promise.all([queryA, queryB]);

    expect(waitingCount).toBe(2);
    const spanA = findSpan(statementA);
    const spanB = findSpan(statementB);
    const parentA = findNamedSpan("parent-a");
    const parentB = findNamedSpan("parent-b");
    expectAcquisition(spanA, "queued");
    expectAcquisition(spanB, "queued");
    expect(spanA.spanContext().traceId).toBe(parentA.spanContext().traceId);
    expect(spanA.parentSpanContext?.spanId).toBe(parentA.spanContext().spanId);
    expect(spanB.spanContext().traceId).toBe(parentB.spanContext().traceId);
    expect(spanB.parentSpanContext?.spanId).toBe(parentB.spanContext().spanId);
    expect(parentA.spanContext().traceId).not.toBe(
      parentB.spanContext().traceId,
    );
  });

  it("preserves acquisition and query failures and releases clients", async () => {
    const timeoutPool = createPool({ connectionTimeoutMillis: 25 });
    const heldClient = await timeoutPool.connect();
    const timeoutStatement = "SELECT 301 AS acquisition_timeout";

    const timeoutError = await captureRejection(
      timeoutPool.query(timeoutStatement),
    );
    heldClient.release();

    expect(timeoutError).toBeInstanceOf(Error);
    expect(timeoutError).toHaveProperty(
      "message",
      "timeout exceeded when trying to connect",
    );
    const timeoutSpan = findSpan(timeoutStatement);
    expect(timeoutSpan.status.code).toBe(SpanStatusCode.ERROR);
    expectAcquisition(timeoutSpan, "queued");

    const failurePool = createPool();
    const invalidStatement =
      "SELECT * FROM vm0_missing_db_instrumentation_table";
    const recoveryStatement = "SELECT 302 AS recovered";
    const queryError = await captureRejection(
      failurePool.query(invalidStatement),
    );
    const recoveryResult = await failurePool.query(recoveryStatement);

    expect(queryError).toBeInstanceOf(Error);
    expect(recoveryResult.rowCount).toBe(1);
    const failureSpan = findSpan(invalidStatement);
    expect(failureSpan.status.code).toBe(SpanStatusCode.ERROR);
    expectAcquisition(failureSpan, "new");
    expectAcquisition(findSpan(recoveryStatement), "new");
  });

  it("preserves direct callbacks and instruments reused clients only once", async () => {
    const pool = createPool();
    let callbackError: Error | undefined;
    let callbackClient: PoolClient | undefined;
    const callbackReturn = pool.connect((error, client, release) => {
      if (error) {
        callbackError = error;
        return;
      }
      if (!client || !release) {
        callbackError = new Error("Pool callback did not return a client");
        return;
      }
      callbackClient = client;
      release();
    });

    const statementA = "SELECT 401 AS reused_a";
    const statementB = "SELECT 402 AS reused_b";
    // With max: 1, this checkout cannot resolve until the callback above has
    // received and released the sole client.
    const clientA = await pool.connect();
    const resultA = await clientA.query(statementA);
    clientA.release();

    const clientB = await pool.connect();
    const sameClient = clientB === clientA;
    const resultB = await clientB.query(statementB);
    clientB.release();

    expect(callbackReturn).toBeUndefined();
    expect(callbackError).toBeUndefined();
    expect(callbackClient).toBe(clientA);
    expect(sameClient).toBeTruthy();
    expect(resultA.rowCount).toBe(1);
    expect(resultB.rowCount).toBe(1);
    expect(
      exporter.getFinishedSpans().filter((span) => {
        return span.attributes["db.statement"] === statementA;
      }),
    ).toHaveLength(1);
    expect(
      exporter.getFinishedSpans().filter((span) => {
        return span.attributes["db.statement"] === statementB;
      }),
    ).toHaveLength(1);
    expect(
      findSpan(statementA).attributes[ACQUIRE_PATH_ATTRIBUTE],
    ).toBeUndefined();
    expect(
      findSpan(statementB).attributes[ACQUIRE_PATH_ATTRIBUTE],
    ).toBeUndefined();
  });
});
