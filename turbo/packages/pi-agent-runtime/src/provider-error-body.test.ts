import { describe, expect, it } from "vitest";

import { preserveProviderErrorStatus } from "./provider-error-body";

const REQUEST_URL = "https://provider.example/responses";

function respondWith(
  status: number,
  body: string | null,
  headers: Record<string, string> = {},
): NonNullable<Parameters<typeof preserveProviderErrorStatus>[0]> {
  return () => {
    return Promise.resolve(new Response(body, { status, headers }));
  };
}

async function normalizedBody(
  status: number,
  body: string | null,
  headers?: Record<string, string>,
): Promise<{ response: Response; text: string }> {
  const response = await preserveProviderErrorStatus(
    respondWith(status, body, headers),
  )(REQUEST_URL);
  return { response, text: await response.text() };
}

describe("Pi provider error body boundary", () => {
  it("restates an Envoy local reply with its observed status", async () => {
    const { response, text } = await normalizedBody(
      503,
      "no healthy upstream",
      {
        "content-type": "text/plain",
      },
    );

    expect(response.status).toBe(503);
    expect(JSON.parse(text)).toStrictEqual({
      error: {
        message: "provider HTTP 503: no healthy upstream",
        type: "http_error",
      },
    });
    expect(response.headers.get("content-type")).toBe("application/json");
  });

  it("reduces an edge HTML error page to one readable phrase", async () => {
    const page = [
      "<!doctype html><html><head>",
      '<meta name="viewport" content="width=device-width, initial-scale=1">',
      "<style>body { color: red }</style>",
      "<script>console.log('noise')</script>",
      "</head><body><h1>Service Unavailable</h1></body></html>",
    ].join("");

    const { text } = await normalizedBody(502, page, {
      "content-type": "text/html",
    });

    const { message } = (JSON.parse(text) as { error: { message: string } })
      .error;
    expect(message).toBe("provider HTTP 502: Service Unavailable");
    expect(message).not.toContain("console.log");
    expect(message).not.toContain("viewport");
    expect(message).not.toContain("<");
  });

  it("keeps the status alone when the body carries no phrase", async () => {
    const { text } = await normalizedBody(503, "   \n  ");

    expect((JSON.parse(text) as { error: { message: string } }).error).toEqual({
      message: "provider HTTP 503",
      type: "http_error",
    });
  });

  it("bounds a long opaque body", async () => {
    const { text } = await normalizedBody(500, "upstream ".repeat(1000));

    const { message } = (JSON.parse(text) as { error: { message: string } })
      .error;
    expect(message.startsWith("provider HTTP 500: upstream upstream")).toBe(
      true,
    );
    expect(message.endsWith("...")).toBe(true);
    expect(message.length).toBeLessThan(250);
  });

  it.each([
    ['{"error":{"message":"You have hit your ChatGPT usage limit."}}', 429],
    ['{"error":"insufficient_credits"}', 402],
    ['{"error":{"code":"token_refresh_failed"}}', 401],
  ])(
    "leaves the provider-authored envelope %s untouched",
    async (body, status) => {
      const { response, text } = await normalizedBody(status, body, {
        "content-type": "application/json",
      });

      expect(response.status).toBe(status);
      expect(text).toBe(body);
    },
  );

  it("passes an oversized body through without normalization", async () => {
    const body = "x".repeat(70 * 1024);

    const { text } = await normalizedBody(503, body);

    expect(text).toBe(body);
  });

  it.each([200, 201])(
    "never touches a successful response %i",
    async (status) => {
      const { response, text } = await normalizedBody(
        status,
        "event: done\n\n",
      );

      expect(response.status).toBe(status);
      expect(text).toBe("event: done\n\n");
    },
  );

  it("preserves a bodyless failure status", async () => {
    const { response, text } = await normalizedBody(304, null);

    expect(response.status).toBe(304);
    expect(text).toBe("");
  });
});
