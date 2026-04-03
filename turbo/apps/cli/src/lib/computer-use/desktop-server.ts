import {
  createServer,
  type Server,
  type IncomingMessage,
  type ServerResponse,
} from "http";
import { createServer as createNetServer } from "net";
import type { AddressInfo } from "net";
import { captureScreenshot, getScreenInfo } from "./screencapture";

/**
 * Allocate a random available port on localhost.
 */
export async function getRandomPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => {
        resolve(port);
      });
    });
    server.on("error", reject);
  });
}

async function handleRequest(
  token: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (req.headers["x-vm0-token"] !== token) {
    res.writeHead(403, { "Content-Type": "text/plain" });
    res.end("Forbidden");
    return;
  }

  try {
    if (req.method === "GET" && req.url === "/screenshot") {
      const result = await captureScreenshot();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } else if (req.method === "GET" && req.url === "/info") {
      const info = await getScreenInfo();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(info));
    } else {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
    }
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Internal server error";
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end(message);
  }
}

/**
 * Start the desktop HTTP server.
 * Validates x-vm0-token on every request and serves /screenshot and /info endpoints.
 */
export function startDesktopServer(
  token: string,
  port: number,
): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      handleRequest(token, req, res).catch(() => {
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "text/plain" });
          res.end("Internal server error");
        }
      });
    });

    server.on("error", reject);
    server.listen(port, "127.0.0.1", () => {
      resolve(server);
    });
  });
}
