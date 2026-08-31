import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { test } from "node:test";

import { chromium, type JSHandle, type Page } from "@playwright/test";

import { SharedWorkerRoutes } from "./shared-worker-routes";

interface WorkerFetchResult {
  readonly mocked: Readonly<Record<string, unknown>>;
  readonly passthrough: Readonly<Record<string, unknown>>;
}

interface WorkerFixture {
  readonly origin: string;
  readonly requestCount: (pathname: string) => number;
}

test("routes requests from a real SharedWorker and cleans up", async (context) => {
  await withWorkerFixture(async (fixture) => {
    await context.test(
      "fulfills worker fetches and passes through others",
      async () => {
        const browser = await chromium.launch();
        try {
          const browserContext = await browser.newContext();
          const page = await browserContext.newPage();
          const routes = await SharedWorkerRoutes.create(
            browser,
            page,
            fixture.origin,
          );
          let routesClosed = false;
          try {
            let pageRouteObserved = false;
            await browserContext.route("**/api/mocked", async (route) => {
              pageRouteObserved = true;
              await route.fulfill({ json: { source: "page-route" } });
            });
            const registration = routes.route(
              (url) => url.pathname === "/api/mocked",
              async (route) => {
                assert.equal(route.request().method(), "GET");
                assert.equal(
                  await route.request().headerValue("x-worker-route-test"),
                  "present",
                );
                await route.fulfill({ json: { source: "worker-route" } });
              },
            );

            await page.goto(fixture.origin);
            const port = await connectSharedWorker(page, "success");
            const result = fetchFromSharedWorker(port);
            await routes.waitForWorker();
            await registration.handled;

            assert.deepEqual(await result, {
              mocked: { source: "worker-route" },
              passthrough: { source: "network-passthrough" },
            });
            assert.equal(pageRouteObserved, false);
            assert.equal(fixture.requestCount("/api/mocked"), 0);
            assert.equal(fixture.requestCount("/api/passthrough"), 1);

            const isolatedContext = await browser.newContext();
            try {
              const isolatedPage = await isolatedContext.newPage();
              await isolatedPage.goto(fixture.origin);
              const isolatedPort = await connectSharedWorker(
                isolatedPage,
                "isolated-context",
              );
              const isolatedResult = await fetchFromSharedWorker(isolatedPort);
              assert.deepEqual(isolatedResult.mocked, {
                source: "network-mocked",
              });
              assert.equal(fixture.requestCount("/api/mocked"), 1);
            } finally {
              await isolatedContext.close();
            }

            let handlerCalled = false;
            routes.route(
              (url) => url.pathname === "/api/mocked",
              async () => {
                handlerCalled = true;
                throw new Error("worker route handler failed");
              },
            );
            await assert.rejects(
              fetchFromSharedWorker(port),
              /Failed to fetch/u,
            );
            assert.equal(handlerCalled, true);
            routesClosed = true;
            await assert.rejects(
              routes.close(),
              /worker route handler failed/u,
            );
          } finally {
            if (!routesClosed) {
              await routes.close();
            }
            await browserContext.close();
          }

          const cleanContext = await browser.newContext();
          try {
            const page = await cleanContext.newPage();
            await page.goto(fixture.origin);
            const port = await connectSharedWorker(page, "after-cleanup");
            const result = await fetchFromSharedWorker(port);
            assert.deepEqual(result.mocked, { source: "network-mocked" });
            assert.equal(fixture.requestCount("/api/mocked"), 2);
          } finally {
            await cleanContext.close();
          }
        } finally {
          await browser.close();
        }
      },
    );
  });
});

async function connectSharedWorker(
  page: Page,
  name: string,
): Promise<JSHandle<MessagePort>> {
  return await page.evaluateHandle<MessagePort, string>((workerName) => {
    return new Promise<MessagePort>((resolve) => {
      const worker = new SharedWorker("/worker.js", { name: workerName });
      worker.port.addEventListener(
        "message",
        () => {
          resolve(worker.port);
        },
        { once: true },
      );
      worker.port.start();
    });
  }, name);
}

async function fetchFromSharedWorker(
  port: JSHandle<MessagePort>,
): Promise<WorkerFetchResult> {
  return await port.evaluate<WorkerFetchResult>((workerPort) => {
    return new Promise<WorkerFetchResult>((resolve, reject) => {
      workerPort.addEventListener(
        "message",
        (
          event: MessageEvent<WorkerFetchResult | { readonly error: string }>,
        ) => {
          if ("error" in event.data) {
            reject(new Error(event.data.error));
          } else {
            resolve(event.data);
          }
        },
        { once: true },
      );
      workerPort.postMessage("fetch");
    });
  });
}

async function withWorkerFixture<Result>(
  use: (fixture: WorkerFixture) => Promise<Result>,
): Promise<Result> {
  const requestCounts = new Map<string, number>();
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://fixture").pathname;
    requestCounts.set(pathname, (requestCounts.get(pathname) ?? 0) + 1);
    if (pathname === "/") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<!doctype html><title>SharedWorker route fixture</title>");
      return;
    }
    if (pathname === "/worker.js") {
      response.writeHead(200, { "content-type": "text/javascript" });
      response.end(`
        onconnect = ({ ports: [port] }) => {
          port.postMessage({ ready: true });
          port.onmessage = () => {
            Promise.all([
              fetch("/api/mocked", {
                headers: { "x-worker-route-test": "present" },
              }).then((response) => response.json()),
              fetch("/api/passthrough").then((response) => response.json()),
            ])
              .then(([mocked, passthrough]) => {
                port.postMessage({ mocked, passthrough });
              })
              .catch((error) => {
                port.postMessage({ error: String(error.message ?? error) });
              });
          };
        };
      `);
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        source:
          pathname === "/api/mocked" ? "network-mocked" : "network-passthrough",
      }),
    );
  });
  await listen(server);
  const address = server.address();
  if (!address || typeof address === "string") {
    await close(server);
    throw new Error("SharedWorker fixture server has no TCP address");
  }
  try {
    return await use({
      origin: `http://127.0.0.1:${address.port}`,
      requestCount: (pathname: string): number =>
        requestCounts.get(pathname) ?? 0,
    });
  } finally {
    await close(server);
  }
}

async function listen(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
    server.closeAllConnections();
  });
}
