import type { PublicConnectorCatalogIcon } from "@okouai/api-contracts/contracts/connector-catalog";
import { connectorsSlugCallbackContract } from "@okouai/api-contracts/contracts/connectors-slug-callback";
import { customConnectorOAuth2Contract } from "@okouai/api-contracts/contracts/custom-connectors";
import { CONNECTOR_APP_OAUTH_CALLBACK_METADATA_STORAGE_KEY } from "@okouai/connectors/app-oauth-callback";
import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";

import { setupPage } from "../../../__tests__/page-helper.ts";
import { localStorageSignals } from "../../../signals/external/local-storage.ts";
import { pathname, search } from "../../../signals/location.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();
const { set$: setCallbackMetadata$ } = localStorageSignals(
  CONNECTOR_APP_OAUTH_CALLBACK_METADATA_STORAGE_KEY,
);

function githubIcon(): PublicConnectorCatalogIcon {
  return {
    url: "https://icons.example.test/github.svg",
    invertInDarkMode: true,
  };
}

function seedCallbackMetadata(icon: PublicConnectorCatalogIcon): void {
  context.store.set(
    setCallbackMetadata$,
    JSON.stringify({ connectorSlug: "github", icon }),
  );
}

test("Complete a custom connector authorization", async () => {
  context.mocks.api(
    customConnectorOAuth2Contract.callback,
    ({ query, respond }) => {
      expect(query).toMatchObject({
        code: "oauth-code",
        state: "oauth-state",
        responseMode: "json",
      });
      return respond(200, { status: "success", username: null });
    },
  );

  await setupPage({
    context,
    path: "/connectors/custom/callback?code=oauth-code&state=oauth-state",
    auth: null,
  });

  await expect(
    screen.findByRole("heading", { name: "Custom connector connected" }),
  ).resolves.toBeInTheDocument();
  await waitFor(() => {
    expect(pathname()).toBe("/connectors/custom/callback/success");
    expect(search()).toBe("");
  });
});

test("Complete a GitHub connector authorization", async () => {
  const icon = githubIcon();
  seedCallbackMetadata(icon);
  context.mocks.api(
    connectorsSlugCallbackContract.callback,
    ({ params, query, respond }) => {
      expect(params.connectorSlug).toBe("github");
      expect(query).toMatchObject({
        code: "oauth-code",
        state: "oauth-state",
        responseMode: "json",
      });
      return respond(200, { status: "success", username: "octocat" });
    },
  );

  await setupPage({
    context,
    path: "/connectors/github/callback?code=oauth-code&state=oauth-state",
    auth: null,
  });

  const heading = await screen.findByRole("heading", {
    name: "GitHub connected",
  });
  expect(heading).toBeInTheDocument();
  const image = document.querySelector<HTMLImageElement>(
    `img[src="${icon.url}"]`,
  );
  expect(image).toHaveAttribute("src", icon.url);
  expect(
    screen.getByText("Connected as octocat. You can close this window."),
  ).toBeInTheDocument();
  await waitFor(() => {
    expect(pathname()).toBe("/connectors/github/callback/success");
  });
  const result = new URLSearchParams(search());
  expect(result.has("code")).toBeFalsy();
  expect(result.has("state")).toBeFalsy();
});

test("Refreshing a completed connector callback does not reconnect it", async () => {
  context.mocks.api(connectorsSlugCallbackContract.callback, ({ never }) => {
    return never();
  });

  await setupPage({
    context,
    path: "/connectors/github/callback/success?username=octocat",
    auth: null,
  });

  await expect(
    screen.findByRole("heading", { name: "GitHub connected" }),
  ).resolves.toBeInTheDocument();
  expect(
    screen.getByText("Connected as octocat. You can close this window."),
  ).toBeInTheDocument();
});

test("Show a provider error safely without an authenticated session", async () => {
  context.mocks.api(
    connectorsSlugCallbackContract.callback,
    ({ query, respond }) => {
      expect(query).toMatchObject({
        error: "access_denied",
        state: "oauth-state",
        responseMode: "json",
      });
      return respond(200, {
        status: "error",
        message: "Provider denied access",
      });
    },
  );

  await setupPage({
    context,
    path: "/connectors/notion/callback?error=access_denied&state=oauth-state",
    auth: null,
  });

  await expect(
    screen.findByRole("heading", { name: "Couldn’t connect NOTION" }),
  ).resolves.toBeInTheDocument();
  expect(screen.getByText(/Provider denied access/u)).toBeInTheDocument();
  expect(
    screen.getByText(/Close this window and try again\./u),
  ).toBeInTheDocument();
  await waitFor(() => {
    expect(pathname()).toBe("/connectors/notion/callback/error");
  });
  const result = new URLSearchParams(search());
  expect(result.has("error")).toBeFalsy();
  expect(result.has("state")).toBeFalsy();
});
