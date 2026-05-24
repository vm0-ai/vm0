import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  detachedSetupPage,
  fill,
  click,
} from "../../../__tests__/page-helper.ts";
import { refreshOrg$ } from "../../../signals/org.ts";
import {
  setMockOrg,
  resetMockOrg,
  setMockOrgLogo,
  resetMockOrgLogo,
} from "../../../mocks/handlers/api-org.ts";
import { zeroOrgContract } from "@vm0/api-contracts/contracts/zero-org";
import { createMockApi } from "../../../mocks/msw-contract.ts";
import { setOrgManageDialogOpen$ } from "../../../signals/zero-page/settings/org-manage-dialog.ts";
import { setActiveOrgManageTab$ } from "../../../signals/zero-page/settings/org-manage-tabs-state.ts";

const context = testContext();
const mockApi = createMockApi(context);

beforeEach(() => {
  resetMockOrg();
  resetMockOrgLogo();
});

async function openGeneralTab() {
  detachedSetupPage({ context, path: "/" });
  context.store.set(setActiveOrgManageTab$, "general");
  await context.store.set(setOrgManageDialogOpen$, true, context.signal);
  await waitFor(() => {
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
}

describe("org general tab - display", () => {
  // ORG-D-008
  it("logo preview image is displayed", async () => {
    setMockOrg({ slug: "my-org" });
    setMockOrgLogo("https://example.com/logo.png");
    await openGeneralTab();
    const logo = await screen.findByAltText("my-org");
    expect(logo).toBeInTheDocument();
    expect(logo).toHaveAttribute("src", "https://example.com/logo.png");
  });

  // ORG-D-009
  it("organization name is displayed", async () => {
    setMockOrg({ name: "Acme Corp" });
    await openGeneralTab();
    const nameInput = await screen.findByDisplayValue("Acme Corp");
    expect(nameInput).toBeInTheDocument();
  });

  // ORG-D-010
  it("organization slug is displayed", async () => {
    setMockOrg({ slug: "acme-corp" });
    await openGeneralTab();
    const slugInput = await screen.findByDisplayValue("acme-corp");
    expect(slugInput).toBeInTheDocument();
  });

  // ORG-D-011
  it("loading skeletons are shown while data loads", async () => {
    // First load org so the dialog opens normally
    setMockOrg({ slug: "test-org" });
    await openGeneralTab();
    // Wait for content to be rendered
    await screen.findByDisplayValue("test-org");

    // Now trigger a refresh with a never-resolving org response
    server.use(
      mockApi(zeroOrgContract.get, async ({ respond, never }) => {
        await never();
        return respond(200, {
          id: "org_1",
          slug: "test-org",
          name: "Test Org",
          role: "admin",
        });
      }),
    );
    context.store.set(refreshOrg$);

    // While org is reloading, the skeleton should be shown
    await waitFor(() => {
      expect(
        screen.queryByPlaceholderText("Workspace name"),
      ).not.toBeInTheDocument();
      expect(
        screen.getByRole("status", { name: "Loading" }),
      ).toBeInTheDocument();
    });
  });

  // ORG-D-012
  it("error messages shown during save failure", async () => {
    setMockOrg({ slug: "old-slug" });
    server.use(
      mockApi(zeroOrgContract.update, ({ respond }) => {
        return respond(409, {
          error: {
            message: "Slug already taken",
            code: "INTERNAL_SERVER_ERROR",
          },
        });
      }),
    );
    await openGeneralTab();
    const slugInput = await screen.findByDisplayValue("old-slug");
    await fill(slugInput, "taken-slug");
    click(screen.getByText("Save changes"));
    await waitFor(() => {
      expect(screen.getByText("Slug already taken")).toBeInTheDocument();
    });
  });

  // ORG-D-013
  it("logo upload preview is shown after selecting a file", async () => {
    const user = userEvent.setup();
    // Happy-dom does not decode image bytes, so `new Image()` never fires
    // `load` with real dimensions. Stub Image so readImageDimensions resolves
    // with an in-range size (100–4096 px) that the upload handler accepts.
    class FakeImage {
      naturalWidth = 512;
      naturalHeight = 512;
      private listeners: Record<string, () => void> = {};
      addEventListener(event: string, cb: () => void) {
        this.listeners[event] = cb;
      }
      set src(_value: string) {
        queueMicrotask(() => {
          this.listeners.load?.();
        });
      }
    }
    vi.stubGlobal("Image", FakeImage);
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:mock-preview");
    vi.spyOn(URL, "revokeObjectURL").mockReturnValue(undefined);
    setMockOrg({ slug: "test-org", name: "Test Org" });
    await openGeneralTab();
    // Wait for admin inputs to load
    await screen.findByDisplayValue("Test Org");
    const fileInput = screen.getByLabelText("Upload logo");
    const file = new File(["img"], "logo.png", { type: "image/png" });
    await user.upload(fileInput, file);
    await waitFor(() => {
      const img = screen.getByAltText("test-org");
      expect(img).toHaveAttribute("src", "blob:mock-preview");
    });
  });
});

describe("org general tab - interaction", () => {
  // ORG-I-015
  it("name input field is editable", async () => {
    setMockOrg({ name: "Old Name" });
    await openGeneralTab();
    const nameInput = await screen.findByDisplayValue("Old Name");
    await fill(nameInput, "New Name");
    expect(screen.getByDisplayValue("New Name")).toBeInTheDocument();
  });

  // ORG-I-016
  it("slug input field is editable", async () => {
    setMockOrg({ slug: "old-slug" });
    await openGeneralTab();
    const slugInput = await screen.findByDisplayValue("old-slug");
    await fill(slugInput, "new-slug");
    expect(screen.getByDisplayValue("new-slug")).toBeInTheDocument();
  });

  // ORG-I-017
  it("save changes button submits form", async () => {
    const requestBody = vi.fn();
    setMockOrg({ name: "Old Name", slug: "test-org" });
    server.use(
      mockApi(zeroOrgContract.update, ({ body, respond }) => {
        requestBody(body);
        // After a successful save, update the GET handler to return the new name
        // so the org refresh reflects the change and hasChanges becomes false
        setMockOrg({ name: "New Name", slug: "test-org" });
        return respond(200, {
          id: "org_1",
          slug: "test-org",
          name: "New Name",
          role: "admin",
        });
      }),
    );
    await openGeneralTab();
    const nameInput = await screen.findByDisplayValue("Old Name");
    await fill(nameInput, "New Name");
    click(screen.getByText("Save changes"));
    await waitFor(() => {
      expect(requestBody).toHaveBeenCalledWith({ name: "New Name" });
      // After a successful save the unsaved-changes toolbar disappears
      expect(screen.queryByText("Save changes")).not.toBeInTheDocument();
    });
  });

  // ORG-I-018
  it("discard button reverts changes", async () => {
    setMockOrg({ name: "Original Name" });
    await openGeneralTab();
    const nameInput = await screen.findByDisplayValue("Original Name");
    await fill(nameInput, "Changed Name");
    expect(screen.getByDisplayValue("Changed Name")).toBeInTheDocument();
    click(screen.getByText("Discard"));
    expect(screen.getByDisplayValue("Original Name")).toBeInTheDocument();
    expect(screen.queryByText("Save changes")).not.toBeInTheDocument();
  });

  // ORG-I-019
  it("leave workspace button opens confirmation dialog", async () => {
    setMockOrg({ role: "member" });
    await openGeneralTab();
    await waitFor(() => {
      expect(
        screen.getAllByRole("button").find((el) => {
          return el.textContent?.trim() === "Leave";
        }),
      ).toBeInTheDocument();
    });
    click(
      screen.getAllByRole("button").find((el) => {
        return el.textContent?.trim() === "Leave";
      })!,
    );
    await waitFor(() => {
      expect(screen.getByText("Leave workspace?")).toBeInTheDocument();
    });
  });

  // ORG-I-020
  it("delete workspace button opens confirmation dialog requiring slug", async () => {
    setMockOrg({ slug: "acme-org" });
    await openGeneralTab();
    // Wait for page to load
    await screen.findByDisplayValue("acme-org");
    const deleteButton = screen.getAllByRole("button").find((el) => {
      return el.textContent?.trim() === "Delete";
    });
    expect(deleteButton).toBeDefined();
    click(deleteButton!);
    await waitFor(() => {
      expect(screen.getByText("Delete workspace?")).toBeInTheDocument();
    });
    // The dialog should contain an input with placeholder matching the slug
    const confirmInput = screen.getByPlaceholderText("acme-org");
    expect(confirmInput).toBeInTheDocument();
  });
});

describe("org general tab - validation", () => {
  it("delete workspace requires typing exact slug", async () => {
    const user = userEvent.setup();
    setMockOrg({ slug: "my-workspace" });
    await openGeneralTab();
    await screen.findByDisplayValue("my-workspace");
    const deleteWorkspaceBtn = screen.getAllByRole("button").find((el) => {
      return el.textContent?.trim() === "Delete";
    });
    expect(deleteWorkspaceBtn).toBeDefined();
    click(deleteWorkspaceBtn!);
    await waitFor(() => {
      expect(screen.getByText("Delete workspace?")).toBeInTheDocument();
    });
    // Get the destructive "Delete workspace" button inside the dialog footer
    const deleteBtn = screen.getAllByRole("button").find((el) => {
      return el.textContent?.trim() === "Delete workspace";
    });
    expect(deleteBtn).toBeDefined();
    expect(deleteBtn).toBeDisabled();
    // Type wrong slug — still disabled
    const confirmInput = screen.getByPlaceholderText("my-workspace");
    await user.type(confirmInput, "wrong-slug");
    expect(deleteBtn).toBeDisabled();
    // Fill correct slug — now enabled
    await fill(confirmInput, "my-workspace");
    expect(deleteBtn).not.toBeDisabled();
  });
});
