import { describe, expect, it } from "vitest";

import {
  resolveAssistantNameForHostname,
  resolveBrandNameForHostname,
} from "../branding.ts";

describe("public branding", () => {
  it.each([
    ["app.okou.ai", "Okou", "Okou"],
    ["pr-27200-app.omby.ai", "Okou", "Okou"],
    ["app.vm0.ai", "VM0", "Zero"],
    ["localhost", "VM0", "Zero"],
  ] as const)(
    "maps %s to brand %s and assistant %s",
    (hostname, brandName, assistantName) => {
      expect(resolveBrandNameForHostname(hostname)).toBe(brandName);
      expect(resolveAssistantNameForHostname(hostname)).toBe(assistantName);
    },
  );
});
