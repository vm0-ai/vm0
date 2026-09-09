import { afterEach, expect, test, vi, onTestFinished } from "vitest";
import { type ArtifactSharePolicy } from "@okouai/api-contracts/contracts/artifact-shares";
import worker from "./index";
import { fetchWorker } from "./test-helpers";

type Env = Parameters<typeof worker.fetch>[1];
const id = "00000000-0000-4000-8000-000000000010";
const fileId = "00000000-0000-4000-8000-000000000011";
const snapshotId = "00000000-0000-4000-8000-000000000012";
const siteId = "00000000-0000-4000-8000-000000000013";
const publicToken = "a".repeat(24);
const origin = `https://sh-${id.replaceAll("-", "")}-${publicToken}.okou.app`;
const policyKey = `artifact-shares/okou/${id}.json`;

function fixture(html = false) {
  const files = {
    "/index.html": {
      path: "/index.html",
      size: 16,
      sha256: "a",
      contentType: "text/html",
    },
    "/style.css": {
      path: "/style.css",
      size: 12,
      sha256: "b",
      contentType: "text/css",
    },
    "/app.js": {
      path: "/app.js",
      size: 8,
      sha256: "c",
      contentType: "application/javascript",
    },
    "/image.png": {
      path: "/image.png",
      size: 3,
      sha256: "d",
      contentType: "image/png",
    },
    "/download.csv": {
      path: "/download.csv",
      size: 3,
      sha256: "e",
      contentType: "text/csv",
    },
  };
  const policy: ArtifactSharePolicy = {
    version: 1,
    revision: snapshotId,
    shareId: id,
    ownerId: "owner",
    orgId: "org",
    publicBrand: "okou",
    audience: "public",
    status: "active",
    publicToken,
    target: html
      ? {
          kind: "html",
          id: fileId,
          siteId,
          snapshotId,
          deploymentVersion: 1,
          manifest: {
            version: 1,
            access: "owner-private-v1",
            publicBrand: "okou",
            deploymentId: fileId,
            siteId,
            publicSlug: "private-report",
            createdAt: "2026-09-08T00:00:00Z",
            spaFallback: true,
            files,
          },
        }
      : {
          kind: "file",
          id: fileId,
          key: `private-artifacts/${fileId}/shares/${snapshotId}/report.pdf`,
          filename: "report.pdf",
          contentType: "application/pdf",
        },
  };
  const prefix = `shared-artifacts/okou/${snapshotId}/${fileId}`;
  const objects = new Map<string, string>([
    [policyKey, JSON.stringify(policy)],
  ]);
  if (policy.target.kind === "html") {
    objects.set(
      `${prefix}/manifest.json`,
      JSON.stringify(policy.target.manifest),
    );
    for (const path of Object.keys(files))
      objects.set(`${prefix}${path}`, `Content ${path}`);
  } else objects.set(policy.target.key, "Private PDF bytes");
  const reads: string[] = [];
  const bucket: Env["HOSTED_SITES_BUCKET"] = {
    get: async (key) => {
      reads.push(key);
      const value = objects.get(key);
      return value === undefined
        ? null
        : {
            body: new Response(value).body!,
            httpEtag: '"file"',
            writeHttpMetadata() {},
          };
    },
  };
  const env: Env = {
    HOST_DOMAIN: "sites.vm0.io",
    OKOU_HOST_DOMAIN: "okou.app",
    HOSTED_SITES_BUCKET: bucket,
    PRIVATE_ARTIFACTS_BUCKET: bucket,
  };
  const bytes = new Map<string, Response>();
  const cache = {
    match: vi.fn(async (key: Request) => {
      return bytes.get(key.url)?.clone();
    }),
    put: vi.fn(async (key: Request, response: Response) => {
      bytes.set(key.url, response);
    }),
  };
  vi.stubGlobal("caches", { default: cache });
  return { env, objects, reads, policy, cache };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

test("warm public bytes still require authoritative permission, and revocation defeats cache hits", async () => {
  const f = fixture();
  const request = () => {
    return new Request(origin);
  };
  expect(await (await fetchWorker(request(), f.env)).text()).toBe(
    "Private PDF bytes",
  );
  f.reads.length = 0;
  const warm = await fetchWorker(request(), f.env);
  expect(await warm.text()).toBe("Private PDF bytes");
  expect(warm.headers.get("cache-control")).toBe("private, no-store");
  expect(f.reads).toEqual([policyKey]);
  const cacheReads = f.cache.match.mock.calls.length;
  f.objects.set(
    policyKey,
    JSON.stringify({
      ...f.policy,
      audience: "organization",
      publicToken: null,
    }),
  );
  const denied = await fetchWorker(request(), f.env);
  expect(denied.status).toBe(404);
  expect(await denied.text()).not.toContain("Private PDF");
  expect(f.cache.match).toHaveBeenCalledTimes(cacheReads);
});

test("missing, malformed and unavailable publication state never serve cached bytes", async () => {
  const f = fixture();
  await fetchWorker(new Request(origin), f.env);
  f.objects.set(policyKey, "broken");
  expect((await fetchWorker(new Request(origin), f.env)).status).toBe(503);
  f.objects.delete(policyKey);
  expect((await fetchWorker(new Request(origin), f.env)).status).toBe(404);
  f.env.HOSTED_SITES_BUCKET.get = async () => {
    throw new Error("Storage unavailable");
  };
  expect((await fetchWorker(new Request(origin), f.env)).status).toBe(503);
  expect(f.cache.match).toHaveBeenCalledTimes(1);
});

test("republishing does not reactivate earlier public URLs or canonical private aliases", async () => {
  const f = fixture();
  f.objects.set(
    policyKey,
    JSON.stringify({ ...f.policy, publicToken: "b".repeat(24) }),
  );
  expect((await fetchWorker(new Request(origin), f.env)).status).toBe(404);
  expect(
    (await fetchWorker(new Request(`https://dpl-${fileId}.okou.app/`), f.env))
      .status,
  ).toBe(404);
  expect(
    (
      await fetchWorker(
        new Request(origin.replace(publicToken, "b".repeat(24))),
        f.env,
      )
    ).status,
  ).toBe(200);
});

test("html snapshots protect every resource and navigation on an isolated origin", async () => {
  const f = fixture(true);
  for (const path of [
    "/",
    "/style.css",
    "/app.js",
    "/image.png",
    "/download.csv",
    "/nested/route",
  ]) {
    const response = await fetchWorker(
      new Request(`${origin}${path}`, { headers: { accept: "text/html" } }),
      f.env,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toContain(
      "worker-src 'none'",
    );
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  }
  const head = await fetchWorker(
    new Request(`${origin}/app.js`, { method: "HEAD" }),
    f.env,
  );
  expect(head.status).toBe(200);
  expect(await head.text()).toBe("");
  f.objects.set(
    policyKey,
    JSON.stringify({
      ...f.policy,
      audience: "private",
      status: "revoked",
      publicToken: null,
    }),
  );
  for (const path of [
    "/",
    "/style.css",
    "/app.js",
    "/image.png",
    "/download.csv",
    "/nested/route",
  ]) {
    expect(
      (await fetchWorker(new Request(`${origin}${path}`), f.env)).status,
    ).toBe(404);
  }
});

test("organization snapshot credentials remain bearer capabilities only until their exact expiry", async () => {
  const f = fixture(true);
  const token = "c".repeat(48);
  const key = `shared-previews/okou/${token}.json`;
  const grant = {
    version: 1,
    publicBrand: "okou",
    deploymentId: fileId,
    snapshotId,
    expiresAt: "2099-01-01T00:00:00Z",
  };
  f.objects.set(key, JSON.stringify(grant));
  const request = (path: string) => {
    return new Request(`https://ps-${token}.okou.app${path}`);
  };
  expect((await fetchWorker(request("/"), f.env)).status).toBe(200);
  const rewritten = new Request(`https://pv-${token}.okou.app/`);
  expect((await fetchWorker(rewritten, f.env)).status).toBe(404);
  expect(f.objects.has(`private-previews/okou/${token}.json`)).toBeFalsy();
  // Stopping the share does not promise invalidation of previously issued credentials.
  f.objects.set(
    policyKey,
    JSON.stringify({
      ...f.policy,
      audience: "private",
      status: "revoked",
      publicToken: null,
    }),
  );
  expect((await fetchWorker(request("/style.css"), f.env)).status).toBe(200);
  f.objects.set(
    key,
    JSON.stringify({ ...grant, expiresAt: "2000-01-01T00:00:00Z" }),
  );
  expect((await fetchWorker(request("/"), f.env)).status).toBe(404);
  expect((await fetchWorker(request("/style.css"), f.env)).status).toBe(404);
});

test("a cold cache write runs in the Worker lifetime without delaying content delivery", async () => {
  const f = fixture();
  const gate = Promise.withResolvers<void>();
  onTestFinished(() => {
    return gate.resolve();
  });
  f.cache.put.mockImplementation(async () => {
    await gate.promise;
  });
  const pending: Promise<unknown>[] = [];
  const response = await worker.fetch(new Request(origin), f.env, {
    waitUntil(promise) {
      pending.push(promise);
    },
  });
  expect(await response.text()).toBe("Private PDF bytes");
  expect(pending).toHaveLength(1);
  gate.resolve();
  await Promise.all(pending);
});
