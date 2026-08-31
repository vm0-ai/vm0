import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { test } from "node:test";

import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from "@playwright/test";

import { SharedWorkerRoutes } from "./shared-worker-routes";

interface Harness {
  readonly browser: Browser;
  readonly origin: string;
  readonly server: Server;
}

interface WorkerFetchResult {
  readonly body?: unknown;
  readonly error?: string;
  readonly ok: boolean;
  readonly source?: string | null;
  readonly status?: number;
}

const workerScript = "**/shared-worker.js";

test("intercepts a real SharedWorker after explicit readiness", async () => {
  const harness = await createHarness();
  const context = await harness.browser.newContext();
  const page = await context.newPage();
  const routes = await installRoutes(harness, context);
  try {
    await routes.route("/api/mocked", async (route) => {
      assert.equal(await route.request().headerValue("x-test-request"), "yes");
      await route.fulfill({
        headers: { "x-test-source": "route" },
        json: { source: "route" },
        status: 201,
      });
    });
    await page.goto(harness.origin);
    await createWorker(page);
    await routes.waitForReady();

    assert.deepEqual(
      await fetchFromWorker(page, "/api/mocked", {
        "x-test-request": "yes",
      }),
      {
        body: { source: "route" },
        ok: true,
        source: "route",
        status: 201,
      },
    );
    await page.reload();
    assert.deepEqual(
      (
        await fetchFromWorker(page, "/api/mocked", {
          "x-test-request": "yes",
        })
      ).body,
      { source: "route" },
    );
  } finally {
    await closeTestResources([routes], [context], harness);
  }
});

test("passes unmatched SharedWorker requests through to the network", async () => {
  const harness = await createHarness();
  const context = await harness.browser.newContext();
  const page = await context.newPage();
  const routes = await installRoutes(harness, context);
  try {
    await page.goto(harness.origin);
    await createWorker(page);
    await routes.waitForReady();
    assert.deepEqual(await fetchFromWorker(page, "/api/network"), {
      body: { source: "network" },
      ok: true,
      source: "network",
      status: 200,
    });
  } finally {
    await closeTestResources([routes], [context], harness);
  }
});

test("surfaces SharedWorker handler errors without waiting for a test timeout", async () => {
  const harness = await createHarness();
  const context = await harness.browser.newContext();
  const page = await context.newPage();
  const routes = await installRoutes(harness, context);
  try {
    await routes.route("/api/mocked", () => {
      throw new Error("intentional handler failure");
    });
    await page.goto(harness.origin);
    await createWorker(page);
    await routes.waitForReady();

    const result = await Promise.race([
      fetchFromWorker(page, "/api/mocked"),
      new Promise<WorkerFetchResult>((_resolve, reject) => {
        setTimeout(() => {
          reject(new Error("SharedWorker handler did not fail promptly"));
        }, 2_000);
      }),
    ]);
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /intentional handler failure/u);
    await assert.rejects(
      routes.close(),
      /SharedWorker route handler failed.*intentional handler failure/u,
    );
  } finally {
    await closeTestResources([routes], [context], harness);
  }
});

test("keeps SharedWorker route state isolated between browser contexts", async () => {
  const harness = await createHarness();
  const firstContext = await harness.browser.newContext();
  const secondContext = await harness.browser.newContext();
  const firstPage = await firstContext.newPage();
  const secondPage = await secondContext.newPage();
  const firstRoutes = await installRoutes(harness, firstContext);
  const secondRoutes = await installRoutes(harness, secondContext);
  try {
    await firstRoutes.route("/api/mocked", async (route) => {
      await route.fulfill({ json: { source: "first" } });
    });
    await secondRoutes.route("/api/mocked", async (route) => {
      await route.fulfill({ json: { source: "second" } });
    });
    await Promise.all([
      firstPage.goto(harness.origin),
      secondPage.goto(harness.origin),
    ]);
    await Promise.all([createWorker(firstPage), createWorker(secondPage)]);
    await Promise.all([
      firstRoutes.waitForReady(),
      secondRoutes.waitForReady(),
    ]);

    const [first, second] = await Promise.all([
      fetchFromWorker(firstPage, "/api/mocked"),
      fetchFromWorker(secondPage, "/api/mocked"),
    ]);
    assert.deepEqual(first.body, { source: "first" });
    assert.deepEqual(second.body, { source: "second" });
  } finally {
    await closeTestResources(
      [firstRoutes, secondRoutes],
      [firstContext, secondContext],
      harness,
    );
  }
});

test("restores native SharedWorker fetch during deterministic cleanup", async () => {
  const harness = await createHarness();
  const context = await harness.browser.newContext();
  const page = await context.newPage();
  const routes = await installRoutes(harness, context);
  try {
    await routes.route("/api/mocked", async (route) => {
      await route.fulfill({ json: { source: "route" } });
    });
    await page.goto(harness.origin);
    await createWorker(page);
    await routes.waitForReady();
    assert.deepEqual((await fetchFromWorker(page, "/api/mocked")).body, {
      source: "route",
    });

    await routes.close();
    assert.deepEqual(await fetchFromWorker(page, "/api/mocked"), {
      body: { source: "network" },
      ok: true,
      source: "network",
      status: 200,
    });
  } finally {
    await closeTestResources([routes], [context], harness);
  }
});

