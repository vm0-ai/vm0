import { describe, expect, it, vi } from "vitest";

import {
  buildPreviewBypassCookie,
  writePreviewBypassCookie,
} from "../preview-bypass-cookie.ts";

describe("preview bypass cookie", () => {
  it("builds a vm6.ai scoped Vercel bypass cookie from the standard query", () => {
    expect(
      buildPreviewBypassCookie({
        hostname: "pr-123-app.vm6.ai",
        protocol: "https:",
        search: "?x-vercel-protection-bypass=preview-secret",
      }),
    ).toBe(
      "x-vercel-protection-bypass=preview-secret; Path=/; Max-Age=3600; SameSite=Lax; Domain=.vm6.ai; Secure",
    );
  });

  it("does not read legacy vm0 preview bypass query params", () => {
    expect(
      buildPreviewBypassCookie({
        hostname: "pr-123-app.vm6.ai",
        protocol: "https:",
        search: "?vm0_preview_bypass=preview-secret",
      }),
    ).toBeNull();
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
    const setCookie = vi.fn();

    expect(
      writePreviewBypassCookie(
        {
          hostname: "staging-app.vm6.ai",
          protocol: "https:",
          search: "?x-vercel-protection-bypass=preview%20secret",
        },
        setCookie,
      ),
    ).toBeTruthy();
    expect(setCookie).toHaveBeenCalledWith(
      "x-vercel-protection-bypass=preview%20secret; Path=/; Max-Age=3600; SameSite=Lax; Domain=.vm6.ai; Secure",
    );
  });
});
