import { describe, it, expect, vi, beforeEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../mocks/server";
import {
  runPreflightCheck,
  reportPreflightFailure,
  CURL_ERROR_MESSAGES,
} from "../executor";

/**
 * Unit tests for preflight connectivity check functions
 */

// Mock SSH client type matching SSHClient interface
interface MockSSHClient {
  exec: ReturnType<typeof vi.fn>;
}

describe("runPreflightCheck", () => {
  let mockSsh: MockSSHClient;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSsh = {
      exec: vi.fn(),
    };
  });

  it("returns success when curl succeeds", async () => {
    mockSsh.exec.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });

    const result = await runPreflightCheck(
      mockSsh as unknown as Parameters<typeof runPreflightCheck>[0],
      "https://api.example.com",
      "run-123",
      "token-456",
    );

    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();

    // Verify curl command was called with correct URL and timeout
    expect(mockSsh.exec).toHaveBeenCalledOnce();
    const [curlCmd, timeout] = mockSsh.exec.mock.calls[0] as [string, number];
    expect(curlCmd).toContain(
      "https://api.example.com/api/webhooks/agent/heartbeat",
    );
    expect(curlCmd).toContain("Bearer token-456");
    expect(curlCmd).toContain("run-123");
    expect(curlCmd).toContain("--connect-timeout 5");
    expect(curlCmd).toContain("--max-time 10");
    expect(timeout).toBe(20000); // 20 second SSH timeout
  });

  it("returns DNS error for exit code 6", async () => {
    mockSsh.exec.mockResolvedValue({ exitCode: 6, stdout: "", stderr: "" });

    const result = await runPreflightCheck(
      mockSsh as unknown as Parameters<typeof runPreflightCheck>[0],
      "https://api.example.com",
      "run-123",
      "token-456",
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("DNS resolution failed");
    expect(result.error).toContain("VM cannot reach VM0 API");
  });

  it("returns connection refused error for exit code 7", async () => {
    mockSsh.exec.mockResolvedValue({ exitCode: 7, stdout: "", stderr: "" });

    const result = await runPreflightCheck(
      mockSsh as unknown as Parameters<typeof runPreflightCheck>[0],
      "https://api.example.com",
      "run-123",
      "token-456",
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("Connection refused");
  });

  it("returns timeout error for exit code 28", async () => {
    mockSsh.exec.mockResolvedValue({ exitCode: 28, stdout: "", stderr: "" });

    const result = await runPreflightCheck(
      mockSsh as unknown as Parameters<typeof runPreflightCheck>[0],
      "https://api.example.com",
      "run-123",
      "token-456",
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("Connection timeout");
  });

  it("returns TLS error for exit code 60", async () => {
    mockSsh.exec.mockResolvedValue({ exitCode: 60, stdout: "", stderr: "" });

    const result = await runPreflightCheck(
      mockSsh as unknown as Parameters<typeof runPreflightCheck>[0],
      "https://api.example.com",
      "run-123",
      "token-456",
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("TLS certificate error");
  });

  it("returns HTTP error for exit code 22", async () => {
    mockSsh.exec.mockResolvedValue({ exitCode: 22, stdout: "", stderr: "" });

    const result = await runPreflightCheck(
      mockSsh as unknown as Parameters<typeof runPreflightCheck>[0],
      "https://api.example.com",
      "run-123",
      "token-456",
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("HTTP error from server");
  });

  it("returns generic error for unknown exit code", async () => {
    mockSsh.exec.mockResolvedValue({ exitCode: 99, stdout: "", stderr: "" });

    const result = await runPreflightCheck(
      mockSsh as unknown as Parameters<typeof runPreflightCheck>[0],
      "https://api.example.com",
      "run-123",
      "token-456",
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("curl exit code 99");
  });

  it("includes stderr in error message when available", async () => {
    mockSsh.exec.mockResolvedValue({
      exitCode: 60,
      stdout: "",
      stderr: "SSL certificate problem: unable to get local issuer certificate",
    });

    const result = await runPreflightCheck(
      mockSsh as unknown as Parameters<typeof runPreflightCheck>[0],
      "https://api.example.com",
      "run-123",
      "token-456",
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("TLS certificate error");
    expect(result.error).toContain("unable to get local issuer certificate");
  });

  it("includes Vercel bypass header when bypassSecret is provided", async () => {
    mockSsh.exec.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });

    await runPreflightCheck(
      mockSsh as unknown as Parameters<typeof runPreflightCheck>[0],
      "https://api.example.com",
      "run-123",
      "token-456",
      "bypass-secret-789",
    );

    expect(mockSsh.exec).toHaveBeenCalledOnce();
    const [curlCmd] = mockSsh.exec.mock.calls[0] as [string, number];
    expect(curlCmd).toContain("x-vercel-protection-bypass: bypass-secret-789");
  });

  it("does not include Vercel bypass header when bypassSecret is not provided", async () => {
    mockSsh.exec.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });

    await runPreflightCheck(
      mockSsh as unknown as Parameters<typeof runPreflightCheck>[0],
      "https://api.example.com",
      "run-123",
      "token-456",
    );

    expect(mockSsh.exec).toHaveBeenCalledOnce();
    const [curlCmd] = mockSsh.exec.mock.calls[0] as [string, number];
    expect(curlCmd).not.toContain("x-vercel-protection-bypass");
  });
});

describe("reportPreflightFailure", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls complete API with correct parameters", async () => {
    let capturedRequest: Request | undefined;
    server.use(
      http.post(
        "http://localhost:3000/api/webhooks/agent/complete",
        async ({ request }) => {
          capturedRequest = request;
          return HttpResponse.json({}, { status: 200 });
        },
      ),
    );

    await reportPreflightFailure(
      "http://localhost:3000",
      "run-123",
      "token-456",
      "Test error message",
    );

    expect(capturedRequest?.url).toBe(
      "http://localhost:3000/api/webhooks/agent/complete",
    );
    expect(capturedRequest?.method).toBe("POST");
    expect(capturedRequest?.headers.get("Content-Type")).toBe(
      "application/json",
    );
    expect(capturedRequest?.headers.get("Authorization")).toBe(
      "Bearer token-456",
    );

    const body = await capturedRequest?.json();
    expect(body).toEqual({
      runId: "run-123",
      exitCode: 1,
      error: "Test error message",
    });
  });

  it("logs error when API returns non-ok response", async () => {
    server.use(
      http.post("http://localhost:3000/api/webhooks/agent/complete", () => {
        return HttpResponse.json({}, { status: 500 });
      }),
    );

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await reportPreflightFailure(
      "http://localhost:3000",
      "run-123",
      "token-456",
      "Test error",
    );

    expect(consoleSpy).toHaveBeenCalledWith(
      "[Executor] Failed to report preflight failure: HTTP 500",
    );

    consoleSpy.mockRestore();
  });

  it("logs error when fetch throws", async () => {
    server.use(
      http.post("http://localhost:3000/api/webhooks/agent/complete", () => {
        return HttpResponse.error();
      }),
    );

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await reportPreflightFailure(
      "http://localhost:3000",
      "run-123",
      "token-456",
      "Test error",
    );

    expect(consoleSpy).toHaveBeenCalledWith(
      "[Executor] Failed to report preflight failure: TypeError: Failed to fetch",
    );

    consoleSpy.mockRestore();
  });

  it("includes Vercel bypass header when bypassSecret is provided", async () => {
    let capturedRequest: Request | undefined;
    server.use(
      http.post(
        "http://localhost:3000/api/webhooks/agent/complete",
        async ({ request }) => {
          capturedRequest = request;
          return HttpResponse.json({}, { status: 200 });
        },
      ),
    );

    await reportPreflightFailure(
      "http://localhost:3000",
      "run-123",
      "token-456",
      "Test error message",
      "bypass-secret-789",
    );

    expect(capturedRequest?.headers.get("Content-Type")).toBe(
      "application/json",
    );
    expect(capturedRequest?.headers.get("Authorization")).toBe(
      "Bearer token-456",
    );
    expect(capturedRequest?.headers.get("x-vercel-protection-bypass")).toBe(
      "bypass-secret-789",
    );
  });

  it("does not include Vercel bypass header when bypassSecret is not provided", async () => {
    let capturedRequest: Request | undefined;
    server.use(
      http.post(
        "http://localhost:3000/api/webhooks/agent/complete",
        async ({ request }) => {
          capturedRequest = request;
          return HttpResponse.json({}, { status: 200 });
        },
      ),
    );

    await reportPreflightFailure(
      "http://localhost:3000",
      "run-123",
      "token-456",
      "Test error message",
    );

    expect(capturedRequest?.headers.get("Content-Type")).toBe(
      "application/json",
    );
    expect(capturedRequest?.headers.get("Authorization")).toBe(
      "Bearer token-456",
    );
    expect(
      capturedRequest?.headers.get("x-vercel-protection-bypass"),
    ).toBeNull();
  });
});

describe("CURL_ERROR_MESSAGES", () => {
  it("contains expected error codes", () => {
    expect(CURL_ERROR_MESSAGES[6]).toBe("DNS resolution failed");
    expect(CURL_ERROR_MESSAGES[7]).toBe("Connection refused");
    expect(CURL_ERROR_MESSAGES[28]).toBe("Connection timeout");
    expect(CURL_ERROR_MESSAGES[60]).toBe(
      "TLS certificate error (proxy CA not trusted)",
    );
    expect(CURL_ERROR_MESSAGES[22]).toBe("HTTP error from server");
  });
});
