import {
  createServer,
  type Server,
  type IncomingMessage,
  type ServerResponse,
} from "http";
import { createServer as createNetServer } from "net";
import type { AddressInfo } from "net";
import {
  captureScreenshot,
  captureRegionScreenshot,
  getScreenInfo,
} from "./screencapture";
import {
  leftClickDrag,
  leftMouseDown,
  leftMouseUp,
  executeMouseAction,
  getCursorPosition,
  VALID_ACTIONS,
  pressKey,
  holdKey,
  typeText,
} from "./cliclick";
import type { MouseAction } from "./cliclick";
import { scroll, type ScrollDirection } from "./scroll";
import { readClipboard, writeClipboard } from "./clipboard";
import { openApplication } from "./application";

/**
 * Read the full request body as a string.
 */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    req.on("end", () => {
      resolve(Buffer.concat(chunks).toString());
    });
    req.on("error", reject);
  });
}

interface MouseDragBody {
  action: "left_click_drag";
  startX: number;
  startY: number;
  endX: number;
  endY: number;
}

interface MouseDownBody {
  action: "left_mouse_down";
  x: number;
  y: number;
}

interface MouseUpBody {
  action: "left_mouse_up";
  x: number;
  y: number;
}

interface MouseScrollBody {
  action: "scroll";
  x: number;
  y: number;
  direction: ScrollDirection;
  amount?: number;
}

type MouseRequestBody =
  | MouseDragBody
  | MouseDownBody
  | MouseUpBody
  | MouseScrollBody;

async function handleZoom(
  searchParams: URLSearchParams,
  res: ServerResponse,
): Promise<void> {
  const x = Number(searchParams.get("x"));
  const y = Number(searchParams.get("y"));
  const width = Number(searchParams.get("width"));
  const height = Number(searchParams.get("height"));

  if (
    [x, y, width, height].some((v) => {
      return !Number.isFinite(v);
    })
  ) {
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end(
      "Missing or invalid query parameters: x, y, width, height are required numbers",
    );
    return;
  }
  if (width <= 0 || height <= 0) {
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end("width and height must be positive");
    return;
  }
  if (x < 0 || y < 0) {
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end("x and y must be non-negative");
    return;
  }

  const info = await getScreenInfo();
  if (x + width > info.width || y + height > info.height) {
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end(`Region exceeds screen bounds (${info.width}x${info.height})`);
    return;
  }

  const result = await captureRegionScreenshot({ x, y, width, height });
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(result));
}

function parseJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 1024) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString()));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

async function handleMouseRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = await parseJsonBody(req);
  if (typeof body !== "object" || body === null || !("action" in body)) {
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end("Missing required fields: action, x, y");
    return;
  }

  const { action } = body as { action: unknown };

  if (typeof action !== "string") {
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end("Invalid action");
    return;
  }

  // Click actions with validation
  if (VALID_ACTIONS.has(action)) {
    if (!("x" in body) || !("y" in body)) {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("Missing required fields: action, x, y");
      return;
    }

    const { x, y } = body as { x: unknown; y: unknown };

    if (
      typeof x !== "number" ||
      typeof y !== "number" ||
      !Number.isFinite(x) ||
      !Number.isFinite(y)
    ) {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("Coordinates x and y must be finite numbers");
      return;
    }

    const info = await getScreenInfo();
    if (x < 0 || x >= info.width || y < 0 || y >= info.height) {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end(
        `Coordinates out of bounds. Screen size: ${info.width}x${info.height} (points)`,
      );
      return;
    }

    await executeMouseAction(action as MouseAction, x, y);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // Drag, mouse-down, mouse-up, scroll actions
  const typedBody = body as MouseRequestBody;
  switch (typedBody.action) {
    case "left_click_drag":
      await leftClickDrag(
        typedBody.startX,
        typedBody.startY,
        typedBody.endX,
        typedBody.endY,
      );
      break;
    case "left_mouse_down":
      await leftMouseDown(typedBody.x, typedBody.y);
      break;
    case "left_mouse_up":
      await leftMouseUp(typedBody.x, typedBody.y);
      break;
    case "scroll":
      await scroll(
        typedBody.x,
        typedBody.y,
        typedBody.direction,
        typedBody.amount,
      );
      break;
    default:
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end(
        `Unknown mouse action: ${(body as unknown as Record<string, unknown>).action}`,
      );
      return;
  }

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true }));
}

interface KeyPressBody {
  action: "key";
  keys: string;
}

interface HoldKeyBody {
  action: "hold_key";
  keys: string;
  durationMs: number;
}

interface TypeTextBody {
  action: "type";
  text: string;
}

type KeyboardRequestBody = KeyPressBody | HoldKeyBody | TypeTextBody;

async function handleKeyboard(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const raw = await readBody(req);
  const body = JSON.parse(raw) as KeyboardRequestBody;

  switch (body.action) {
    case "key":
      await pressKey(body.keys);
      break;
    case "hold_key":
      if (
        typeof body.durationMs !== "number" ||
        !Number.isFinite(body.durationMs) ||
        body.durationMs <= 0
      ) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("durationMs must be a positive number");
        return;
      }
      await holdKey(body.keys, body.durationMs);
      break;
    case "type":
      if (typeof body.text !== "string" || body.text.length === 0) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("text must be a non-empty string");
        return;
      }
      await typeText(body.text);
      break;
    default:
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end(
        `Unknown keyboard action: ${(body as Record<string, unknown>).action}`,
      );
      return;
  }

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true }));
}

async function handleClipboard(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (req.method === "GET") {
    const text = await readClipboard();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ text }));
  } else if (req.method === "POST") {
    const raw = await readBody(req);
    const body = JSON.parse(raw) as { text: string };
    await writeClipboard(body.text);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  } else {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  }
}

async function handleOpenApplication(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const raw = await readBody(req);
  const body = JSON.parse(raw) as { nameOrBundleId: unknown };

  if (
    typeof body.nameOrBundleId !== "string" ||
    body.nameOrBundleId.length === 0
  ) {
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end("nameOrBundleId must be a non-empty string");
    return;
  }

  await openApplication(body.nameOrBundleId);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true }));
}

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

async function handleCursorPosition(res: ServerResponse): Promise<void> {
  const position = await getCursorPosition();
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(position));
}

function routeKey(method: string, pathname: string): string {
  return `${method} ${pathname}`;
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

  const url = new URL(req.url ?? "/", "http://localhost");
  const { pathname, searchParams } = url;
  const key = routeKey(req.method ?? "GET", pathname);

  try {
    switch (key) {
      case "GET /screenshot": {
        const result = await captureScreenshot();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
        break;
      }
      case "GET /info": {
        const info = await getScreenInfo();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(info));
        break;
      }
      case "GET /zoom":
        await handleZoom(searchParams, res);
        break;
      case "POST /mouse":
        await handleMouseRequest(req, res);
        break;
      case "GET /clipboard":
      case "POST /clipboard":
        await handleClipboard(req, res);
        break;
      case "POST /keyboard":
        await handleKeyboard(req, res);
        break;
      case "POST /open-application":
        await handleOpenApplication(req, res);
        break;
      case "GET /cursor-position":
        await handleCursorPosition(res);
        break;
      default:
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
