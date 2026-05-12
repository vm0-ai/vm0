import { env } from "../env";

const HOP_BY_HOP_HEADERS: Readonly<Record<string, true>> = {
  connection: true,
  "content-length": true,
  host: true,
  "keep-alive": true,
  "proxy-authenticate": true,
  "proxy-authorization": true,
  te: true,
  trailer: true,
  "transfer-encoding": true,
  upgrade: true,
};

function isHopByHopHeader(name: string): boolean {
  return Object.hasOwn(HOP_BY_HOP_HEADERS, name.toLowerCase());
}

function buildProxyHeaders(request: Request): Headers {
  const headers = new Headers();
  for (const [key, value] of request.headers) {
    if (!isHopByHopHeader(key)) {
      headers.set(key, value);
    }
  }
  const requestUrl = new URL(request.url);
  headers.set("x-forwarded-host", requestUrl.host);
  headers.set("x-forwarded-proto", requestUrl.protocol.replace(":", ""));
  return headers;
}

function buildProxyResponse(response: Response): Response {
  const headers = new Headers();
  for (const [key, value] of response.headers) {
    if (key.toLowerCase() !== "set-cookie" && !isHopByHopHeader(key)) {
      headers.set(key, value);
    }
  }
  const cookies = response.headers.getSetCookie();
  if (cookies.length > 0) {
    for (const cookie of cookies) {
      headers.append("set-cookie", cookie);
    }
  } else {
    const cookie = response.headers.get("set-cookie");
    if (cookie) {
      headers.set("set-cookie", cookie);
    }
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export async function proxyToApiBackend(request: Request): Promise<Response> {
  const requestUrl = new URL(request.url);
  const apiBackendUrl = env().VM0_API_BACKEND_URL;
  if (!apiBackendUrl) {
    return Response.json(
      {
        error: {
          message: "API backend is not configured",
          code: "BAD_GATEWAY",
        },
      },
      { status: 502 },
    );
  }

  const target = new URL(
    `${requestUrl.pathname}${requestUrl.search}`,
    apiBackendUrl,
  );

  const init: RequestInit & { duplex?: "half" } = {
    method: request.method,
    headers: buildProxyHeaders(request),
    redirect: "manual",
    signal: request.signal,
  };

  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = request.body;
    init.duplex = "half";
  }

  const response = await fetch(target, init);
  return buildProxyResponse(response);
}
