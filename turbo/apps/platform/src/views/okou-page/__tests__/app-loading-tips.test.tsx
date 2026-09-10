import { act, screen, within } from "@testing-library/react";
import { expect, test } from "vitest";
import appHtml from "../../../../index.html?raw";
import { startPage } from "../../../__tests__/page-helper.ts";
import { mockNow } from "../../../lib/time.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();
const EMPLOYEE_TIP = "Hire an AI teammate.";

test("Loading rotates all eight tips, offers support, and stops when the page is ready", async () => {
  let time = new Date("2026-09-10T08:00:00Z").getTime();
  mockNow(() => {
    return time;
  }, context.signal);
  context.mocks.browser.matchMedia(false);
  const clerkLoad = context.mocks.clerk().runtimePending();
  const page = await startPage({ context, path: "/v1/sign-in", auth: null });

  const loading = await screen.findByRole("status", { name: "Loading" });
  await expect(within(loading).findByText(EMPLOYEE_TIP)).resolves.toBeVisible();

  for (const text of [
    "Match the model to the task.",
    "Schedule tasks. Save time.",
    "Step away. Okou keeps working.",
    "Let Okou brainstorm and plan.",
    "Workflows are skills your team can share.",
    "Just ask Okou.",
    "Email contact@okou.ai.",
  ]) {
    time += 8000;
    await expect(within(loading).findByText(text)).resolves.toBeVisible();
  }
  expect(within(loading).getByText("Email contact@okou.ai.")).toHaveAttribute(
    "href",
    "mailto:contact@okou.ai",
  );

  time += 8000;
  await expect(within(loading).findByText(EMPLOYEE_TIP)).resolves.toBeVisible();

  await act(async () => {
    clerkLoad.resolve();
    await clerkLoad.promise;
  });
  await screen.findByTestId("clerk-sign-in");
  await page.ready;
  expect(loading).toHaveAttribute("aria-hidden", "true");
  expect(screen.queryByText(EMPLOYEE_TIP)).not.toBeInTheDocument();
});

test("The initial HTML loading avatar shows tips in the browser's supported language", async () => {
  context.mocks.browser.languages(["fr-FR"]);
  const parsed = new DOMParser().parseFromString(appHtml, "text/html");
  const initialSkeleton = parsed.getElementById("app-bootstrap-skeleton");
  if (!initialSkeleton) {
    throw new Error("The application HTML must provide its loading skeleton");
  }
  const loading = document.importNode(initialSkeleton, true);
  document.body.append(loading);
  context.signal.addEventListener(
    "abort",
    () => {
      loading.remove();
    },
    { once: true },
  );
  const clerkLoad = context.mocks.clerk().runtimePending();

  await startPage({ context, path: "/v1/sign-in", auth: null });

  const tip = "Recrutez un collègue IA.";
  await expect(within(loading).findByText(tip)).resolves.toBeVisible();
  expect(screen.queryByText(EMPLOYEE_TIP)).not.toBeInTheDocument();

  await act(async () => {
    clerkLoad.resolve();
    await clerkLoad.promise;
  });
  await screen.findByTestId("clerk-sign-in");
  expect(loading).toHaveAttribute("aria-hidden", "true");
  expect(within(loading).queryByText(tip)).not.toBeInTheDocument();
});
