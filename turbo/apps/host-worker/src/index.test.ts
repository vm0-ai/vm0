import { describe, expect, it } from "vitest";

import worker from "./index";

type WorkerEnv = Parameters<typeof worker.fetch>[1];
type R2Object = NonNullable<
  Awaited<ReturnType<WorkerEnv["HOSTED_SITES_BUCKET"]["get"]>>
>;

interface TestFile {
  readonly body: string;
  readonly contentType: string;
}

interface TestEnvOptions {
  readonly files?: Record<string, TestFile>;
}

const DEFAULT_ROBOTS_TXT = "User-agent: *\nDisallow: /\n";

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

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function env(options: TestEnvOptions = {}): WorkerEnv {
  const publicSlug = "demo";
  const deploymentId = "00000000-0000-4000-8000-000000000001";
  const prefix = `sites/${publicSlug}/deployments/${deploymentId}`;
  const manifestKey = `${prefix}/manifest.json`;
  const files: Record<string, TestFile> = {
    "/index.html": {
      body: "<!doctype html>ok",
      contentType: "text/html; charset=utf-8",
    },
    ...(options.files ?? {}),
  };
  const manifestFiles = Object.fromEntries(
    Object.entries(files).map(([path, file]) => {
      return [
        path,
        {
          path,
          size: byteLength(file.body),
          sha256: "a".repeat(64),
          contentType: file.contentType,
        },
      ];
    }),
  );
  const fileObjects: [string, R2Object][] = Object.entries(files).map(
    ([path, file]) => {
      return [`${prefix}${path}`, objectBody(file.body, file.contentType)];
    },
  );
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
          files: manifestFiles,
        }),
      ),
    ],
    ...fileObjects,
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

describe("hosted site worker", () => {
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

  it("serves default robots.txt when the active deployment omits it", async () => {
    const response = await worker.fetch(
      new Request("https://demo.sites.vm0.io/robots.txt"),
      env(),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe(
      "text/plain; charset=utf-8",
    );
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=3600");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(await response.text()).toBe(DEFAULT_ROBOTS_TXT);
  });

  it("serves an uploaded robots.txt when present", async () => {
    const customRobots = "User-agent: *\nAllow: /\n";
    const response = await worker.fetch(
      new Request("https://demo.sites.vm0.io/robots.txt"),
      env({
        files: {
          "/robots.txt": {
            body: customRobots,
            contentType: "text/plain; charset=utf-8",
          },
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(customRobots);
  });
});
