import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const [workerPath, indexPath, manifestPath] = process.argv.slice(2);
if (!workerPath || !indexPath || !manifestPath) {
  throw new Error("worker, index, and manifest paths are required");
}

function parseAttributes(tag) {
  const attributes = new Map();
  const pattern = /([A-Za-z_:][A-Za-z0-9:._-]*)\s*=\s*(["'])(.*?)\2/gu;
  for (const match of tag.matchAll(pattern)) {
    const name = match[1];
    const value = match[3];
    if (name !== undefined && value !== undefined) {
      attributes.set(name, value);
    }
  }
  return attributes;
}

function serializeAttributes(attributes) {
  return [...attributes].map(([name, value]) => ` ${name}="${value}"`).join("");
}

function matchesSelector(tagName, attributes, selector) {
  if (selector === tagName) {
    return true;
  }
  if (selector === "script[data-clerk-js-script]") {
    return tagName === "script" && attributes.has("data-clerk-js-script");
  }
  const match = /^(meta|link)\[(name|property|rel)(\^?=)"([^"]+)"\]$/u.exec(
    selector,
  );
  if (!match || match[1] !== tagName) {
    return false;
  }
  const attributeName = match[2];
  const operator = match[3];
  const expectedValue = match[4];
  const actualValue = attributes.get(attributeName);
  if (actualValue === undefined) {
    return false;
  }
  return operator === "^="
    ? actualValue.startsWith(expectedValue)
    : actualValue === expectedValue;
}

function applyHandler({ attributes, handler, innerContent = "" }) {
  const state = {
    appendedContent: "",
    attributes,
    innerContent,
    removed: false,
  };
  handler.element({
    append(content) {
      state.appendedContent += content;
    },
    getAttribute(name) {
      return state.attributes.get(name) ?? null;
    },
    remove() {
      state.removed = true;
    },
    setAttribute(name, value) {
      state.attributes.set(name, value);
    },
    setInnerContent(content) {
      state.innerContent = content;
    },
  });
  return state;
}

function rewritePairedTag(html, tagName, handler) {
  const pattern =
    tagName === "html"
      ? /<html([^>]*)>([\s\S]*?)<\/html>/iu
      : tagName === "head"
        ? /<head([^>]*)>([\s\S]*?)<\/head>/iu
        : /<title([^>]*)>([\s\S]*?)<\/title>/iu;
  return html.replace(pattern, (_tag, attributeSource, innerContent) => {
    const state = applyHandler({
      attributes: parseAttributes(attributeSource),
      handler,
      innerContent,
    });
    if (state.removed) {
      return "";
    }
    return `<${tagName}${serializeAttributes(state.attributes)}>${state.innerContent}${state.appendedContent}</${tagName}>`;
  });
}

function rewriteClerkScriptOpeningTag(html, handler) {
  const marker = 'data-clerk-js-script=""';
  const markerIndex = html.indexOf(marker);
  if (markerIndex === -1) {
    return html;
  }
  const tagStart = html.lastIndexOf("<", markerIndex);
  const tagEnd = html.indexOf(">", markerIndex);
  if (tagStart === -1 || tagEnd === -1) {
    throw new Error("Invalid Clerk script fixture");
  }
  const tag = html.slice(tagStart, tagEnd + 1);
  const attributes = parseAttributes(tag);
  if (!matchesSelector("script", attributes, "script[data-clerk-js-script]")) {
    throw new Error("Invalid Clerk script selector fixture");
  }
  const state = applyHandler({ attributes, handler });
  if (state.removed || state.appendedContent || state.innerContent) {
    throw new Error("Unsupported Clerk script rewrite operation");
  }
  const tagNameEnd = tag.search(/\s/u);
  if (tagNameEnd === -1) {
    throw new Error("Invalid Clerk script opening tag");
  }
  const rewrittenTag = `${tag.slice(0, tagNameEnd)}${serializeAttributes(state.attributes)}>`;
  return `${html.slice(0, tagStart)}${rewrittenTag}${html.slice(tagEnd + 1)}`;
}

