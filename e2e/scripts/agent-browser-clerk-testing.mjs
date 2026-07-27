#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";

const TOKEN_RETRYABLE_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504]);
const FAPI_RETRYABLE_STATUS_CODES = new Set([429, 502, 503, 504]);
const MAX_TOKEN_RETRIES = 5;
const MAX_FAPI_RETRIES = 3;
const BASE_DELAY_MS = 500;
const JITTER_MAX_MS = 250;

function delay(attempt) {
  const duration = BASE_DELAY_MS * 2 ** attempt + Math.random() * JITTER_MAX_MS;
  return new Promise((resolve) => setTimeout(resolve, duration));
}

function parseFrontendApi(publishableKey) {
  const prefix = ["pk_test_", "pk_live_"].find((candidate) =>
    publishableKey.startsWith(candidate),
  );
  if (!prefix) {
    throw new Error("Unsupported Clerk publishable key");
  }

  const encoded = publishableKey
    .slice(prefix.length)
    .replaceAll("-", "+")
    .replaceAll("_", "/");
  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  if (!decoded.endsWith("$")) {
    throw new Error("Invalid Clerk publishable key");
  }

  return decoded.slice(0, -1);
}

async function createTestingToken() {
  const secretKey = process.env.CLERK_SECRET_KEY;
  if (!secretKey) {
    throw new Error("CLERK_SECRET_KEY is required");
  }

  for (let attempt = 0; attempt <= MAX_TOKEN_RETRIES; attempt += 1) {
    let response;
    try {
      response = await fetch("https://api.clerk.com/v1/testing_tokens", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${secretKey}`,
          "Content-Type": "application/json",
        },
      });
    } catch (error) {
      if (attempt === MAX_TOKEN_RETRIES) {
        throw error;
      }
      await delay(attempt);
      continue;
    }

    if (response.ok) {
      const body = await response.json();
      if (typeof body.token !== "string" || body.token.length === 0) {
        throw new Error("Clerk testing token response did not include a token");
      }
      return body.token;
    }

    if (
      !TOKEN_RETRYABLE_STATUS_CODES.has(response.status) ||
      attempt === MAX_TOKEN_RETRIES
    ) {
      throw new Error(
        `Clerk testing token request failed with status ${response.status}`,
      );
    }

    await delay(attempt);
  }

  throw new Error("Clerk testing token retry loop exhausted");
}

async function prepare(configPath) {
  const publishableKey = process.env.CLERK_PUBLISHABLE_KEY;
  if (!publishableKey) {
    throw new Error("CLERK_PUBLISHABLE_KEY is required");
  }

  const config = {
    frontendApi: parseFrontendApi(publishableKey),
    testingToken: await createTestingToken(),
  };
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
}

class CdpClient {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.nextId = 1;
    this.pending = new Map();
    this.eventHandler = undefined;
  }

  async connect() {
    await new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener(
        "error",
        () => reject(new Error("Failed to connect to agent-browser CDP")),
        { once: true },
      );
    });

    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (typeof message.id === "number") {
        const pending = this.pending.get(message.id);
        if (!pending) {
          return;
        }
        this.pending.delete(message.id);
        if (message.error) {
          pending.reject(new Error(message.error.message));
        } else {
          pending.resolve(message.result);
        }
        return;
      }

      this.eventHandler?.(message);
    });
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId;
    this.nextId += 1;
    const message = { id, method, params };
    if (sessionId) {
      message.sessionId = sessionId;
    }

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify(message));
    });
  }
}

function createFetchRetryScript(frontendApi) {
  return `(() => {
    const originalFetch = window.fetch.bind(window);
    const retryableStatuses = new Set(${JSON.stringify([...FAPI_RETRYABLE_STATUS_CODES])});
    const frontendApiOrigin = ${JSON.stringify(`https://${frontendApi}`)};
    const maxRetries = ${MAX_FAPI_RETRIES};
    const baseDelayMs = ${BASE_DELAY_MS};
    const jitterMaxMs = ${JITTER_MAX_MS};

    window.fetch = async (input, init) => {
      const rawUrl = input instanceof Request ? input.url : String(input);
      const url = new URL(rawUrl, window.location.href);
      if (
        url.origin !== frontendApiOrigin ||
        !url.pathname.startsWith("/v1/")
      ) {
        return originalFetch(input, init);
      }

      for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        let response;
        try {
          const attemptInput = input instanceof Request ? input.clone() : input;
          response = await originalFetch(attemptInput, init);
        } catch (error) {
          if (attempt === maxRetries) {
            throw error;
          }

          const delayMs =
            baseDelayMs * 2 ** attempt + Math.random() * jitterMaxMs;
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          continue;
        }

        if (!retryableStatuses.has(response.status) || attempt === maxRetries) {
          return response;
        }

        const delayMs =
          baseDelayMs * 2 ** attempt + Math.random() * jitterMaxMs;
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }

      throw new Error("Clerk Frontend API retry loop exhausted");
    };
  })();`;
}

async function handlePausedResponse(client, sessionId, params) {
  const { requestId, responseStatusCode, responseStatusText } = params;
  try {
    const { body, base64Encoded } = await client.send(
      "Fetch.getResponseBody",
      { requestId },
      sessionId,
    );
    const decodedBody = base64Encoded
      ? Buffer.from(body, "base64").toString("utf8")
      : body;
    let json;
    try {
      json = JSON.parse(decodedBody);
    } catch {
      await client.send("Fetch.continueResponse", { requestId }, sessionId);
      return;
    }

    let changed = false;
    if (json?.response?.captcha_bypass === false) {
      json.response.captcha_bypass = true;
      changed = true;
    }
    if (json?.client?.captcha_bypass === false) {
      json.client.captcha_bypass = true;
      changed = true;
    }

    if (!changed) {
      await client.send("Fetch.continueResponse", { requestId }, sessionId);
      return;
    }

    const responseHeaders = (params.responseHeaders ?? []).filter(
      ({ name }) =>
        !["content-encoding", "content-length"].includes(name.toLowerCase()),
    );
    const fulfillParams = {
      requestId,
      responseCode: responseStatusCode,
      responseHeaders,
      body: Buffer.from(JSON.stringify(json)).toString("base64"),
    };
    if (responseStatusText) {
      fulfillParams.responsePhrase = responseStatusText;
    }

    await client.send("Fetch.fulfillRequest", fulfillParams, sessionId);
    console.log(
      `normalized captcha bypass ${new URL(params.request.url).pathname}`,
    );
  } catch (error) {
    console.error(`Failed to inspect Clerk response: ${error.message}`);
    await client.send("Fetch.continueResponse", { requestId }, sessionId);
  }
}

async function intercept(configPath) {
  const cdpUrl = process.env.AGENT_BROWSER_CDP_URL;
  if (!cdpUrl) {
    throw new Error("AGENT_BROWSER_CDP_URL is required");
  }

  const config = JSON.parse(await readFile(configPath, "utf8"));
  const client = new CdpClient(cdpUrl);
  await client.connect();

  const { targetInfos } = await client.send("Target.getTargets");
  const pageTarget = targetInfos.find((target) => target.type === "page");
  if (!pageTarget) {
    throw new Error("agent-browser page target was not found");
  }

  const { sessionId } = await client.send("Target.attachToTarget", {
    targetId: pageTarget.targetId,
    flatten: true,
  });

  const frontendApiPattern = `https://${config.frontendApi}/v1/*`;
  client.eventHandler = (message) => {
    if (
      message.method !== "Fetch.requestPaused" ||
      message.sessionId !== sessionId
    ) {
      return;
    }

    if (typeof message.params.responseStatusCode === "number") {
      void handlePausedResponse(client, sessionId, message.params).catch(
        (error) => {
          console.error(`Failed to continue Clerk response: ${error.message}`);
        },
      );
      return;
    }

    const { requestId, request } = message.params;
    const url = new URL(request.url);
    url.searchParams.set("__clerk_testing_token", config.testingToken);
    console.log(`decorated ${url.pathname}`);
    void client
      .send(
        "Fetch.continueRequest",
        { requestId, url: url.toString() },
        sessionId,
      )
      .catch((error) => {
        console.error(`Failed to continue Clerk request: ${error.message}`);
      });
  };

  await client.send(
    "Page.addScriptToEvaluateOnNewDocument",
    { source: createFetchRetryScript(config.frontendApi) },
    sessionId,
  );
  await client.send(
    "Fetch.enable",
    {
      patterns: [
        { urlPattern: frontendApiPattern, requestStage: "Request" },
        { urlPattern: frontendApiPattern, requestStage: "Response" },
      ],
    },
    sessionId,
  );

  console.log("ready");
}

const [command, configPath] = process.argv.slice(2);
if (!command || !configPath) {
  throw new Error(
    "Usage: agent-browser-clerk-testing.mjs <prepare|intercept> <config-path>",
  );
}

if (command === "prepare") {
  await prepare(configPath);
} else if (command === "intercept") {
  await intercept(configPath);
} else {
  throw new Error(`Unknown command: ${command}`);
}
