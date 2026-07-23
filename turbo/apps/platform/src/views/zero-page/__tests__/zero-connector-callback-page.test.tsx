import { connectorsTypeCallbackContract } from "@vm0/api-contracts/contracts/connectors-type-callback";
import { getStaticConnectorIconMetadata } from "@vm0/connectors/static-connector-icons";
import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { pathname, search } from "../../../signals/location.ts";

const context = testContext();

describe("connector callback page", () => {
  it("forwards provider parameters and renders a durable success page", async () => {
    let observedQuery: Readonly<Record<string, string | undefined>> = {};
    context.mocks.api(
      connectorsTypeCallbackContract.callback,
      ({ params, query, respond }) => {
        expect(params.type).toBe("github");
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

    await expect(
      screen.findByRole("heading", {
        name: "GitHub connected",
      }),
    ).resolves.toBeInTheDocument();
    expect(document.querySelector("img")).toHaveAttribute(
      "src",
      getStaticConnectorIconMetadata("github").url,
    );
    expect(screen.getByText("octocat")).toBeInTheDocument();
    expect(screen.getByText(/You can close this window\./)).toBeInTheDocument();
    expect(observedQuery).toMatchObject({
      code: "oauth-code",
      state: "oauth-state",
      responseMode: "json",
    });
    await waitFor(() => {
      expect(pathname()).toBe("/connectors/github/callback/success");
    });
    expect(search()).toBe("?username=octocat");
  });

  it("renders the API failure result without retaining OAuth parameters", async () => {
    context.mocks.api(
      connectorsTypeCallbackContract.callback,
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

  it("restores a completed result page without replaying the callback", async () => {
    context.mocks.api(connectorsTypeCallbackContract.callback, ({ never }) => {
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
