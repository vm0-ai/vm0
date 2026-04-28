import type { TsRestRequest, TsRestResponse } from "@ts-rest/serverless";

import { env } from "../../env";
import { logger } from "../shared/logger";

const log = logger("response-shadow");

interface ShadowCompareOptions {
  readonly request: TsRestRequest;
  readonly response: TsRestResponse;
  readonly route: string;
}

interface Difference {
  readonly path: string;
  readonly web: unknown;
  readonly api: unknown;
}

/**
 * Replay the just-served request against the api app and compare the response.
 *
 * Forward only the auth-bearing headers (authorization, cookie) — passing all
 * headers would forward `host` and friends, which the api side would
 * misinterpret. Body is read from `response.rawBody`, which TsRestResponse
 * already serialized synchronously, so no stream cloning is needed.
 *
 * Designed to run inside `after()` after the response is already on the wire,
 * so the 2s timeout on the replay is invisible to callers.
 */
export async function shadowCompareResponse({
  request,
  response,
  route,
}: ShadowCompareOptions): Promise<void> {
  const apiUrl = env().VM0_API_BACKEND_URL;
  if (!apiUrl) {
    return;
  }

  const url = new URL(request.url);
  const target = new URL(`${url.pathname}${url.search}`, apiUrl).toString();

  const headers: Record<string, string> = {};
  const auth = request.headers.get("authorization");
  if (auth) headers.authorization = auth;
  const cookie = request.headers.get("cookie");
  if (cookie) headers.cookie = cookie;

  const apiFetch = await fetch(target, {
    method: request.method,
    headers,
    signal: AbortSignal.timeout(2000),
  }).catch((err: unknown) => {
    return err instanceof Error ? err : new Error(String(err));
  });

  if (apiFetch instanceof Error) {
    log.warn("response shadow request failed", {
      route,
      error: apiFetch.message,
    });
    return;
  }

  const webBody = parseWebBody(response.rawBody);
  const apiBodyText = await apiFetch.text();
  const apiBody = parseJson(apiBodyText);

  const differences: Difference[] = [];
  if (response.status !== apiFetch.status) {
    differences.push({
      path: "status",
      web: response.status,
      api: apiFetch.status,
    });
  }
  diffJson(webBody, apiBody, "body", differences);

  if (differences.length > 0) {
    log.warn("response shadow divergence", {
      route,
      method: request.method,
      path: url.pathname,
      webStatus: response.status,
      apiStatus: apiFetch.status,
      differences,
    });
  }
}

function parseWebBody(rawBody: TsRestResponse["rawBody"]): unknown {
  if (typeof rawBody === "string") {
    return parseJson(rawBody);
  }
  // Non-string bodies (Blob/ArrayBuffer/null) — return a sentinel so a body
  // mismatch surfaces without spamming the diff with binary content.
  return { __nonJsonBody: true };
}

function parseJson(text: string): unknown {
  if (text === "") return null;
  try {
    return JSON.parse(text);
  } catch {
    return { __invalidJson: text.slice(0, 200) };
  }
}

function diffJson(
  web: unknown,
  api: unknown,
  path: string,
  out: Difference[],
): void {
  if (Object.is(web, api)) return;

  if (
    web !== null &&
    api !== null &&
    typeof web === "object" &&
    typeof api === "object"
  ) {
    if (Array.isArray(web) || Array.isArray(api)) {
      if (!Array.isArray(web) || !Array.isArray(api)) {
        out.push({ path, web, api });
        return;
      }
      const len = Math.max(web.length, api.length);
      for (let i = 0; i < len; i++) {
        diffJson(web[i], api[i], `${path}[${i}]`, out);
      }
      return;
    }
    const keys = new Set([
      ...Object.keys(web as Record<string, unknown>),
      ...Object.keys(api as Record<string, unknown>),
    ]);
    for (const key of keys) {
      diffJson(
        (web as Record<string, unknown>)[key],
        (api as Record<string, unknown>)[key],
        `${path}.${key}`,
        out,
      );
    }
    return;
  }

  if (web !== api) {
    out.push({ path, web, api });
  }
}
