// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import type {
  AnchorHTMLAttributes,
  ButtonHTMLAttributes,
  ComponentProps,
  HTMLAttributes,
  ReactNode,
} from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, fireEvent, render, screen } from "@testing-library/react";
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
          ...props
        }: {
          href: string;
          children: ReactNode;
          className?: string;
        } & AnchorHTMLAttributes<HTMLAnchorElement>) => {
          return (
            <a href={href} className={className} {...props}>
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
      ...props
    }: {
      href: string;
      children: ReactNode;
      className?: string;
    } & AnchorHTMLAttributes<HTMLAnchorElement>) => {
      return (
        <a href={href} className={className} {...props}>
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
  const passthrough = ({ children }: { children?: ReactNode }) => {
    return <>{children}</>;
  };
  return {
    Root: passthrough,
    Trigger: ({
      children,
      className,
      ...props
    }: {
      children?: ReactNode;
      className?: string;
    } & ButtonHTMLAttributes<HTMLButtonElement>) => {
      return (
        <button className={className} {...props}>
          {children}
        </button>
      );
    },
    Portal: passthrough,
    Content: ({
      children,
      ...props
    }: {
      children?: ReactNode;
    } & HTMLAttributes<HTMLDivElement>) => {
      return <div {...props}>{children}</div>;
    },
  };
});

function renderNavbar(props: ComponentProps<typeof Navbar> = {}) {
  return renderToStaticMarkup(
    <ThemeProvider>
      <Navbar {...props} />
    </ThemeProvider>,
  );
}

function renderNavbarClient(props: ComponentProps<typeof Navbar> = {}) {
  return render(
    <ThemeProvider>
      <Navbar {...props} />
    </ThemeProvider>,
  );
}

function getDesktopNavTrigger(label: string): HTMLButtonElement {
  const trigger = screen.getAllByRole("button").find((button) => {
    return (
      button.classList.contains("nav-trigger") &&
      button.textContent?.includes(label)
    );
  });
  if (!trigger) {
    throw new Error(`Missing nav trigger: ${label}`);
  }
  return trigger as HTMLButtonElement;
}

function getNavPopover(id: string): HTMLElement {
  const popover = document.querySelector<HTMLElement>(
    `[data-nav-popover-id="${id}"]`,
  );
  if (!popover) {
    throw new Error(`Missing nav popover: ${id}`);
  }
  return popover;
}

function setElementRect(
  element: Element,
  rect: Pick<DOMRect, "bottom" | "height" | "left" | "right" | "top" | "width">,
): void {
  Object.defineProperty(element, "getBoundingClientRect", {
    configurable: true,
    value: () => {
      return {
        x: rect.left,
        y: rect.top,
        ...rect,
        toJSON: () => {
          return rect;
        },
      };
    },
  });
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

describe("Navbar dropdown interactions", () => {
  it("keeps the newly hovered menu open when a previous close timer expires", () => {
    vi.useFakeTimers();
    try {
      renderNavbarClient();

      const resources = getDesktopNavTrigger("resources");
      const trust = getDesktopNavTrigger("trustAndTech");

      const navCenter = document.querySelector<HTMLDivElement>(".nav-center");
      expect(navCenter).not.toBeNull();
      setElementRect(resources, {
        left: 100,
        right: 180,
        top: 10,
        bottom: 30,
        width: 80,
        height: 20,
      });
      setElementRect(trust, {
        left: 220,
        right: 340,
        top: 10,
        bottom: 30,
        width: 120,
        height: 20,
      });

      fireEvent.pointerEnter(resources);
      expect(resources).toHaveClass("nav-trigger-active");

      fireEvent.pointerMove(navCenter!, { clientX: 215, clientY: 20 });
      expect(resources).not.toHaveClass("nav-trigger-active");
      expect(trust).toHaveClass("nav-trigger-active");

      act(() => {
        vi.advanceTimersByTime(300);
      });

      expect(trust).toHaveClass("nav-trigger-active");
    } finally {
      vi.useRealTimers();
    }
  });

  it("closes the open menu when a dropdown item is clicked", () => {
    renderNavbarClient();

    const resources = getDesktopNavTrigger("resources");
    fireEvent.pointerEnter(resources);
    expect(resources).toHaveClass("nav-trigger-active");

    const firstItem =
      document.querySelector<HTMLAnchorElement>(".nav-popover-item");
    expect(firstItem).not.toBeNull();
    fireEvent.click(firstItem!);

    expect(resources).not.toHaveClass("nav-trigger-active");
  });

  it("does not reopen from trigger focus restoration after a dropdown item click", () => {
    vi.useFakeTimers();
    try {
      renderNavbarClient();

      const resources = getDesktopNavTrigger("resources");
      fireEvent.pointerEnter(resources);
      expect(resources).toHaveClass("nav-trigger-active");

      const firstItem =
        document.querySelector<HTMLAnchorElement>(".nav-popover-item");
      expect(firstItem).not.toBeNull();
      fireEvent.click(firstItem!);

      fireEvent.focus(resources);
      expect(resources).not.toHaveClass("nav-trigger-active");

      act(() => {
        vi.advanceTimersByTime(400);
      });

      fireEvent.focus(resources);
      expect(resources).toHaveClass("nav-trigger-active");
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores immediate hover reopen after a dropdown item is selected", () => {
    vi.useFakeTimers();
    try {
      renderNavbarClient();

      const resources = getDesktopNavTrigger("resources");
      fireEvent.pointerEnter(resources);
      expect(resources).toHaveClass("nav-trigger-active");

      const firstItem =
        document.querySelector<HTMLAnchorElement>(".nav-popover-item");
      expect(firstItem).not.toBeNull();
      fireEvent.click(firstItem!);

      expect(resources).not.toHaveClass("nav-trigger-active");

      fireEvent.pointerEnter(resources);
      expect(resources).not.toHaveClass("nav-trigger-active");

      act(() => {
        vi.advanceTimersByTime(400);
      });

      fireEvent.pointerEnter(resources);
      expect(resources).toHaveClass("nav-trigger-active");
    } finally {
      vi.useRealTimers();
    }
  });

  it("closes the open menu when the pointer leaves the computed hotzone", () => {
    renderNavbarClient();

    const resources = getDesktopNavTrigger("resources");
    const popover = getNavPopover("resources");
    setElementRect(resources, {
      left: 100,
      right: 180,
      top: 10,
      bottom: 30,
      width: 80,
      height: 20,
    });
    setElementRect(popover, {
      left: 80,
      right: 400,
      top: 42,
      bottom: 220,
      width: 320,
      height: 178,
    });

    fireEvent.pointerEnter(resources);
    expect(resources).toHaveClass("nav-trigger-active");

    fireEvent.pointerMove(document, { clientX: 500, clientY: 260 });

    expect(resources).not.toHaveClass("nav-trigger-active");
  });
});
