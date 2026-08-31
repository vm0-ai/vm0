import assert from "node:assert/strict";
import { test } from "node:test";

import type { BrowserContext } from "@playwright/test";

import {
  installPreviewBypassCookie,
  previewBypassCookie,
} from "./preview-bypass";

test("builds an app-readable host-only preview bypass cookie", () => {
  assert.deepEqual(
    previewBypassCookie(
      "https://pr-30474-app.omby.ai/path",
      "preview secret/value",
    ),
    {
      name: "x-vercel-protection-bypass",
      value: "preview%20secret%2Fvalue",
      url: "https://pr-30474-app.omby.ai",
      sameSite: "Lax",
      secure: true,
    },
  );
});

test("installs the preview bypass cookie before the browser uses the context", async () => {
  const calls: Parameters<BrowserContext["addCookies"]>[0][] = [];
  await installPreviewBypassCookie(
    {
      addCookies: (cookies) => {
        calls.push(cookies);
        return Promise.resolve();
      },
    },
    "http://127.0.0.1:3000",
    "local-secret",
  );

  assert.deepEqual(calls, [
    [
      {
        name: "x-vercel-protection-bypass",
        value: "local-secret",
        url: "http://127.0.0.1:3000",
        sameSite: "Lax",
        secure: false,
      },
    ],
  ]);
});
