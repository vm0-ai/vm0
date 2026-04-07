/**
 * Tests for the desktop HTTP server.
 *
 * Entry point: startDesktopServer()
 * Mock (external): screencapture module (macOS system commands)
 * Real (internal): HTTP server, token validation, routing
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { http, passthrough } from "msw";
import { server as mswServer } from "../../../mocks/server";

vi.mock("../screencapture", () => {
  return {
    captureScreenshot: vi.fn().mockResolvedValue({
      image: "dGVzdC1pbWFnZQ==",
      width: 960,
      height: 540,
      scaleFactor: 2,
      format: "jpg",
    }),
    captureRegionScreenshot: vi.fn().mockResolvedValue({
      image: "em9vbS1pbWFnZQ==",
      width: 400,
      height: 300,
      scaleFactor: 2,
      format: "jpg",
    }),
    getScreenInfo: vi.fn().mockResolvedValue({
      width: 960,
      height: 540,
      scaleFactor: 2,
    }),
  };
});

vi.mock("../cliclick", () => {
  return {
    leftClickDrag: vi.fn().mockResolvedValue(undefined),
    leftMouseDown: vi.fn().mockResolvedValue(undefined),
    leftMouseUp: vi.fn().mockResolvedValue(undefined),
    executeMouseAction: vi.fn().mockResolvedValue(undefined),
    getCursorPosition: vi.fn().mockResolvedValue({ x: 250, y: 150 }),
    VALID_ACTIONS: new Set([
      "left_click",
      "right_click",
      "middle_click",
      "double_click",
      "triple_click",
      "move",
    ]),
    pressKey: vi.fn().mockResolvedValue(undefined),
    holdKey: vi.fn().mockResolvedValue(undefined),
    typeText: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("../scroll", () => {
  return {
    scroll: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("../clipboard", () => {
  return {
    readClipboard: vi.fn().mockResolvedValue("clipboard content"),
    writeClipboard: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("../application", () => {
  return {
    openApplication: vi.fn().mockResolvedValue(undefined),
  };
});

import type { Server } from "http";
import { startDesktopServer, getRandomPort } from "../desktop-server";
import {
  captureScreenshot,
  captureRegionScreenshot,
  getScreenInfo,
} from "../screencapture";
import {
  leftClickDrag,
  leftMouseDown,
  leftMouseUp,
  executeMouseAction,
  getCursorPosition,
  pressKey,
  holdKey,
  typeText,
} from "../cliclick";
import { scroll } from "../scroll";
import { readClipboard, writeClipboard } from "../clipboard";
import { openApplication } from "../application";

const TEST_TOKEN = "test-bridge-token-abc123";

async function setup(): Promise<{ server: Server; port: number }> {
  const port = await getRandomPort();
  mswServer.use(
    http.all(`http://127.0.0.1:${port}/screenshot`, () => {
      return passthrough();
    }),
    http.all(`http://127.0.0.1:${port}/info`, () => {
      return passthrough();
    }),
    http.all(`http://127.0.0.1:${port}/mouse`, () => {
      return passthrough();
    }),
    http.all(`http://127.0.0.1:${port}/clipboard`, () => {
      return passthrough();
    }),
    http.all(`http://127.0.0.1:${port}/cursor-position`, () => {
      return passthrough();
    }),
    http.all(`http://127.0.0.1:${port}/keyboard`, () => {
      return passthrough();
    }),
    http.all(`http://127.0.0.1:${port}/open-application`, () => {
      return passthrough();
    }),
    http.all(`http://127.0.0.1:${port}/unknown`, () => {
      return passthrough();
    }),
    http.all(new RegExp(`http://127\\.0\\.0\\.1:${port}/zoom`), () => {
      return passthrough();
    }),
  );
  const server = await startDesktopServer(TEST_TOKEN, port);
  return { server, port };
}

describe("desktop-server", () => {
  let testServer: Server | undefined;

  afterEach(() => {
    testServer?.close();
    testServer = undefined;
  });

  describe("getRandomPort", () => {
    it("should return a valid port number", async () => {
      const p = await getRandomPort();
      expect(p).toBeGreaterThan(0);
      expect(p).toBeLessThan(65536);
    });
  });

  describe("startDesktopServer", () => {
    it("should return 403 when no token is provided", async () => {
      const { server, port } = await setup();
      testServer = server;

      const res = await fetch(`http://127.0.0.1:${port}/screenshot`);
      expect(res.status).toBe(403);
    });

    it("should return 403 when wrong token is provided", async () => {
      const { server, port } = await setup();
      testServer = server;

      const res = await fetch(`http://127.0.0.1:${port}/screenshot`, {
        headers: { "x-vm0-token": "wrong-token" },
      });
      expect(res.status).toBe(403);
    });

    it("should return 404 for unknown routes", async () => {
      const { server, port } = await setup();
      testServer = server;

      const res = await fetch(`http://127.0.0.1:${port}/unknown`, {
        headers: { "x-vm0-token": TEST_TOKEN },
      });
      expect(res.status).toBe(404);
    });

    it("should return screenshot data on GET /screenshot", async () => {
      const { server, port } = await setup();
      testServer = server;

      const res = await fetch(`http://127.0.0.1:${port}/screenshot`, {
        headers: { "x-vm0-token": TEST_TOKEN },
      });
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data).toEqual({
        image: "dGVzdC1pbWFnZQ==",
        width: 960,
        height: 540,
        scaleFactor: 2,
        format: "jpg",
      });
      expect(captureScreenshot).toHaveBeenCalledOnce();
    });

    it("should return screen info on GET /info", async () => {
      const { server, port } = await setup();
      testServer = server;

      const res = await fetch(`http://127.0.0.1:${port}/info`, {
        headers: { "x-vm0-token": TEST_TOKEN },
      });
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data).toEqual({
        width: 960,
        height: 540,
        scaleFactor: 2,
      });
      expect(getScreenInfo).toHaveBeenCalledOnce();
    });

    it("should return 500 when screenshot capture fails", async () => {
      vi.mocked(captureScreenshot).mockRejectedValueOnce(
        new Error("screencapture failed"),
      );

      const { server, port } = await setup();
      testServer = server;

      const res = await fetch(`http://127.0.0.1:${port}/screenshot`, {
        headers: { "x-vm0-token": TEST_TOKEN },
      });
      expect(res.status).toBe(500);
      const text = await res.text();
      expect(text).toBe("screencapture failed");
    });

    it("should return zoom data on GET /zoom with valid params", async () => {
      const { server, port } = await setup();
      testServer = server;

      const res = await fetch(
        `http://127.0.0.1:${port}/zoom?x=100&y=200&width=400&height=300`,
        { headers: { "x-vm0-token": TEST_TOKEN } },
      );
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data).toEqual({
        image: "em9vbS1pbWFnZQ==",
        width: 400,
        height: 300,
        scaleFactor: 2,
        format: "jpg",
      });
      expect(captureRegionScreenshot).toHaveBeenCalledWith({
        x: 100,
        y: 200,
        width: 400,
        height: 300,
      });
    });

    it("should return 400 when zoom params are missing", async () => {
      const { server, port } = await setup();
      testServer = server;

      const res = await fetch(`http://127.0.0.1:${port}/zoom`, {
        headers: { "x-vm0-token": TEST_TOKEN },
      });
      expect(res.status).toBe(400);
    });

    it("should return 400 when zoom width is negative", async () => {
      const { server, port } = await setup();
      testServer = server;

      const res = await fetch(
        `http://127.0.0.1:${port}/zoom?x=0&y=0&width=-10&height=100`,
        { headers: { "x-vm0-token": TEST_TOKEN } },
      );
      expect(res.status).toBe(400);
      const text = await res.text();
      expect(text).toContain("must be positive");
    });

    it("should return 400 when zoom region exceeds screen bounds", async () => {
      const { server, port } = await setup();
      testServer = server;

      const res = await fetch(
        `http://127.0.0.1:${port}/zoom?x=1800&y=0&width=200&height=100`,
        { headers: { "x-vm0-token": TEST_TOKEN } },
      );
      expect(res.status).toBe(400);
      const text = await res.text();
      expect(text).toContain("exceeds screen bounds");
    });

    it("should return 500 when zoom capture fails", async () => {
      vi.mocked(captureRegionScreenshot).mockRejectedValueOnce(
        new Error("region capture failed"),
      );

      const { server, port } = await setup();
      testServer = server;

      const res = await fetch(
        `http://127.0.0.1:${port}/zoom?x=0&y=0&width=100&height=100`,
        { headers: { "x-vm0-token": TEST_TOKEN } },
      );
      expect(res.status).toBe(500);
      const text = await res.text();
      expect(text).toBe("region capture failed");
    });

    it("should execute left_click on POST /mouse with valid body", async () => {
      const { server, port } = await setup();
      testServer = server;

      const res = await fetch(`http://127.0.0.1:${port}/mouse`, {
        method: "POST",
        headers: {
          "x-vm0-token": TEST_TOKEN,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ action: "left_click", x: 500, y: 300 }),
      });
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data).toEqual({ ok: true });
      expect(executeMouseAction).toHaveBeenCalledWith("left_click", 500, 300);
    });

    it("should return 400 for invalid action on POST /mouse", async () => {
      const { server, port } = await setup();
      testServer = server;

      const res = await fetch(`http://127.0.0.1:${port}/mouse`, {
        method: "POST",
        headers: {
          "x-vm0-token": TEST_TOKEN,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ action: "invalid_action", x: 100, y: 100 }),
      });
      expect(res.status).toBe(400);
      const text = await res.text();
      expect(text).toContain("Unknown mouse action");
    });

    it("should return 400 for out-of-bounds coordinates on POST /mouse", async () => {
      const { server, port } = await setup();
      testServer = server;

      // Screen returns logical dimensions 960x540 directly
      const res = await fetch(`http://127.0.0.1:${port}/mouse`, {
        method: "POST",
        headers: {
          "x-vm0-token": TEST_TOKEN,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ action: "left_click", x: 1000, y: 300 }),
      });
      expect(res.status).toBe(400);
      const text = await res.text();
      expect(text).toContain("out of bounds");
    });

    it("should return 400 for missing fields on POST /mouse", async () => {
      const { server, port } = await setup();
      testServer = server;

      const res = await fetch(`http://127.0.0.1:${port}/mouse`, {
        method: "POST",
        headers: {
          "x-vm0-token": TEST_TOKEN,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ action: "left_click" }),
      });
      expect(res.status).toBe(400);
      const text = await res.text();
      expect(text).toContain("Missing required fields");
    });

    it("should return 400 for non-numeric coordinates on POST /mouse", async () => {
      const { server, port } = await setup();
      testServer = server;

      const res = await fetch(`http://127.0.0.1:${port}/mouse`, {
        method: "POST",
        headers: {
          "x-vm0-token": TEST_TOKEN,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ action: "left_click", x: "abc", y: 100 }),
      });
      expect(res.status).toBe(400);
      const text = await res.text();
      expect(text).toContain("finite numbers");
    });

    it("should return 500 when cliclick fails on POST /mouse", async () => {
      vi.mocked(executeMouseAction).mockRejectedValueOnce(
        new Error("cliclick not found. Install with: brew install cliclick"),
      );

      const { server, port } = await setup();
      testServer = server;

      const res = await fetch(`http://127.0.0.1:${port}/mouse`, {
        method: "POST",
        headers: {
          "x-vm0-token": TEST_TOKEN,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ action: "left_click", x: 100, y: 100 }),
      });
      expect(res.status).toBe(500);
      const text = await res.text();
      expect(text).toContain("cliclick not found");
    });

    it("should return 404 for GET /mouse", async () => {
      const { server, port } = await setup();
      testServer = server;

      const res = await fetch(`http://127.0.0.1:${port}/mouse`, {
        headers: { "x-vm0-token": TEST_TOKEN },
      });
      expect(res.status).toBe(404);
    });

    it("should execute left_click_drag on POST /mouse", async () => {
      const { server, port } = await setup();
      testServer = server;

      const res = await fetch(`http://127.0.0.1:${port}/mouse`, {
        method: "POST",
        headers: {
          "x-vm0-token": TEST_TOKEN,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          action: "left_click_drag",
          startX: 100,
          startY: 200,
          endX: 500,
          endY: 600,
        }),
      });
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data).toEqual({ ok: true });
      expect(leftClickDrag).toHaveBeenCalledWith(100, 200, 500, 600);
    });

    it("should execute left_mouse_down on POST /mouse", async () => {
      const { server, port } = await setup();
      testServer = server;

      const res = await fetch(`http://127.0.0.1:${port}/mouse`, {
        method: "POST",
        headers: {
          "x-vm0-token": TEST_TOKEN,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          action: "left_mouse_down",
          x: 300,
          y: 400,
        }),
      });
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data).toEqual({ ok: true });
      expect(leftMouseDown).toHaveBeenCalledWith(300, 400);
    });

    it("should execute left_mouse_up on POST /mouse", async () => {
      const { server, port } = await setup();
      testServer = server;

      const res = await fetch(`http://127.0.0.1:${port}/mouse`, {
        method: "POST",
        headers: {
          "x-vm0-token": TEST_TOKEN,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          action: "left_mouse_up",
          x: 500,
          y: 600,
        }),
      });
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data).toEqual({ ok: true });
      expect(leftMouseUp).toHaveBeenCalledWith(500, 600);
    });

    it("should execute scroll on POST /mouse", async () => {
      const { server, port } = await setup();
      testServer = server;

      const res = await fetch(`http://127.0.0.1:${port}/mouse`, {
        method: "POST",
        headers: {
          "x-vm0-token": TEST_TOKEN,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          action: "scroll",
          x: 500,
          y: 300,
          direction: "down",
          amount: 5,
        }),
      });
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data).toEqual({ ok: true });
      expect(scroll).toHaveBeenCalledWith(500, 300, "down", 5);
    });

    it("should execute scroll with default amount when omitted", async () => {
      const { server, port } = await setup();
      testServer = server;

      const res = await fetch(`http://127.0.0.1:${port}/mouse`, {
        method: "POST",
        headers: {
          "x-vm0-token": TEST_TOKEN,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          action: "scroll",
          x: 200,
          y: 100,
          direction: "up",
        }),
      });
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data).toEqual({ ok: true });
      expect(scroll).toHaveBeenCalledWith(200, 100, "up", undefined);
    });

    it("should return 500 when mouse action fails", async () => {
      vi.mocked(leftClickDrag).mockRejectedValueOnce(
        new Error("cliclick not found"),
      );

      const { server, port } = await setup();
      testServer = server;

      const res = await fetch(`http://127.0.0.1:${port}/mouse`, {
        method: "POST",
        headers: {
          "x-vm0-token": TEST_TOKEN,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          action: "left_click_drag",
          startX: 0,
          startY: 0,
          endX: 100,
          endY: 100,
        }),
      });
      expect(res.status).toBe(500);
      const text = await res.text();
      expect(text).toBe("cliclick not found");
    });

    it("should return 500 when scroll fails", async () => {
      vi.mocked(scroll).mockRejectedValueOnce(new Error("osascript failed"));

      const { server, port } = await setup();
      testServer = server;

      const res = await fetch(`http://127.0.0.1:${port}/mouse`, {
        method: "POST",
        headers: {
          "x-vm0-token": TEST_TOKEN,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          action: "scroll",
          x: 0,
          y: 0,
          direction: "down",
          amount: 3,
        }),
      });
      expect(res.status).toBe(500);
      const text = await res.text();
      expect(text).toBe("osascript failed");
    });

    it("should return clipboard text on GET /clipboard", async () => {
      const { server, port } = await setup();
      testServer = server;

      const res = await fetch(`http://127.0.0.1:${port}/clipboard`, {
        headers: { "x-vm0-token": TEST_TOKEN },
      });
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data).toEqual({ text: "clipboard content" });
      expect(readClipboard).toHaveBeenCalledOnce();
    });

    it("should write clipboard text on POST /clipboard", async () => {
      const { server, port } = await setup();
      testServer = server;

      const res = await fetch(`http://127.0.0.1:${port}/clipboard`, {
        method: "POST",
        headers: {
          "x-vm0-token": TEST_TOKEN,
          "content-type": "application/json",
        },
        body: JSON.stringify({ text: "hello world" }),
      });
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data).toEqual({ ok: true });
      expect(writeClipboard).toHaveBeenCalledWith("hello world");
    });

    it("should return 500 when clipboard read fails", async () => {
      vi.mocked(readClipboard).mockRejectedValueOnce(
        new Error("pbpaste failed"),
      );

      const { server, port } = await setup();
      testServer = server;

      const res = await fetch(`http://127.0.0.1:${port}/clipboard`, {
        headers: { "x-vm0-token": TEST_TOKEN },
      });
      expect(res.status).toBe(500);
      const text = await res.text();
      expect(text).toBe("pbpaste failed");
    });

    it("should return 500 when clipboard write fails", async () => {
      vi.mocked(writeClipboard).mockRejectedValueOnce(
        new Error("pbcopy failed"),
      );

      const { server, port } = await setup();
      testServer = server;

      const res = await fetch(`http://127.0.0.1:${port}/clipboard`, {
        method: "POST",
        headers: {
          "x-vm0-token": TEST_TOKEN,
          "content-type": "application/json",
        },
        body: JSON.stringify({ text: "fail" }),
      });
      expect(res.status).toBe(500);
      const text = await res.text();
      expect(text).toBe("pbcopy failed");
    });

    it("should execute move on POST /mouse with action move", async () => {
      const { server, port } = await setup();
      testServer = server;

      const res = await fetch(`http://127.0.0.1:${port}/mouse`, {
        method: "POST",
        headers: {
          "x-vm0-token": TEST_TOKEN,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ action: "move", x: 100, y: 200 }),
      });
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data).toEqual({ ok: true });
      expect(executeMouseAction).toHaveBeenCalledWith("move", 100, 200);
    });

    it("should return cursor position on GET /cursor-position", async () => {
      const { server, port } = await setup();
      testServer = server;

      const res = await fetch(`http://127.0.0.1:${port}/cursor-position`, {
        headers: { "x-vm0-token": TEST_TOKEN },
      });
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data).toEqual({ x: 250, y: 150 });
      expect(getCursorPosition).toHaveBeenCalledOnce();
    });

    it("should return 500 when getCursorPosition fails", async () => {
      vi.mocked(getCursorPosition).mockRejectedValueOnce(
        new Error("cliclick not found. Install with: brew install cliclick"),
      );

      const { server, port } = await setup();
      testServer = server;

      const res = await fetch(`http://127.0.0.1:${port}/cursor-position`, {
        headers: { "x-vm0-token": TEST_TOKEN },
      });
      expect(res.status).toBe(500);
      const text = await res.text();
      expect(text).toContain("cliclick not found");
    });

    it("should execute key press on POST /keyboard with action key", async () => {
      const { server, port } = await setup();
      testServer = server;

      const res = await fetch(`http://127.0.0.1:${port}/keyboard`, {
        method: "POST",
        headers: {
          "x-vm0-token": TEST_TOKEN,
          "content-type": "application/json",
        },
        body: JSON.stringify({ action: "key", keys: "cmd+c" }),
      });
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data).toEqual({ ok: true });
      expect(pressKey).toHaveBeenCalledWith("cmd+c");
    });

    it("should execute hold key on POST /keyboard with action hold_key", async () => {
      const { server, port } = await setup();
      testServer = server;

      const res = await fetch(`http://127.0.0.1:${port}/keyboard`, {
        method: "POST",
        headers: {
          "x-vm0-token": TEST_TOKEN,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          action: "hold_key",
          keys: "shift",
          durationMs: 1000,
        }),
      });
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data).toEqual({ ok: true });
      expect(holdKey).toHaveBeenCalledWith("shift", 1000);
    });

    it("should return 400 for invalid durationMs on hold_key", async () => {
      const { server, port } = await setup();
      testServer = server;

      const res = await fetch(`http://127.0.0.1:${port}/keyboard`, {
        method: "POST",
        headers: {
          "x-vm0-token": TEST_TOKEN,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          action: "hold_key",
          keys: "shift",
          durationMs: -100,
        }),
      });
      expect(res.status).toBe(400);
      const text = await res.text();
      expect(text).toContain("durationMs must be a positive number");
    });

    it("should type text on POST /keyboard with action type", async () => {
      const { server, port } = await setup();
      testServer = server;

      const res = await fetch(`http://127.0.0.1:${port}/keyboard`, {
        method: "POST",
        headers: {
          "x-vm0-token": TEST_TOKEN,
          "content-type": "application/json",
        },
        body: JSON.stringify({ action: "type", text: "Hello, world!" }),
      });
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data).toEqual({ ok: true });
      expect(typeText).toHaveBeenCalledWith("Hello, world!");
    });

    it("should return 400 for empty text on POST /keyboard type", async () => {
      const { server, port } = await setup();
      testServer = server;

      const res = await fetch(`http://127.0.0.1:${port}/keyboard`, {
        method: "POST",
        headers: {
          "x-vm0-token": TEST_TOKEN,
          "content-type": "application/json",
        },
        body: JSON.stringify({ action: "type", text: "" }),
      });
      expect(res.status).toBe(400);
      const text = await res.text();
      expect(text).toContain("non-empty string");
    });

    it("should return 400 for unknown keyboard action", async () => {
      const { server, port } = await setup();
      testServer = server;

      const res = await fetch(`http://127.0.0.1:${port}/keyboard`, {
        method: "POST",
        headers: {
          "x-vm0-token": TEST_TOKEN,
          "content-type": "application/json",
        },
        body: JSON.stringify({ action: "unknown_action" }),
      });
      expect(res.status).toBe(400);
      const text = await res.text();
      expect(text).toContain("Unknown keyboard action");
    });

    it("should return 500 when pressKey fails", async () => {
      vi.mocked(pressKey).mockRejectedValueOnce(
        new Error('Unknown key: "badkey"'),
      );

      const { server, port } = await setup();
      testServer = server;

      const res = await fetch(`http://127.0.0.1:${port}/keyboard`, {
        method: "POST",
        headers: {
          "x-vm0-token": TEST_TOKEN,
          "content-type": "application/json",
        },
        body: JSON.stringify({ action: "key", keys: "badkey" }),
      });
      expect(res.status).toBe(500);
      const text = await res.text();
      expect(text).toContain("Unknown key");
    });

    it("should return 500 when typeText fails", async () => {
      vi.mocked(typeText).mockRejectedValueOnce(
        new Error("cliclick not found"),
      );

      const { server, port } = await setup();
      testServer = server;

      const res = await fetch(`http://127.0.0.1:${port}/keyboard`, {
        method: "POST",
        headers: {
          "x-vm0-token": TEST_TOKEN,
          "content-type": "application/json",
        },
        body: JSON.stringify({ action: "type", text: "test" }),
      });
      expect(res.status).toBe(500);
      const text = await res.text();
      expect(text).toBe("cliclick not found");
    });

    it("should open application on POST /open-application", async () => {
      const { server, port } = await setup();
      testServer = server;

      const res = await fetch(`http://127.0.0.1:${port}/open-application`, {
        method: "POST",
        headers: {
          "x-vm0-token": TEST_TOKEN,
          "content-type": "application/json",
        },
        body: JSON.stringify({ nameOrBundleId: "Safari" }),
      });
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data).toEqual({ ok: true });
      expect(openApplication).toHaveBeenCalledWith("Safari");
    });

    it("should return 400 for empty nameOrBundleId on POST /open-application", async () => {
      const { server, port } = await setup();
      testServer = server;

      const res = await fetch(`http://127.0.0.1:${port}/open-application`, {
        method: "POST",
        headers: {
          "x-vm0-token": TEST_TOKEN,
          "content-type": "application/json",
        },
        body: JSON.stringify({ nameOrBundleId: "" }),
      });
      expect(res.status).toBe(400);
      const text = await res.text();
      expect(text).toContain("non-empty string");
    });

    it("should return 500 when openApplication fails", async () => {
      vi.mocked(openApplication).mockRejectedValueOnce(
        new Error("The application could not be found"),
      );

      const { server, port } = await setup();
      testServer = server;

      const res = await fetch(`http://127.0.0.1:${port}/open-application`, {
        method: "POST",
        headers: {
          "x-vm0-token": TEST_TOKEN,
          "content-type": "application/json",
        },
        body: JSON.stringify({ nameOrBundleId: "NonExistentApp" }),
      });
      expect(res.status).toBe(500);
      const text = await res.text();
      expect(text).toBe("The application could not be found");
    });
  });
});
