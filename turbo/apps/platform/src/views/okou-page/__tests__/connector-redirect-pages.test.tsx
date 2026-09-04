import { screen } from "@testing-library/react";
import { expect, test } from "vitest";

import {
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();
const MOBILE_WARNING =
  "The GitHub app may not support this OAuth link. Please complete this connection in the VM0 web app on a computer.";
const IPHONE_USER_AGENT =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1";

function getBackLink(brand: "VM0" | "Okou"): HTMLElement {
  const link = queryAllByRoleFast("link").find((candidate) => {
    return candidate.textContent?.trim() === `Back to ${brand}`;
  });
  if (!link) {
    throw new Error(`Expected a Back to ${brand} link`);
  }
  return link;
}

test("The connector redirect page explains the secure provider handoff", async () => {
  await setupPage({
    context,
    path: "/connectors/github/redirecting?label=GitHub",
    auth: null,
  });

  await expect(
    screen.findByRole("heading", { name: "Redirecting to GitHub…" }),
  ).resolves.toBeInTheDocument();
  expect(
    screen.getByText("You’ll continue on GitHub to authorize VM0."),
  ).toBeInTheDocument();
  expect(screen.getByText("Preparing a secure connection")).toBeInTheDocument();
  expect(
    screen.getByLabelText("Connector icon unavailable"),
  ).toBeInTheDocument();
  expect(getBackLink("VM0")).toHaveAttribute("href", "/");
});

test("A connector redirect uses Okou branding on Okou", async () => {
  await setupPage({
    context,
    host: "app.okou.ai",
    path: "/connectors/github/redirecting?label=GitHub",
    auth: null,
  });

  await expect(
    screen.findByRole("heading", { name: "Redirecting to GitHub…" }),
  ).resolves.toBeInTheDocument();
  expect(
    screen.getByText("You’ll continue on GitHub to authorize Okou."),
  ).toBeInTheDocument();
  expect(getBackLink("Okou")).toHaveAttribute("href", "/");
});

test("A stalled mobile provider handoff shows guidance", async () => {
  context.mocks.browser.userAgent(IPHONE_USER_AGENT);

  await setupPage({
    context,
    path: "/connectors/github/redirecting?label=GitHub",
    auth: null,
  });

  await expect(
    screen.findByRole("heading", { name: "Redirecting to GitHub…" }),
  ).resolves.toBeInTheDocument();
  await expect(screen.findByText(MOBILE_WARNING)).resolves.toBeInTheDocument();
});

test("An unsafe route icon is not loaded", async () => {
  await setupPage({
    context,
    path: "/connectors/server-only/redirecting?label=Server+Only&iconUrl=http%3A%2F%2Ficons.example.test%2Fserver-only.svg&iconInvertInDarkMode=true",
    auth: null,
  });

  await expect(
    screen.findByRole("heading", { name: "Redirecting to Server Only…" }),
  ).resolves.toBeInTheDocument();
  expect(
    screen.getByLabelText("Connector icon unavailable"),
  ).toBeInTheDocument();
  expect(
    document.querySelector(
      'img[src="http://icons.example.test/server-only.svg"]',
    ),
  ).toBeNull();
});

test("A failed provider handoff offers a return path", async () => {
  await setupPage({
    context,
    path: "/connectors/github/redirecting?label=GitHub&status=error",
    auth: null,
  });

  await expect(
    screen.findByRole("heading", { name: "Couldn’t open GitHub" }),
  ).resolves.toBeInTheDocument();
  expect(
    screen.getByText("Return to VM0 and try connecting again."),
  ).toBeInTheDocument();
  expect(getBackLink("VM0")).toHaveAttribute("href", "/");
});
