import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage, fill } from "../../../__tests__/page-helper.ts";
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
} from "@vm0/core";
import { mockApi } from "../../../mocks/msw-contract.ts";

const context = testContext();

beforeEach(() => {
  resetMockOrg();
  resetMockOrgLogo();
});

async function openGeneralTab() {
  detachedSetupPage({ context, path: "/?settings=general" });
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
    const user = userEvent.setup();
    setMockOrg({ slug: "original-slug" });
    await openGeneralTab();

    const slugInput = await screen.findByDisplayValue("original-slug");
    await fill(slugInput, "changed-slug");

    expect(screen.getByDisplayValue("changed-slug")).toBeInTheDocument();

    await user.click(screen.getByText("Discard"));

    expect(screen.getByDisplayValue("original-slug")).toBeInTheDocument();
    expect(screen.queryByText("Save changes")).not.toBeInTheDocument();
  });

  it("should send slug in PUT request when saving slug change", async () => {
    const user = userEvent.setup();
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

    await user.click(screen.getByText("Save changes"));

    await vi.waitFor(() => {
      expect(requestBody).toHaveBeenCalledWith({
        slug: "new-slug",
        force: true,
      });
    });
  });

  it("should send both name and slug when both are changed", async () => {
    const user = userEvent.setup();
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

    await user.click(screen.getByText("Save changes"));

    await vi.waitFor(() => {
      expect(requestBody).toHaveBeenCalledWith({
        name: "New Name",
        slug: "new-slug",
        force: true,
      });
    });
  });

  it("should show inline error when save fails", async () => {
    const user = userEvent.setup();
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

    await user.click(screen.getByText("Save changes"));

    await waitFor(() => {
      expect(screen.getByText("Slug is already taken")).toBeInTheDocument();
    });
  });

  it("should clear inline error on discard", async () => {
    const user = userEvent.setup();
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

    await user.click(screen.getByText("Save changes"));

    await waitFor(() => {
      expect(screen.getByText("Slug is already taken")).toBeInTheDocument();
    });

    await user.click(screen.getByText("Discard"));

    expect(screen.queryByText("Slug is already taken")).not.toBeInTheDocument();
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
    const user = userEvent.setup();
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

    await user.click(screen.getByText("Save changes"));

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
    const user = userEvent.setup();
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
    await user.click(leaveTrigger);

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
    await user.click(confirmBtn);

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
    const user = userEvent.setup();
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
    await user.click(deleteTrigger);

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
    await user.click(confirmBtn);

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
    const user = userEvent.setup();
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
    await user.click(leaveTrigger);

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
    await user.click(confirmBtn);

    await waitFor(() => {
      expect(leaveCalled).toHaveBeenCalledTimes(1);
    });

    // Session must not be touched on failure — otherwise a transient 5xx
    // could silently log the user out of their current workspace.
    expect(mockedClerk.setActive).not.toHaveBeenCalled();
    expect(window.location.href).not.toContain(CHOOSE_ORG_PATH);
  });
});
