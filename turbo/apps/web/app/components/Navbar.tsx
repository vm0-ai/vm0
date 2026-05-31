"use client";

import {
  type PointerEvent as ReactPointerEvent,
  type RefObject,
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
const NAV_MENU_SELECT_REOPEN_BLOCK_MS = 350;
const DESKTOP_NAV_MENU_IDS = ["resources", "trust-and-tech"] as const;

type DesktopNavMenuId = (typeof DESKTOP_NAV_MENU_IDS)[number];

function isDesktopNavMenuId(id: string | undefined): id is DesktopNavMenuId {
  return DESKTOP_NAV_MENU_IDS.includes(id as DesktopNavMenuId);
}

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

function useDesktopNavMenus(desktopNavRef: RefObject<HTMLDivElement | null>) {
  const [openMenuId, setOpenMenuId] = useState<DesktopNavMenuId | null>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const blockOpenUntilRef = useRef(0);

  const cancelClose = useCallback(() => {
    if (closeTimerRef.current === null) {
      return;
    }
    clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
  }, []);

  const openMenu = useCallback(
    (id: DesktopNavMenuId) => {
      if (Date.now() < blockOpenUntilRef.current) {
        return;
      }
      cancelClose();
      setOpenMenuId(id);
    },
    [cancelClose],
  );

  const closeMenu = useCallback(() => {
    cancelClose();
    setOpenMenuId(null);
  }, [cancelClose]);

  const selectMenuItem = useCallback(() => {
    blockOpenUntilRef.current = Date.now() + NAV_MENU_SELECT_REOPEN_BLOCK_MS;
    closeMenu();
  }, [closeMenu]);

  const scheduleClose = useCallback(() => {
    cancelClose();
    closeTimerRef.current = setTimeout(() => {
      setOpenMenuId(null);
      closeTimerRef.current = null;
    }, NAV_MENU_CLOSE_DELAY_MS);
  }, [cancelClose]);

  const getMenuIdFromTriggerHotzone = useCallback(
    (clientX: number, clientY: number): DesktopNavMenuId | null => {
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
        .filter((entry): entry is { id: DesktopNavMenuId; rect: DOMRect } => {
          return isDesktopNavMenuId(entry.id);
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
    [desktopNavRef],
  );

  const getOpenMenuElements = useCallback(() => {
    if (openMenuId === null) {
      return null;
    }

    const root = desktopNavRef.current;
    if (!root) {
      return null;
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
      return null;
    }

    return { trigger, popover };
  }, [desktopNavRef, openMenuId]);

  const isPointerInOpenMenuHotzone = useCallback(
    (clientX: number, clientY: number): boolean => {
      const elements = getOpenMenuElements();
      if (!elements) {
        return false;
      }

      const triggerRect = elements.trigger.getBoundingClientRect();
      const popoverRect = elements.popover.getBoundingClientRect();
      if (
        containsPoint(popoverRect, clientX, clientY, NAV_MENU_POPOVER_HOTZONE)
      ) {
        return true;
      }

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
    [getOpenMenuElements],
  );

  const syncMenuForPointer = useCallback(
    (clientX: number, clientY: number) => {
      const menuId = getMenuIdFromTriggerHotzone(clientX, clientY);
      if (menuId) {
        openMenu(menuId);
        return;
      }

      if (isPointerInOpenMenuHotzone(clientX, clientY)) {
        cancelClose();
        return;
      }

      closeMenu();
    },
    [
      cancelClose,
      closeMenu,
      getMenuIdFromTriggerHotzone,
      isPointerInOpenMenuHotzone,
      openMenu,
    ],
  );

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      syncMenuForPointer(event.clientX, event.clientY);
    },
    [syncMenuForPointer],
  );

  useEffect(() => {
    return () => {
      cancelClose();
    };
  }, [cancelClose]);

  useEffect(() => {
    if (openMenuId === null) {
      return undefined;
    }

    const handleDocumentPointerMove = (event: PointerEvent) => {
      syncMenuForPointer(event.clientX, event.clientY);
    };

    document.addEventListener("pointermove", handleDocumentPointerMove);
    return () => {
      document.removeEventListener("pointermove", handleDocumentPointerMove);
    };
  }, [openMenuId, syncMenuForPointer]);

  return {
    openMenuId,
    openMenu,
    closeMenu,
    selectMenuItem,
    cancelClose,
    scheduleClose,
    handlePointerMove,
  };
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
  // Attribution is carried by the shared .vm0.ai cookie (AttributionCapture),
  // so the signup CTAs are plain links.
  const signupHref = "/sign-up";
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const desktopNavRef = useRef<HTMLDivElement | null>(null);
  const {
    openMenuId,
    openMenu,
    closeMenu,
    selectMenuItem,
    cancelClose,
    scheduleClose,
    handlePointerMove,
  } = useDesktopNavMenus(desktopNavRef);
  const openResourcesMenu = useCallback(() => {
    openMenu("resources");
  }, [openMenu]);
  const openTrustMenu = useCallback(() => {
    openMenu("trust-and-tech");
  }, [openMenu]);

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
        icon: "/assets/nav/docs.png",
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
            onPointerMove={handlePointerMove}
            onPointerLeave={scheduleClose}
          >
            <Link href="/use-cases" className="nav-link">
              {t("useCases")}
            </Link>
            <NavMenu
              id="resources"
              label={t("resources")}
              items={resourcesItems}
              alignOffset={-40}
              open={openMenuId === "resources"}
              onOpen={openResourcesMenu}
              onClose={closeMenu}
              onSelect={selectMenuItem}
              onCancelClose={cancelClose}
              onScheduleClose={scheduleClose}
            />
            <NavMenu
              id="trust-and-tech"
              label={t("trustAndTech")}
              items={trustItems}
              alignOffset={40}
              open={openMenuId === "trust-and-tech"}
              onOpen={openTrustMenu}
              onClose={closeMenu}
              onSelect={selectMenuItem}
              onCancelClose={cancelClose}
              onScheduleClose={scheduleClose}
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
                <NextLink
                  href={signupHref}
                  className="btn-get-access nav-desktop"
                >
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
            {!isSignedIn && (
              <NextLink
                href={signupHref}
                className="mobile-menu-link mobile-menu-cta"
                onClick={closeMobile}
              >
                {t("joinWaitlist")}
              </NextLink>
            )}
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
