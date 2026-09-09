import { sharedThreadsContract } from "@okouai/api-contracts/contracts/shared-threads";
import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";

import { platformOkouWordmarkLightImg } from "../../../lib/static-assets.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  getLinkByName,
  setupSharedThreadPage,
  sharedThread,
} from "./shared-thread-test-helpers.ts";

const context = testContext();

test("A brand-only public title is not repeated", async () => {
  context.mocks.api(sharedThreadsContract.get, ({ respond }) => {
    return respond(200, {
      ...sharedThread(),
      title: "Okou",
      publicBrand: "vm0",
    });
  });

  await setupSharedThreadPage(context, { host: "app.okou.ai" });

  await expect(
    screen.findByRole("heading", { name: "Okou" }),
  ).resolves.toBeInTheDocument();
  await waitFor(() => {
    expect(document.title).toBe("Okou");
  });
});

test("A missing public conversation uses the Okou presentation", async () => {
  context.mocks.api(sharedThreadsContract.get, ({ respond }) => {
    return respond(404, {
      error: { code: "NOT_FOUND", message: "Not found" },
    });
  });

  await setupSharedThreadPage(context, { host: "app.okou.ai" });

  await expect(
    screen.findByRole("heading", {
      name: "Shared conversation not found",
    }),
  ).resolves.toBeInTheDocument();
  const brandLink = getLinkByName("Okou");
  expect(brandLink).toHaveAttribute("href", "https://app.okou.ai");
  expect(getLinkByName("Sign up")).toHaveAttribute(
    "href",
    expect.stringContaining("https://app.okou.ai/sign-up"),
  );
});

test("A public conversation hides owner and agent identity", async () => {
  context.mocks.browser.matchMedia((query) => {
    return query === "(prefers-color-scheme: dark)";
  });
  context.mocks.api(sharedThreadsContract.get, ({ respond }) => {
    return respond(200, {
      ...sharedThread(),
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
          content: "The plain status is ready.",
          runIndex: 0,
        },
        {
          messageIndex: 2,
          role: "assistant",
          content: "Primary\n=\n\nLaunch the **public preview**.",
          runIndex: 0,
        },
        {
          messageIndex: 3,
          role: "assistant",
          content: "Secondary\n--",
          runIndex: 0,
        },
      ],
    });
  });

  await setupSharedThreadPage(context, { host: "app.okou.ai" });

  await expect(
    screen.findByRole("heading", { name: "Public launch plan" }),
  ).resolves.toBeInTheDocument();
  expect(screen.getByText("What should we launch?")).toBeInTheDocument();
  expect(screen.getByText("The plain status is ready.")).toBeInTheDocument();
  await expect(
    screen.findByRole("heading", { name: "Primary" }),
  ).resolves.toHaveProperty("tagName", "H1");
  expect(screen.getByRole("heading", { name: "Secondary" })).toHaveProperty(
    "tagName",
    "H2",
  );
  expect(screen.getByText("public preview")).toHaveProperty(
    "tagName",
    "STRONG",
  );
  expect(screen.queryByTestId("rich-content-loading")).not.toBeInTheDocument();
  const brandLink = getLinkByName("Okou");
  expect(brandLink).toHaveAttribute("href", "https://app.okou.ai");
  expect(within(brandLink).getByRole("img", { name: "Okou" })).toHaveAttribute(
    "src",
    platformOkouWordmarkLightImg,
  );
  expect(screen.queryByText("Owner")).not.toBeInTheDocument();
  expect(screen.queryByText("Agent")).not.toBeInTheDocument();
});

test("An intact public Goal archive displays its original literal text", async () => {
  const content =
    "Okou Goal retired.\nGoal ID: 00000000-0000-4000-8000-000000000001\nOriginal recorded status: paused\nThe recorded status is preserved; retirement does not mark the objective complete.\n\nFull original objective:\nBefore <oai-mem-citation>literal objective</oai-mem-citation> after\n`<oai-mem-citation>`\nUnclosed <oai-mem-citation>keep the rest 🧭\n\n";
  context.mocks.api(sharedThreadsContract.get, ({ respond }) => {
    return respond(
      200,
      sharedThread({
        messages: [{ messageIndex: 0, role: "assistant", content }],
      }),
    );
  });
  await setupSharedThreadPage(context, { host: "app.okou.ai" });
  const message = await screen.findByText(
    /Before <oai-mem-citation>literal objective/,
  );
  expect(message.textContent).toBe(content);
});
