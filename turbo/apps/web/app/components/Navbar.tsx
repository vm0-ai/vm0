"use client";

import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import Image from "next/image";
import NextLink from "next/link";
import { Link } from "../../navigation";
import { useTranslations } from "next-intl";
import { useTheme } from "./ThemeProvider";
import {
  IconArrowRight,
  IconArrowUpRight,
  IconChevronDown,
} from "@tabler/icons-react";
import { ThemeToggle } from "./ThemeToggle";
import { LanguageSwitcher } from "./LanguageSwitcher";
import { NavMenu, type NavMenuItem } from "./NavMenu";
import { useUser, useClerk } from "@clerk/nextjs";
import { getAppUrl } from "../../src/lib/zero/url";
import { isBlogEnabled } from "../../src/env";

interface NavbarProps {
  initialIsSignedIn?: boolean;
  initialShowDocs?: boolean;
}

const GITHUB_URL = "https://github.com/vm0-ai/vm0";
const STATUS_URL = "https://status.vm0.ai";
const DEMO_URL = "https://calendar.app.google/csdygPrHHyNgxpTPA";
const NAV_MENU_CLOSE_DELAY_MS = 250;
const NAV_MENU_TRIGGER_HOTZONE_Y = 18;
const NAV_MENU_TRIGGER_HOTZONE_X = 12;
const NAV_MENU_POPOVER_HOTZONE = 8;

function containsPoint(
  rect: DOMRect,
  clientX: number,
  clientY: number,
  margin = 0,
): boolean {
  return (
    clientX >= rect.left - margin &&
    clientX <= rect.right + margin &&
    clientY >= rect.top - margin &&
    clientY <= rect.bottom + margin
  );
}