function rewriteVoidTag(html, tagName, selector, handler) {
  const pattern =
    tagName === "meta"
      ? /<meta\b[^>]*>/giu
      : tagName === "link"
        ? /<link\b[^>]*>/giu
        : /<img\b[^>]*>/giu;
  return html.replace(pattern, (tag) => {
    const attributes = parseAttributes(tag);
    if (!matchesSelector(tagName, attributes, selector)) {
      return tag;
    }
    const state = applyHandler({ attributes, handler });
    if (state.removed) {
      return "";
    }
    return `<${tagName}${serializeAttributes(state.attributes)} />`;
  });
}

function rewriteHtml(html, selector, handler) {
  if (selector === "html" || selector === "head" || selector === "title") {
    return rewritePairedTag(html, selector, handler);
  }
  if (selector === "script[data-clerk-js-script]") {
    return rewriteClerkScriptOpeningTag(html, handler);
  }
  if (selector.startsWith("meta[")) {
    return rewriteVoidTag(html, "meta", selector, handler);
  }
  if (selector.startsWith("link[")) {
    return rewriteVoidTag(html, "link", selector, handler);
  }
  if (selector === "img") {
    return rewriteVoidTag(html, "img", selector, handler);
  }
  throw new Error(`Unsupported test HTMLRewriter selector: ${selector}`);
}

globalThis.HTMLRewriter = class HTMLRewriter {
  handlers = [];

  on(selector, handler) {
    this.handlers.push({ handler, selector });
    return this;
  }

  transform(response) {
    const handlers = this.handlers;
    const body = new ReadableStream({
      async start(controller) {
        let html = await response.text();
        for (const { handler, selector } of handlers) {
          html = rewriteHtml(html, selector, handler);
        }
        controller.enqueue(new TextEncoder().encode(html));
        controller.close();
      },
    });
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }
};

const [indexTemplate, manifestTemplate, workerModule] = await Promise.all([
  readFile(indexPath, "utf8"),
  readFile(manifestPath, "utf8"),
  import(pathToFileURL(workerPath).href),
]);
const worker = workerModule.default;
const sharedThreadId = "10000000-0000-4000-8000-000000000001";
const previewOrigin = "https://pr-25304-api.vm6.ai";
const clerkJsVersion = "6.25.8";
const previewClerkHost = "informed-calf-6.clerk.accounts.dev";
const productionClerkHost = "clerk.vm0.ai";
const clerkSatelliteDomain = "app.okou.ai";
const previewClerkPublishableKey = publishableKey("test", previewClerkHost);
const productionClerkPublishableKey = publishableKey(
  "live",
  productionClerkHost,
);
const previewClerkScriptUrl = clerkScriptUrl(previewClerkHost);
const productionClerkScriptUrl = clerkScriptUrl(productionClerkHost);
const satelliteClerkScriptUrl = clerkScriptUrl(`clerk.${clerkSatelliteDomain}`);
const builtIndexTemplate = indexTemplate
  .replaceAll(
    "%VITE_CLERK_PUBLISHABLE_KEY_PREVIEW%",
    previewClerkPublishableKey,
  )
  .replaceAll(
    "%VITE_CLERK_PUBLISHABLE_KEY_PROD%",
    productionClerkPublishableKey,
  )
  .replaceAll("__VM0_CLERK_PREVIEW_SCRIPT_URL__", previewClerkScriptUrl)
  .replaceAll("__VM0_CLERK_PRODUCTION_SCRIPT_URL__", productionClerkScriptUrl)
  .replaceAll("__VM0_CLERK_SATELLITE_SCRIPT_URL__", satelliteClerkScriptUrl);
const vm0Description =
  "VM0, your trustworthy AI teammate for real work. An AI agent that connects to 100+ tools to run reports, triage, outreach, and research in Slack or the web.";
