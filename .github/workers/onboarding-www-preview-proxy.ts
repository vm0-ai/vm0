interface Env {
  readonly API_BACKEND_BYPASS_SECRET: string;
  readonly API_BACKEND_ORIGIN: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!env.API_BACKEND_BYPASS_SECRET) {
      throw new Error("API_BACKEND_BYPASS_SECRET is required");
    }
    if (!env.API_BACKEND_ORIGIN) {
      throw new Error("API_BACKEND_ORIGIN is required");
    }

    const requestUrl = new URL(request.url);
    const apiUrl = new URL(env.API_BACKEND_ORIGIN);
    apiUrl.pathname = requestUrl.pathname;
    apiUrl.search = requestUrl.search;
    const upstreamRequest = new Request(apiUrl, request);
    const headers = new Headers(upstreamRequest.headers);
    headers.delete("host");
    headers.set("x-forwarded-host", requestUrl.host);
    headers.set("x-forwarded-proto", requestUrl.protocol.slice(0, -1));
    headers.set("x-vm0-pathname", requestUrl.pathname);
    headers.set("x-vm0-web-origin", requestUrl.origin);
    headers.set("x-vercel-protection-bypass", env.API_BACKEND_BYPASS_SECRET);

    return fetch(
      new Request(upstreamRequest, {
        headers,
        redirect: "manual",
      }),
    );
  },
};
