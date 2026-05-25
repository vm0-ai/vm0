// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DesktopAuthSelectOrgClient } from "../DesktopAuthSelectOrgClient";

interface GetTokenOptions {
  readonly skipCache?: boolean;
}

interface AuthState {
  readonly getToken: (options?: GetTokenOptions) => Promise<string | null>;
  readonly isLoaded: boolean;
  readonly isSignedIn: boolean;
  readonly orgId: string | null;
}

interface TestOrganization {
  readonly id: string;
  readonly name: string;
}

interface TestMembership {
  readonly id: string;
  readonly organization: TestOrganization;
}

interface OrganizationListState {
  readonly isLoaded: boolean;
  readonly setActive: (args: {
    readonly organization: string;
  }) => Promise<void>;
  readonly userMemberships: {
    readonly data: readonly TestMembership[];
  };
}

const clerkState = vi.hoisted(() => {
  return {
    auth: {
      getToken: vi.fn<(options?: GetTokenOptions) => Promise<string | null>>(),
      isLoaded: true,
      isSignedIn: true,
      orgId: null,
    } as AuthState,
    organizationList: {
      isLoaded: true,
      setActive:
        vi.fn<(args: { readonly organization: string }) => Promise<void>>(),
      userMemberships: { data: [] },
    } as OrganizationListState,
  };
});

vi.mock("@clerk/nextjs", () => {
  return {
    useAuth: () => {
      return clerkState.auth;
    },
    useOrganizationList: () => {
      return clerkState.organizationList;
    },
  };
});

function installDesktopAuthBridge() {
  const completeSignIn =
    vi.fn<(params: { readonly token: string }) => Promise<void>>();
  completeSignIn.mockResolvedValue(undefined);
  Object.defineProperty(window, "vm0DesktopAuth", {
    value: { completeSignIn },
    configurable: true,
  });
  return completeSignIn;
}

function membership(id: string, name: string): TestMembership {
  return {
    id: `membership_${id}`,
    organization: { id, name },
  };
}

describe("DesktopAuthSelectOrgClient", () => {
  beforeEach(() => {
    const getToken =
      vi.fn<(options?: GetTokenOptions) => Promise<string | null>>();
    getToken.mockResolvedValue("fresh-desktop-token");
    clerkState.auth = {
      getToken,
      isLoaded: true,
      isSignedIn: true,
      orgId: null,
    };
    const setActive =
      vi.fn<(args: { readonly organization: string }) => Promise<void>>();
    setActive.mockResolvedValue(undefined);
    clerkState.organizationList = {
      isLoaded: true,
      setActive,
      userMemberships: {
        data: [
          membership("org_1", "First Workspace"),
          membership("org_2", "Second Workspace"),
        ],
      },
    };
    Reflect.deleteProperty(window, "vm0DesktopAuth");
    window.history.replaceState(null, "", "/desktop-auth/select-org");
  });

  it("sets the selected workspace and completes desktop auth", async () => {
    const completeSignIn = installDesktopAuthBridge();
    const replace = vi
      .spyOn(window.location, "replace")
      .mockImplementation(() => {
        return undefined;
      });

    render(<DesktopAuthSelectOrgClient forceSelection={false} />);

    fireEvent.click(screen.getByRole("button", { name: "Second Workspace" }));
    await waitFor(() => {
      expect(clerkState.organizationList.setActive).toHaveBeenCalledWith({
        organization: "org_2",
      });
    });
    await waitFor(() => {
      expect(completeSignIn).toHaveBeenCalledWith({
        token: "fresh-desktop-token",
      });
    });
    expect(replace).toHaveBeenCalledWith("/");
  });

  it("redirects signed-out sessions to desktop auth start", async () => {
    clerkState.auth = {
      ...clerkState.auth,
      isSignedIn: false,
    };
    const replace = vi
      .spyOn(window.location, "replace")
      .mockImplementation(() => {
        return undefined;
      });

    render(<DesktopAuthSelectOrgClient forceSelection={false} />);

    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith("/desktop-auth/start");
    });
  });

  it("completes immediately when a workspace is already active", async () => {
    const completeSignIn = installDesktopAuthBridge();
    clerkState.auth = {
      ...clerkState.auth,
      orgId: "org_1",
    };
    const replace = vi
      .spyOn(window.location, "replace")
      .mockImplementation(() => {
        return undefined;
      });

    render(<DesktopAuthSelectOrgClient forceSelection={false} />);

    await waitFor(() => {
      expect(completeSignIn).toHaveBeenCalledWith({
        token: "fresh-desktop-token",
      });
    });
    expect(replace).toHaveBeenCalledWith("/");
  });

  it("keeps showing choices when forced even if a workspace is active", () => {
    const completeSignIn = installDesktopAuthBridge();
    clerkState.auth = {
      ...clerkState.auth,
      orgId: "org_1",
    };

    render(<DesktopAuthSelectOrgClient forceSelection={true} />);

    expect(
      screen.getByRole("button", { name: "First Workspace" }),
    ).toBeTruthy();
    expect(completeSignIn).not.toHaveBeenCalled();
  });
});