const okouDescription =
  "Okou, your trustworthy AI teammate for real work. An AI agent that connects to 100+ tools to run reports, triage, outreach, and research in Slack or the web.";

function publishableKey(environment, host) {
  return `pk_${environment}_${Buffer.from(`${host}$`).toString("base64")}`;
}

function clerkScriptUrl(host) {
  return `https://${host}/npm/@clerk/clerk-js@${clerkJsVersion}/dist/clerk.browser.js`;
}

function requestUrl(input) {
  return new URL(input instanceof Request ? input.url : input.toString());
}

function assetEnvironment(apiOrigin = "") {
  const indexHtml = builtIndexTemplate.replace(
    '<meta name="vm0-api-origin" content="" />',
    `<meta name="vm0-api-origin" content="${apiOrigin}" />`,
  );
  return {
    ASSETS: {
      fetch(input) {
        const url = requestUrl(input);
        if (url.pathname === "/manifest.webmanifest") {
          return Promise.resolve(
            new Response(manifestTemplate, {
              headers: {
                "Content-Encoding": "gzip",
                "Content-Type": "application/manifest+json",
                ETag: '"manifest-etag"',
              },
            }),
          );
        }
        if (url.pathname === "/assets/app.js") {
          return Promise.resolve(
            new Response("export const app = true;", {
              headers: {
                "Content-Type": "application/javascript",
                ETag: '"asset-etag"',
              },
            }),
          );
        }
        return Promise.resolve(
          new Response(indexHtml, {
            status: 200,
            headers: {
              "Content-Encoding": "gzip",
              "Content-Type": "text/html; charset=UTF-8",
              ETag: '"index-etag"',
            },
          }),
        );
      },
    },
  };
}

function tagAttribute(html, tagName, selectorAttribute, selectorValue, target) {
  const pattern =
    tagName === "meta"
      ? /<meta\b[^>]*>/giu
      : tagName === "link"
        ? /<link\b[^>]*>/giu
        : tagName === "script"
          ? /<script\b[^>]*>/giu
          : /<img\b[^>]*>/giu;
  for (const match of html.matchAll(pattern)) {
    const attributes = parseAttributes(match[0]);
    if (attributes.get(selectorAttribute) === selectorValue) {
      return attributes.get(target) ?? null;
    }
  }
  return null;
}

function tagAttributeValues(html, tagName, target) {
  const pattern = tagName === "link" ? /<link\b[^>]*>/giu : /<img\b[^>]*>/giu;
  return [...html.matchAll(pattern)].flatMap((match) => {
    const value = parseAttributes(match[0]).get(target);
    return value === undefined ? [] : [value];
  });
}

function metaContent(html, selectorAttribute, selectorValue) {
  return tagAttribute(
    html,
    "meta",
    selectorAttribute,
    selectorValue,
    "content",
  );
}

function documentTitle(html) {
  return /<title[^>]*>([\s\S]*?)<\/title>/iu.exec(html)?.[1]?.trim() ?? null;
}

function htmlAttribute(html, attributeName) {
  const tag = /<html\b[^>]*>/iu.exec(html)?.[0];
  return tag ? (parseAttributes(tag).get(attributeName) ?? null) : null;
}

function clerkAttribute(html, target) {
  return tagAttribute(html, "script", "data-clerk-js-script", "", target);
}

function clerkScriptCount(html) {
  return [...html.matchAll(/<script\b[^>]*>/giu)].filter((match) => {
    return parseAttributes(match[0]).has("data-clerk-js-script");
  }).length;
}

async function requestAppPage(origin, apiOrigin = "") {
  const response = await worker.fetch(
    new Request(`${origin}/settings/profile`),
    assetEnvironment(apiOrigin),
  );
  const html = await response.text();
  return { html, response };
}

