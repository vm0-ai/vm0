import { describe, expect, it } from "vitest";
import { branding$ } from "../branding.ts";
import { updateDocumentTitle$ } from "../document-title.ts";
import { testContext } from "./test-helpers.ts";

const context = testContext();

describe("platform branding", () => {
  it.each([
    "https://app.okou.ai/",
    "https://console.okou.ai/",
    "https://pr-23382-app.omby.ai/",
    "https://3508a2f5.okou-app.pages.dev/",
    "https://app.okou.ai:8443/",
  ])("uses okou branding on %s", (url) => {
    window.location.href = url;

    expect(context.store.get(branding$)).toBe("okou");
  });

  it.each([
    "https://app.vm0.ai/",
    "https://pr-23382-app.vm6.ai/",
    "http://localhost:3002/",
    "https://okou.ai.evil.example/",
    "https://omby.ai.evil.example/",
    "https://okou-app.pages.dev.evil.example/",
  ])("uses vm0 branding on %s", (url) => {
    window.location.href = url;

    expect(context.store.get(branding$)).toBe("vm0");
  });

  it.each([
    ["https://app.okou.ai/", "Agents | Okou"],
    ["https://app.vm0.ai/", "Agents | VM0"],
  ])("uses the current branding in the document title on %s", (url, title) => {
    window.location.href = url;

    context.store.set(updateDocumentTitle$, "Agents");

    expect(document.title).toBe(title);
  });
});
