import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "./route";

// Mock modules
vi.mock("../../../../lib/init-services", () => ({
  initServices: vi.fn(),
}));

vi.mock("../../../../lib/middleware/auth", () => ({
  authenticate: vi.fn(),
}));

import { authenticate } from "../../../../lib/middleware/auth";

// Mock globalThis.services
const mockDb = {
  select: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(globalThis, "services", {
    value: { db: mockDb },
    configurable: true,
  });
});

describe("GET /api/agent-configs/:id", () => {
  it("should return 401 when authentication fails", async () => {
    const request = new NextRequest(
      "http://localhost/api/agent-configs/cfg-123"
    );

    vi.mocked(authenticate).mockRejectedValue(
      new Error("Missing API key")
    );

    const response = await GET(request, {
      params: Promise.resolve({ id: "cfg-123" }),
    });
    const data = await response.json();

    expect(response.status).toBe(500);
    expect(data.error).toBeDefined();
  });

  it("should return 404 when config is not found", async () => {
    const request = new NextRequest(
      "http://localhost/api/agent-configs/non-existent",
      {
        headers: { "x-api-key": "test-key" },
      }
    );

    vi.mocked(authenticate).mockResolvedValue("api-key-id");
    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([]),
        }),
      }),
    });

    const response = await GET(request, {
      params: Promise.resolve({ id: "non-existent" }),
    });
    const data = await response.json();

    expect(response.status).toBe(404);
    expect(data.error.message).toBe("Agent config not found");
    expect(data.error.code).toBe("NOT_FOUND");
  });

  it("should return 200 with config when found", async () => {
    const mockConfig = {
      id: "cfg-test-123",
      apiKeyId: "api-key-id",
      config: {
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
      },
      createdAt: new Date("2025-11-17T10:00:00.000Z"),
      updatedAt: new Date("2025-11-17T10:00:00.000Z"),
    };

    const request = new NextRequest(
      "http://localhost/api/agent-configs/cfg-test-123",
      {
        headers: { "x-api-key": "test-key" },
      }
    );

    vi.mocked(authenticate).mockResolvedValue("api-key-id");
    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([mockConfig]),
        }),
      }),
    });

    const response = await GET(request, {
      params: Promise.resolve({ id: "cfg-test-123" }),
    });
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.id).toBe("cfg-test-123");
    expect(data.config).toEqual(mockConfig.config);
    expect(data.createdAt).toBe("2025-11-17T10:00:00.000Z");
    expect(data.updatedAt).toBe("2025-11-17T10:00:00.000Z");
  });
});