const vm0Page = await requestAppPage("https://app.vm0.ai");
assert.equal(vm0Page.response.status, 200);
assert.equal(vm0Page.response.headers.get("x-robots-tag"), "noindex, nofollow");
assert.equal(vm0Page.response.headers.get("content-encoding"), null);
assert.equal(vm0Page.response.headers.get("etag"), null);
assert.equal(
  documentTitle(vm0Page.html),
  "AI Agents for Real Work — Your Trustworthy AI Teammate | VM0",
);
assert.equal(htmlAttribute(vm0Page.html, "data-app-brand-name"), "VM0");
assert.equal(metaContent(vm0Page.html, "name", "application-name"), "VM0");
assert.equal(
  metaContent(vm0Page.html, "name", "apple-mobile-web-app-title"),
  "VM0",
);
assert.equal(metaContent(vm0Page.html, "name", "description"), vm0Description);
assert.equal(metaContent(vm0Page.html, "property", "og:site_name"), "VM0");
assert.equal(
  metaContent(vm0Page.html, "property", "og:title"),
  "VM0 - Your Trustworthy AI Teammate",
);
assert.equal(metaContent(vm0Page.html, "name", "twitter:site"), "@okou_ai");
assert.equal(metaContent(vm0Page.html, "name", "twitter:creator"), "@okou_ai");
assert.equal(metaContent(vm0Page.html, "name", "robots"), "noindex, nofollow");
assert.equal(
  tagAttribute(vm0Page.html, "link", "rel", "canonical", "href"),
  "https://app.vm0.ai/",
);
assert.equal(
  metaContent(vm0Page.html, "property", "og:url"),
  "https://app.vm0.ai/",
);
assert.equal(
  metaContent(vm0Page.html, "name", "vm0-api-origin"),
  "https://api.vm0.ai",
);
assert.equal(
  metaContent(vm0Page.html, "property", "og:image"),
  "https://static.vm0.io/web/og-image.png",
);
assert.ok(
  tagAttributeValues(vm0Page.html, "link", "href").includes(
    "https://static.vm0.io/platform/icon.svg",
  ),
);
assert.equal(
  tagAttribute(vm0Page.html, "img", "alt", "", "src"),
  "https://static.vm0.io/platform/icon.svg",
);
assert.equal(clerkScriptCount(vm0Page.html), 1);
assert.equal(
  clerkAttribute(vm0Page.html, "data-clerk-publishable-key"),
  productionClerkPublishableKey,
);
assert.equal(clerkAttribute(vm0Page.html, "src"), productionClerkScriptUrl);
assert.equal(clerkAttribute(vm0Page.html, "data-clerk-domain"), null);

const okouPage = await requestAppPage("https://app.okou.ai");
assert.equal(
  documentTitle(okouPage.html),
  "AI Agents for Real Work — Your Trustworthy AI Teammate | Okou",
);
assert.equal(htmlAttribute(okouPage.html, "data-app-brand-name"), "Okou");
assert.equal(metaContent(okouPage.html, "name", "application-name"), "Okou");
assert.equal(
  metaContent(okouPage.html, "name", "description"),
  okouDescription,
);
assert.equal(metaContent(okouPage.html, "property", "og:site_name"), "Okou");
assert.equal(
  metaContent(okouPage.html, "property", "og:title"),
  "Okou - Your Trustworthy AI Teammate",
);
assert.equal(
  tagAttribute(okouPage.html, "link", "rel", "canonical", "href"),
  "https://app.okou.ai/",
);
assert.equal(
  metaContent(okouPage.html, "property", "og:url"),
  "https://app.okou.ai/",
);
assert.equal(
  metaContent(okouPage.html, "name", "vm0-api-origin"),
  "https://api.okou.ai",
);
assert.equal(
  metaContent(okouPage.html, "property", "og:image"),
  "https://static.okou.io/web/og-image.png",
);
assert.ok(
  tagAttributeValues(okouPage.html, "link", "href").includes(
    "https://static.okou.io/platform/icon.svg",
  ),
);
assert.ok(
  tagAttributeValues(okouPage.html, "link", "href").some(
    (href) => href === "https://static.okou.io",
  ),
);
assert.equal(
  tagAttribute(okouPage.html, "img", "alt", "", "src"),
  "https://static.okou.io/platform/icon.svg",
);
assert.equal(clerkScriptCount(okouPage.html), 1);
assert.equal(
  clerkAttribute(okouPage.html, "data-clerk-publishable-key"),
  productionClerkPublishableKey,
);
assert.equal(clerkAttribute(okouPage.html, "src"), satelliteClerkScriptUrl);
assert.equal(
  clerkAttribute(okouPage.html, "data-clerk-domain"),
  clerkSatelliteDomain,
);

