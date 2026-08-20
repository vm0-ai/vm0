import type { IncomingMessage, ServerResponse } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";

const httpsGet = vi.hoisted(() => {
  return vi.fn();
});

vi.mock("node:https", () => {
  return { get: httpsGet };
});

import { handleDevArtifactFetchProxyRequest } from "../../dev-artifact-fetch-proxy.ts";

function proxyRequest(target: string): IncomingMessage {
  return {
    method: "GET",
    url: `?url=${encodeURIComponent(target)}`,
  } as IncomingMessage;
}

function proxyResponse(): {
  readonly response: ServerResponse;
  readonly end: ReturnType<typeof vi.fn>;
} {
  const end = vi.fn();
  return {
    response: {
      end,
      statusCode: 200,
    } as unknown as ServerResponse,
    end,
  };
}

/**
 * The Vite-only proxy has no rendered page boundary. Exercise its production
 * request handler so the SSRF allowlist is covered where requests enter it.
 */
describe("development artifact fetch proxy", () => {
  beforeEach(() => {
    httpsGet.mockReturnValue({ on: vi.fn() });
  });

  it.each([
    "https://cdn.okou.io/artifacts/user_1/artifact_1/report.html",
    "https://static.okou.io/web/assets/presentation.html",
    "https://demo.okou.app/",
  ])("forwards the exact Okou target %s", (target) => {
    const { response } = proxyResponse();

    handleDevArtifactFetchProxyRequest(proxyRequest(target), response);

    expect(httpsGet).toHaveBeenCalledWith(
      new URL(target),
      expect.any(Function),
    );
  });

  it("rejects an Okou lookalike before opening an upstream request", () => {
    const target = "https://static.okou.io.attacker.example/payload.html";
    const { response, end } = proxyResponse();

    handleDevArtifactFetchProxyRequest(proxyRequest(target), response);

    expect(response.statusCode).toBe(403);
    expect(end).toHaveBeenCalledWith("Forbidden");
    expect(httpsGet).not.toHaveBeenCalled();
  });
});
