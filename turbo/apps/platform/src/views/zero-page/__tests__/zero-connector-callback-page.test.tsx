import { connectorsSlugCallbackContract } from "@vm0/api-contracts/contracts/connectors-slug-callback";
import { zeroCustomConnectorOAuth2Contract } from "@vm0/api-contracts/contracts/zero-custom-connectors";
import type { PublicConnectorCatalogIcon } from "@vm0/api-contracts/contracts/zero-connector-catalog";
import { CONNECTOR_APP_OAUTH_CALLBACK_METADATA_STORAGE_KEY } from "@vm0/connectors/app-oauth-callback";
import { screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { initializeI18n } from "../../../i18n/index.ts";
import { DEFAULT_LOCALE } from "../../../i18n/resources.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { localStorageSignals } from "../../../signals/external/local-storage.ts";
import { pathname, search } from "../../../signals/location.ts";

const context = testContext();
const { set$: setConnectorAppOauthCallbackMetadata$ } = localStorageSignals(
  CONNECTOR_APP_OAUTH_CALLBACK_METADATA_STORAGE_KEY,
);

afterEach(async () => {
  document.documentElement.lang = DEFAULT_LOCALE;
  await initializeI18n(DEFAULT_LOCALE);
});

describe("connector callback page", () => {
  it("completes a custom connector callback through the API", async () => {
    let observedQuery: Readonly<Record<string, string | undefined>> = {};
    context.mocks.api(
      zeroCustomConnectorOAuth2Contract.callback,
      ({ query, respond }) => {
        observedQuery = query;
        return respond(200, {
          status: "success",
          username: null,
        });
      },
    );

    detachedSetupPage({
      context,
      path: "/connectors/custom/callback?code=oauth-code&state=oauth-state",
      user: null,
      session: null,
    });

    await expect(
      screen.findByRole("heading", {
        name: "Custom connector connected",
      }),
    ).resolves.toBeInTheDocument();
    expect(observedQuery).toMatchObject({
      code: "oauth-code",
      state: "oauth-state",
      responseMode: "json",
    });
    await waitFor(() => {
      expect(pathname()).toBe("/connectors/custom/callback/success");
    });
  });

  it("forwards provider parameters and renders a durable success page", async () => {
    const githubIcon: PublicConnectorCatalogIcon = {
      url: "https://icons.example.test/github.svg",
      invertInDarkMode: true,
    };
    context.store.set(
      setConnectorAppOauthCallbackMetadata$,
      JSON.stringify({ connectorRef: "github", icon: githubIcon }),
    );
    let observedQuery: Readonly<Record<string, string | undefined>> = {};
    context.mocks.api(
      connectorsSlugCallbackContract.callback,
      ({ params, query, respond }) => {
        expect(params.connectorSlug).toBe("github");
        observedQuery = query;
        return respond(200, {
          status: "success",
          username: "octocat",
        });
      },
    );

    detachedSetupPage({
      context,
      path: "/connectors/github/callback?code=oauth-code&state=oauth-state",
      user: null,
      session: null,
    });

    const heading = await screen.findByRole("heading", {
      name: "GitHub connected",
    });
    const connectorIcon = heading.parentElement?.querySelector("img");
    if (!(connectorIcon instanceof HTMLImageElement)) {
      throw new Error("GitHub connector icon not found");
    }
    expect(connectorIcon).toHaveAttribute("src", githubIcon.url);
    expect(
      screen.getByText("Connected as octocat. You can close this window."),
    ).toBeInTheDocument();
    expect(observedQuery).toMatchObject({
      code: "oauth-code",
      state: "oauth-state",
      responseMode: "json",
    });
    await waitFor(() => {
      expect(pathname()).toBe("/connectors/github/callback/success");
    });
    const resultSearchParams = new URLSearchParams(search());
    expect(resultSearchParams.get("username")).toBe("octocat");
    expect(resultSearchParams.get("iconUrl")).toBe(githubIcon.url);
    expect(resultSearchParams.get("iconInvertInDarkMode")).toBe(
      String(githubIcon.invertInDarkMode),
    );
    expect(resultSearchParams.get("iconScale")).toBe(
      githubIcon.scale === undefined ? null : String(githubIcon.scale),
    );
  });

  it("renders the API failure result without retaining OAuth parameters", async () => {
    context.mocks.api(
      connectorsSlugCallbackContract.callback,
      ({ query, respond }) => {
        expect(query).toMatchObject({
          error: "access_denied",
          error_description: "Provider denied access",
          state: "oauth-state",
          responseMode: "json",
        });
        return respond(200, {
          status: "error",
          message: "Provider denied access",
        });
      },
    );

    detachedSetupPage({
      context,
      path: "/connectors/notion/callback?error=access_denied&error_description=Provider+denied+access&state=oauth-state",
      user: null,
      session: null,
    });

    await expect(
      screen.findByRole("heading", { name: "Couldn’t connect NOTION" }),
    ).resolves.toBeInTheDocument();
    expect(screen.getByText(/Provider denied access/)).toBeInTheDocument();
    await waitFor(() => {
      expect(pathname()).toBe("/connectors/notion/callback/error");
    });
    expect(search()).toBe("?message=Provider+denied+access");
  });

  it("localizes connection failures in Portuguese while preserving provider errors", async () => {
    document.documentElement.lang = "pt-BR";
    context.mocks.api(
      connectorsSlugCallbackContract.callback,
      ({ respond }) => {
        return respond(200, {
          status: "error",
          message: "Provider denied access",
        });
      },
    );

    detachedSetupPage({
      context,
      path: "/connectors/notion/callback?error=access_denied",
      user: null,
      session: null,
    });

    await expect(
      screen.findByRole("heading", {
        name: "Não foi possível conectar NOTION",
      }),
    ).resolves.toBeInTheDocument();
    expect(screen.getByText(/Provider denied access/)).toBeInTheDocument();
    expect(
      screen.getByText(/Feche esta janela e tente novamente\./),
    ).toBeInTheDocument();
  });

  it("restores a completed result page without replaying the callback", async () => {
    context.mocks.api(connectorsSlugCallbackContract.callback, ({ never }) => {
      return never();
    });

    detachedSetupPage({
      context,
      path: "/connectors/github/callback/success?username=octocat",
      user: null,
      session: null,
    });

    await expect(
      screen.findByRole("heading", {
        name: "GitHub connected",
      }),
    ).resolves.toBeInTheDocument();
  });
});
