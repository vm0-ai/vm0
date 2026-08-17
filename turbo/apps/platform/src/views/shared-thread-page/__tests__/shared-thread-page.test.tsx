import { sharedThreadsContract } from "@okouai/api-contracts/contracts/shared-threads";
import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  detachedSetupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { sharedThreadHomeUrl } from "../shared-thread-page.tsx";

const context = testContext();
const SHARED_THREAD_ID = "30000000-0000-4000-8000-000000000702";

describe("shared thread page", () => {
  it("maps production navigation to the persisted brand host", () => {
    expect(sharedThreadHomeUrl("https://app.vm0.ai", "okou")).toBe(
      "https://app.okou.ai",
    );
    expect(sharedThreadHomeUrl("https://app.okou.ai", "vm0")).toBe(
      "https://app.vm0.ai",
    );
  });

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
    expect(screen.getByText("public preview").tagName).toBe("STRONG");
    expect(document.querySelector("[data-role='user']")).toBeInTheDocument();
    expect(
      document.querySelector("[data-role='assistant']"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Agent")).not.toBeInTheDocument();
    expect(screen.queryByText("Owner")).not.toBeInTheDocument();
    expect(
      queryAllByRoleFast("link").find((link) => {
        return link.textContent === "Try Okou";
      }),
    ).toBeInTheDocument();
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
    expect(scroller).toHaveClass("h-full", "overflow-y-auto");
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
        return link.textContent === "VM0";
      }),
    ).toBeInTheDocument();
    expect(
      links.find((link) => {
        return link.textContent === "Try Zero";
      }),
    ).toBeInTheDocument();
  });
});
