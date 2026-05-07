import { describe, expect, it } from "vitest";
import {
  buildFileUrl,
  publicFileUserIdSegment,
  storageUserIdFromFileUrlSegment,
} from "./file-url";

describe("file URL user ID segments", () => {
  it("omits the Clerk user_ prefix from generated /f URLs", () => {
    expect(buildFileUrl("user_alice", "file-id", "report.pdf")).toBe(
      "http://localhost:3000/f/alice/file-id/report.pdf",
    );
  });

  it("leaves non-Clerk user IDs unchanged in generated /f URLs", () => {
    expect(buildFileUrl("user-1", "file-id", "report.pdf")).toBe(
      "http://localhost:3000/f/user-1/file-id/report.pdf",
    );
  });

  it("maps public URL segments back to storage user IDs", () => {
    expect(publicFileUserIdSegment("user_alice")).toBe("alice");
    expect(storageUserIdFromFileUrlSegment("alice")).toBe("user_alice");
    expect(storageUserIdFromFileUrlSegment("user_alice")).toBe("user_alice");
    expect(storageUserIdFromFileUrlSegment("user-1")).toBe("user-1");
  });
});
