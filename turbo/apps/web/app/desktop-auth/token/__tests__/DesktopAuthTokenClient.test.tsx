// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { DesktopAuthTokenClient } from "../DesktopAuthTokenClient";

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
      orgId: "org_1",
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

describe("DesktopAuthTokenClient", () => {
  beforeEach(() => {
    const getToken =
      vi.fn<(options?: GetTokenOptions) => Promise<string | null>>();
    getToken.mockResolvedValue("fresh-desktop-token");
    clerkState.auth = {
      getToken,
      isLoaded: true,
      isSignedIn: true,
      orgId: "org_1",
    };
    const setActive =
      vi.fn<(args: { readonly organization: string }) => Promise<void>>();
    setActive.mockResolvedValue(undefined);
    clerkState.organizationList = {
      isLoaded: true,
      setActive,
      userMemberships: { data: [] },
    };
    Reflect.deleteProperty(window, "vm0DesktopAuth");
    window.history.replaceState(null, "", "/desktop-auth/token");
  });

  it("sends a fresh Clerk session token to the desktop bridge", async () => {
    const completeSignIn = installDesktopAuthBridge();
    const replace = vi
      .spyOn(window.location, "replace")
      .mockImplementation(() => {
        return undefined;
      });

    render(<DesktopAuthTokenClient />);

    expect(screen.getByText("Signing in...")).toBeTruthy();
    await waitFor(() => {
      expect(clerkState.auth.getToken).toHaveBeenCalledWith({
        skipCache: true,
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
      orgId: null,
    };
    const completeSignIn = installDesktopAuthBridge();
    const replace = vi
      .spyOn(window.location, "replace")
      .mockImplementation(() => {
        return undefined;
      });

    render(<DesktopAuthTokenClient />);

    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith("/desktop-auth/start");
    });
    expect(completeSignIn).not.toHaveBeenCalled();
  });

  it("auto-selects a single workspace before completing desktop auth", async () => {
    const completeSignIn = installDesktopAuthBridge();
    clerkState.auth = {
      ...clerkState.auth,
      orgId: null,
    };
    clerkState.organizationList = {
      ...clerkState.organizationList,
      userMemberships: { data: [membership("org_1", "Workspace")] },
    };
    const replace = vi
      .spyOn(window.location, "replace")
      .mockImplementation(() => {
        return undefined;
      });

    render(<DesktopAuthTokenClient />);

    await waitFor(() => {
      expect(clerkState.organizationList.setActive).toHaveBeenCalledWith({
        organization: "org_1",
      });
    });
    await waitFor(() => {
      expect(completeSignIn).toHaveBeenCalledWith({
        token: "fresh-desktop-token",
      });
    });
    expect(replace).toHaveBeenCalledWith("/");
  });

  it("redirects multiple-workspace sessions to workspace selection", async () => {
    const completeSignIn = installDesktopAuthBridge();
    clerkState.auth = {
      ...clerkState.auth,
      orgId: null,
    };
    clerkState.organizationList = {
      ...clerkState.organizationList,
      userMemberships: {
        data: [
          membership("org_1", "First Workspace"),
          membership("org_2", "Second Workspace"),
        ],
      },
    };
    const replace = vi
      .spyOn(window.location, "replace")
      .mockImplementation(() => {
        return undefined;
      });

    render(<DesktopAuthTokenClient />);

    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith("/desktop-auth/select-org");
    });
    expect(completeSignIn).not.toHaveBeenCalled();
  });
});
