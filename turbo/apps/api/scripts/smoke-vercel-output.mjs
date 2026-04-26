import { createServer } from "node:http";
import { resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const functionPath = resolve(".vercel/output/functions/__hono.func/index.js");
const { default: handler } = await import(pathToFileURL(functionPath).href);

if (typeof handler !== "function") {
  throw new TypeError(`Expected ${functionPath} to export a default handler`);
}

const server = createServer((request, response) => {
  Promise.resolve(handler(request, response)).catch((error) => {
    response.destroy(error instanceof Error ? error : new Error(String(error)));
  });
});

await new Promise((resolveListen) => {
  server.listen(0, "127.0.0.1", resolveListen);
});

const address = server.address();
if (address === null || typeof address === "string") {
  throw new Error("Expected smoke server to listen on a TCP port");
}

try {
  const response = await globalThis.fetch(
    `http://127.0.0.1:${address.port}/health`,
    {
      signal: globalThis.AbortSignal.timeout(20_000),
    },
  );
  const body = await response.json();

  if (!response.ok || body.status !== "ok") {
    throw new Error(
      `Expected /health to return 200 with status ok, got ${response.status} ${JSON.stringify(body)}`,
    );
  }

  process.stdout.write(`API Vercel output smoke passed: ${response.status}\n`);
} finally {
  await new Promise((resolveClose, rejectClose) => {
    server.close((error) => {
      if (error) {
        rejectClose(error);
        return;
      }
      resolveClose();
    });
  });
}
