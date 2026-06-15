import { describe, expect, it } from "vitest";

import worker from "./index";

type WorkerEnv = Parameters<typeof worker.fetch>[1];
type R2Object = NonNullable<
  Awaited<ReturnType<WorkerEnv["HOSTED_SITES_BUCKET"]["get"]>>
>;

function textStream(value: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(value));
      controller.close();
    },
  });
}

function objectBody(body: string, contentType = "application/json"): R2Object {
  return {
    body: textStream(body),
    httpEtag: '"test-etag"',
    writeHttpMetadata(headers: Headers): void {
      headers.set("Content-Type", contentType);
    },
  };
}

function env(): WorkerEnv {
  const publicSlug = "demo";
  const deploymentId = "00000000-0000-4000-8000-000000000001";
  const prefix = `sites/${publicSlug}/deployments/${deploymentId}`;
  const manifestKey = `${prefix}/manifest.json`;
  const objects = new Map<string, R2Object>([
    [
      `sites/${publicSlug}/active.json`,
      objectBody(
        JSON.stringify({
          version: 1,
          publicSlug,
          siteId: "site_1",
          deploymentId,
          prefix,
          manifestKey,
          spaFallback: false,
          updatedAt: "2026-01-01T00:00:00.000Z",
        }),
      ),
    ],
    [
      manifestKey,
      objectBody(
        JSON.stringify({
          version: 1,
          deploymentId,
          siteId: "site_1",
          publicSlug,
          createdAt: "2026-01-01T00:00:00.000Z",
          spaFallback: false,
          files: {
            "/index.html": {
              path: "/index.html",
              size: 18,
              sha256: "a".repeat(64),
              contentType: "text/html; charset=utf-8",
            },
          },
        }),
      ),
    ],
    [
      `${prefix}/index.html`,
      objectBody("<!doctype html>ok", "text/html; charset=utf-8"),
    ],
  ]);

  return {
    HOST_DOMAIN: "sites.vm0.io",
    HOSTED_SITES_BUCKET: {
      get(key: string): Promise<R2Object | null> {
        return Promise.resolve(objects.get(key) ?? null);
      },
    },
  };
}

describe("hosted site CORS", () => {
  it("allows the vm0 apex origin on preflight responses", async () => {
    const response = await worker.fetch(
      new Request("https://demo.sites.vm0.io/", {
        method: "OPTIONS",
        headers: { Origin: "https://vm0.ai" },
      }),
      env(),
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://vm0.ai",
    );
    expect(response.headers.get("Access-Control-Allow-Methods")).toBe(
      "GET, HEAD, OPTIONS",
    );
    expect(response.headers.get("Vary")).toBe("Origin");
  });

  it("allows vm0 subdomain origins on hosted file responses", async () => {
    const response = await worker.fetch(
      new Request("https://demo.sites.vm0.io/", {
        headers: { Origin: "https://app.vm0.ai:8443" },
      }),
      env(),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("<!doctype html>ok");
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://app.vm0.ai:8443",
    );
    expect(response.headers.get("Vary")).toBe("Origin");
  });

  it("omits allow-origin for disallowed origins", async () => {
    const response = await worker.fetch(
      new Request("https://demo.sites.vm0.io/", {
        headers: { Origin: "https://attacker.example" },
      }),
      env(),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(response.headers.get("Vary")).toBe("Origin");
  });
});
