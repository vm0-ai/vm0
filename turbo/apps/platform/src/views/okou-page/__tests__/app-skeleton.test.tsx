import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  detachedSetupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

describe("app skeleton", () => {
  it("removes the inline loading surface after the page is ready", async () => {
    const bootstrapSkeleton = document.createElement("div");
    bootstrapSkeleton.id = "app-bootstrap-skeleton";
    document.body.append(bootstrapSkeleton);

    detachedSetupPage({ context, path: "/_/error" });

    await waitFor(() => {
      expect(bootstrapSkeleton).toHaveClass("app-bootstrap-skeleton--hidden");
    });
    expect(bootstrapSkeleton).toHaveAttribute("aria-hidden", "true");
    expect(screen.queryByTestId("app-skeleton")).not.toBeInTheDocument();

    bootstrapSkeleton.dispatchEvent(new Event("transitionend"));

    expect(document.getElementById("app-bootstrap-skeleton")).toBeNull();
  });

  it("keeps the inline loading surface until the main stylesheet is ready", async () => {
    const stylesheetLoaded = context.mocks.deferred<"failed" | "loaded">();
    vi.stubGlobal("__mainStylesheetLoaded", stylesheetLoaded.promise);
    const bootstrapSkeleton = document.createElement("div");
    bootstrapSkeleton.id = "app-bootstrap-skeleton";
    document.body.append(bootstrapSkeleton);

    detachedSetupPage({ context, path: "/_/error" });

    await waitFor(() => {
      expect(queryAllByRoleFast("link")).not.toHaveLength(0);
    });
    expect(bootstrapSkeleton).not.toHaveAttribute("aria-hidden");

    stylesheetLoaded.resolve("loaded");

    await waitFor(() => {
      expect(bootstrapSkeleton).toHaveAttribute("aria-hidden", "true");
    });

    bootstrapSkeleton.dispatchEvent(new Event("transitionend"));
    expect(document.getElementById("app-bootstrap-skeleton")).toBeNull();
  });

  it("keeps the inline loading surface when the main stylesheet fails", async () => {
    const stylesheetLoaded = context.mocks.deferred<"failed" | "loaded">();
    vi.stubGlobal("__mainStylesheetLoaded", stylesheetLoaded.promise);
    const bootstrapSkeleton = document.createElement("div");
    bootstrapSkeleton.id = "app-bootstrap-skeleton";
    document.body.append(bootstrapSkeleton);

    // A stylesheet network failure happens before the app exposes a page
    // interaction, so the build-installed promise is this scenario's
    // production boundary. The page still enters through its real bootstrap.
    detachedSetupPage({ context, path: "/_/error" });

    await waitFor(() => {
      expect(queryAllByRoleFast("link")).not.toHaveLength(0);
    });

    stylesheetLoaded.resolve("failed");
    await stylesheetLoaded.promise;

    expect(bootstrapSkeleton).not.toHaveAttribute("aria-hidden");
    expect(document.getElementById("app-bootstrap-skeleton")).toBe(
      bootstrapSkeleton,
    );
    bootstrapSkeleton.remove();
  });

  it("unmounts the app skeleton after its fade-out completes", async () => {
    detachedSetupPage({ context, path: "/_/error" });

    const skeleton = await screen.findByTestId("app-skeleton");
    await waitFor(() => {
      expect(skeleton).toHaveClass("opacity-0");
    });

    fireEvent.transitionEnd(skeleton);

    expect(screen.queryByTestId("app-skeleton")).not.toBeInTheDocument();
  });

  it("renders the first avatar preset with a locale-free pulse", async () => {
    detachedSetupPage({
      context,
      path: "/_/skeleton",
    });

    const skeletons = await screen.findAllByRole("status", { name: "Loading" });
    expect(skeletons.length).toBeGreaterThan(0);
    expect(skeletons[0]).toHaveTextContent("");
    expect(skeletons[0]?.querySelectorAll("img")).toHaveLength(3);
    expect(skeletons[0]?.querySelectorAll("img")[0]).toHaveAttribute(
      "src",
      expect.stringContaining("/head-r1-s0.svg"),
    );
  });
});
