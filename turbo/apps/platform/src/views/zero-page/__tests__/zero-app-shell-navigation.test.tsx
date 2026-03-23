import { describe, expect, it } from "vitest";
import { screen, waitFor, fireEvent } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";
import { pathname } from "../../../signals/location.ts";

const context = testContext();

function mockChatAPIs() {
  server.use(
    http.get("*/api/zero/chat-threads", () => {
      return HttpResponse.json({ threads: [] });
    }),
  );
}

describe("zero-app-shell content navigation handlers", () => {
  it("should navigate to agent profile when clicking chat avatar on landing page", async () => {
    mockChatAPIs();

    await setupPage({ context, path: "/" });

    // On the landing page the avatar button triggers handleChatAvatarClick
    const avatarButton = await waitFor(
      () => {
        return screen.getByLabelText("View agent profile");
      },
      { timeout: 5000 },
    );

    fireEvent.click(avatarButton);

    // handleChatAvatarClick -> navigateTo("/team/:name", { pathParams: { name: "zero" } })
    await waitFor(() => {
      expect(pathname()).toBe("/team/zero");
    });
  }, 15_000);
});
