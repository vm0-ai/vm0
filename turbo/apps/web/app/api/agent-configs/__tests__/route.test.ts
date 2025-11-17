import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "./route";

// Mock modules
vi.mock("../../../lib/init-services", () => ({
  initServices: vi.fn(),
}));

vi.mock("../../../lib/middleware/auth", () => ({
  authenticate: vi.fn(),
}));

import { authenticate } from "../../../lib/middleware/auth";

// Mock globalThis.services
const mockDb = {
  insert: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(globalThis, "services", {
    value: { db: mockDb },
    configurable: true,
  });
});

describe("POST /api/agent-configs", () => {
  it("should return 401 when authentication fails", async () => {
    const request = new NextRequest("http://localhost/api/agent-configs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ config: {} }),
    });

    vi.mocked(authenticate).mockRejectedValue(
      new Error("Missing API key")
    );

    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(500);
    expect(data.error).toBeDefined();
  });

  it("should return 400 when config is missing", async () => {
    const request = new NextRequest("http://localhost/api/agent-configs", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "test-key" },
      body: JSON.stringify({}),
    });

    vi.mocked(authenticate).mockResolvedValue("api-key-id");

    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error.message).toBe("Missing config");
    expect(data.error.code).toBe("BAD_REQUEST");
  });

  it("should return 400 when config.version is missing", async () => {
    const request = new NextRequest("http://localhost/api/agent-configs", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "test-key" },
      body: JSON.stringify({ config: {} }),
    });

    vi.mocked(authenticate).mockResolvedValue("api-key-id");

    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error.message).toBe("Missing config.version");
  });

  it("should return 400 when config.agent is missing", async () => {
    const request = new NextRequest("http://localhost/api/agent-configs", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "test-key" },
      body: JSON.stringify({ config: { version: "1.0" } }),
    });

    vi.mocked(authenticate).mockResolvedValue("api-key-id");

    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error.message).toBe("Missing config.agent");
  });

  it("should return 201 when config is created successfully", async () => {
    const validConfig = {
      version: "1.0",
      agent: {
        description: "Test agent",
        image: "vm0-claude-code:test",
        provider: "claude-code",
        working_dir: "/home/user/workspace",
        volumes: ["test-volume:/home/user/workspace"],
      },
      volumes: {
        "test-volume": {
          driver: "s3fs",
          driver_opts: {
            uri: "s3://test-bucket/path",
            region: "us-west-2",
          },
        },
      },
    };

    const request = new NextRequest("http://localhost/api/agent-configs", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "test-key" },
      body: JSON.stringify({ config: validConfig }),
    });

    const mockResult = {
      id: "cfg-test-123",
      createdAt: new Date("2025-11-17T10:00:00.000Z"),
    };

    vi.mocked(authenticate).mockResolvedValue("api-key-id");
    mockDb.insert.mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([mockResult]),
      }),
    });

    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(201);
    expect(data.agentConfigId).toBe("cfg-test-123");
    expect(data.createdAt).toBe("2025-11-17T10:00:00.000Z");
  });
});
