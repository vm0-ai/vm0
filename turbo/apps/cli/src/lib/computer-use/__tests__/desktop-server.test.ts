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

import type { Server } from "http";
import { startDesktopServer, getRandomPort } from "../desktop-server";
import { captureScreenshot, getScreenInfo } from "../screencapture";

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
  });
});
