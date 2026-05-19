import {
  desktopAuthConsumeContract,
  desktopAuthHandoffContract,
} from "@vm0/api-contracts/contracts/desktop-auth";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { clearMockedAuth, mockedClerk } from "../../__tests__/mock-auth.ts";
import { setupPage } from "../../__tests__/page-helper.ts";
import { testContext } from "./test-helpers.ts";
import { server } from "../../mocks/server.ts";
import { createMockApi } from "../../mocks/msw-contract.ts";

const context = testContext();
const mockApi = createMockApi(context);

async function setupSignedInDesktopAuthPage(path: string) {
  await setupPage({
    context,
    path,
    withoutRender: true,
    user: {
      id: "user_desktop",
      fullName: "Desktop User",
    },
    session: { token: "browser-session-token" },
  });
}

describe("desktop auth setup", () => {
  beforeEach(() => {
    clearMockedAuth();
  });

  it("routes signed-in browser sessions from start to callback through the platform router", async () => {
    const replace = vi
      .spyOn(window.location, "replace")
      .mockImplementation(() => {
        return undefined;
      });

    await setupSignedInDesktopAuthPage("/desktop-auth/start");

    expect(replace).toHaveBeenCalledWith("/desktop-auth/callback");
  });

  it("creates a handoff callback URL for signed-in browser sessions through the platform router", async () => {
    const callbackUrl =
      "vm0://auth/callback?code=abcdefghijklmnopqrstuvwxyzABCDEF0123456789_-";
    const assign = vi
      .spyOn(window.location, "assign")
      .mockImplementation(() => {
        return undefined;
      });
    const authHeaders: string[] = [];

    server.use(
      mockApi(desktopAuthHandoffContract.create, ({ request, respond }) => {
        authHeaders.push(request.headers.get("authorization") ?? "");
        return respond(200, { callbackUrl });
      }),
    );

    await setupSignedInDesktopAuthPage("/desktop-auth/callback");

    expect(authHeaders).toStrictEqual(["Bearer browser-session-token"]);
    expect(assign).toHaveBeenCalledWith(callbackUrl);
  });

  it("consumes a desktop callback code into the Electron web session through the platform router", async () => {
    server.use(
      mockApi(desktopAuthConsumeContract.consume, ({ body, respond }) => {
        expect(body).toStrictEqual({ code: "desktop-code" });
        return respond(200, { token: "clerk-sign-in-token" });
      }),
    );

    await setupPage({
      context,
      path: "/desktop-auth/consume?code=desktop-code",
      user: null,
      session: null,
      withoutRender: true,
    });

    expect(mockedClerk.clientSignInCreate).toHaveBeenCalledWith({
      strategy: "ticket",
      ticket: "clerk-sign-in-token",
    });
    expect(mockedClerk.setActive).toHaveBeenCalledWith({
      session: "test-created-session-id",
    });
  });
});
