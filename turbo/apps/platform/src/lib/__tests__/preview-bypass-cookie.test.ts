import { expect, test, vi } from "vitest";

import {
  appendPreviewBypassToUrl,
  buildPreviewBypassCookie,
  writePreviewBypassCookie,
} from "../preview-bypass-cookie.ts";

test("A protected preview link remains usable on a secure preview host", () => {
  expect(
    buildPreviewBypassCookie({
      hostname: "pr-123-app.omby.ai",
      protocol: "https:",
      search: "?x-vercel-protection-bypass=preview-secret",
    }),
  ).toBe(
    "x-vercel-protection-bypass=preview-secret; Path=/; Max-Age=3600; SameSite=Lax; Secure",
  );

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

test("A protected preview link works in local HTTP development", () => {
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

test("A preview credential only reaches its matching Platform service", () => {
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