export function Navbar({
  initialIsSignedIn = false,
  initialShowDocs = false,
}: NavbarProps) {
  const { theme } = useTheme();
  const t = useTranslations("nav");
  const { isSignedIn: clerkIsSignedIn, isLoaded } = useUser();
  const isSignedIn = isLoaded ? clerkIsSignedIn : initialIsSignedIn;
  const { signOut } = useClerk();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const desktopNavRef = useRef<HTMLDivElement | null>(null);
  const closeMenuTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelMenuClose = useCallback(() => {
    if (closeMenuTimer.current !== null) {
      clearTimeout(closeMenuTimer.current);
      closeMenuTimer.current = null;
    }
  }, []);

  const openNavMenu = useCallback(
    (id: string) => {
      cancelMenuClose();
      setOpenMenuId(id);
    },
    [cancelMenuClose],
  );

  const closeNavMenu = useCallback(() => {
    cancelMenuClose();
    setOpenMenuId(null);
  }, [cancelMenuClose]);

  const scheduleNavMenuClose = useCallback(() => {
    cancelMenuClose();
    closeMenuTimer.current = setTimeout(() => {
      setOpenMenuId(null);
      closeMenuTimer.current = null;
    }, NAV_MENU_CLOSE_DELAY_MS);
  }, [cancelMenuClose]);

  const navMenuIdFromTriggerHotzone = useCallback(
    (clientX: number, clientY: number): string | null => {
      const root = desktopNavRef.current;
      if (!root) {
        return null;
      }
      const triggerRects = Array.from(
        root.querySelectorAll<HTMLButtonElement>("[data-nav-menu-id]"),
      )
        .map((trigger) => {
          return {
            id: trigger.dataset.navMenuId ?? "",
            rect: trigger.getBoundingClientRect(),
          };
        })
        .filter((entry) => {
          return entry.id.length > 0;
        })
        .sort((a, b) => {
          return a.rect.left - b.rect.left;
        });

      if (triggerRects.length === 0) {
        return null;
      }
      const firstTrigger = triggerRects[0];
      const lastTrigger = triggerRects[triggerRects.length - 1];
      if (!firstTrigger || !lastTrigger) {
        return null;
      }

      const top =
        Math.min(
          ...triggerRects.map((entry) => {
            return entry.rect.top;
          }),
        ) - NAV_MENU_TRIGGER_HOTZONE_Y;
      const bottom =
        Math.max(
          ...triggerRects.map((entry) => {
            return entry.rect.bottom;
          }),
        ) + NAV_MENU_TRIGGER_HOTZONE_Y;
      if (clientY < top || clientY > bottom) {
        return null;
      }

      const left = firstTrigger.rect.left - NAV_MENU_TRIGGER_HOTZONE_X;
      const right = lastTrigger.rect.right + NAV_MENU_TRIGGER_HOTZONE_X;
      if (clientX < left || clientX > right) {
        return null;
      }

      return triggerRects.reduce((nearest, current) => {
        const currentCenter = current.rect.left + current.rect.width / 2;
        const nearestCenter = nearest.rect.left + nearest.rect.width / 2;
        return Math.abs(currentCenter - clientX) <
          Math.abs(nearestCenter - clientX)
          ? current
          : nearest;
      }).id;
    },
    [],
  );

  const isPointerInOpenPopoverHotzone = useCallback(
    (clientX: number, clientY: number): boolean => {
      if (openMenuId === null) {
        return false;
      }
      const popover = Array.from(
        document.querySelectorAll<HTMLElement>("[data-nav-popover-id]"),
      ).find((element) => {
        return element.dataset.navPopoverId === openMenuId;
      });
      if (!popover) {
        return false;
      }
      return containsPoint(
        popover.getBoundingClientRect(),
        clientX,
        clientY,
        NAV_MENU_POPOVER_HOTZONE,
      );
    },
    [openMenuId],
  );

  const isPointerInOpenMenuBridge = useCallback(
    (clientX: number, clientY: number): boolean => {
      if (openMenuId === null) {
        return false;
      }
      const root = desktopNavRef.current;
      if (!root) {
        return false;
      }
      const trigger = Array.from(
        root.querySelectorAll<HTMLButtonElement>("[data-nav-menu-id]"),
      ).find((element) => {
        return element.dataset.navMenuId === openMenuId;
      });
      const popover = Array.from(
        document.querySelectorAll<HTMLElement>("[data-nav-popover-id]"),
      ).find((element) => {
        return element.dataset.navPopoverId === openMenuId;
      });
      if (!trigger || !popover) {
        return false;
      }

      const triggerRect = trigger.getBoundingClientRect();
      const popoverRect = popover.getBoundingClientRect();
      const left =
        Math.min(triggerRect.left, popoverRect.left) - NAV_MENU_POPOVER_HOTZONE;
      const right =
        Math.max(triggerRect.right, popoverRect.right) +
        NAV_MENU_POPOVER_HOTZONE;
      const top =
        Math.min(triggerRect.bottom, popoverRect.top) -
        NAV_MENU_POPOVER_HOTZONE;
      const bottom =
        Math.max(triggerRect.bottom, popoverRect.top) +
        NAV_MENU_POPOVER_HOTZONE;

      return (
        clientX >= left &&
        clientX <= right &&
        clientY >= top &&
        clientY <= bottom
      );
    },
    [openMenuId],
  );

  const syncOpenMenuForPointer = useCallback(
    (clientX: number, clientY: number) => {
      const menuId = navMenuIdFromTriggerHotzone(clientX, clientY);
      if (menuId) {
        openNavMenu(menuId);
        return;
      }
      if (
        isPointerInOpenPopoverHotzone(clientX, clientY) ||
        isPointerInOpenMenuBridge(clientX, clientY)
      ) {
        cancelMenuClose();
        return;
      }
      closeNavMenu();
    },
    [
      cancelMenuClose,
      closeNavMenu,
      isPointerInOpenMenuBridge,
      isPointerInOpenPopoverHotzone,
      navMenuIdFromTriggerHotzone,
      openNavMenu,
    ],
  );

  const handleDesktopNavPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      syncOpenMenuForPointer(event.clientX, event.clientY);
    },
    [syncOpenMenuForPointer],
  );

  useEffect(() => {
    return () => {
      cancelMenuClose();
    };
  }, [cancelMenuClose]);

  useEffect(() => {
    if (openMenuId === null) {
      return undefined;
    }

    const handlePointerMove = (event: PointerEvent) => {
      syncOpenMenuForPointer(event.clientX, event.clientY);
    };

    document.addEventListener("pointermove", handlePointerMove);
    return () => {
      document.removeEventListener("pointermove", handlePointerMove);
    };
  }, [openMenuId, syncOpenMenuForPointer]);

  useEffect(() => {
    const handleResize = () => {
      if (window.innerWidth > 960) {
        setMobileMenuOpen(false);
      }
    };
    window.addEventListener("resize", handleResize);
    return () => {
      return window.removeEventListener("resize", handleResize);
    };
  }, []);

  useEffect(() => {
    if (mobileMenuOpen) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => {
      document.body.style.overflow = "";
    };
  }, [mobileMenuOpen]);

  const handleSignOut = () => {
    signOut().catch((error: Error) => {
      console.error("Sign out error:", error);
    });
  };

  const closeMobile = () => {
    setMobileMenuOpen(false);
  };

  const blogItem: NavMenuItem | null = isBlogEnabled()
    ? {
        label: t("blog"),
        description: t("blogDesc"),
        href: "/blog",
        icon: "/assets/nav/blog.png",
      }
    : null;

  const docsItem: NavMenuItem | null = initialShowDocs
    ? {
        label: t("docs"),
        description: t("docsDesc"),
        href: "/docs",
        icon: "/assets/nav/docs.svg",
      }
    : null;

  const resourcesItems: NavMenuItem[] = [
    ...(docsItem ? [docsItem] : []),
    ...(blogItem ? [blogItem] : []),
    {
      label: t("support"),
      description: t("supportDesc"),
      href: "/support",
      icon: "/assets/nav/support.png",
    },
    {
      label: t("status"),
      description: t("statusDesc"),
      href: STATUS_URL,
      icon: "/assets/nav/status.png",
      external: true,
    },
    {
      label: t("github"),
      description: t("githubDesc"),
      href: GITHUB_URL,
      icon: "/assets/nav/github.png",
      external: true,
    },
  ];

  const trustItems: NavMenuItem[] = [
    {
      label: t("models"),
      description: t("modelsDesc"),
      href: "/models",
      icon: "/assets/nav/models.png",
    },
    {
      label: t("modelRankings"),
      description: t("modelRankingsDesc"),
      href: "/rankings",
      icon: "/assets/nav/rankings.png",
    },
    {
      label: t("security"),
      description: t("securityDesc"),
      href: "/security",
      icon: "/assets/nav/security.png",
    },
  ];

  return (
    <nav className="navbar">
      <div className="container">
        <div className="nav-wrapper">
          <div className="nav-left">
            <Link href="/" className="logo">
              <Image
                src={
                  theme === "light"
                    ? "/assets/vm0-logo-dark.svg"
                    : "/assets/vm0-logo.svg"
                }
                alt="VM0 - Your Trustworthy AI Teammate"
                width={120}
                height={30}
              />
            </Link>
          </div>

          <div
            ref={desktopNavRef}
            className="nav-center nav-desktop"
            onPointerMove={handleDesktopNavPointerMove}
            onPointerLeave={scheduleNavMenuClose}
          >
            <Link href="/use-cases" className="nav-link">
              {t("useCases")}
            </Link>
            <NavMenu
              id="resources"
              label={t("resources")}
              items={resourcesItems}
              alignOffset={-40}
              openId={openMenuId}
              onOpen={openNavMenu}
              onClose={closeNavMenu}
              onCancelClose={cancelMenuClose}
              onScheduleClose={scheduleNavMenuClose}
            />
            <NavMenu
              id="trust-and-tech"
              label={t("trustAndTech")}
              items={trustItems}
              alignOffset={40}
              openId={openMenuId}
              onOpen={openNavMenu}
              onClose={closeNavMenu}
              onCancelClose={cancelMenuClose}
              onScheduleClose={scheduleNavMenuClose}
            />
            <Link href="/pricing" className="nav-link">
              {t("pricing")}
            </Link>
          </div>

          <div className="nav-right">
            {!isSignedIn && (
              <>
                <a
                  href={DEMO_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="btn-try-demo nav-desktop"
                >
                  {t("contact")}
                </a>
                <NextLink href="/sign-up" className="btn-get-access">
                  {t("joinWaitlist")}
                </NextLink>
              </>
            )}
            {isSignedIn && (
              <>
                <button
                  onClick={handleSignOut}
                  className="btn-try-demo nav-desktop"
                >
                  {t("signOut")}
                </button>
                <a
                  href={getAppUrl()}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="btn-get-access nav-desktop group"
                >
                  <span>{t("openApp")}</span>
                  <IconArrowRight
                    size={16}
                    className="transition-transform group-hover:translate-x-0.5"
                  />
                </a>
              </>
            )}

            <button
              className="hamburger-btn"
              onClick={() => {
                return setMobileMenuOpen(!mobileMenuOpen);
              }}
              aria-label="Toggle menu"
              aria-expanded={mobileMenuOpen}
            >
              <span
                className={`hamburger-line ${mobileMenuOpen ? "open" : ""}`}
              />
              <span
                className={`hamburger-line ${mobileMenuOpen ? "open" : ""}`}
              />
              <span
                className={`hamburger-line ${mobileMenuOpen ? "open" : ""}`}
              />
            </button>
          </div>
        </div>
      </div>

      <div className={`mobile-menu ${mobileMenuOpen ? "open" : ""}`}>
        <div className="mobile-menu-content">
          <div className="mobile-menu-links">
            <Link
              href="/use-cases"
              className="mobile-menu-link"
              onClick={closeMobile}
            >
              {t("useCases")}
            </Link>
            <Link
              href="/pricing"
              className="mobile-menu-link"
              onClick={closeMobile}
            >
              {t("pricing")}
            </Link>

            <MobileMenuGroup
              label={t("resources")}
              items={resourcesItems}
              onSelect={closeMobile}
            />
            <MobileMenuGroup
              label={t("trustAndTech")}
              items={trustItems}
              onSelect={closeMobile}
            />

            <a
              href={DEMO_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="mobile-menu-link"
              onClick={closeMobile}
            >
              {t("contact")}
            </a>
            {isSignedIn && (
              <>
                <button
                  onClick={() => {
                    closeMobile();
                    handleSignOut();
                  }}
                  className="mobile-menu-link"
                  style={{ textAlign: "left", width: "100%" }}
                >
                  {t("signOut")}
                </button>
                <a
                  href={getAppUrl()}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mobile-menu-link group"
                  onClick={closeMobile}
                  style={{ display: "flex", alignItems: "center", gap: "8px" }}
                >
                  <span>{t("openApp")}</span>
                  <IconArrowRight
                    size={16}
                    className="transition-transform group-hover:translate-x-0.5"
                  />
                </a>
              </>
            )}
          </div>
          <div className="mobile-menu-controls">
            <ThemeToggle />
            <LanguageSwitcher />
          </div>
        </div>
      </div>

      {mobileMenuOpen && (
        <div
          className="mobile-menu-overlay"
          onClick={() => {
            return setMobileMenuOpen(false);
          }}
        />
      )}
    </nav>
  );
}

interface MobileMenuRowProps {
  item: NavMenuItem;
  onSelect: () => void;
}

function MobileMenuRow({ item, onSelect }: MobileMenuRowProps) {
  const body = (
    <span className="mobile-menu-row-body">
      <Image
        src={item.icon}
        alt=""
        width={22}
        height={22}
        className="mobile-menu-row-icon"
      />
      <span className="mobile-menu-row-label">{item.label}</span>
      {item.external && (
        <IconArrowUpRight
          size={12}
          strokeWidth={1.8}
          className="mobile-menu-row-ext"
        />
      )}
    </span>
  );

  if (item.external) {
    return (
      <a
        href={item.href}
        target="_blank"
        rel="noopener noreferrer"
        className="mobile-menu-link mobile-menu-row"
        onClick={onSelect}
      >
        {body}
      </a>
    );
  }

  return (
    <Link
      href={item.href}
      className="mobile-menu-link mobile-menu-row"
      onClick={onSelect}
    >
      {body}
    </Link>
  );
}

interface MobileMenuGroupProps {
  label: string;
  items: NavMenuItem[];
  onSelect: () => void;
}

function MobileMenuGroup({ label, items, onSelect }: MobileMenuGroupProps) {
  const [open, setOpen] = useState(false);

  return (
    <div
      className={`mobile-menu-group${open ? " mobile-menu-group-open" : ""}`}
    >
      <button
        type="button"
        className="mobile-menu-link mobile-menu-group-trigger"
        aria-expanded={open}
        onClick={() => {
          setOpen((prev) => {
            return !prev;
          });
        }}
      >
        <span>{label}</span>
        <IconChevronDown
          size={14}
          strokeWidth={1.8}
          className="mobile-menu-group-caret"
        />
      </button>
      <div className="mobile-menu-group-children">
        {items.map((item) => {
          return (
            <MobileMenuRow key={item.href} item={item} onSelect={onSelect} />
          );
        })}
      </div>
    </div>
  );
}
