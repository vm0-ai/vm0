import {
  zeroOrgContract,
  zeroOrgDeleteContract,
} from "@vm0/api-contracts/contracts/zero-org";
import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  click,
  detachedSetupPage,
  fill,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

function buttonByText(
  text: string,
  container: ParentNode = document.body,
): HTMLElement {
  const button = queryAllByRoleFast("button", container).find((candidate) => {
    return candidate.textContent?.replace(/\s+/g, " ").trim() === text;
  });
  if (!button) {
    throw new Error(`${text} button not found`);
  }
  return button;
}

async function openGeneralTab(): Promise<void> {
  detachedSetupPage({ context, path: "/?settings=general" });
  await waitFor(() => {
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "General" }),
    ).toBeInTheDocument();
  });
}

describe("organization general settings", () => {
  it("lets admins save or discard workspace profile edits", async () => {
    let capturedBody: unknown = null;
    const logoUrl = "https://cdn.vm0.test/orgs/old-slug/logo.png";
    context.mocks.data.org({
      id: "org_1",
      name: "Old Name",
      slug: "old-slug",
      role: "admin",
    });
    context.mocks.http.get("*/api/zero/org/logo", () => {
      return new Response(JSON.stringify({ logoUrl }), {
        headers: { "Content-Type": "application/json" },
      });
    });
    context.mocks.api(zeroOrgContract.update, ({ body, respond }) => {
      capturedBody = body;
      return respond(200, {
        id: "org_1",
        name: "New Name",
        slug: "new-slug",
        role: "admin",
      });
    });

    await openGeneralTab();

    await waitFor(() => {
      expect(screen.getByRole("img", { name: "old-slug" })).toHaveAttribute(
        "src",
        logoUrl,
      );
    });

    await fill(await screen.findByDisplayValue("Old Name"), "New Name");
    await fill(screen.getByDisplayValue("old-slug"), "new-slug");
    expect(screen.getByText("Save changes")).toBeInTheDocument();
    expect(screen.getByText("Discard")).toBeInTheDocument();

    click(screen.getByText("Discard"));
    expect(screen.getByDisplayValue("Old Name")).toBeInTheDocument();
    expect(screen.getByDisplayValue("old-slug")).toBeInTheDocument();

    await fill(screen.getByDisplayValue("Old Name"), "New Name");
    await fill(screen.getByDisplayValue("old-slug"), "new-slug");
    click(screen.getByText("Save changes"));

    await waitFor(() => {
      expect(capturedBody).toStrictEqual({
        name: "New Name",
        slug: "new-slug",
        force: true,
      });
    });
  });

  it("shows save errors without losing the current workspace state", async () => {
    context.mocks.data.org({
      id: "org_1",
      name: "Old Name",
      slug: "old-slug",
      role: "admin",
    });
    context.mocks.api(zeroOrgContract.update, ({ respond }) => {
      return respond(409, {
        error: {
          message: "Slug is already taken",
          code: "INTERNAL_SERVER_ERROR",
        },
      });
    });

    await openGeneralTab();

    await fill(await screen.findByDisplayValue("old-slug"), "taken-slug");
    click(screen.getByText("Save changes"));

    await waitFor(() => {
      expect(screen.getByText("Slug is already taken")).toBeInTheDocument();
      expect(screen.getByDisplayValue("taken-slug")).toBeInTheDocument();
    });
  });

  it("requires slug confirmation before deleting a workspace and keeps failures visible", async () => {
    let deleteShouldFail = true;
    context.mocks.data.org({
      id: "org_1",
      name: "Acme",
      slug: "acme",
      role: "admin",
    });
    context.mocks.api(zeroOrgDeleteContract.delete, ({ respond }) => {
      if (!deleteShouldFail) {
        return respond(200, { message: "Org deleted" });
      }
      return respond(400, {
        error: {
          message: "Delete blocked by active members",
          code: "INTERNAL_SERVER_ERROR",
        },
      });
    });

    await openGeneralTab();

    click(buttonByText("Delete"));

    const dialog = await screen.findByRole("dialog", {
      name: "Delete workspace?",
    });
    const deleteButton = buttonByText("Delete workspace", dialog);
    expect(deleteButton).toBeDisabled();

    await fill(within(dialog).getByPlaceholderText("acme"), "wrong");
    expect(deleteButton).toBeDisabled();

    await fill(within(dialog).getByPlaceholderText("acme"), "acme");
    expect(deleteButton).not.toBeDisabled();

    click(deleteButton);

    await waitFor(() => {
      expect(
        screen.getByText("Delete blocked by active members"),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("dialog", { name: "Delete workspace?" }),
      ).toBeInTheDocument();
    });

    deleteShouldFail = false;
    click(deleteButton);

    await waitFor(() => {
      expect(screen.getByText("Workspace deleted")).toBeInTheDocument();
      expect(window.location.href).toContain(
        "/sign-in/tasks/choose-organization",
      );
    });
  });
});