const okouPreview = await requestAppPage(
  "https://3508a2f5.okou-app.pages.dev",
  previewOrigin,
);
assert.equal(htmlAttribute(okouPreview.html, "data-app-brand-name"), "Okou");
assert.equal(
  tagAttribute(okouPreview.html, "link", "rel", "canonical", "href"),
  "https://app.okou.ai/",
);
assert.equal(
  metaContent(okouPreview.html, "name", "vm0-api-origin"),
  previewOrigin,
);
assert.equal(clerkScriptCount(okouPreview.html), 1);
assert.equal(
  clerkAttribute(okouPreview.html, "data-clerk-publishable-key"),
  previewClerkPublishableKey,
);
assert.equal(clerkAttribute(okouPreview.html, "src"), previewClerkScriptUrl);
assert.equal(clerkAttribute(okouPreview.html, "data-clerk-domain"), null);
assert.equal(clerkAttribute(okouPreview.html, "defer"), "");
assert.equal(clerkAttribute(okouPreview.html, "crossorigin"), "anonymous");
assert.equal(clerkAttribute(okouPreview.html, "onerror"), "this.remove()");
assert.equal(clerkAttribute(okouPreview.html, "type"), "text/javascript");
assert.equal(okouPreview.html.includes("/npm/@clerk/ui@"), false);

const untrustedSuffix = await requestAppPage("https://okou.ai.evil.example");
assert.equal(htmlAttribute(untrustedSuffix.html, "data-app-brand-name"), "VM0");

for (const [origin, brandName, description] of [
  ["https://app.vm0.ai", "VM0", vm0Description],
  ["https://app.okou.ai", "Okou", okouDescription],
]) {
  const response = await worker.fetch(
    new Request(`${origin}/manifest.webmanifest`),
    assetEnvironment(),
  );
  const manifest = await response.json();
  assert.equal(response.headers.get("content-encoding"), null);
  assert.equal(response.headers.get("etag"), null);
  assert.equal(
    response.headers.get("content-type"),
    "application/manifest+json; charset=UTF-8",
  );
  assert.equal(manifest.name, brandName);
  assert.equal(manifest.short_name, brandName);
  assert.equal(manifest.description, description);
  assert.equal(manifest.icons.length, 3);
}

const staticAsset = await worker.fetch(
  new Request("https://app.okou.ai/assets/app.js"),
  assetEnvironment(),
);
assert.equal(await staticAsset.text(), "export const app = true;");
assert.equal(staticAsset.headers.get("etag"), '"asset-etag"');
assert.equal(staticAsset.headers.get("x-robots-tag"), null);

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
    new Request(`${appOrigin}/share/threads/${sharedThreadId}${query}`),
    assetEnvironment(apiOrigin),
  );
  return { response, observedUrl, observedHeaders };
}

