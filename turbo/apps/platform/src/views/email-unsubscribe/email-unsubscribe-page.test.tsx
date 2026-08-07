import { screen, waitFor } from "@testing-library/react";
import { emailUnsubscribeContract } from "@vm0/api-contracts/contracts/email-unsubscribe";
import { describe, expect, it } from "vitest";

import {
  click,
  detachedSetupPage,
  queryAllByRoleFast,
} from "../../__tests__/page-helper.ts";
import { testContext } from "../../signals/__tests__/test-helpers.ts";

const context = testContext();

function usePortugueseLocale(): void {
  document.documentElement.lang = "pt-BR";
  context.signal.addEventListener(
    "abort",
    () => {
      document.documentElement.lang = "en-US";
    },
    { once: true },
  );
}

function buttonByText(text: string): HTMLElement {
  const button = queryAllByRoleFast("button").find((candidate) => {
    return candidate.textContent?.replace(/\s+/g, " ").trim() === text;
  });
  if (!button) {
    throw new Error(`${text} button not found`);
  }
  return button;
}

describe("email unsubscribe page", () => {
  it("confirms an unsubscribe in Brazilian Portuguese", async () => {
    usePortugueseLocale();
    context.mocks.api(emailUnsubscribeContract.unsubscribe, ({ respond }) => {
      return respond(200, { unsubscribed: true });
    });

    detachedSetupPage({
      context,
      path: "/email/unsubscribe?token=user_1.pt",
    });

    await expect(
      screen.findByText("Cancelar o recebimento de notificações por e-mail?"),
    ).resolves.toBeInTheDocument();
    click(buttonByText("Cancelar inscrição"));

    await expect(
      screen.findByText("Inscrição cancelada"),
    ).resolves.toBeInTheDocument();
    expect(document.title).toBe("Cancelar inscrição | VM0");
  });

  it("unsubscribes from system emails after confirmation", async () => {
    context.mocks.api(emailUnsubscribeContract.unsubscribe, ({ respond }) => {
      return respond(200, { unsubscribed: true });
    });

    detachedSetupPage({
      context,
      path: "/email/unsubscribe?token=user_1.abc",
    });

    await waitFor(() => {
      expect(
        screen.getByText("Unsubscribe from email notifications?"),
      ).toBeInTheDocument();
    });

    click(buttonByText("Unsubscribe"));

    await waitFor(() => {
      expect(screen.getByText("Unsubscribed")).toBeInTheDocument();
    });
  });

  it("shows an error state for an invalid token", async () => {
    context.mocks.api(emailUnsubscribeContract.unsubscribe, ({ respond }) => {
      return respond(400, { error: "Invalid token" });
    });

    detachedSetupPage({
      context,
      path: "/email/unsubscribe?token=broken",
    });

    await waitFor(() => {
      expect(
        screen.getByText("Unsubscribe from email notifications?"),
      ).toBeInTheDocument();
    });

    click(buttonByText("Unsubscribe"));

    await waitFor(() => {
      expect(screen.getByText("Something went wrong")).toBeInTheDocument();
    });
  });
});
