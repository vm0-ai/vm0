import { describe, it, expect, vi, beforeEach } from "vitest";
import Home from "../page";

const { authMock, notFoundMock } = vi.hoisted(() => {
  return {
    authMock: vi.fn(),
    // Mirror React's notFound(): throw a tagged error so any code running
    // after this call short-circuits, matching production behaviour.
    notFoundMock: vi.fn(() => {
      throw new Error("NEXT_NOT_FOUND");
    }),
  };
});

vi.mock("@clerk/nextjs/server", () => {
  return {
    auth: authMock,
  };
});

vi.mock("next/navigation", () => {
  return {
    notFound: notFoundMock,
  };
});

vi.mock("next-intl/server", () => {
  return {
    getRequestConfig: vi.fn((fn: unknown) => {
      return fn;
    }),
  };
});

vi.mock("next-intl", () => {
  return {
    useTranslations: vi.fn(() => {
      return (key: string) => {
        return key;
      };
    }),
    useLocale: vi.fn(() => {
      return "en";
    }),
  };
});

vi.mock("next-intl/navigation", () => {
  return {
    createNavigation: vi.fn(() => {
      return {
        Link: () => {
          return null;
        },
        redirect: vi.fn(),
        usePathname: vi.fn(),
        useRouter: vi.fn(),
      };
    }),
  };
});

describe("Home page locale guard", () => {
  beforeEach(() => {
    authMock.mockReset();
    notFoundMock.mockClear();
    authMock.mockResolvedValue({ userId: null });
  });

  it("renders for a supported locale by calling auth()", async () => {
    await Home({ params: Promise.resolve({ locale: "en" }) });

    expect(notFoundMock).not.toHaveBeenCalled();
    expect(authMock).toHaveBeenCalledTimes(1);
  });

  it("calls notFound() for an unsupported locale before auth()", async () => {
    // Reproduces issue #10363: bots hit asset-like paths (e.g.
    // /apple-touch-icon-precomposed.png) which Next.js routes to this
    // dynamic segment. Middleware's matcher excludes dotted paths, so
    // clerkMiddleware never ran — auth() here would throw.
    await expect(
      Home({
        params: Promise.resolve({ locale: "apple-touch-icon-precomposed.png" }),
      }),
    ).rejects.toThrow("NEXT_NOT_FOUND");

    expect(notFoundMock).toHaveBeenCalledTimes(1);
    expect(authMock).not.toHaveBeenCalled();
  });

  it("calls notFound() for non-dotted invalid locales too", async () => {
    await expect(
      Home({ params: Promise.resolve({ locale: "zh" }) }),
    ).rejects.toThrow("NEXT_NOT_FOUND");

    expect(authMock).not.toHaveBeenCalled();
  });
});
