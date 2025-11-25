import { describe, it, expect, vi, beforeEach } from "vitest";
import { POST, GET } from "../route";
import { NextRequest } from "next/server";
import * as getUserIdModule from "../../../../src/lib/auth/get-user-id";
import * as initServicesModule from "../../../../src/lib/init-services";

// Mock node:fs
vi.mock("node:fs", () => ({
  promises: {
    mkdir: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn().mockResolvedValue(Buffer.from("test")),
    readdir: vi.fn().mockResolvedValue([
      { name: "file1.txt", isDirectory: () => false },
      { name: "file2.txt", isDirectory: () => false },
    ]),
    stat: vi.fn().mockResolvedValue({ size: 100 }),
    rm: vi.fn().mockResolvedValue(undefined),
  },
  existsSync: vi.fn().mockReturnValue(true),
}));

// Mock node:os
vi.mock("node:os", () => ({
  tmpdir: vi.fn().mockReturnValue("/tmp"),
}));

// Mock node:path
vi.mock("node:path", async () => {
  const actual = await vi.importActual<typeof import("node:path")>("node:path");
  return {
    ...actual,
    join: vi.fn((...args: string[]) => args.join("/")),
    dirname: vi.fn((p: string) => p.split("/").slice(0, -1).join("/")),
    basename: vi.fn((p: string) => p.split("/").pop() || ""),
    relative: vi.fn((from: string, to: string) => to),
  };
});

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
vi.mock("adm-zip", () => ({
  default: vi.fn().mockImplementation(() => ({
    extractAllTo: vi.fn(),
    addLocalFolder: vi.fn(),
    writeZip: vi.fn(),
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
  })),
}));

// Mock transaction executor that forwards calls to mockTx
const mockTx = {
  select: vi.fn().mockReturnThis(),
  from: vi.fn().mockReturnThis(),
  where: vi.fn().mockReturnThis(),
  limit: vi.fn().mockResolvedValue([]),
  insert: vi.fn().mockReturnThis(),
  values: vi.fn().mockReturnThis(),
  returning: vi.fn().mockResolvedValue([]),
  update: vi.fn().mockReturnThis(),
  set: vi.fn().mockReturnThis(),
};

