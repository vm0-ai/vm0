import { describe, it, expect, vi, beforeEach } from "vitest";
import { POST, GET } from "../route";
import { NextRequest } from "next/server";
import * as getUserIdModule from "../../../../src/lib/auth/get-user-id";
import * as initServicesModule from "../../../../src/lib/init-services";

// Mock dependencies
vi.mock("../../../../src/lib/auth/get-user-id");
vi.mock("../../../../src/lib/init-services");
vi.mock("../../../../src/lib/s3/s3-client", () => ({
  uploadS3Directory: vi.fn().mockResolvedValue({
    s3Prefix: "test-user/test-volume",
    filesUploaded: 10,
    totalBytes: 1000,
  }),
  deleteS3Directory: vi.fn().mockResolvedValue(undefined),
  downloadS3Directory: vi.fn().mockResolvedValue({
    localPath: "/tmp/test",
    filesDownloaded: 10,
    totalBytes: 1000,
  }),
}));

// Mock AdmZip
vi.mock("adm-zip", () => {
  return {
    default: vi.fn().mockImplementation((buffer?: Buffer) => {
      if (buffer) {
        // Mock for GET (reading zip)
        return {
          getEntries: vi.fn().mockReturnValue([
            {
              entryName: "file1.txt",
              isDirectory: false,
              getData: vi.fn().mockReturnValue(Buffer.from("content1")),
            },
            {
              entryName: "file2.txt",
              isDirectory: false,
              getData: vi.fn().mockReturnValue(Buffer.from("content2")),
            },
          ]),
        };
      } else {
        // Mock for POST (creating zip)
        return {
          extractAllTo: vi.fn(),
          addLocalFolder: vi.fn(),
          writeZip: vi.fn(),
        };
      }
    }),
  };
});

// Mock database
const mockDb = {
  select: vi.fn().mockReturnThis(),
  from: vi.fn().mockReturnThis(),
  where: vi.fn().mockReturnThis(),
  limit: vi.fn().mockResolvedValue([]),
  insert: vi.fn().mockReturnThis(),
  values: vi.fn().mockReturnThis(),
  update: vi.fn().mockReturnThis(),
  set: vi.fn().mockReturnThis(),
};

beforeEach(() => {
  vi.clearAllMocks();

  // Setup global services mock
  globalThis.services = {
    db: mockDb as never,
    env: {} as never,
    pool: {} as never,
  };

  vi.mocked(initServicesModule.initServices).mockImplementation(() => {});
});

describe("POST /api/volumes", () => {
  it("should return 401 when not authenticated", async () => {
    vi.mocked(getUserIdModule.getUserId).mockResolvedValue(null);

    const formData = new FormData();
    formData.append("volumeName", "test-volume");
    formData.append("file", new Blob(["test"]), "test.zip");

    const request = new NextRequest("http://localhost/api/volumes", {
      method: "POST",
      body: formData,
    });

    const response = await POST(request);

    expect(response.status).toBe(401);
    const json = await response.json();
    expect(json.error).toBe("Not authenticated");
  });

  // Note: Additional POST tests are skipped due to complex file system mocking requirements
  // The core validation logic is tested through unit tests of isValidVolumeName function
});

describe("GET /api/volumes", () => {
  it("should return 401 when not authenticated", async () => {
    vi.mocked(getUserIdModule.getUserId).mockResolvedValue(null);

    const request = new NextRequest(
      "http://localhost/api/volumes?name=test-volume",
      {
        method: "GET",
      },
    );

    const response = await GET(request);

    expect(response.status).toBe(401);
    const json = await response.json();
    expect(json.error).toBe("Not authenticated");
  });

  it("should return 400 when name parameter is missing", async () => {
    vi.mocked(getUserIdModule.getUserId).mockResolvedValue("test-user");

    const request = new NextRequest("http://localhost/api/volumes", {
      method: "GET",
    });

    const response = await GET(request);

    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json.error).toBe("Missing name parameter");
  });

  it("should return 404 when volume does not exist", async () => {
    vi.mocked(getUserIdModule.getUserId).mockResolvedValue("test-user");

    // Mock volume not found
    mockDb.limit.mockResolvedValueOnce([]);

    const request = new NextRequest(
      "http://localhost/api/volumes?name=nonexistent",
      {
        method: "GET",
      },
    );

    const response = await GET(request);

    expect(response.status).toBe(404);
    const json = await response.json();
    expect(json.error).toContain("not found");
  });
});
