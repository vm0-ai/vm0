import { describe, expect, it, vi } from "vitest";
import { parsePermissionActionUrl } from "../permission-action-block.ts";

const PERMISSION_PATH =
  "/agents/b431c9a7-4f78-4977-aba1-dec4c04b212c/permissions?ref=slack&permission=chat%3Awrite&action=allow";

describe("parsePermissionActionUrl", () => {
  it.each([
    `\u0000https://evil.example${PERMISSION_PATH}`,
    `https:\n//evil.example${PERMISSION_PATH}`,
    ` \t//evil.example${PERMISSION_PATH}`,
  ])("rejects parser-normalized external permission URLs: %s", (url) => {
    vi.stubEnv("VITE_API_URL", "https://app.vm0.ai");

    expect(parsePermissionActionUrl(url)).toBeNull();
  });
});
