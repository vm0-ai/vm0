import { sharedThreadsContract } from "@okouai/api-contracts/contracts/shared-threads";
import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  detachedSetupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();
const SHARED_THREAD_ID = "30000000-0000-4000-8000-000000000702";

describe("shared thread page", () => {
  it("renders the immutable public DTO without owner or agent identity", async () => {
    context.mocks.api(sharedThreadsContract.get, ({ params, respond }) => {
      expect(params.id).toBe(SHARED_THREAD_ID);
      return respond(200, {
        id: SHARED_THREAD_ID,
        title: "Public launch plan",
        publicBrand: "okou",
        messages: [
          {
            messageIndex: 0,
            role: "user",
            content: "What should we launch?",
            runIndex: 0,
          },
          {
            messageIndex: 1,
            role: "user",
            content: "Keep it concise.",
            runIndex: 0,
          },
          {
            messageIndex: 2,
            role: "assistant",
            content: "Launch the **public preview**.",
            runIndex: 0,
          },
        ],
      });
    });

    detachedSetupPage({
      context,
      path: `/share/threads/${SHARED_THREAD_ID}`,
      user: null,
    });

    await expect(
      screen.findByRole("heading", { name: "Public launch plan" }),
    ).resolves.toBeInTheDocument();
    expect(screen.getByText("What should we launch?")).toBeInTheDocument();
    expect(screen.getByText("Keep it concise.")).toBeInTheDocument();
    expect(screen.getByText("public preview").tagName).toBe("STRONG");
    const userMessages = document.querySelectorAll("[data-role='user']");
    expect(userMessages).toHaveLength(2);
    expect(userMessages[1]).toHaveClass("-mt-5");
    expect(
      document.querySelector("[data-role='assistant']"),
    ).toBeInTheDocument();
    const assistantAvatar = screen.getByRole("img", { name: "Okou" });
    expect(assistantAvatar).toHaveClass("h-7", "@[900px]:h-9");
    expect(assistantAvatar.querySelectorAll("img")).toHaveLength(3);
    expect(
      document.querySelector("[data-shared-assistant-avatar] svg"),
    ).not.toBeInTheDocument();
    expect(
      document.querySelector("[data-shared-message-actions='user']"),
    ).toHaveClass("mt-1");
    expect(
      document.querySelector("[data-shared-message-actions='assistant']"),
    ).toHaveClass("pt-2", "pb-1");
    expect(
      document.querySelectorAll("[data-shared-message-copy]"),
    ).toHaveLength(3);
    expect(screen.queryByText("Agent")).not.toBeInTheDocument();
    expect(screen.queryByText("Owner")).not.toBeInTheDocument();
    expect(
      queryAllByRoleFast("button").find((button) => {
        return button.getAttribute("aria-label") === "Share";
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Make this conversation yours"),
    ).toBeInTheDocument();
    expect(document.querySelector("[data-message-container]")).toHaveClass(
      "max-w-[900px]",
      "gap-6",
    );
    expect(document.querySelector("[data-shared-thread-handoff]")).toHaveClass(
      "shrink-0",
    );

    const links = queryAllByRoleFast("link");
    const handoffLink = links.find((link) => {
      return link.textContent === "Try it yourself";
    });
    expect(handoffLink).toBeInTheDocument();
    const handoffUrl = new URL(handoffLink?.getAttribute("href") ?? "");
    expect(handoffUrl.origin).toBe(window.location.origin);
    expect(handoffUrl.pathname).toBe("/");
    expect(handoffUrl.searchParams.get("prompt")).toContain(
      `/share/threads/${SHARED_THREAD_ID}`,
    );

    const signInLinks = links.filter((link) => {
      return link.textContent === "Sign in";
    });
    expect(signInLinks).toHaveLength(2);
    for (const signInLink of signInLinks) {
      const signInUrl = new URL(signInLink.getAttribute("href") ?? "");
      expect(signInUrl.pathname).toBe("/sign-in");
      expect(signInUrl.searchParams.get("redirect_url")).toBe(
        handoffUrl.toString(),
      );
    }

    const signUpLink = links.find((link) => {
      return link.textContent === "Sign up";
    });
    expect(signUpLink).toBeInTheDocument();
    const signUpUrl = new URL(signUpLink?.getAttribute("href") ?? "");
    expect(signUpUrl.pathname).toBe("/sign-up");
    expect(signUpUrl.searchParams.get("redirect_url")).toBe(
      handoffUrl.toString(),
    );
  });

  it("owns its scrolling because the app shell clips overflow", async () => {
    context.mocks.api(sharedThreadsContract.get, ({ respond }) => {
      return respond(200, {
        id: SHARED_THREAD_ID,
        title: "Long thread",
        publicBrand: "vm0",
        messages: [
          {
            messageIndex: 0,
            role: "user",
            content: "First question",
            runIndex: 0,
          },
        ],
      });
    });

    detachedSetupPage({
      context,
      path: `/share/threads/${SHARED_THREAD_ID}`,
      user: null,
    });

    const scroller = await screen.findByTestId("shared-thread-scroll");
    expect(scroller).toHaveClass("absolute", "inset-0", "overflow-y-auto");
  });

  it("does not repeat a brand-only document title", async () => {
    context.mocks.api(sharedThreadsContract.get, ({ respond }) => {
      return respond(200, {
        id: SHARED_THREAD_ID,
        title: "VM0",
        publicBrand: "vm0",
        messages: [],
      });
    });

    detachedSetupPage({
      context,
      path: `/share/threads/${SHARED_THREAD_ID}`,
      user: null,
    });

    await expect(
      screen.findByRole("heading", { name: "VM0" }),
    ).resolves.toBeInTheDocument();
    expect(document.title).toBe("VM0");
  });

  it("defaults an ambiguous not-found page to VM0 presentation", async () => {
    context.mocks.api(sharedThreadsContract.get, ({ respond }) => {
      return respond(404, {
        error: { code: "NOT_FOUND", message: "Not found" },
      });
    });

    detachedSetupPage({
      context,
      path: `/share/threads/${SHARED_THREAD_ID}`,
      user: null,
    });

    await expect(
      screen.findByRole("heading", { name: "Shared conversation not found" }),
    ).resolves.toBeInTheDocument();
    const links = queryAllByRoleFast("link");
    expect(
      links.find((link) => {
        return link.getAttribute("aria-label") === "VM0";
      }),
    ).toBeInTheDocument();
    expect(
      links.find((link) => {
        return link.textContent === "Sign up";
      }),
    ).toBeInTheDocument();
  });
});
