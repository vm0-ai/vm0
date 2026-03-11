import { describe, it, expect } from "vitest";

// Import the nextConfig to test headers() function
// next.config.js exports the Sentry-wrapped config, so we need to extract headers from the raw config
// We test the headers function by dynamically importing and extracting the config

async function getSecurityHeaders(): Promise<
  Array<{ key: string; value: string }>
> {
  // Dynamic import to get the module fresh
  const configModule = await import("../next.config.js");
  const config = configModule.default;

  // The exported config is wrapped by Sentry, but headers() is preserved
  // Next.js config headers() returns an array of { source, headers } objects
  if (!config.headers) {
    throw new Error("headers() function not found in Next.js config");
  }
  const headerEntries = await config.headers();
  const catchAllEntry = headerEntries.find(
    (entry: { source: string }) => entry.source === "/(.*)",
  );
  return catchAllEntry?.headers ?? [];
}

function findHeader(
  headers: Array<{ key: string; value: string }>,
  name: string,
): string | undefined {
  return headers.find((h) => h.key === name)?.value;
}

describe("Security Response Headers", () => {
  it("should include all 5 ASVS-required security headers", async () => {
    const headers = await getSecurityHeaders();
    const headerNames = headers.map((h) => h.key);

    expect(headerNames).toContain("X-Frame-Options");
    expect(headerNames).toContain("X-Content-Type-Options");
    expect(headerNames).toContain("Referrer-Policy");
    expect(headerNames).toContain("Strict-Transport-Security");
    expect(headerNames).toContain("Content-Security-Policy");
  });

  it("should set X-Frame-Options to DENY", async () => {
    const headers = await getSecurityHeaders();
    expect(findHeader(headers, "X-Frame-Options")).toBe("DENY");
  });

  it("should set X-Content-Type-Options to nosniff", async () => {
    const headers = await getSecurityHeaders();
    expect(findHeader(headers, "X-Content-Type-Options")).toBe("nosniff");
  });

  it("should set Referrer-Policy to strict-origin-when-cross-origin", async () => {
    const headers = await getSecurityHeaders();
    expect(findHeader(headers, "Referrer-Policy")).toBe(
      "strict-origin-when-cross-origin",
    );
  });

  it("should set HSTS with max-age of 1 year and includeSubDomains", async () => {
    const headers = await getSecurityHeaders();
    const hsts = findHeader(headers, "Strict-Transport-Security");
    expect(hsts).toBe("max-age=31536000; includeSubDomains");
  });

  describe("Content-Security-Policy", () => {
    it("should use permissive script-src with unsafe-inline for phase 1", async () => {
      const headers = await getSecurityHeaders();
      const csp = findHeader(headers, "Content-Security-Policy");

      expect(csp).toContain("script-src");
      expect(csp).toContain("'unsafe-inline'");
    });

    it("should allow inline styles via style-src", async () => {
      const headers = await getSecurityHeaders();
      const csp = findHeader(headers, "Content-Security-Policy");

      expect(csp).toContain("style-src");
      expect(csp).toContain("'unsafe-inline'");
    });

    it("should not allow unsafe-eval", async () => {
      const headers = await getSecurityHeaders();
      const csp = findHeader(headers, "Content-Security-Policy");

      expect(csp).not.toContain("unsafe-eval");
    });

    it("should deny frame-ancestors", async () => {
      const headers = await getSecurityHeaders();
      const csp = findHeader(headers, "Content-Security-Policy");

      expect(csp).toContain("frame-ancestors 'none'");
    });

    it("should use permissive default-src for phase 1", async () => {
      const headers = await getSecurityHeaders();
      const csp = findHeader(headers, "Content-Security-Policy");

      expect(csp).toContain("default-src *");
    });
  });
});
