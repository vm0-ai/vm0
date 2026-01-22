import { act, render } from "@testing-library/react";
import type { TestContext } from "../signals/__tests__/test-helpers";
import { clearMockedAuth, mockUser } from "./mock-auth";
import { bootstrap$ } from "../signals/bootstrap";
import { setupRouter } from "../views/main";
import { setPathname } from "../signals/location";

export async function setupPage(options: {
  context: TestContext;
  path: string;
  user?: { id: string; fullName: string } | null;
  session?: { token: string } | null;
}) {
  setPathname(options.path);

  mockUser(
    options.user !== undefined
      ? options.user
      : {
          id: "test-user-123",
          fullName: "Test User",
        },
    options.session ?? {
      token: "test-token",
    },
  );
  options.context.signal.addEventListener("abort", () => {
    clearMockedAuth();
  });

  const rootEl = document.createElement("div");
  document.body.appendChild(rootEl);
  options.context.signal.addEventListener("abort", () => {
    rootEl.remove();
  });

  // Bootstrap the app (like main.ts does)
  await act(async () => {
    await options.context.store.set(
      bootstrap$,
      () => {
        setupRouter(options.context.store, (element) => {
          render(element, { container: rootEl });
        });
      },
      options.context.signal,
    );
  });
}
