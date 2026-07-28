import { waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

describe("document title branding", () => {
  it.each([
    ["https://app.okou.ai/", "Team | Okou"],
    ["https://console.okou.ai/", "Team | Okou"],
    ["https://pr-23382-app.omby.ai/", "Team | Okou"],
    ["https://3508a2f5.okou-app.pages.dev/", "Team | Okou"],
    ["https://app.okou.ai:8443/", "Team | Okou"],
    ["https://app.vm0.ai/", "Team | VM0"],
    ["https://pr-23382-app.vm6.ai/", "Team | VM0"],
    ["http://localhost:3002/", "Team | VM0"],
    ["https://okou.ai.evil.example/", "Team | VM0"],
    ["https://omby.ai.evil.example/", "Team | VM0"],
    ["https://okou-app.pages.dev.evil.example/", "Team | VM0"],
  ])("uses the matching brand on %s", async (url, title) => {
    window.location.href = url;

    detachedSetupPage({ context, path: "/agents" });

    await waitFor(() => {
      expect(document.title).toBe(title);
    });
  });
});
