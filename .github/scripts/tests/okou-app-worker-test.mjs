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
        : tagName === "body"
          ? /<body([^>]*)>([\s\S]*?)<\/body>/iu
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
  if (
    selector === "html" ||
    selector === "head" ||
    selector === "body" ||
    selector === "title"
  ) {
    return rewritePairedTag(html, selector, handler);
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
const sharedThreadId = "10000000-0000-4000-8000-000000000001";
const previewOrigin = "https://pr-25304-api.vm6.ai";
const clerkJsVersion = "6.25.8";
const previewClerkHost = "informed-calf-6.clerk.accounts.dev";
const productionClerkHost = "clerk.vm0.ai";
const previewClerkPublishableKey = publishableKey("test", previewClerkHost);
const productionClerkPublishableKey = publishableKey(
  "live",
  productionClerkHost,
);
const clerkBrowserScriptUrl = `https://cdn.jsdelivr.net/npm/@clerk/clerk-js@${clerkJsVersion}/dist/clerk.browser.js`;
const builtIndexTemplate = indexTemplate
  .replaceAll(
    "%VITE_CLERK_PUBLISHABLE_KEY_PREVIEW%",
    previewClerkPublishableKey,
  )
  .replaceAll(
    "%VITE_CLERK_PUBLISHABLE_KEY_PROD%",
    productionClerkPublishableKey,
  )
  .replaceAll("__VM0_CLERK_PRODUCTION_PRIMARY_APP_DOMAIN__", "app.vm0.ai")
  .replaceAll("__VM0_CLERK_BROWSER_SCRIPT_URL__", clerkBrowserScriptUrl);
const embeddedIndexTemplate = builtIndexTemplate
  .replace(
    "</head>",
    [
      '<link id="vm0-main-stylesheet" rel="preload" as="style" href="https://static.okou.io/okou-app/assets/index-Test1234.css" />',
      '<link rel="modulepreload" href="https://static.okou.io/okou-app/assets/vendor-Test1234.js" />',
      "</head>",
    ].join("\n"),
  )
  .replace(
    "</body>",
    '<script type="module" src="https://static.okou.io/okou-app/assets/index-Test1234.js"></script>\n</body>',
  );
const embeddedShell = {
  icon192: new TextEncoder().encode("icon-192").buffer,
  icon512: new TextEncoder().encode("icon-512").buffer,
  icon512Maskable: new TextEncoder().encode("icon-maskable").buffer,
  indexHtml: embeddedIndexTemplate,
  manifest: manifestTemplate,
  robots: "User-agent: *\nAllow: /\n",
  serviceWorker: 'self.addEventListener("install", () => {});',
};
const embeddedWorker = workerModule.createWorker(embeddedShell);
const worker = embeddedWorker;
const expectedClerkCoreScript = clerkCoreScript(builtIndexTemplate);
const expectedClerkBootstrap = clerkBootstrap(builtIndexTemplate);
const vm0Description =
  "VM0, your trustworthy AI teammate for real work. An AI agent that connects to 100+ tools to run reports, triage, outreach, and research in Slack or the web.";
const okouDescription =
  "Okou, your trustworthy AI teammate for real work. An AI agent that connects to 100+ tools to run reports, triage, outreach, and research in Slack or the web.";

function publishableKey(environment, host) {
  return `pk_${environment}_${Buffer.from(`${host}$`).toString("base64")}`;
}

function assetEnvironment(publicBrand) {
  return {
    ...(publicBrand ? { PUBLIC_BRAND: publicBrand } : {}),
    STATIC_ASSETS_BUCKET: {
      get(key, options) {
        observedR2Key = key;
        observedR2Options = options;
        const body = "export const worker = true;";
        const bodySize = new TextEncoder().encode(body).byteLength;
        const range = options?.range.get("Range")
          ? { offset: 0, length: bodySize }
          : undefined;
        return Promise.resolve({
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(body));
              controller.close();
            },
          }),
          httpEtag: '"shared-worker-etag"',
          range,
          size: bodySize,
          writeHttpMetadata(headers) {
            headers.set("Content-Type", "application/javascript");
          },
        });
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

function clerkEdgeSessionJson(html) {
  const matches = [
    ...html.matchAll(
      /<script type="application\/json" id="vm0-clerk-edge-session">([\s\S]*?)<\/script>/giu,
    ),
  ];
  assert.equal(matches.length, 1);
  return JSON.parse(matches[0][1]);
}

async function responseSnapshot(targetWorker, url, env) {
  const response = await targetWorker.fetch(
    new Request(url, {
      headers: {
        Cookie:
          "__session=jwt-cookie-must-not-render; __clerk_db_jwt=dev-browser-jwt-must-not-render",
      },
    }),
    env,
  );
  return {
    body: await response.text(),
    headers: [...response.headers.entries()],
    status: response.status,
    statusText: response.statusText,
  };
}

function assertNoClerkSecrets(snapshot) {
  for (const sensitiveValue of [
    "jwt-cookie-must-not-render",
    "dev-browser-jwt-must-not-render",
    "sk_test_secret-must-not-render",
    "sk_live_secret-must-not-render",
    "session-token-must-not-render",
    "sess_must-not-render",
    "claim-must-not-render",
    "handshake-cookie-must-not-render",
    "refreshed-cookie-must-not-render",
    "token=must-not-render",
  ]) {
    assert.doesNotMatch(snapshot.body, new RegExp(sensitiveValue, "u"));
  }
}

function clerkBootstrap(html) {
  const bootstrap =
    /<script\b[^>]*data-vm0-clerk-bootstrap=""[^>]*>[\s\S]*?<\/script>/iu.exec(
      html,
    )?.[0];
  if (!bootstrap) {
    throw new Error("Clerk bootstrap script is unavailable");
  }
  return bootstrap;
}

function clerkCoreScript(html) {
  const script =
    /<script\b[^>]*id="vm0-clerk-core-script"[^>]*><\/script>/iu.exec(
      html,
    )?.[0];
  if (!script) {
    throw new Error("Clerk core script is unavailable");
  }
  return script;
}

function assertBootstrapAvatar(html) {
  assert.doesNotMatch(html, /app-bootstrap-skeleton__avatar-placeholder/u);
  const avatar =
    /<svg\b[^>]*class="app-bootstrap-skeleton__avatar-layers"[^>]*>[\s\S]*?<\/svg>/iu.exec(
      html,
    )?.[0];
  assert.ok(avatar, "bootstrap avatar must remain inline");
  assert.equal(parseAttributes(avatar).get("viewBox"), "0 0 518 512");
  assert.equal([...avatar.matchAll(/<path\b/giu)].length, 20);
  assert.doesNotMatch(html, /data-app-bootstrap-avatar-layer/u);
  assert.doesNotMatch(html, /assets\/avatar-svg\//u);
}

async function requestAppPage(origin, publicBrand) {
  const response = await worker.fetch(
    new Request(`${origin}/settings/profile`),
    assetEnvironment(publicBrand),
  );
  const html = await response.text();
  return { html, response };
}

const vm0Page = await requestAppPage("https://app.vm0.ai");
assert.equal(vm0Page.response.status, 200);
assert.equal(vm0Page.response.headers.get("x-robots-tag"), "noindex, nofollow");
assert.equal(vm0Page.response.headers.get("content-encoding"), null);
assert.equal(vm0Page.response.headers.get("etag"), null);
assert.equal(vm0Page.response.headers.get("x-frame-options"), "DENY");
assert.equal(
  vm0Page.response.headers.get("permissions-policy"),
  "camera=(), geolocation=(), payment=(), usb=(), serial=(), display-capture=(self), clipboard-read=(), microphone=(self), bluetooth=(self), clipboard-write=(self), fullscreen=(self)",
);
assert.equal(
  documentTitle(vm0Page.html),
  "AI Agents for Real Work — Your Trustworthy AI Teammate | VM0",
);
assert.equal(htmlAttribute(vm0Page.html, "data-app-brand-name"), "VM0");
assert.equal(metaContent(vm0Page.html, "name", "application-name"), "VM0");
assert.equal(metaContent(vm0Page.html, "name", "description"), vm0Description);
assert.equal(metaContent(vm0Page.html, "property", "og:site_name"), "VM0");
assert.equal(metaContent(vm0Page.html, "name", "twitter:site"), "@okou_ai");
assert.equal(metaContent(vm0Page.html, "name", "twitter:creator"), "@okou_ai");
assert.equal(metaContent(vm0Page.html, "name", "robots"), "noindex, nofollow");
assert.equal(
  tagAttribute(vm0Page.html, "link", "rel", "canonical", "href"),
  "https://app.vm0.ai/",
);
assert.ok(
  tagAttributeValues(vm0Page.html, "link", "href").includes(
    "https://static.vm0.io/public/okou-favicon-adaptive-b4eda9221bb7.svg",
  ),
);
assert.equal(
  tagAttribute(vm0Page.html, "link", "rel", "apple-touch-icon", "href"),
  "https://static.vm0.io/platform/okou-pwa-be0be646-180.png",
);
assertBootstrapAvatar(vm0Page.html);
assert.equal(clerkCoreScript(vm0Page.html), expectedClerkCoreScript);
assert.equal(clerkBootstrap(vm0Page.html), expectedClerkBootstrap);

const okouPage = await requestAppPage("https://app.okou.ai");
assert.equal(
  documentTitle(okouPage.html),
  "AI Agents for Real Work — Your Trustworthy AI Teammate | Okou",
);
assert.equal(htmlAttribute(okouPage.html, "data-app-brand-name"), "Okou");
assert.equal(metaContent(okouPage.html, "name", "application-name"), "Okou");
assert.equal(metaContent(okouPage.html, "property", "og:site_name"), "Okou");
assert.equal(
  tagAttribute(okouPage.html, "link", "rel", "canonical", "href"),
  "https://app.okou.ai/",
);
assert.ok(
  tagAttributeValues(okouPage.html, "link", "href").includes(
    "https://static.okou.io/public/okou-favicon-adaptive-b4eda9221bb7.svg",
  ),
);
assert.equal(
  tagAttribute(okouPage.html, "link", "rel", "apple-touch-icon", "href"),
  "https://static.okou.io/platform/okou-pwa-be0be646-180.png",
);
assert.equal(
  tagAttributeValues(okouPage.html, "link", "href").some(
    (href) => href === "https://static.okou.io",
  ),
  false,
);
assertBootstrapAvatar(okouPage.html);
assert.equal(clerkCoreScript(okouPage.html), expectedClerkCoreScript);
assert.equal(clerkBootstrap(okouPage.html), expectedClerkBootstrap);

const okouPreview = await requestAppPage(
  "https://pr-25304-app-okou-app-preview.vm0.workers.dev",
  "okou",
);
assert.equal(htmlAttribute(okouPreview.html, "data-app-brand-name"), "Okou");
assert.equal(
  tagAttribute(okouPreview.html, "link", "rel", "canonical", "href"),
  "https://app.okou.ai/",
);
assert.equal(clerkBootstrap(okouPreview.html), expectedClerkBootstrap);
assert.equal(clerkCoreScript(okouPreview.html), expectedClerkCoreScript);
assert.equal(okouPreview.html.includes("/npm/@clerk/ui@"), false);

const serviceWorker = await worker.fetch(
  new Request("https://pr-25304-app-okou-app-preview.vm0.workers.dev/sw.js"),
  assetEnvironment("okou"),
);
assert.equal(
  serviceWorker.headers.get("cache-control"),
  "public, max-age=0, must-revalidate",
);
assert.equal(serviceWorker.headers.get("service-worker-allowed"), "/");
assert.equal(serviceWorker.headers.get("x-content-type-options"), "nosniff");

const embeddedPage = await embeddedWorker.fetch(
  new Request(
    "https://pr-25304-app-okou-app-preview.vm0.workers.dev/settings/profile",
  ),
  { PUBLIC_BRAND: "okou" },
);
const embeddedHtml = await embeddedPage.text();
assert.equal(embeddedPage.status, 200);
assert.equal(htmlAttribute(embeddedHtml, "data-app-brand-name"), "Okou");
assert.match(
  embeddedHtml,
  /https:\/\/pr-25304-app-okou-app-preview\.vm0\.workers\.dev\/okou-app\/assets\/index-Test1234\.js/u,
);
assert.match(
  embeddedHtml,
  /https:\/\/pr-25304-app-okou-app-preview\.vm0\.workers\.dev\/okou-app\/assets\/index-Test1234\.css/u,
);
assert.match(
  embeddedHtml,
  /https:\/\/pr-25304-app-okou-app-preview\.vm0\.workers\.dev\/okou-app\/assets\/vendor-Test1234\.js/u,
);
assert.doesNotMatch(
  embeddedHtml,
  /https:\/\/static\.okou\.io\/okou-app\/assets\//u,
);

const embeddedProductionPage = await embeddedWorker.fetch(
  new Request("https://app.okou.ai/settings/profile"),
  { PUBLIC_BRAND: "okou" },
);
const embeddedProductionHtml = await embeddedProductionPage.text();
assert.match(
  embeddedProductionHtml,
  /https:\/\/static\.okou\.io\/okou-app\/assets\/index-Test1234\.js/u,
);
assert.doesNotMatch(
  embeddedProductionHtml,
  /https:\/\/app\.okou\.ai\/okou-app\/assets\/index-Test1234\.js/u,
);

const edgeDebugOrigin = "https://pr-25304-app-okou-app-preview.vm0.workers.dev";
const edgeDebugUrl = `${edgeDebugOrigin}/settings/profile`;
const edgeDebugEnvironment = {
  CLERK_EDGE_DEBUG_AUTHORIZED_PARTY: edgeDebugOrigin,
  CLERK_PUBLISHABLE_KEY: previewClerkPublishableKey,
  CLERK_SECRET_KEY: "sk_test_secret-must-not-render",
  PUBLIC_BRAND: "okou",
};
let unexpectedClerkClientFactoryCalls = 0;
const unexpectedClerkClientFactory = () => {
  unexpectedClerkClientFactoryCalls += 1;
  throw new Error("Clerk must not run for this request");
};
const guardedEdgeWorker = workerModule.createWorker(
  embeddedShell,
  unexpectedClerkClientFactory,
);
const edgeDebugBaseline = await responseSnapshot(
  guardedEdgeWorker,
  edgeDebugUrl,
  edgeDebugEnvironment,
);
assert.doesNotMatch(edgeDebugBaseline.body, /vm0-clerk-edge-session/u);
assertNoClerkSecrets(edgeDebugBaseline);

const duplicateFlag = await responseSnapshot(
  guardedEdgeWorker,
  `${edgeDebugUrl}?__clerk_edge_debug=1&__clerk_edge_debug=1`,
  edgeDebugEnvironment,
);
assert.deepEqual(duplicateFlag, edgeDebugBaseline);

for (const ineligibleOrigin of [
  "http://app.okou.ai",
  "https://app.okou.ai.evil.example",
  "https://pr-25304-app.omby.ai",
  "https://staging-app-okou-app-preview.vm0.workers.dev",
]) {
  const ineligibleUrl = `${ineligibleOrigin}/settings/profile`;
  const ineligibleEnvironment = {
    ...edgeDebugEnvironment,
    CLERK_EDGE_DEBUG_AUTHORIZED_PARTY: ineligibleOrigin,
  };
  const baseline = await responseSnapshot(
    guardedEdgeWorker,
    ineligibleUrl,
    ineligibleEnvironment,
  );
  const flagged = await responseSnapshot(
    guardedEdgeWorker,
    `${ineligibleUrl}?__clerk_edge_debug=1`,
    ineligibleEnvironment,
  );
  assert.deepEqual(flagged, baseline);
  assertNoClerkSecrets(flagged);
}

const missingConfig = await responseSnapshot(
  guardedEdgeWorker,
  `${edgeDebugUrl}?__clerk_edge_debug=1`,
  {
    CLERK_EDGE_DEBUG_AUTHORIZED_PARTY: edgeDebugOrigin,
    PUBLIC_BRAND: "okou",
  },
);
assert.deepEqual(missingConfig, edgeDebugBaseline);
assert.equal(unexpectedClerkClientFactoryCalls, 0);

function clerkClientReturning(requestState) {
  return () => ({
    authenticateRequest() {
      return Promise.resolve(requestState);
    },
  });
}

const anonymous = await responseSnapshot(
  workerModule.createWorker(
    embeddedShell,
    clerkClientReturning({
      headers: new Headers(),
      isAuthenticated: false,
    }),
  ),
  `${edgeDebugUrl}?__clerk_edge_debug=1`,
  edgeDebugEnvironment,
);

const handshake = await responseSnapshot(
  workerModule.createWorker(
    embeddedShell,
    clerkClientReturning({
      headers: new Headers({
        Location: "https://clerk.example/handshake?token=must-not-render",
        "Set-Cookie": "__session=handshake-cookie-must-not-render",
      }),
      isAuthenticated: false,
    }),
  ),
  `${edgeDebugUrl}?__clerk_edge_debug=1`,
  edgeDebugEnvironment,
);

const refresh = await responseSnapshot(
  workerModule.createWorker(
    embeddedShell,
    clerkClientReturning({
      headers: new Headers({
        "Set-Cookie": "__session=refreshed-cookie-must-not-render",
      }),
      isAuthenticated: true,
      toAuth() {
        throw new Error("Refresh state must not be consumed");
      },
    }),
  ),
  `${edgeDebugUrl}?__clerk_edge_debug=1`,
  edgeDebugEnvironment,
);

const thrown = await responseSnapshot(
  workerModule.createWorker(embeddedShell, () => ({
    authenticateRequest() {
      return Promise.reject(new Error("Clerk network failure"));
    },
  })),
  `${edgeDebugUrl}?__clerk_edge_debug=1`,
  edgeDebugEnvironment,
);

const constructorThrown = await responseSnapshot(
  workerModule.createWorker(embeddedShell, () => {
    throw new Error("Clerk SDK failure");
  }),
  `${edgeDebugUrl}?__clerk_edge_debug=1`,
  edgeDebugEnvironment,
);

const timedOut = await responseSnapshot(
  workerModule.createWorker(embeddedShell, () => ({
    authenticateRequest() {
      return new Promise(() => {});
    },
  })),
  `${edgeDebugUrl}?__clerk_edge_debug=1`,
  edgeDebugEnvironment,
);

for (const unchanged of [
  anonymous,
  handshake,
  refresh,
  thrown,
  constructorThrown,
  timedOut,
]) {
  assert.deepEqual(unchanged, edgeDebugBaseline);
  assertNoClerkSecrets(unchanged);
  assert.equal(new Headers(unchanged.headers).get("Location"), null);
  assert.equal(new Headers(unchanged.headers).get("Set-Cookie"), null);
}

const currentUserId = "user_current</script><script>alert(1)</script>";
const currentOrgId = "org_current";
const authenticatedWorker = workerModule.createWorker(
  embeddedShell,
  ({ publishableKey, secretKey, telemetry }) => {
    if (
      publishableKey !== previewClerkPublishableKey ||
      secretKey !== "sk_test_secret-must-not-render" ||
      telemetry?.disabled !== true
    ) {
      throw new Error("Unexpected Clerk client configuration");
    }
    return {
      authenticateRequest(request, options) {
        if (
          request.url !== `${edgeDebugUrl}?__clerk_edge_debug=1` ||
          options.acceptsToken !== "session_token" ||
          options.authorizedParties.length !== 1 ||
          options.authorizedParties[0] !== edgeDebugOrigin
        ) {
          return Promise.reject(new Error("Unexpected Clerk request options"));
        }
        return Promise.resolve({
          headers: new Headers(),
          isAuthenticated: true,
          token: "session-token-must-not-render",
          toAuth() {
            return {
              orgId: currentOrgId,
              sessionClaims: { private: "claim-must-not-render" },
              sessionId: "sess_must-not-render",
              userId: currentUserId,
            };
          },
        });
      },
    };
  },
);
const authenticated = await responseSnapshot(
  authenticatedWorker,
  `${edgeDebugUrl}?__clerk_edge_debug=1`,
  edgeDebugEnvironment,
);
assert.equal(authenticated.status, 200);
assert.equal(
  new Headers(authenticated.headers).get("Cache-Control"),
  "private, no-store",
);
assert.equal(new Headers(authenticated.headers).get("Location"), null);
assert.equal(new Headers(authenticated.headers).get("Set-Cookie"), null);
assert.match(authenticated.body, /id="app-bootstrap-skeleton"/u);
assert.match(authenticated.body, /\\u003c\/script>/u);
assert.doesNotMatch(authenticated.body, /<script>alert\(1\)<\/script>/u);
assert.deepEqual(clerkEdgeSessionJson(authenticated.body), {
  userId: currentUserId,
  orgId: currentOrgId,
});
assert.deepEqual(Object.keys(clerkEdgeSessionJson(authenticated.body)).sort(), [
  "orgId",
  "userId",
]);
assertNoClerkSecrets(authenticated);

for (const [productionOrigin, publicBrand] of [
  ["https://app.okou.ai", "okou"],
  ["https://app.vm0.ai", "vm0"],
]) {
  const productionEdgeUrl = `${productionOrigin}/settings/profile`;
  const productionEdgeEnvironment = {
    CLERK_PUBLISHABLE_KEY: productionClerkPublishableKey,
    CLERK_SECRET_KEY: "sk_live_secret-must-not-render",
    PUBLIC_BRAND: publicBrand,
  };
  let clerkClientFactoryCalls = 0;
  const productionEdgeWorker = workerModule.createWorker(
    embeddedShell,
    ({ publishableKey, secretKey, telemetry }) => {
      clerkClientFactoryCalls += 1;
      assert.equal(publishableKey, productionClerkPublishableKey);
      assert.equal(secretKey, "sk_live_secret-must-not-render");
      assert.equal(telemetry?.disabled, true);
      return {
        authenticateRequest(request, options) {
          assert.equal(
            request.url,
            `${productionEdgeUrl}?__clerk_edge_debug=1`,
          );
          assert.equal(options.acceptsToken, "session_token");
          assert.deepEqual(options.authorizedParties, [productionOrigin]);
          return Promise.resolve({
            headers: new Headers(),
            isAuthenticated: true,
            toAuth() {
              return {
                orgId: "org_production",
                userId: "user_production",
              };
            },
          });
        },
      };
    },
  );
  const productionBaseline = await responseSnapshot(
    productionEdgeWorker,
    productionEdgeUrl,
    productionEdgeEnvironment,
  );
  assert.equal(clerkClientFactoryCalls, 0);
  assert.doesNotMatch(productionBaseline.body, /vm0-clerk-edge-session/u);

  const productionAuthenticated = await responseSnapshot(
    productionEdgeWorker,
    `${productionEdgeUrl}?__clerk_edge_debug=1`,
    productionEdgeEnvironment,
  );
  assert.equal(clerkClientFactoryCalls, 1);
  assert.deepEqual(clerkEdgeSessionJson(productionAuthenticated.body), {
    userId: "user_production",
    orgId: "org_production",
  });
  assert.equal(
    new Headers(productionAuthenticated.headers).get("Cache-Control"),
    "private, no-store",
  );
  assertNoClerkSecrets(productionAuthenticated);
}

const authenticatedWithoutOrganization = await responseSnapshot(
  workerModule.createWorker(
    embeddedShell,
    clerkClientReturning({
      headers: new Headers(),
      isAuthenticated: true,
      toAuth() {
        return { userId: "user_without_organization", orgId: null };
      },
    }),
  ),
  `${edgeDebugUrl}?__clerk_edge_debug=1`,
  edgeDebugEnvironment,
);
assert.deepEqual(clerkEdgeSessionJson(authenticatedWithoutOrganization.body), {
  userId: "user_without_organization",
  orgId: null,
});
assert.equal(
  new Headers(authenticatedWithoutOrganization.headers).get("Cache-Control"),
  "private, no-store",
);
assertNoClerkSecrets(authenticatedWithoutOrganization);

const embeddedServiceWorker = await embeddedWorker.fetch(
  new Request("https://pr-25304-app-okou-app-preview.vm0.workers.dev/sw.js"),
  { PUBLIC_BRAND: "okou" },
);
assert.equal(
  await embeddedServiceWorker.text(),
  'self.addEventListener("install", () => {});',
);
assert.equal(
  embeddedServiceWorker.headers.get("content-type"),
  "application/javascript; charset=UTF-8",
);
assert.equal(embeddedServiceWorker.headers.get("service-worker-allowed"), "/");

const embeddedIcon = await embeddedWorker.fetch(
  new Request(
    "https://pr-25304-app-okou-app-preview.vm0.workers.dev/icons/icon-192.png",
  ),
  { PUBLIC_BRAND: "okou" },
);
assert.equal(embeddedIcon.headers.get("content-type"), "image/png");
assert.equal(await embeddedIcon.text(), "icon-192");

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

let observedR2Key = null;
let observedR2Options = null;
const proxiedAsset = await worker.fetch(
  new Request(
    "https://app.okou.ai/okou-app/assets/shared-database-worker-AbCd1234.js",
    {
      headers: {
        Authorization: "Bearer secret",
        Cookie: "session=secret",
        Range: "bytes=0-1023",
      },
    },
  ),
  assetEnvironment(),
);
assert.equal(
  observedR2Key,
  "okou-app/assets/shared-database-worker-AbCd1234.js",
);
assert.equal(observedR2Options?.range.get("range"), "bytes=0-1023");
assert.equal(observedR2Options?.range.get("authorization"), null);
assert.equal(observedR2Options?.range.get("cookie"), null);
assert.equal(await proxiedAsset.text(), "export const worker = true;");
assert.equal(proxiedAsset.status, 206);
assert.equal(proxiedAsset.headers.get("content-range"), "bytes 0-26/27");
assert.equal(
  proxiedAsset.headers.get("cache-control"),
  "public, max-age=31536000, immutable",
);

let publicAssetRequest = null;
globalThis.fetch = (input) => {
  publicAssetRequest = input instanceof Request ? input : new Request(input);
  return Promise.resolve(
    new Response("export const publicWorker = true;", {
      headers: { "Content-Type": "application/javascript" },
    }),
  );
};
const publicOriginEnvironment = assetEnvironment();
delete publicOriginEnvironment.STATIC_ASSETS_BUCKET;
const publicOriginProxiedAsset = await worker.fetch(
  new Request(
    "https://app.okou.ai/okou-app/assets/shared-database-worker-Legacy123.js",
    {
      headers: {
        Authorization: "Bearer secret",
        Cookie: "secret=true",
        Range: "bytes=0-1023",
      },
    },
  ),
  publicOriginEnvironment,
);
assert.equal(
  publicAssetRequest?.url,
  "https://static.okou.io/okou-app/assets/shared-database-worker-Legacy123.js",
);
assert.equal(publicAssetRequest?.headers.get("authorization"), null);
assert.equal(publicAssetRequest?.headers.get("cookie"), null);
assert.equal(publicAssetRequest?.headers.get("range"), "bytes=0-1023");
assert.equal(
  await publicOriginProxiedAsset.text(),
  "export const publicWorker = true;",
);

async function requestSharedPage({ appOrigin, query = "", metaResponse }) {
  let observedUrl = null;
  let observedHeaders = null;
  globalThis.fetch = (input, init) => {
    observedUrl = String(input);
    observedHeaders = new Headers(init?.headers);
    return Promise.resolve(metaResponse());
  };
  const response = await worker.fetch(
    new Request(`${appOrigin}/share/threads/${sharedThreadId}${query}`),
    assetEnvironment(),
  );
  return { response, observedUrl, observedHeaders };
}

const preview = await requestSharedPage({
  appOrigin: "https://pr-25304-app.omby.ai",
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
