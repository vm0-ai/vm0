import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { clerk$ } from "../auth";
import { fetch$ } from "../fetch";
import { setOrigin } from "../location";
import { testContext } from "./test-helpers";

// Store mock instance at module level
// eslint-disable-next-line ccstate/no-package-variable
let mockClerkInstance: MockClerkType | null = null;

interface MockClerkType {
  user: { id: string } | null;
  session: { getToken: () => Promise<string | null> } | null;
  setUser: (user: { id: string } | null) => void;
  setSession: (
    session: { getToken: () => Promise<string | null> } | null,
  ) => void;
}

// Setup Clerk mock BEFORE importing auth module
vi.mock("@clerk/clerk-js/headless", () => {
  return {
    Clerk: function MockClerk() {
      const listeners: (() => void)[] = [];

      const instance = {
        user: null as { id: string } | null,
        session: null as { getToken: () => Promise<string | null> } | null,
        setUser(user: { id: string } | null) {
          instance.user = user;
          for (const listener of listeners) listener();
        },
        setSession(session: { getToken: () => Promise<string | null> } | null) {
          instance.session = session;
          for (const listener of listeners) listener();
        },
        load: () => Promise.resolve(),
        addListener: (callback: () => void) => {
          listeners.push(callback);
          return () => {
            const idx = listeners.indexOf(callback);
            if (idx !== -1) listeners.splice(idx, 1);
          };
        },
      };

      mockClerkInstance = instance;
      return instance;
    },
  };
});

// Mock the environment variable
vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", "test_key");

function getMockClerk(): MockClerkType | null {
  return mockClerkInstance;
}

function resetMockAuth(): void {
  if (mockClerkInstance) {
    mockClerkInstance.user = null;
    mockClerkInstance.session = null;
  }
}

const context = testContext();
const TEST_API_BASE = "http://localhost:3005";

beforeAll(() => {
  setOrigin(TEST_API_BASE);
});

function getLastRequestHeaders(
  traceFetch: ReturnType<typeof vi.fn>,
): Record<string, string> {
  const [, init] = traceFetch.mock.calls[traceFetch.mock.calls.length - 1] as [
    unknown,
    RequestInit,
  ];
  return init.headers as Record<string, string>;
}

