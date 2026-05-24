import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { toast } from "@vm0/ui/components/ui/sonner";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  detachedSetupPage,
  fill,
  click,
} from "../../../__tests__/page-helper.ts";
import { mockedClerk } from "../../../__tests__/mock-auth.ts";
import {
  setMockOrg,
  resetMockOrg,
  setMockOrgLogo,
  resetMockOrgLogo,
} from "../../../mocks/handlers/api-org.ts";
import {
  zeroOrgContract,
  zeroOrgLeaveContract,
  zeroOrgDeleteContract,
} from "@vm0/api-contracts/contracts/zero-org";
import { createMockApi } from "../../../mocks/msw-contract.ts";
import { setOrgManageDialogOpen$ } from "../../../signals/zero-page/settings/org-manage-dialog.ts";
import { setActiveOrgManageTab$ } from "../../../signals/zero-page/settings/org-manage-tabs-state.ts";

vi.mock("@vm0/ui/components/ui/sonner", async (importOriginal) => {
  const actual =
    (await importOriginal()) as typeof import("@vm0/ui/components/ui/sonner");
  return {
    ...actual,
    toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
  };
});

const context = testContext();
const mockApi = createMockApi(context);

beforeEach(() => {
  resetMockOrg();
  resetMockOrgLogo();
  vi.mocked(toast.error).mockClear();
  vi.mocked(toast.success).mockClear();
});

/**
 * Happy-dom does not decode actual image bytes, so `new Image()` never
 * fires `load` with real `naturalWidth`/`naturalHeight`. Stub the global
 * `Image` constructor for the lifetime of a single test so the handler's
 * dimension check has a deterministic answer.
 */
