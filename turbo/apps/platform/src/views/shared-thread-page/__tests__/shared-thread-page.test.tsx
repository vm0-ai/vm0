import { sharedThreadsContract } from "@okouai/api-contracts/contracts/shared-threads";
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
    const user = userEvent.setup({ delay: null });
    const clipboard = context.mocks.browser.clipboardWriteText();
    const firstImport = context.mocks.deferred<void>();
    let importAttempt = 0;
    const richMarkdownImport = context.mocks.browser.richMarkdownImport(
      async () => {
        importAttempt += 1;
        if (importAttempt === 1) {
          await firstImport.promise;
        }
      },
    );
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
            content: "The plain status is ready.",
            runIndex: 0,
          },
          {
            messageIndex: 3,
            role: "assistant",
            content: "Primary\n=\n\nLaunch the **public preview**.",
            runIndex: 0,
          },
          {
            messageIndex: 4,
            role: "assistant",
            content: "Secondary\n--",
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
    expect(screen.getByText("The plain status is ready.")).toBeInTheDocument();
    expect(screen.queryByText("public preview")).not.toBeInTheDocument();
    expect(screen.getAllByTestId("rich-content-loading")).toHaveLength(2);
    expect(richMarkdownImport).toHaveBeenCalledTimes(1);

    act(() => {
      firstImport.reject(new Error("rich content chunk unavailable"));
    });
    const retryButtons = await waitFor(() => {
      const buttons = queryAllByRoleFast("button").filter((button) => {
        return button.textContent?.trim() === "Try again";
      });
      expect(buttons).toHaveLength(2);
      return buttons;
    });
    expect(screen.getByText("The plain status is ready.")).toBeInTheDocument();

    await user.click(retryButtons[0] as HTMLElement);
    await waitFor(() => {
      expect(richMarkdownImport).toHaveBeenCalledTimes(2);
      expect(screen.getByRole("heading", { name: "Primary" }).tagName).toBe(
        "H1",
      );
      expect(screen.getByRole("heading", { name: "Secondary" }).tagName).toBe(
        "H2",
      );
      expect(screen.getByText("public preview").tagName).toBe("STRONG");
    });
    expect(
      screen.queryByTestId("rich-content-loading"),
    ).not.toBeInTheDocument();
    const links = queryAllByRoleFast("link");
    const brandLink = links.find((link) => {
      return link.getAttribute("aria-label") === "Okou";
    });
    expect(brandLink).toBeInTheDocument();
    expect(brandLink?.textContent).toBe("Okou");
    expect(screen.getByRole("img", { name: "Okou" })).toBeInTheDocument();
    expect(screen.queryByText("Agent")).not.toBeInTheDocument();
    expect(screen.queryByText("Owner")).not.toBeInTheDocument();
    expect(
      screen.getByText("Make this conversation yours"),
    ).toBeInTheDocument();

    const shareUrl = `${window.location.origin}/share/threads/${SHARED_THREAD_ID}`;
    const buttons = queryAllByRoleFast("button");
    const shareButton = buttons.find((button) => {
      return button.getAttribute("aria-label") === "Share";
    });
    if (shareButton === undefined) {
      throw new Error("shared thread share button not found");
    }
    await user.click(shareButton);
    await waitFor(() => {
      expect(clipboard.writes).toStrictEqual([shareUrl]);
    });
    await expect(screen.findByText("Link copied")).resolves.toBeInTheDocument();

    const copyButtons = buttons.filter((button) => {
      return button.getAttribute("aria-label") === "Copy message";
    });
    const userCopyButton = copyButtons[0];
    const assistantCopyButton = copyButtons.at(-1);
    if (userCopyButton === undefined || assistantCopyButton === undefined) {
      throw new Error("shared message copy buttons not found");
    }

    await user.click(userCopyButton);
    await waitFor(() => {
      expect(clipboard.writes).toStrictEqual([
        shareUrl,
        "What should we launch?",
      ]);
    });
    await expect(screen.findByText("Copied!")).resolves.toBeInTheDocument();

    await user.click(assistantCopyButton);
    await waitFor(() => {
      expect(clipboard.writes).toStrictEqual([
        shareUrl,
        "What should we launch?",
        [
          "The plain status is ready.",
          "Primary\n=\n\nLaunch the **public preview**.",
          "Secondary\n--",
        ].join("\n\n"),
      ]);
    });

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
