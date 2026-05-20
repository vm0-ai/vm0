import { describe, expect, it } from "vitest";
import { buildFileUrl, storageUserIdFromFileUrlSegment } from "./file-url";

describe("file URL user ID segments", () => {
  it("keeps the storage user ID in generated CDN URLs", () => {
    expect(buildFileUrl("user_alice", "file-id", "report.pdf")).toBe(
      "https://cdn.vm7.io/artifacts/user_alice/file-id/report.pdf",
    );
  });

  it("leaves non-Clerk user IDs unchanged in generated CDN URLs", () => {
    expect(buildFileUrl("user-1", "file-id", "report.pdf")).toBe(
      "https://cdn.vm7.io/artifacts/user-1/file-id/report.pdf",
    );
  });

  it("maps public URL segments back to storage user IDs", () => {
    expect(storageUserIdFromFileUrlSegment("alice")).toBe("user_alice");
    expect(storageUserIdFromFileUrlSegment("user_alice")).toBe("user_alice");
    expect(storageUserIdFromFileUrlSegment("user-1")).toBe("user-1");
  });
});