test("closes cleanly after the runtime SharedWorker has stopped", async () => {
  const harness = await createHarness();
  const context = await harness.browser.newContext();
  const page = await context.newPage();
  const routes = await installRoutes(harness, context);
  try {
    await page.goto(harness.origin);
    await createWorker(page);
    await routes.waitForReady();
    await terminateWorker(page);
    await routes.close();
  } finally {
    await closeTestResources([routes], [context], harness);
  }
});

test("fails readiness quickly when the runtime worker is not intercepted", async () => {
  const harness = await createHarness();
  const context = await harness.browser.newContext();
  const page = await context.newPage();
  const routes = await SharedWorkerRoutes.install({
    apiOrigin: harness.origin,
    bridgeOrigin: harness.origin,
    context,
    workerScript: "**/different-worker.js",
  });
  try {
    await page.goto(harness.origin);
    await createWorker(page);
    await assert.rejects(
      routes.waitForReady(100),
      /SharedWorker route bridge was not ready within 100ms/u,
    );
  } finally {
    await closeTestResources([routes], [context], harness);
  }
});

async function installRoutes(
  harness: Harness,
  context: BrowserContext,
): Promise<SharedWorkerRoutes> {
  return await SharedWorkerRoutes.install({
    apiOrigin: harness.origin,
    bridgeOrigin: harness.origin,
    context,
    workerScript,
  });
}

async function createHarness(): Promise<Harness> {
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://fixture").pathname;
    if (pathname === "/shared-worker.js") {
      response.writeHead(200, { "content-type": "text/javascript" });
      response.end(`
        addEventListener("connect", ({ ports: [port] }) => {
          port.addEventListener("message", async (event) => {
            if (event.data.terminate === true) {
              port.postMessage({ terminated: true });
              self.close();
              return;
            }
            try {
              const response = await fetch(event.data.path, {
                headers: event.data.headers,
              });
              port.postMessage({
                body: await response.json(),
                ok: true,
                source: response.headers.get("x-test-source"),
                status: response.status,
              });
            } catch (error) {
              port.postMessage({
                error: error instanceof Error ? error.message : String(error),
                ok: false,
              });
            }
          });
          port.start();
        });
      `);
      return;
    }
    if (pathname.startsWith("/api/")) {
      response.writeHead(200, {
        "content-type": "application/json",
        "x-test-source": "network",
      });
      response.end(JSON.stringify({ source: "network" }));
      return;
    }
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<!doctype html><title>SharedWorker route fixture</title>");
  });
  await listen(server);
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("SharedWorker fixture server has no TCP address");
  }
  return {
    browser: await chromium.launch(),
    origin: `http://127.0.0.1:${address.port}`,
    server,
  };
}

async function createWorker(page: Page): Promise<void> {
  await page.evaluate(() => {
    const worker = new SharedWorker("/shared-worker.js", {
      name: "production-topology-fixture",
    });
    worker.port.start();
  });
}

async function fetchFromWorker(
  page: Page,
  path: string,
  headers: Readonly<Record<string, string>> = {},
): Promise<WorkerFetchResult> {
  const value: unknown = await page.evaluate(
    async ({ requestHeaders, requestPath }) => {
      const worker = new SharedWorker("/shared-worker.js", {
        name: "production-topology-fixture",
      });
      worker.port.start();
      return await new Promise<unknown>((resolve, reject) => {
        worker.addEventListener("error", (event) => {
          reject(new Error(event.message));
        });
        worker.port.addEventListener(
          "message",
          (event: MessageEvent<unknown>) => {
            resolve(event.data);
          },
          { once: true },
        );
        worker.port.postMessage({
          headers: requestHeaders,
          path: requestPath,
        });
      });
    },
    { requestHeaders: headers, requestPath: path },
  );
  if (!isWorkerFetchResult(value)) {
    throw new Error("SharedWorker returned an invalid fixture response");
  }
  return value;
}

async function terminateWorker(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const worker = new SharedWorker("/shared-worker.js", {
      name: "production-topology-fixture",
    });
    worker.port.start();
    await new Promise<void>((resolve) => {
      worker.port.addEventListener(
        "message",
        (event: MessageEvent<unknown>) => {
          const message = event.data;
          if (
            message &&
            typeof message === "object" &&
            "terminated" in message &&
            message.terminated === true
          ) {
            resolve();
          }
        },
        { once: true },
      );
      worker.port.postMessage({ terminate: true });
    });
  });
}

function isWorkerFetchResult(value: unknown): value is WorkerFetchResult {
  return (
    typeof value === "object" &&
    value !== null &&
    "ok" in value &&
    typeof value.ok === "boolean"
  );
}

async function closeHarness(harness: Harness): Promise<void> {
  await harness.browser.close();
  await new Promise<void>((resolve, reject) => {
    harness.server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
    harness.server.closeAllConnections();
  });
}

async function closeTestResources(
  routes: readonly SharedWorkerRoutes[],
  contexts: readonly BrowserContext[],
  harness: Harness,
): Promise<void> {
  const failures: unknown[] = [];
  for (const workerRoutes of routes) {
    try {
      await workerRoutes.close();
    } catch (error: unknown) {
      failures.push(error);
    }
  }
  for (const context of contexts) {
    try {
      await context.close();
    } catch (error: unknown) {
      failures.push(error);
    }
  }
  try {
    await closeHarness(harness);
  } catch (error: unknown) {
    failures.push(error);
  }
  if (failures.length === 1) {
    throw failures[0];
  }
  if (failures.length > 1) {
    throw new AggregateError(failures, "SharedWorker test cleanup failed");
  }
}

async function listen(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}
