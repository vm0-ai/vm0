import { describe, it, expect } from "vitest";
import vercelConfig from "../../vercel.json";

interface HeaderPair {
  key: string;
  value: string;
}

interface VercelHeaderEntry {
  source: string;
  headers: HeaderPair[];
}

const entries =
  (vercelConfig as { headers?: VercelHeaderEntry[] }).headers ?? [];

function findHeaderEntry(source: string): VercelHeaderEntry | undefined {
  return entries.find((e) => {
    return e.source === source;
  });
}

function findHeader(headers: HeaderPair[], name: string): string | undefined {
  return headers.find((h) => {
    return h.key === name;
  })?.value;
}

describe("app vercel.json headers", () => {
  it("should set immutable cache headers for hashed assets", () => {
    const assetEntry = findHeaderEntry("/assets/(.*)");

    expect(assetEntry).toBeDefined();
    expect(findHeader(assetEntry!.headers, "Cache-Control")).toBe(
      "max-age=31536000, immutable",
    );
  });

  it("should include security headers for all routes", () => {
    const catchAll = findHeaderEntry("/(.*)");

    expect(catchAll).toBeDefined();
    expect(findHeader(catchAll!.headers, "X-Frame-Options")).toBe("DENY");
    expect(findHeader(catchAll!.headers, "X-Content-Type-Options")).toBe(
      "nosniff",
    );
    expect(findHeader(catchAll!.headers, "Referrer-Policy")).toBe(
      "strict-origin-when-cross-origin",
    );
    expect(findHeader(catchAll!.headers, "Strict-Transport-Security")).toBe(
      "max-age=31536000; includeSubDomains",
    );
  });

  it("should place asset cache rule before catch-all so it takes priority", () => {
    const assetIndex = entries.findIndex((e) => {
      return e.source === "/assets/(.*)";
    });
    const catchAllIndex = entries.findIndex((e) => {
      return e.source === "/(.*)";
    });

    expect(assetIndex).toBeGreaterThanOrEqual(0);
    expect(catchAllIndex).toBeGreaterThanOrEqual(0);
    expect(assetIndex).toBeLessThan(catchAllIndex);
  });
});
