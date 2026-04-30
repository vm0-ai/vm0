import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { corsMiddleware } from "../cors";
import { mockEnv, clearMockedEnv } from "../env";

function createTestApp(): Hono {
  const app = new Hono();
  app.use("*", corsMiddleware);
  app.get("/test", (c) => {
    return c.text("ok");
  });
  return app;
}

describe("corsMiddleware", () => {
  afterEach(() => {
    clearMockedEnv();
  });

  async function originForRequest(origin: string | null): Promise<string | null> {
    const app = createTestApp();
    const headers: Record<string, string> = {};
    if (origin !== null) {
      headers.Origin = origin;
    }
    const res = await app.request("/test", { headers });
    return res.headers.get("Access-Control-Allow-Origin");
  }

  it("allows https://www.vm0.ai", async () => {
    expect(await originForRequest("https://www.vm0.ai")).toBe("https://www.vm0.ai");
  });

  it("allows https://vm0.ai", async () => {
    expect(await originForRequest("https://vm0.ai")).toBe("https://vm0.ai");
  });

  it("rejects unknown external origins in production", async () => {
    mockEnv("ENV", "production");
    expect(await originForRequest("https://evil.com")).toBeNull();
  });

  it("allows .vm0.ai subdomains in production", async () => {
    mockEnv("ENV", "production");
    expect(await originForRequest("https://app.vm0.ai")).toBe("https://app.vm0.ai");
  });

  it("allows http://localhost in development", async () => {
    expect(await originForRequest("http://localhost:3000")).toBe("http://localhost:3000");
  });

  it("rejects http://localhost in production", async () => {
    mockEnv("ENV", "production");
    expect(await originForRequest("http://localhost:3000")).toBeNull();
  });

  it("allows .vm6.ai subdomains in preview", async () => {
    mockEnv("ENV", "preview");
    expect(await originForRequest("https://my-preview.vm6.ai")).toBe("https://my-preview.vm6.ai");
  });

  it("rejects .vm6.ai subdomains in production", async () => {
    mockEnv("ENV", "production");
    expect(await originForRequest("https://my-preview.vm6.ai")).toBeNull();
  });

  it("rejects http origins for non-localhost in development", async () => {
    expect(await originForRequest("http://insecure.vm0.ai")).toBeNull();
  });

  it("allows .vm7.ai subdomains in development", async () => {
    expect(await originForRequest("https://dev-branch.vm7.ai")).toBe("https://dev-branch.vm7.ai");
  });

  it("returns null when no Origin header is present", async () => {
    expect(await originForRequest(null)).toBeNull();
  });

  it("returns null for an unparseable Origin header", async () => {
    expect(await originForRequest("not-a-valid-url")).toBeNull();
  });

  it("sets credentials and allowed methods on preflight", async () => {
    const app = createTestApp();
    const res = await app.request("/test", {
      method: "OPTIONS",
      headers: {
        Origin: "https://www.vm0.ai",
        "Access-Control-Request-Method": "POST",
      },
    });

    expect(res.headers.get("Access-Control-Allow-Credentials")).toBe("true");
    const methods = res.headers.get("Access-Control-Allow-Methods");
    expect(methods).toContain("GET");
    expect(methods).toContain("POST");
    expect(methods).toContain("DELETE");
  });
});
