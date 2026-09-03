import { fireEvent, screen } from "@testing-library/react";
import { expect, test } from "vitest";

import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

function createBootstrapSkeleton(): HTMLDivElement {
  const skeleton = document.createElement("div");
  skeleton.id = "app-bootstrap-skeleton";
  skeleton.setAttribute("aria-label", "Loading");
  skeleton.setAttribute("aria-live", "polite");
  skeleton.setAttribute("role", "status");
  const content = document.createElement("div");
  content.className = "app-bootstrap-skeleton__content";
  const progress = document.createElement("p");
  progress.className = "app-bootstrap-skeleton__progress";
  progress.dataset.appBootstrapProgress = "";
  progress.textContent = "Loading…";
  content.append(progress);
  skeleton.append(content);
  document.body.append(skeleton);
  context.signal.addEventListener("abort", () => {
    skeleton.remove();
  });
  return skeleton;
}

test("The bootstrap loading surface yields cleanly to ready content", async () => {
  const bootstrapSkeleton = createBootstrapSkeleton();

  const pageReady = setupPage({ context, path: "/_/error" });

  expect(screen.getByRole("status")).toBe(bootstrapSkeleton);
  expect(
    screen.queryByText("Oops! Something went sideways"),
  ).not.toBeInTheDocument();

  const readyContent = await screen.findByText("Oops! Something went sideways");
  await pageReady;
  expect(readyContent).toBeVisible();
  expect(readyContent.closest('[aria-hidden="true"]')).toBeNull();
  expect(bootstrapSkeleton).toHaveAttribute("aria-hidden", "true");
  expect(bootstrapSkeleton).toHaveClass("app-bootstrap-skeleton--hidden");
  expect(screen.queryByRole("status")).not.toBeInTheDocument();

  fireEvent.transitionEnd(bootstrapSkeleton);

  expect(document.getElementById("app-bootstrap-skeleton")).toBeNull();
});

test("The application loading surface uses an inline illustration", async () => {
  const clerkLoad = context.mocks.clerk().runtimePending();

  const pageReady = setupPage({
    context,
    host: "app.vm0.ai",
    path: "/agents",
  });

  const applicationSkeleton = await screen.findByTestId("app-skeleton");
  expect(applicationSkeleton).toBeVisible();
  expect(applicationSkeleton.querySelector("svg")).not.toBeNull();
  expect(applicationSkeleton.querySelectorAll("path").length).toBeGreaterThan(
    0,
  );
  expect(applicationSkeleton.querySelector("img")).toBeNull();
  expect(screen.queryByRole("heading", { name: "Agents" })).toBeNull();

  clerkLoad.resolve();
  await pageReady;

  await expect(
    screen.findByRole("heading", { name: "Agents" }),
  ).resolves.toBeVisible();
});
