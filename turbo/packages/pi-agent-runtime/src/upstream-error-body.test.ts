import { describe, expect, it } from "vitest";

import {
  UPSTREAM_NON_API_RESPONSE_MARKER,
  describeUpstreamNonApiResponse,
  guardPiUpstreamErrorBody,
  isMarkupDocumentBody,
} from "./upstream-error-body";

const ERROR_PAGE = [
  "<html>",
  "  <head><style global>body{font-family:Arial}.logo{color:#8e8ea0}</style></head>",
  "  <body>",
  '    <div class="container"><svg viewBox="0 0 41 41"><path d="M37.5324 16.8707" /></svg></div>',
  "  </body>",
  "</html>",
].join("\n");

function respondWith(
  body: string | null,
  init: ResponseInit,
): NonNullable<Parameters<typeof guardPiUpstreamErrorBody>[0]> {
  return () => {
    return Promise.resolve(new Response(body, init));
  };
}

describe("Pi upstream error body guard", () => {
  it("replaces a failed markup body with a bounded description", async () => {
    const guarded = guardPiUpstreamErrorBody(
      respondWith(ERROR_PAGE, {
        status: 502,
        statusText: "Bad Gateway",
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
    );

    const response = await guarded("https://provider.example/v1/responses");
    const text = await response.text();

    expect(response.status).toBe(502);
    expect(response.statusText).toBe("Bad Gateway");
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(text).not.toContain("<html");
    expect(text).not.toContain("<svg");
    expect(text).not.toContain("8e8ea0");
    expect(JSON.parse(text)).toStrictEqual({
      error: {
        type: UPSTREAM_NON_API_RESPONSE_MARKER,
        message: describeUpstreamNonApiResponse({
          status: 502,
          contentType: "text/html; charset=utf-8",
          body: ERROR_PAGE,
        }),
      },
    });
  });

  it("records the observed status and content type in the description", () => {
    const message = describeUpstreamNonApiResponse({
      status: 525,
      contentType: "text/html; charset=utf-8",
      body: ERROR_PAGE,
    });

    expect(message).toMatch(
      /^upstream_non_api_response status=525 content_type=html bytes=\d+ digest=[0-9a-f]{8}$/u,
    );
    expect(message).toContain(
      `bytes=${new TextEncoder().encode(ERROR_PAGE).length}`,
    );
  });

  it.each([
    { contentType: "application/json", expected: "content_type=json" },
    { contentType: "text/plain", expected: "content_type=text" },
    { contentType: "application/octet-stream", expected: "content_type=other" },
    { contentType: null, expected: "content_type=unknown" },
  ])(
    "annotates $contentType without letting it override the body",
    ({ contentType, expected }) => {
      const message = describeUpstreamNonApiResponse({
        status: 503,
        contentType,
        body: ERROR_PAGE,
      });

      expect(message).toContain(expected);
      expect(message).toContain(UPSTREAM_NON_API_RESPONSE_MARKER);
    },
  );

  it("groups identical pages and separates different ones by digest", () => {
    const shared = { status: 502, contentType: "text/html" } as const;
    const first = describeUpstreamNonApiResponse({
      ...shared,
      body: ERROR_PAGE,
    });
    const repeat = describeUpstreamNonApiResponse({
      ...shared,
      body: ERROR_PAGE,
    });
    const other = describeUpstreamNonApiResponse({
      ...shared,
      body: `${ERROR_PAGE}<!-- other -->`,
    });

    expect(first).toBe(repeat);
    expect(first).not.toBe(other);
  });

  it.each([
    {
      name: "structured provider error",
      contentType: "application/json",
      body: '{"error":{"code":"rate_limit_exceeded","message":"You have hit your usage limit."}}',
    },
    {
      name: "plain text provider error",
      contentType: "text/plain",
      body: "You've hit your usage limit. Try again in ~13 min.",
    },
    {
      name: "empty body",
      contentType: "text/plain",
      body: "",
    },
  ])("preserves a $name verbatim", async ({ contentType, body }) => {
    const guarded = guardPiUpstreamErrorBody(
      respondWith(body, {
        status: 429,
        headers: { "content-type": contentType },
      }),
    );

    const response = await guarded("https://provider.example/v1/responses");

    expect(await response.text()).toBe(body);
    expect(response.status).toBe(429);
    expect(response.headers.get("content-type")).toBe(contentType);
  });

  it("leaves a successful streamed response untouched", async () => {
    const upstream = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("data: {}\n\n"));
          controller.close();
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
    const guarded = guardPiUpstreamErrorBody(() => {
      return Promise.resolve(upstream);
    });

    const response = await guarded("https://provider.example/v1/responses");

    expect(response).toBe(upstream);
    expect(response.bodyUsed).toBe(false);
    expect(await response.text()).toBe("data: {}\n\n");
  });

  it("leaves a failed response without a body untouched", async () => {
    const upstream = new Response(null, { status: 504 });
    const guarded = guardPiUpstreamErrorBody(() => {
      return Promise.resolve(upstream);
    });

    expect(await guarded("https://provider.example/v1/responses")).toBe(
      upstream,
    );
  });

  it("drops transfer framing the consumed body invalidated", async () => {
    const guarded = guardPiUpstreamErrorBody(
      respondWith(ERROR_PAGE, {
        status: 502,
        headers: {
          "content-type": "text/html",
          "content-encoding": "gzip",
          "x-request-id": "request-42",
        },
      }),
    );

    const response = await guarded("https://provider.example/v1/responses");

    expect(response.headers.get("content-encoding")).toBeNull();
    expect(response.headers.get("content-length")).toBeNull();
    expect(response.headers.get("x-request-id")).toBe("request-42");
  });

  it.each([
    {
      name: "doctype page",
      body: "<!DOCTYPE html><html><body>x</body></html>",
    },
    {
      name: "leading whitespace page",
      body: "\n  <html><body>x</body></html>",
    },
    {
      name: "bare svg document",
      body: '<svg xmlns="http://www.w3.org/2000/svg" />',
    },
  ])("detects a $name as markup", ({ body }) => {
    expect(isMarkupDocumentBody(body)).toBe(true);
  });

  it.each([
    { name: "json object", body: '{"error":{"message":"<html> in text"}}' },
    { name: "plain sentence", body: "Overloaded" },
    { name: "empty body", body: "" },
    {
      name: "xml without markup document markers",
      body: "<Error><Code>x</Code></Error>",
    },
  ])("does not treat a $name as markup", ({ body }) => {
    expect(isMarkupDocumentBody(body)).toBe(false);
  });
});
