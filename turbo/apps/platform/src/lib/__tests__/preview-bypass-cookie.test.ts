import { describe, expect, it, vi } from "vitest";

import {
  appendPreviewBypassToUrl,
  buildPreviewBypassCookie,
  writePreviewBypassCookie,
} from "../preview-bypass-cookie.ts";

describe("preview bypass cookie", () => {
  it("builds a host-only Vercel bypass cookie from the standard query", () => {
    expect(
      buildPreviewBypassCookie({
        hostname: "pr-123-app.omby.ai",
        protocol: "https:",
        search: "?x-vercel-protection-bypass=preview-secret",
      }),
    ).toBe(
      "x-vercel-protection-bypass=preview-secret; Path=/; Max-Age=3600; SameSite=Lax; Secure",
    );
  });

  it("falls back to a host-only cookie outside vm6.ai", () => {
    expect(
      buildPreviewBypassCookie({
        hostname: "localhost",
        protocol: "http:",
        search: "?x-vercel-protection-bypass=preview-secret",
      }),
    ).toBe(
      "x-vercel-protection-bypass=preview-secret; Path=/; Max-Age=3600; SameSite=Lax",
    );
  });

  it("writes the cookie when the bypass query is present", () => {
    const setCookie = vi.fn<(cookie: string) => void>();

    expect(
      writePreviewBypassCookie(
        {
          hostname: "staging-app.omby.ai",
          protocol: "https:",
          search: "?x-vercel-protection-bypass=preview%20secret",
        },
        setCookie,
      ),
    ).toBeTruthy();
    expect(setCookie).toHaveBeenCalledWith(
      "x-vercel-protection-bypass=preview%20secret; Path=/; Max-Age=3600; SameSite=Lax; Secure",
    );
  });

  it("forwards an omby host cookie only to the matching vm6 API", () => {
    const location = {
      hostname: "pr-22085-app.omby.ai",
      protocol: "https:",
      search: "",
    };
    const cookie = "x-vercel-protection-bypass=preview%20secret";
    const apiUrl = new URL("https://pr-22085-api.vm6.ai/api/okou/status");
    const lookalikeUrl = new URL(
      "https://pr-22085-api.vm6.ai.evil.example/api/okou/status",
    );
    const otherPreviewUrl = new URL(
      "https://pr-22086-api.vm6.ai/api/okou/status",
    );
    const wwwUrl = new URL(
      "https://pr-22085-www.vm6.ai/connector/success?x-vercel-protection-bypass=stale",
    );

    appendPreviewBypassToUrl(apiUrl, location, cookie);
    appendPreviewBypassToUrl(lookalikeUrl, location, cookie);
    appendPreviewBypassToUrl(otherPreviewUrl, location, cookie);
    appendPreviewBypassToUrl(wwwUrl, location, cookie);

    expect(apiUrl.searchParams.get("x-vercel-protection-bypass")).toBe(
      "preview secret",
    );
    expect(
      lookalikeUrl.searchParams.has("x-vercel-protection-bypass"),
    ).toBeFalsy();
    expect(
      otherPreviewUrl.searchParams.has("x-vercel-protection-bypass"),
    ).toBeFalsy();
    expect(wwwUrl.searchParams.has("x-vercel-protection-bypass")).toBeFalsy();
  });

  it("forwards a Worker preview cookie only to its matching vm6 API", () => {
    const location = {
      hostname: "pr-22085-app-okou-app-preview.vm0.workers.dev",
      protocol: "https:",
      search: "?x-vercel-protection-bypass=preview-secret",
    };
    const matchingApiUrl = new URL(
      "https://pr-22085-api.vm6.ai/api/okou/status",
    );
    const otherApiUrl = new URL("https://pr-22086-api.vm6.ai/api/okou/status");

    appendPreviewBypassToUrl(matchingApiUrl, location, "");
    appendPreviewBypassToUrl(otherApiUrl, location, "");

    expect(matchingApiUrl.searchParams.get("x-vercel-protection-bypass")).toBe(
      "preview-secret",
    );
    expect(
      otherApiUrl.searchParams.has("x-vercel-protection-bypass"),
    ).toBeFalsy();
  });
});
