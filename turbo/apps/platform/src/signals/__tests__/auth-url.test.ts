import { describe, expect, it } from "vitest";
import { resolveWebAuthUrl, resolveWebOrigin } from "../auth.ts";

function setLocation(url: string): void {
  window.location.href = url;
}

describe("platform auth URLs", () => {
  it("derives the web origin from the app origin", () => {
    setLocation("https://pr-18532-app.vm6.ai/agents");

    expect(resolveWebOrigin()).toBe("https://pr-18532-www.vm6.ai");
  });

  it("adds the PR API domain override to vm6 auth URLs", () => {
    setLocation("https://pr-18532-app.vm6.ai/agents");

    expect(resolveWebAuthUrl("/sign-in")).toBe(
      "https://pr-18532-www.vm6.ai/sign-in?domain=pr-18532-api.vm6.ai",
    );
    expect(resolveWebAuthUrl("/sign-in/tasks/choose-organization")).toBe(
      "https://pr-18532-www.vm6.ai/sign-in/tasks/choose-organization?domain=pr-18532-api.vm6.ai",
    );
    expect(
      resolveWebAuthUrl("/sign-in", {
        redirectUrl: "https://pr-18532-app.vm6.ai/",
      }),
    ).toBe(
      "https://pr-18532-www.vm6.ai/sign-in?domain=pr-18532-api.vm6.ai&redirect_url=https%3A%2F%2Fpr-18532-app.vm6.ai%2F",
    );
  });

  it("does not add a domain override outside vm6 preview origins", () => {
    setLocation("https://app.vm0.ai/agents");

    expect(resolveWebAuthUrl("/sign-in")).toBe("https://www.vm0.ai/sign-in");
  });
});