function stubImageDimensions(width: number, height: number): void {
  class FakeImage {
    naturalWidth = width;
    naturalHeight = height;
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
  // Override only the two URL methods we care about — happy-dom's default
  // revokeObjectURL throws on unknown blob URLs, and the real createObjectURL
  // requires a live blob. Full URL stubbing would break MSW's URL parser.
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:mock");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
}

async function openGeneralTab() {
  detachedSetupPage({ context, path: "/" });
  context.store.set(setActiveOrgManageTab$, "general");
  await context.store.set(setOrgManageDialogOpen$, true, context.signal);
  await waitFor(() => {
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
}

describe("org general tab - profile section", () => {
  it("should show name and slug inputs for admin", async () => {
    setMockOrg({ name: "My Org", slug: "my-org", role: "admin" });
    await openGeneralTab();

    const nameInput = await screen.findByDisplayValue("My Org");
    expect(nameInput).toBeInTheDocument();

    const slugInput = await screen.findByDisplayValue("my-org");
    expect(slugInput).toBeInTheDocument();
  });

  it("should show name and slug as read-only text for non-admin", async () => {
    setMockOrg({ name: "My Org", slug: "my-org", role: "member" });
    await openGeneralTab();

    await waitFor(() => {
      expect(screen.getByText("My Org")).toBeInTheDocument();
    });

    // Non-admin should see text, not inputs
    expect(screen.queryByDisplayValue("My Org")).not.toBeInTheDocument();
    expect(screen.getByText("my-org")).toBeInTheDocument();
    expect(screen.queryByDisplayValue("my-org")).not.toBeInTheDocument();
  });

  it("should show save/discard buttons when slug is changed", async () => {
    setMockOrg({ slug: "old-slug" });
    await openGeneralTab();

    const slugInput = await screen.findByDisplayValue("old-slug");
    await fill(slugInput, "new-slug");

    expect(screen.getByText("Save changes")).toBeInTheDocument();
    expect(screen.getByText("Discard")).toBeInTheDocument();
  });

  it("should discard slug changes when clicking Discard", async () => {
    setMockOrg({ slug: "original-slug" });
    await openGeneralTab();

    const slugInput = await screen.findByDisplayValue("original-slug");
    await fill(slugInput, "changed-slug");

    expect(screen.getByDisplayValue("changed-slug")).toBeInTheDocument();

    click(screen.getByText("Discard"));

    expect(screen.getByDisplayValue("original-slug")).toBeInTheDocument();
    expect(screen.queryByText("Save changes")).not.toBeInTheDocument();
  });

  it("should send slug in PUT request when saving slug change", async () => {
    const requestBody = vi.fn();
    setMockOrg({ name: "Test Org", slug: "old-slug" });
    server.use(
      mockApi(zeroOrgContract.update, ({ body, respond }) => {
        requestBody(body);
        return respond(200, {
          id: "org_1",
          slug: "new-slug",
          name: "Test Org",
          role: "admin",
        });
      }),
    );

    await openGeneralTab();

    const slugInput = await screen.findByDisplayValue("old-slug");
    await fill(slugInput, "new-slug");

    click(screen.getByText("Save changes"));

    await vi.waitFor(() => {
      expect(requestBody).toHaveBeenCalledWith({
        slug: "new-slug",
        force: true,
      });
    });
  });

  it("should send both name and slug when both are changed", async () => {
    const requestBody = vi.fn();
    setMockOrg({ name: "Old Name", slug: "old-slug" });
    server.use(
      mockApi(zeroOrgContract.update, ({ body, respond }) => {
        requestBody(body);
        return respond(200, {
          id: "org_1",
          slug: "new-slug",
          name: "New Name",
          role: "admin",
        });
      }),
    );

    await openGeneralTab();

    const nameInput = await screen.findByDisplayValue("Old Name");
    const slugInput = screen.getByDisplayValue("old-slug");

    await fill(nameInput, "New Name");
    await fill(slugInput, "new-slug");

    click(screen.getByText("Save changes"));

    await vi.waitFor(() => {
      expect(requestBody).toHaveBeenCalledWith({
        name: "New Name",
        slug: "new-slug",
        force: true,
      });
    });
  });

  it("should show inline error when save fails", async () => {
    setMockOrg({ slug: "old-slug" });
    server.use(
      mockApi(zeroOrgContract.update, ({ respond }) => {
        return respond(409, {
          error: {
            message: "Slug is already taken",
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
      expect(screen.getByText("Slug is already taken")).toBeInTheDocument();
    });
  });

  it("should clear inline error on discard", async () => {
    setMockOrg({ slug: "old-slug" });
    server.use(
      mockApi(zeroOrgContract.update, ({ respond }) => {
        return respond(409, {
          error: {
            message: "Slug is already taken",
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
      expect(screen.getByText("Slug is already taken")).toBeInTheDocument();
    });

    click(screen.getByText("Discard"));

    expect(screen.queryByText("Slug is already taken")).not.toBeInTheDocument();
  });

  it("should reject a logo that is too small with a toast", async () => {
    stubImageDimensions(50, 50);
    setMockOrg({ name: "My Org", slug: "my-org", role: "admin" });
    await openGeneralTab();

    const fileInput = (await screen.findByLabelText(
      "Upload logo",
    )) as HTMLInputElement;
    const file = new File(["x"], "tiny.png", { type: "image/png" });
    Object.defineProperty(fileInput, "files", { value: [file] });
    fileInput.dispatchEvent(new Event("change", { bubbles: true }));

    await waitFor(() => {
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
        "Logo is too small (50×50px). Minimum size is 100×100px.",
      );
    });

    // File must not have been staged — no Save button should appear
    expect(screen.queryByText("Save changes")).not.toBeInTheDocument();
  });

  it("should reject a logo that is too large with a toast", async () => {
    stubImageDimensions(5000, 5000);
    setMockOrg({ name: "My Org", slug: "my-org", role: "admin" });
    await openGeneralTab();

    const fileInput = (await screen.findByLabelText(
      "Upload logo",
    )) as HTMLInputElement;
    const file = new File(["x"], "huge.png", { type: "image/png" });
    Object.defineProperty(fileInput, "files", { value: [file] });
    fileInput.dispatchEvent(new Event("change", { bubbles: true }));

    await waitFor(() => {
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
        "Logo is too large (5000×5000px). Maximum size is 4096×4096px.",
      );
    });

    expect(screen.queryByText("Save changes")).not.toBeInTheDocument();
  });

  it("should accept a logo within bounds and stage it for save", async () => {
    stubImageDimensions(512, 512);
    setMockOrg({ name: "My Org", slug: "my-org", role: "admin" });
    await openGeneralTab();

    const fileInput = (await screen.findByLabelText(
      "Upload logo",
    )) as HTMLInputElement;
    const file = new File(["x"], "good.png", { type: "image/png" });
    Object.defineProperty(fileInput, "files", { value: [file] });
    fileInput.dispatchEvent(new Event("change", { bubbles: true }));

    // Save button appears because a valid file was staged
    await waitFor(() => {
      expect(screen.getByText("Save changes")).toBeInTheDocument();
    });
    expect(vi.mocked(toast.error)).not.toHaveBeenCalled();
  });

  it("should load and display logo for non-admin members", async () => {
    setMockOrg({ role: "member" });
    setMockOrgLogo("https://example.com/logo.png");

    await openGeneralTab();

    const logo = await screen.findByAltText("user-12345678");
    expect(logo).toBeInTheDocument();
    expect(logo).toHaveAttribute("src", "https://example.com/logo.png");
  });

  it("should not send slug when only name is changed", async () => {
    const requestBody = vi.fn();
    setMockOrg({ name: "Old Name", slug: "keep-slug" });
    server.use(
      mockApi(zeroOrgContract.update, ({ body, respond }) => {
        requestBody(body);
        return respond(200, {
          id: "org_1",
          slug: "keep-slug",
          name: "New Name",
          role: "admin",
        });
      }),
    );

    await openGeneralTab();

    const nameInput = await screen.findByDisplayValue("Old Name");
    await fill(nameInput, "New Name");

    click(screen.getByText("Save changes"));

    await vi.waitFor(() => {
      expect(requestBody).toHaveBeenCalledWith({ name: "New Name" });
    });
  });
});

describe("org general tab - danger zone", () => {
  const CHOOSE_ORG_PATH = "/sign-in/tasks/choose-organization";

  afterEach(() => {
    // These tests intentionally navigate to choose-organization, so always
    // reset the location before the next test runs.
    if (window.location.pathname !== "/") {
      window.location.href = "http://localhost/";
    }
  });

  it("leaves workspace: clears active org then navigates to choose-organization", async () => {
    const leaveCalled = vi.fn();
    setMockOrg({ role: "member", slug: "my-org" });
    server.use(
      mockApi(zeroOrgLeaveContract.leave, ({ respond }) => {
        leaveCalled();
        return respond(200, { message: "ok" });
      }),
    );

    await openGeneralTab();

    const leaveTrigger = await waitFor(() => {
      const btn = screen.getAllByRole("button").find((el) => {
        return el.textContent?.trim() === "Leave";
      });
      expect(btn).toBeInTheDocument();
      return btn as HTMLElement;
    });
    click(leaveTrigger);

    const confirmBtn = await waitFor(() => {
      const buttons = screen.getAllByRole("button");
      const btn = buttons.find((el) => {
        return (
          el.textContent?.trim() === "Leave" && el.closest('[role="dialog"]')
        );
      });
      expect(btn).toBeInTheDocument();
      return btn as HTMLElement;
    });
    click(confirmBtn);

    await waitFor(() => {
      expect(leaveCalled).toHaveBeenCalledTimes(1);
    });

    await waitFor(() => {
      expect(mockedClerk.setActive).toHaveBeenCalledWith({
        organization: null,
      });
    });

    await waitFor(() => {
      expect(window.location.href).toContain(CHOOSE_ORG_PATH);
    });
  });

  it("deletes workspace: clears active org then navigates to choose-organization", async () => {
    const deleteCalled = vi.fn();
    setMockOrg({ role: "admin", slug: "my-org" });
    server.use(
      mockApi(zeroOrgDeleteContract.delete, ({ respond }) => {
        deleteCalled();
        return respond(200, { message: "ok" });
      }),
    );

    await openGeneralTab();

    const deleteTrigger = await waitFor(() => {
      const btn = screen.getAllByRole("button").find((el) => {
        return el.textContent?.trim() === "Delete";
      });
      expect(btn).toBeInTheDocument();
      return btn as HTMLElement;
    });
    click(deleteTrigger);

    const slugInput = await screen.findByPlaceholderText("my-org");
    await fill(slugInput, "my-org");

    const confirmBtn = await waitFor(() => {
      const buttons = screen.getAllByRole("button");
      const btn = buttons.find((el) => {
        return el.textContent?.trim() === "Delete workspace";
      });
      expect(btn).toBeInTheDocument();
      expect(btn).not.toBeDisabled();
      return btn as HTMLElement;
    });
    click(confirmBtn);

    await waitFor(() => {
      expect(deleteCalled).toHaveBeenCalledTimes(1);
    });

    await waitFor(() => {
      expect(mockedClerk.setActive).toHaveBeenCalledWith({
        organization: null,
      });
    });

    await waitFor(() => {
      expect(window.location.href).toContain(CHOOSE_ORG_PATH);
    });
  });

  it("does not clear active org or navigate when leave API fails", async () => {
    const leaveCalled = vi.fn();
    setMockOrg({ role: "member", slug: "my-org" });
    server.use(
      mockApi(zeroOrgLeaveContract.leave, ({ respond }) => {
        leaveCalled();
        return respond(500, {
          error: { message: "boom", code: "INTERNAL_SERVER_ERROR" },
        });
      }),
    );

    await openGeneralTab();

    const leaveTrigger = await waitFor(() => {
      const btn = screen.getAllByRole("button").find((el) => {
        return el.textContent?.trim() === "Leave";
      });
      expect(btn).toBeInTheDocument();
      return btn as HTMLElement;
    });
    click(leaveTrigger);

    const confirmBtn = await waitFor(() => {
      const buttons = screen.getAllByRole("button");
      const btn = buttons.find((el) => {
        return (
          el.textContent?.trim() === "Leave" && el.closest('[role="dialog"]')
        );
      });
      expect(btn).toBeInTheDocument();
      return btn as HTMLElement;
    });
    click(confirmBtn);

    await waitFor(() => {
      expect(leaveCalled).toHaveBeenCalledTimes(1);
    });

    // Session must not be touched on failure — otherwise a transient 5xx
    // could silently log the user out of their current workspace.
    expect(mockedClerk.setActive).not.toHaveBeenCalled();
    expect(window.location.href).not.toContain(CHOOSE_ORG_PATH);
  });
});