describe("fetch$ signal integration tests", () => {
  let traceFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    traceFetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", traceFetch);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetMockAuth();
  });

  describe("headers handling", () => {
    it("should handle Headers object", async () => {
      const fch = context.store.get(fetch$);
      const inputHeaders = new Headers({
        "Content-Type": "application/json",
        "X-Custom": "custom-value",
      });

      await fch("/test", {
        headers: inputHeaders,
      });

      const headers = getLastRequestHeaders(traceFetch);
      expect(headers["Content-Type"]).toBe("application/json");
      expect(headers["X-Custom"]).toBe("custom-value");
    });

    it("should add Authorization header when session token exists", async () => {
      const mockToken = "test-jwt-token";
      const getTokenSpy = vi.fn().mockResolvedValue(mockToken);

      await context.store.get(clerk$);

      const mockClerk = getMockClerk();
      expect(mockClerk).toBeTruthy();

      if (mockClerk) {
        mockClerk.setUser({ id: "user-123" });
        mockClerk.setSession({
          getToken: getTokenSpy,
        });
      }

      const fch = context.store.get(fetch$);
      await fch("/test");

      expect(traceFetch).toHaveBeenCalledWith(
        expect.stringContaining("/test"),
        expect.any(Object),
      );
      expect(getTokenSpy).toHaveBeenCalledWith();

      const headers = getLastRequestHeaders(traceFetch);
      expect(headers.Authorization).toBe(`Bearer ${mockToken}`);
    });

    it("should not add Authorization header when no session", async () => {
      await context.store.get(clerk$);

      const mockClerk = getMockClerk();
      expect(mockClerk).toBeTruthy();
      expect(mockClerk?.session).toBeNull();

      const fch = context.store.get(fetch$);
      await fch("/test");

      const headers = getLastRequestHeaders(traceFetch);
      expect(headers.Authorization).toBeUndefined();
    });

    it("should handle both Authorization and custom headers", async () => {
      const mockToken = "test-jwt-token";
      const getTokenSpy = vi.fn().mockResolvedValue(mockToken);

      await context.store.get(clerk$);

      const mockClerk = getMockClerk();
      if (mockClerk) {
        mockClerk.setUser({ id: "user-123" });
        mockClerk.setSession({
          getToken: getTokenSpy,
        });
      }

      const fch = context.store.get(fetch$);
      const inputHeaders = {
        "Content-Type": "application/json",
        "X-Custom": "custom-value",
      };

      await fch("/test", {
        headers: inputHeaders,
      });

      const headers = getLastRequestHeaders(traceFetch);
      expect(headers.Authorization).toBe(`Bearer ${mockToken}`);
      expect(headers["Content-Type"]).toBe("application/json");
      expect(headers["X-Custom"]).toBe("custom-value");
    });

    it("should allow user-provided Authorization to override automatic one", async () => {
      const mockToken = "test-jwt-token";
      const getTokenSpy = vi.fn().mockResolvedValue(mockToken);

      await context.store.get(clerk$);

      const mockClerk = getMockClerk();
      if (mockClerk) {
        mockClerk.setUser({ id: "user-123" });
        mockClerk.setSession({
          getToken: getTokenSpy,
        });
      }

      const fch = context.store.get(fetch$);
      const customToken = "custom-override-token";

      await fch("/test", {
        headers: {
          Authorization: `Bearer ${customToken}`,
        },
      });

      const headers = getLastRequestHeaders(traceFetch);
      expect(headers.Authorization).toBe(`Bearer ${customToken}`);
    });
  });

  describe("URL handling", () => {
    it("should prepend apiBase to relative paths", async () => {
      const fch = context.store.get(fetch$);

      await fch("/users");

      expect(traceFetch).toHaveBeenCalledWith(
        `${TEST_API_BASE}/users`,
        expect.any(Object),
      );
    });

    it("should prepend apiBase to paths without leading slash", async () => {
      const fch = context.store.get(fetch$);

      await fch("users");

      expect(traceFetch).toHaveBeenCalledWith(
        `${TEST_API_BASE}/users`,
        expect.any(Object),
      );
    });

    it("should keep absolute URLs unchanged", async () => {
      const fch = context.store.get(fetch$);
      const absoluteUrl = "https://external-api.com/data";

      await fch(absoluteUrl);

      expect(traceFetch).toHaveBeenCalledWith(absoluteUrl, expect.any(Object));
    });

    it("should handle query parameters", async () => {
      const fch = context.store.get(fetch$);

      await fch("/api/users?page=1&size=10");

      expect(traceFetch).toHaveBeenCalledWith(
        `${TEST_API_BASE}/api/users?page=1&size=10`,
        expect.any(Object),
      );
    });
  });

  describe("other fetch parameters", () => {
    it("should preserve other RequestInit parameters", async () => {
      const fch = context.store.get(fetch$);

      await fch("/test", {
        method: "POST",
        body: JSON.stringify({ data: "test" }),
        mode: "cors",
        credentials: "include",
      });

      const [, init] = traceFetch.mock.calls[0] as [string, RequestInit];
      expect(init.method).toBe("POST");
      expect(init.body).toBe('{"data":"test"}');
      expect(init.mode).toBe("cors");
      expect(init.credentials).toBe("include");
    });

    it("should handle Request object", async () => {
      const fch = context.store.get(fetch$);

      await fch(new Request("/api/users", { method: "POST" }));

      const [processedRequest] = traceFetch.mock.calls[0] as [Request];

      expect(processedRequest.url).toBe(`${TEST_API_BASE}/api/users`);
    });
  });
});
