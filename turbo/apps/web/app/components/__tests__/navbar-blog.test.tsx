import { describe, it, expect, vi } from "vitest";
import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ThemeProvider } from "../ThemeProvider";
import { Navbar } from "../Navbar";

// External: next-intl/navigation (used by navigation.ts -> Link, usePathname, useRouter)
vi.mock("next-intl/navigation", () => {
  return {
    createNavigation: vi.fn(() => {
      return {
        Link: ({
          href,
          children,
          className,
        }: {
          href: string;
          children: React.ReactNode;
          className?: string;
        }) => {
          return (
            <a href={href} className={className}>
              {children}
            </a>
          );
        },
        redirect: vi.fn(),
        usePathname: vi.fn(() => {
          return "/";
        }),
        useRouter: vi.fn(() => {
          return { push: vi.fn() };
        }),
      };
    }),
  };
});

// External: next-intl (used by Navbar, LanguageSwitcher)
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

// External: @clerk/nextjs (used by Navbar)
vi.mock("@clerk/nextjs", () => {
  return {
    useUser: vi.fn(() => {
      return { isSignedIn: false, user: null, isLoaded: true };
    }),
    useClerk: vi.fn(() => {
      return { signOut: vi.fn() };
    }),
  };
});

// External: next/link (used by Navbar)
vi.mock("next/link", () => {
  return {
    default: ({
      href,
      children,
      className,
    }: {
      href: string;
      children: React.ReactNode;
      className?: string;
    }) => {
      return (
        <a href={href} className={className}>
          {children}
        </a>
      );
    },
  };
});

// External: next/image (used by Navbar)
vi.mock("next/image", () => {
  return {
    default: ({ alt, src }: { alt: string; src: string }) => {
      return <span data-alt={alt} data-src={src} />;
    },
  };
});

// External: @tabler/icons-react (used by Navbar)
vi.mock("@tabler/icons-react", () => {
  const Icon = () => {
    return <span />;
  };
  return {
    IconArrowRight: Icon,
    IconArrowUpRight: Icon,
    IconBrandGithub: Icon,
    IconChevronDown: Icon,
  };
});

// External: @radix-ui/react-popover (used by NavMenu)
vi.mock("@radix-ui/react-popover", () => {
  const passthrough = ({ children }: { children?: React.ReactNode }) => {
    return <>{children}</>;
  };
  return {
    Root: passthrough,
    Trigger: ({
      children,
      className,
    }: {
      children?: React.ReactNode;
      className?: string;
    }) => {
      return <button className={className}>{children}</button>;
    },
    Portal: passthrough,
    Content: passthrough,
  };
});

function renderNavbar(props: ComponentProps<typeof Navbar> = {}) {
  return renderToStaticMarkup(
    <ThemeProvider>
      <Navbar {...props} />
    </ThemeProvider>,
  );
}

describe("Navbar blog link visibility", () => {
  it("does not render blog link when blog feature is disabled", () => {
    // NEXT_PUBLIC_STRAPI_URL is not stubbed in global test setup,
    // so isBlogEnabled() returns false by default
    const html = renderNavbar();

    expect(html).not.toContain('href="/blog"');
  });

  it("renders blog link when blog feature is enabled", () => {
    vi.stubEnv("NEXT_PUBLIC_STRAPI_URL", "https://strapi.example.com");

    const html = renderNavbar();

    expect(html).toContain('href="/blog"');
  });

  it("renders docs link only when the server-side feature gate allows it", () => {
    expect(renderNavbar()).not.toContain('href="/docs"');
    expect(renderNavbar({ initialShowDocs: true })).toContain('href="/docs"');
  });
});
