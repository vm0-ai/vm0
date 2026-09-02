import { browserAuthorizationRequestsContract } from "@okouai/api-contracts/contracts/browser";
import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();
const REQUEST_TOKEN = "browser-request-token";

function mockPendingAuthorization(): void {
  context.mocks.api(browserAuthorizationRequestsContract.get, ({ respond }) => {
    return respond(200, {
      expiresAt: "2099-09-01T10:00:00.000Z",
      completedAt: null,
      cloudBrowserEnabled: false,
    });
  });
}

function getButton(name: string): HTMLButtonElement {
  const button = queryAllByRoleFast("button").find((candidate) => {
    return candidate.textContent?.trim() === name;
  });
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Button not found: ${name}`);
  }
  return button;
}

test("Cloud-browser authorization uses the current app's brand", async () => {
  mockPendingAuthorization();

  await setupPage({
    context,
    path: `/browser/authorize/${REQUEST_TOKEN}`,
    host: "app.okou.ai",
  });

  await expect(
    screen.findByRole("heading", { name: "Enable cloud browser" }),
  ).resolves.toBeVisible();
  const brandLink = queryAllByRoleFast("link").find((candidate) => {
    return candidate.textContent?.trim() === "Okou";
  });
  expect(brandLink).toHaveAttribute("href", "/connectors");
  expect(screen.queryByText("VM0")).toBeNull();
  expect(screen.queryByLabelText("VM0")).toBeNull();
});

test("A user can enable the cloud browser for one conversation", async () => {
  let applyCount = 0;
  mockPendingAuthorization();
  context.mocks.api(
    browserAuthorizationRequestsContract.apply,
    ({ params, respond }) => {
      if (params.requestToken === REQUEST_TOKEN) {
        applyCount += 1;
      }
      return respond(200, { ok: true, cloudBrowserEnabled: true });
    },
  );

  await setupPage({
    context,
    path: `/browser/authorize/${REQUEST_TOKEN}`,
  });

  await expect(
    screen.findByRole("heading", { name: "Enable cloud browser" }),
  ).resolves.toBeVisible();
  expect(
    screen.getByText(
      "Zero will use an isolated cloud browser profile for this chat thread. Enabling it disconnects Computer Use for the thread.",
    ),
  ).toBeVisible();
  click(getButton("Enable for this thread"));

  await waitFor(() => {
    expect(getButton("Cloud browser enabled")).toBeDisabled();
  });
  expect(applyCount).toBe(1);
});
