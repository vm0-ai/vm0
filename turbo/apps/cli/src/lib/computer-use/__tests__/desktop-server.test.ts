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
      width: 1920,
      height: 1080,
      scaleFactor: 2,
      format: "jpg",
    }),
    getScreenInfo: vi.fn().mockResolvedValue({
      width: 1920,
      height: 1080,
      scaleFactor: 2,
    }),
  };
});

vi.mock("../cliclick", () => {
  return {
    leftClickDrag: vi.fn().mockResolvedValue(undefined),
    leftMouseDown: vi.fn().mockResolvedValue(undefined),
    leftMouseUp: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("../scroll", () => {
  return {
    scroll: vi.fn().mockResolvedValue(undefined),
  };
});

import type { Server } from "http";
import { startDesktopServer, getRandomPort } from "../desktop-server";
import { captureScreenshot, getScreenInfo } from "../screencapture";
import { leftClickDrag, leftMouseDown, leftMouseUp } from "../cliclick";
import { scroll } from "../scroll";

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
    http.all(`http://127.0.0.1:${port}/unknown`, () => {
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
        width: 1920,
        height: 1080,
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
        width: 1920,
        height: 1080,
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

    it("should return 400 for unknown mouse action", async () => {
      const { server, port } = await setup();
      testServer = server;

      const res = await fetch(`http://127.0.0.1:${port}/mouse`, {
        method: "POST",
        headers: {
          "x-vm0-token": TEST_TOKEN,
          "content-type": "application/json",
        },
        body: JSON.stringify({ action: "unknown_action" }),
      });
      expect(res.status).toBe(400);
      const text = await res.text();
      expect(text).toBe("Unknown mouse action: unknown_action");
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
  });
});
