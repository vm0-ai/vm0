import { userExportContract } from "@okouai/api-contracts/contracts/user-export";
import { screen } from "@testing-library/react";
import { expect, test } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { mockNow } from "../../../lib/time.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();
const NOW = Date.parse("2026-09-01T00:00:00.000Z");

function mockCompletedExport(canExport: boolean): void {
  context.mocks.api(userExportContract.get, ({ respond }) => {
    return respond(200, {
      job: {
        id: "11111111-1111-4111-8111-111111111111",
        status: "completed",
        createdAt: "2026-08-31T23:00:00.000Z",
        completedAt: "2026-09-01T00:00:00.000Z",
        expiresAt: "2026-09-02T12:00:00.000Z",
        downloadUrl: "https://downloads.example/export.zip",
        error: null,
      },
      canExport,
      nextExportAt: canExport ? null : "2026-09-02T00:00:00.000Z",
    });
  });
}

function getButton(name: string): HTMLButtonElement {
  const button = queryAllByRoleFast("button").find((candidate) => {
    return candidate.textContent?.trim() === name;
  });
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Button not found: ${name}`);
  }
  return button;
}

function getDownloadLink(name: string): HTMLAnchorElement {
  const link = queryAllByRoleFast("link").find((candidate) => {
    return candidate.textContent?.trim() === name;
  });
  if (!(link instanceof HTMLAnchorElement)) {
    throw new Error(`Download link not found: ${name}`);
  }
  return link;
}

test("A completed export shows its contents, expiry, and cooldown", async () => {
  let exportAttempts = 0;
  mockNow(NOW, context.signal);
  mockCompletedExport(true);
  context.mocks.api(userExportContract.post, ({ respond }) => {
    exportAttempts += 1;
    return respond(429, {
      error: {
        code: "TOO_MANY_REQUESTS",
        message: "Export cooldown is active",
      },
    });
  });

  await setupPage({ context, path: "/export", host: "app.vm0.ai" });

  await expect(
    screen.findByRole("heading", { name: "Export data" }),
  ).resolves.toBeVisible();
  expect(
    screen.getByText("Workflow SKILL.md instructions and files"),
  ).toBeVisible();
  expect(screen.getByText("Memory files")).toBeVisible();
  expect(
    screen.getByText("The download link expires in 1d 12h."),
  ).toBeVisible();
  expect(getDownloadLink("Download export")).toHaveAttribute(
    "href",
    "https://downloads.example/export.zip",
  );

  click(getButton("Export again"));

  await expect(
    screen.findByText("You can export once every 24 hours."),
  ).resolves.toBeVisible();
  expect(exportAttempts).toBe(1);
});