// Mock database with transaction support
const mockDb = {
  select: vi.fn().mockReturnThis(),
  from: vi.fn().mockReturnThis(),
  where: vi.fn().mockReturnThis(),
  limit: vi.fn().mockResolvedValue([]),
  insert: vi.fn().mockReturnThis(),
  values: vi.fn().mockReturnThis(),
  returning: vi.fn().mockResolvedValue([]),
  update: vi.fn().mockReturnThis(),
  set: vi.fn().mockReturnThis(),
  transaction: vi.fn().mockImplementation(async (callback) => {
    return callback(mockTx);
  }),
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

  it("should return 400 when volumeName is missing", async () => {
    vi.mocked(getUserIdModule.getUserId).mockResolvedValue("test-user");

    const formData = new FormData();
    const file = new File(["test"], "test.zip", { type: "application/zip" });
    formData.append("file", file);

    // Mock formData method to return immediately
    const mockFormData = async () => formData;

    const request = new NextRequest("http://localhost/api/volumes", {
      method: "POST",
    });
    request.formData = mockFormData as never;

    const response = await POST(request);

    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json.error).toBe("Missing volumeName or file");
  }, 10000);

  it("should return 400 when file is missing", async () => {
    vi.mocked(getUserIdModule.getUserId).mockResolvedValue("test-user");

    const formData = new FormData();
    formData.append("volumeName", "test-volume");

    const request = new NextRequest("http://localhost/api/volumes", {
      method: "POST",
      body: formData,
    });

    const response = await POST(request);

    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json.error).toBe("Missing volumeName or file");
  });

  it("should return 400 for invalid volume name", async () => {
    vi.mocked(getUserIdModule.getUserId).mockResolvedValue("test-user");

    const formData = new FormData();
    formData.append("volumeName", "INVALID-NAME"); // uppercase
    const file = new File(["test"], "test.zip", { type: "application/zip" });
    formData.append("file", file);

    // Mock formData method to return immediately
    const mockFormData = async () => formData;

    const request = new NextRequest("http://localhost/api/volumes", {
      method: "POST",
    });
    request.formData = mockFormData as never;

    const response = await POST(request);

    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json.error).toContain("Invalid volume name");
  }, 10000);

  it("should successfully upload a valid volume", async () => {
    vi.mocked(getUserIdModule.getUserId).mockResolvedValue("test-user");

    // Mock database: no existing volume (outside transaction check)
    mockDb.limit.mockResolvedValueOnce([]); // No existing volume

    // Mock transaction operations: create volume and version
    mockTx.returning
      .mockResolvedValueOnce([
        { id: "volume-id-123", name: "test-volume", userId: "test-user" },
      ]) // Volume creation
      .mockResolvedValueOnce([
        {
          id: "version-id-456",
          volumeId: "volume-id-123",
          s3Key: "test-user/test-volume/version-id-456",
        },
      ]); // Version creation

    const formData = new FormData();
    formData.append("volumeName", "test-volume");
    const file = new File(["test zip content"], "test.zip", {
      type: "application/zip",
    });
    formData.append("file", file);

    // Mock file.arrayBuffer() since it's called in the route
    file.arrayBuffer = vi.fn().mockResolvedValue(new ArrayBuffer(16)) as never;

    // Mock formData method to return immediately
    const mockFormData = async () => formData;

    const request = new NextRequest("http://localhost/api/volumes", {
      method: "POST",
    });
    request.formData = mockFormData as never;

    const response = await POST(request);

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.volumeName).toBe("test-volume");
    expect(json.versionId).toBe("version-id-456");
    expect(json.fileCount).toBeGreaterThanOrEqual(0);
    expect(json.size).toBeGreaterThanOrEqual(0);

    // Verify transaction was used
    expect(mockDb.transaction).toHaveBeenCalled();
  }, 10000);

  it("should rollback transaction when S3 upload fails", async () => {
    vi.mocked(getUserIdModule.getUserId).mockResolvedValue("test-user");

    // Mock database: no existing volume (outside transaction check)
    mockDb.limit.mockResolvedValueOnce([]); // No existing volume

    // Mock transaction operations: create volume and version
    mockTx.returning
      .mockResolvedValueOnce([
        { id: "volume-id-123", name: "test-volume", userId: "test-user" },
      ]) // Volume creation
      .mockResolvedValueOnce([
        {
          id: "version-id-456",
          volumeId: "volume-id-123",
          s3Key: "test-user/test-volume/version-id-456",
        },
      ]); // Version creation

    // Mock S3 upload to fail - this should trigger transaction rollback
    const s3ClientModule = await import("../../../../src/lib/s3/s3-client");
    vi.mocked(s3ClientModule.uploadS3Directory).mockRejectedValueOnce(
      new Error("S3 upload failed: network error"),
    );

    const formData = new FormData();
    formData.append("volumeName", "test-volume");
    const file = new File(["test zip content"], "test.zip", {
      type: "application/zip",
    });
    formData.append("file", file);

    file.arrayBuffer = vi.fn().mockResolvedValue(new ArrayBuffer(16)) as never;

    const mockFormData = async () => formData;

    const request = new NextRequest("http://localhost/api/volumes", {
      method: "POST",
    });
    request.formData = mockFormData as never;

    const response = await POST(request);

    // Should return 500 error
    expect(response.status).toBe(500);
    const json = await response.json();
    expect(json.error).toContain("S3 upload failed");

    // Verify transaction was called (and would have rolled back due to error)
    expect(mockDb.transaction).toHaveBeenCalled();
  }, 10000);

  it("should use existing volume when uploading new version", async () => {
    vi.mocked(getUserIdModule.getUserId).mockResolvedValue("test-user");

    // Mock database: existing volume found
    mockDb.limit.mockResolvedValueOnce([
      { id: "existing-volume-id", name: "test-volume", userId: "test-user" },
    ]);

    // Mock transaction operations: only version creation (volume already exists)
    mockTx.returning.mockResolvedValueOnce([
      {
        id: "new-version-id",
        volumeId: "existing-volume-id",
        s3Key: "test-user/test-volume/new-version-id",
      },
    ]);

    const formData = new FormData();
    formData.append("volumeName", "test-volume");
    const file = new File(["test zip content"], "test.zip", {
      type: "application/zip",
    });
    formData.append("file", file);

    file.arrayBuffer = vi.fn().mockResolvedValue(new ArrayBuffer(16)) as never;

    const mockFormData = async () => formData;

    const request = new NextRequest("http://localhost/api/volumes", {
      method: "POST",
    });
    request.formData = mockFormData as never;

    const response = await POST(request);

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.volumeName).toBe("test-volume");
    expect(json.versionId).toBe("new-version-id");

    // Verify transaction was used
    expect(mockDb.transaction).toHaveBeenCalled();

    // Verify volume insert was NOT called (since volume already exists)
    // The first returning call should be for version, not volume
    expect(mockTx.returning).toHaveBeenCalledTimes(1);
  }, 10000);
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

  it("should return 404 when volume has no HEAD version", async () => {
    vi.mocked(getUserIdModule.getUserId).mockResolvedValue("test-user");

    // Mock volume exists but has no HEAD version
    mockDb.limit.mockResolvedValueOnce([
      {
        id: "volume-id-123",
        name: "test-volume",
        userId: "test-user",
        headVersionId: null,
      },
    ]);

    const request = new NextRequest(
      "http://localhost/api/volumes?name=test-volume",
      {
        method: "GET",
      },
    );

    const response = await GET(request);

    expect(response.status).toBe(404);
    const json = await response.json();
    expect(json.error).toContain("has no versions");
  });

  it("should download HEAD version successfully", async () => {
    vi.mocked(getUserIdModule.getUserId).mockResolvedValue("test-user");

    // Mock volume with HEAD version
    mockDb.limit
      .mockResolvedValueOnce([
        {
          id: "volume-id-123",
          name: "test-volume",
          userId: "test-user",
          headVersionId: "version-id-456",
        },
      ])
      .mockResolvedValueOnce([
        {
          id: "version-id-456",
          volumeId: "volume-id-123",
          s3Key: "test-user/test-volume/version-id-456",
          fileCount: 5,
        },
      ]);

    const request = new NextRequest(
      "http://localhost/api/volumes?name=test-volume",
      {
        method: "GET",
      },
    );

    const response = await GET(request);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/zip");
    expect(response.headers.get("content-disposition")).toContain(
      "test-volume.zip",
    );
  });
});
