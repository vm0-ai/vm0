import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

const workerPath = process.argv[2];
if (!workerPath) {
  throw new Error("worker module path is required");
}

globalThis.HTMLRewriter = class HTMLRewriter {
  on() {
    return this;
  }

  transform(response) {
    return response;
  }
};

const { default: worker } = await import(pathToFileURL(workerPath).href);
const sharedThreadId = "10000000-0000-4000-8000-000000000001";
const previewOrigin = "https://pr-25304-api.vm6.ai";

function assetEnvironment(apiOrigin = "") {
  return {
    ASSETS: {
      fetch() {
        return Promise.resolve(
          new Response(
            `<!doctype html><head><meta name="vm0-api-origin" content="${apiOrigin}" /></head>`,
            { status: 200, headers: { "Content-Type": "text/html" } },
          ),
        );
      },
    },
  };
}

async function requestSharedPage({
  appOrigin,
  apiOrigin = "",
  query = "",
  metaResponse,
}) {
  let observedUrl = null;
  let observedHeaders = null;
  globalThis.fetch = (input, init) => {
    observedUrl = String(input);
    observedHeaders = new Headers(init?.headers);
    return Promise.resolve(metaResponse());
  };
  const response = await worker.fetch(
    new Request(
      `${appOrigin}/share/threads/${sharedThreadId}${query}`,
    ),
    assetEnvironment(apiOrigin),
  );
  return { response, observedUrl, observedHeaders };
}

const preview = await requestSharedPage({
  appOrigin: "https://pr-25304-app.omby.ai",
  apiOrigin: previewOrigin,
  query: "?x-vercel-protection-bypass=preview-secret",
  metaResponse() {
    return Response.json({ title: "Preview conversation" });
  },
});
assert.equal(preview.response.status, 200);
assert.equal(
  preview.observedUrl,
  `${previewOrigin}/api/zero/shared-threads/${sharedThreadId}/meta`,
);
assert.equal(
  preview.observedHeaders.get("x-vercel-protection-bypass"),
  "preview-secret",
);

const production = await requestSharedPage({
  appOrigin: "https://app.okou.ai",
  query: "?x-vercel-protection-bypass=must-not-forward",
  metaResponse() {
    return Response.json({ title: "Production conversation" });
  },
});
assert.equal(production.response.status, 200);
assert.equal(
  production.observedUrl,
  `https://api.vm0.ai/api/zero/shared-threads/${sharedThreadId}/meta`,
);
assert.equal(
  production.observedHeaders.get("x-vercel-protection-bypass"),
  null,
);

const missing = await requestSharedPage({
  appOrigin: "https://app.vm0.ai",
  metaResponse() {
    return Response.json(
      { error: { code: "NOT_FOUND", message: "Not found" } },
      { status: 404 },
    );
  },
});
assert.equal(missing.response.status, 404);
assert.equal(
  missing.response.headers.get("cache-control"),
  "public, max-age=60, s-maxage=60",
);
assert.equal(
  missing.response.headers.get("x-robots-tag"),
  "noindex, nofollow",
);

const upstreamFailure = await requestSharedPage({
  appOrigin: "https://app.okou.ai",
  metaResponse() {
    return new Response("failed", { status: 500 });
  },
});
assert.equal(upstreamFailure.response.status, 502);
assert.equal(
  upstreamFailure.response.headers.get("cache-control"),
  "no-store",
);

console.log("okou app worker tests passed");