const preview = await requestSharedPage({
  appOrigin: "https://pr-25304-app.omby.ai",
  apiOrigin: previewOrigin,
  query: "?x-vercel-protection-bypass=preview-secret",
  metaResponse() {
    return Response.json({
      title: "Preview conversation",
      publicBrand: "okou",
    });
  },
});
assert.equal(preview.response.status, 200);
assert.equal(
  preview.observedUrl,
  `${previewOrigin}/api/shared-threads/${sharedThreadId}/meta`,
);
assert.equal(
  preview.observedHeaders.get("x-vercel-protection-bypass"),
  "preview-secret",
);
const previewHtml = await preview.response.text();
assert.equal(documentTitle(previewHtml), "Preview conversation | Okou");
assert.equal(htmlAttribute(previewHtml, "data-app-brand-name"), "Okou");
assert.equal(metaContent(previewHtml, "name", "vm0-api-origin"), previewOrigin);
assert.equal(
  metaContent(previewHtml, "property", "og:title"),
  "Preview conversation",
);
assert.equal(
  metaContent(previewHtml, "property", "og:url"),
  `https://app.okou.ai/share/threads/${sharedThreadId}`,
);
assert.equal(
  tagAttribute(previewHtml, "link", "rel", "canonical", "href"),
  null,
);

const production = await requestSharedPage({
  appOrigin: "https://app.okou.ai",
  apiOrigin: previewOrigin,
  query: "?x-vercel-protection-bypass=must-not-forward",
  metaResponse() {
    return Response.json({
      title: "Production conversation",
      publicBrand: "okou",
    });
  },
});
assert.equal(production.response.status, 200);
assert.equal(
  production.observedUrl,
  `https://api.okou.ai/api/shared-threads/${sharedThreadId}/meta`,
);
assert.equal(
  production.observedHeaders.get("x-vercel-protection-bypass"),
  null,
);
const productionHtml = await production.response.text();
assert.equal(
  metaContent(productionHtml, "name", "vm0-api-origin"),
  "https://api.okou.ai",
);

const vm0SharedOnOkouHost = await requestSharedPage({
  appOrigin: "https://app.okou.ai",
  metaResponse() {
    return Response.json({
      title: "Legacy conversation",
      publicBrand: "vm0",
    });
  },
});
assert.equal(vm0SharedOnOkouHost.response.status, 200);
const vm0SharedHtml = await vm0SharedOnOkouHost.response.text();
assert.equal(documentTitle(vm0SharedHtml), "Legacy conversation | VM0");
assert.equal(htmlAttribute(vm0SharedHtml, "data-app-brand-name"), "VM0");
assert.equal(
  metaContent(vm0SharedHtml, "property", "og:url"),
  `https://app.vm0.ai/share/threads/${sharedThreadId}`,
);
assert.equal(
  metaContent(vm0SharedHtml, "property", "og:image"),
  "https://static.vm0.io/web/og-image.png",
);

const missingBrandSharedPage = await requestSharedPage({
  appOrigin: "https://app.okou.ai",
  metaResponse() {
    return Response.json({ title: "Missing-brand conversation" });
  },
});
assert.equal(missingBrandSharedPage.response.status, 502);

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
  missing.observedUrl,
  `https://api.vm0.ai/api/shared-threads/${sharedThreadId}/meta`,
);
assert.equal(
  missing.response.headers.get("cache-control"),
  "public, max-age=60, s-maxage=60",
);
assert.equal(missing.response.headers.get("x-robots-tag"), "noindex, nofollow");
const missingHtml = await missing.response.text();
assert.equal(documentTitle(missingHtml), "Shared conversation not found | VM0");
assert.equal(
  metaContent(missingHtml, "name", "vm0-api-origin"),
  "https://api.vm0.ai",
);
assert.equal(metaContent(missingHtml, "property", "og:title"), null);
assert.equal(metaContent(missingHtml, "name", "twitter:title"), null);

const upstreamFailure = await requestSharedPage({
  appOrigin: "https://app.okou.ai",
  metaResponse() {
    return new Response("failed", { status: 500 });
  },
});
assert.equal(upstreamFailure.response.status, 502);
assert.equal(upstreamFailure.response.headers.get("cache-control"), "no-store");

console.log("okou app worker tests passed");
