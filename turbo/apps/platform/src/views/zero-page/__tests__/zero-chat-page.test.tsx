import { describe, expect, it, vi } from "vitest";
import { screen, waitFor, fireEvent } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";

const context = testContext();

function mockChatAPI() {
  server.use(
    http.get("*/api/zero/chat-threads", () => {
      return HttpResponse.json({ threads: [] });
    }),
  );
}

async function renderChatPage() {
  mockChatAPI();
  await setupPage({ context, path: "/" });
}

describe("zero chat page - suggested prompts", () => {
  it("should render 3 suggested prompt cards", async () => {
    await renderChatPage();

    await waitFor(() => {
      expect(screen.getByText("Auto-organize inbox")).toBeInTheDocument();
    });
    expect(screen.getByText("Daily morning brief")).toBeInTheDocument();
    expect(screen.getByText("Create a sub-agent")).toBeInTheDocument();
  });

  it("should render descriptions for suggested prompts", async () => {
    await renderChatPage();

    await waitFor(() => {
      expect(
        screen.getByText("Smart categorization, reply, and daily email digest"),
      ).toBeInTheDocument();
    });
    expect(
      screen.getByText(
        "Trending topics on a schedule, your personalized digest",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Build a specialized agent for a specific workflow"),
    ).toBeInTheDocument();
  });

  it("should populate composer input when suggested prompt is clicked", async () => {
    await renderChatPage();

    await waitFor(() => {
      expect(screen.getByText("Auto-organize inbox")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Auto-organize inbox"));

    await waitFor(() => {
      const textarea = screen.getByPlaceholderText(
        "Ask me to automate workflows, manage tasks...",
      );
      expect(textarea).toHaveValue(
        "Set up auto-organization for my inbox with smart categorization, auto-reply rules, and a daily email digest",
      );
    });
  });
});

describe("zero chat page - composer", () => {
  it("should render composer textarea", async () => {
    await renderChatPage();

    await waitFor(() => {
      expect(
        screen.getByPlaceholderText(
          "Ask me to automate workflows, manage tasks...",
        ),
      ).toBeInTheDocument();
    });
  });

  it("should render Send button", async () => {
    await renderChatPage();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Send" })).toBeInTheDocument();
    });
  });

  it("should render Attach button", async () => {
    await renderChatPage();

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Attach" }),
      ).toBeInTheDocument();
    });
  });

  it("should have accessible name on connectors button", async () => {
    await renderChatPage();
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Connectors" }),
      ).toBeInTheDocument();
    });
  });

  it("should disable Send button when input is empty", async () => {
    await renderChatPage();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    });
  });

  it("should enable Send button when input has text", async () => {
    await renderChatPage();

    const textarea = await waitFor(() =>
      screen.getByPlaceholderText(
        "Ask me to automate workflows, manage tasks...",
      ),
    );

    fireEvent.change(textarea, { target: { value: "Hello" } });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Send" })).not.toBeDisabled();
    });
  });
});

describe("zero chat page - file input ref", () => {
  it("should open file picker when Attach button is clicked", async () => {
    await renderChatPage();

    const attachButton = await waitFor(() =>
      screen.getByRole("button", { name: "Attach" }),
    );

    // The hidden file input should exist in the DOM
    const fileInput =
      document.querySelector<HTMLInputElement>('input[type="file"]');
    expect(fileInput).toBeInTheDocument();
    if (!fileInput) {
      throw new Error("file input not found");
    }

    // Mock the click method to verify it gets called
    const clickSpy = vi.fn();
    fileInput.click = clickSpy;

    fireEvent.click(attachButton);

    expect(clickSpy).toHaveBeenCalledOnce();
  });
});

describe("zero chat page - add connector dialog", () => {
  it("should open add connector dialog when clicking Add connector in popover", async () => {
    await renderChatPage();

    const connectorsButton = await waitFor(() =>
      screen.getByRole("button", { name: "Connectors" }),
    );

    fireEvent.click(connectorsButton);

    const addConnectorButton = await waitFor(() =>
      screen.getByText("Add connector"),
    );

    fireEvent.click(addConnectorButton);

    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });
  });
});

describe("zero chat page - agent avatar and greeting", () => {
  it("should render agent avatar on the landing page", async () => {
    await renderChatPage();

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "View agent profile" }),
      ).toBeInTheDocument();
    });
  });
});
