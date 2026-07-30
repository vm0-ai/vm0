import { screen, waitFor } from "@testing-library/react";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { describe, expect, it } from "vitest";

import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const APP_SKELETON_VISIBLE_EVENT = "vm0:app-skeleton-visible";
const APP_SKELETON_VISIBLE_EVENT_QUEUED_KEY =
  "vm0AppSkeletonVisibleEventQueued";

const context = testContext();

describe("app skeleton", () => {
  it("dispatches one visible event after the skeleton mounts", async () => {
    delete document.documentElement.dataset[
      APP_SKELETON_VISIBLE_EVENT_QUEUED_KEY
    ];
    context.signal.addEventListener("abort", () => {
      delete document.documentElement.dataset[
        APP_SKELETON_VISIBLE_EVENT_QUEUED_KEY
      ];
    });

    let eventCount = 0;
    let skeletonMountedAtDispatch = false;
    window.addEventListener(
      APP_SKELETON_VISIBLE_EVENT,
      () => {
        eventCount += 1;
        skeletonMountedAtDispatch =
          document.querySelector('[data-testid="app-skeleton"]') !== null;
      },
      { signal: context.signal },
    );

    detachedSetupPage({ context, path: "/_/skeleton" });

    await screen.findAllByTestId("app-skeleton");
    await waitFor(() => {
      expect(eventCount).toBe(1);
    });
    expect(skeletonMountedAtDispatch).toBeTruthy();
  });

  it("removes the inline loading surface after the page is ready", async () => {
    const bootstrapSkeleton = document.createElement("div");
    bootstrapSkeleton.id = "app-bootstrap-skeleton";
    document.body.append(bootstrapSkeleton);

    detachedSetupPage({ context, path: "/_/error" });

    await waitFor(() => {
      expect(bootstrapSkeleton).toHaveClass("app-bootstrap-skeleton--hidden");
    });
    expect(bootstrapSkeleton).toHaveAttribute("aria-hidden", "true");

    bootstrapSkeleton.dispatchEvent(new Event("transitionend"));

    expect(document.getElementById("app-bootstrap-skeleton")).toBeNull();
  });

  it("renders the loading state in the workspace locale", async () => {
    context.mocks.data.userPreferences({
      locale: "pt-BR",
      supportedLocales: ["en-US", "pt-BR"],
    });

    detachedSetupPage({
      context,
      path: "/_/skeleton",
      featureSwitches: { [FeatureSwitchKey.LanguagePreference]: true },
    });

    const skeletons = await screen.findAllByRole("status", {
      name: "Carregando seu espaço de trabalho",
    });
    expect(skeletons.length).toBeGreaterThan(0);
    expect(skeletons[0]).toHaveTextContent(
      /Aquecendo os neurônios|Preparando algumas ideias|Preparando tudo|Quase lá|Carregando seu espaço de trabalho|Ajustando os instrumentos|Ligando os pontos|Reunindo a equipe/u,
    );
  });
});
