import { useGet, useLoadable } from "ccstate-react";
import { IconDotsVertical, IconReceipt } from "@tabler/icons-react";
import { SubscriptionDetailsButton } from "@clerk/clerk-react/experimental";
import {
  NAVIGATION_CONFIG,
  FOOTER_NAV_ITEMS,
  GET_STARTED_ITEM,
  activeNavItem$,
} from "../../signals/layout/navigation.ts";
import { clerk$, user$ } from "../../signals/auth.ts";
import { NavLink } from "./nav-link.tsx";
import { ClerkProvider } from "./clerk-provider.tsx";
import { detach, Reason } from "../../signals/utils.ts";

export function Sidebar() {
  const activeItem = useGet(activeNavItem$);

  return (
    <aside className="hidden md:flex w-[255px] flex-col border-r border-sidebar-border bg-sidebar">
      {/* Logo header - height: 49px, padding: 8px */}
      <div className="h-[49px] flex flex-col justify-center p-2 border-b border-divider">
        <div className="flex items-center gap-2.5 p-1.5 h-8">
          {/* VM0 Logo - inline grid layout matching Figma structure */}
          <div className="inline-grid grid-cols-[max-content] grid-rows-[max-content] items-start justify-items-start leading-[0] shrink-0">
            {/* Logo SVG with proper sizing: 81x24 */}
            <img
              src="/logo_light.svg"
              alt="VM0"
              className="col-1 row-1 block max-w-none"
              style={{ width: "81px", height: "24px" }}
            />
          </div>
          <p className="text-xl font-normal leading-7 text-foreground shrink-0">
            Platform
          </p>
        </div>
      </div>

      {/* Main navigation area - gap: 8px between sections */}
      <div className="flex-1 flex flex-col gap-2 overflow-y-auto">
        {/* Get started section */}
        <div className="p-2">
          <div className="flex flex-col gap-1">
            <NavLink
              item={GET_STARTED_ITEM}
              isActive={activeItem === GET_STARTED_ITEM.id}
            />
          </div>
          {/* Your agents section label - height: 32px, px: 8px, opacity: 70% */}
          <div className="h-8 flex items-center px-2 opacity-70">
            <span className="text-xs leading-4 text-sidebar-foreground">
              Your agents
            </span>
          </div>
          {/* Your agents items - gap: 4px */}
          <div className="flex flex-col gap-1">
            {NAVIGATION_CONFIG[0].items.map((item) => (
              <NavLink
                key={item.id}
                item={item}
                isActive={activeItem === item.id}
              />
            ))}
          </div>
        </div>

        {/* Other navigation groups */}
        {NAVIGATION_CONFIG.slice(1).map((group) => (
          <div key={group.label} className="p-2">
            {/* Section label - height: 32px, px: 8px, opacity: 70% */}
            <div className="h-8 flex items-center px-2 opacity-70">
              <span className="text-xs leading-4 text-sidebar-foreground">
                {group.label}
              </span>
            </div>
            {/* Menu items - gap: 4px */}
            <div className="flex flex-col gap-1">
              {group.items.map((item) => (
                <NavLink
                  key={item.id}
                  item={item}
                  isActive={activeItem === item.id}
                />
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* Footer navigation - padding: 8px, gap: 4px */}
      <div className="p-2">
        <div className="flex flex-col gap-1">
          {/* Bill button - opens subscription management modal */}
          <ClerkProvider>
            <SubscriptionDetailsButton
              subscriptionDetailsProps={{
                appearance: {
                  variables: {
                    colorPrimary: "#ED4E01", // primary-800
                    colorBackground: "#FFFCF9", // gray-0
                    borderRadius: "0.5rem",
                    fontFamily:
                      "Noto Sans, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif",
                  },
                  elements: {
                    // Remove shadows and add borders to subscription plan cards
                    card: {
                      boxShadow: "none",
                    },
                    subscriptionDetailsCard: {
                      boxShadow: "none",
                      border: "1px solid #E8E2DD", // gray-200 (border token)
                    },
                    subscriptionDetailsCardBody: {
                      boxShadow: "none",
                    },
                    // Drawer styling
                    drawer: {
                      backgroundColor: "#F9F4EF", // sidebar color (gray-50)
                    },
                    drawerContent: {
                      backgroundColor: "#FFFCF9", // background token (gray-0)
                    },
                    drawerHeader: {
                      backgroundColor: "#F9F4EF !important", // sidebar color (gray-50)
                      borderBottom: "1px solid #E8E2DD !important", // border token (gray-200)
                    },
                    drawerTitle: "text-gray-950",
                    headerBox: "bg-[#F9F4EF]", // sidebar color (gray-50)
                    headerTitle: "text-gray-950",
                    headerSubtitle: "text-gray-800",
                    // Form elements
                    formButtonPrimary:
                      "bg-primary-800 hover:bg-primary-900 text-white font-medium",
                    // Links
                    footerActionLink: "text-primary-800 hover:text-primary-900",
                  },
                },
              }}
            >
              <button className="flex w-full items-center gap-2 p-2 h-9 rounded-lg text-sidebar-foreground hover:bg-sidebar-accent transition-colors">
                <IconReceipt size={16} className="shrink-0" />
                <span className="text-sm leading-5">Bill</span>
              </button>
            </SubscriptionDetailsButton>
          </ClerkProvider>
          {FOOTER_NAV_ITEMS.map((item) => (
            <NavLink
              key={item.id}
              item={item}
              isActive={activeItem === item.id}
            />
          ))}
        </div>
      </div>

      {/* User profile section - padding: 8px */}
      <UserProfile />
    </aside>
  );
}

function UserProfile() {
  const clerkLoadable = useLoadable(clerk$);
  const userLoadable = useLoadable(user$);

  if (userLoadable.state !== "hasData" || !userLoadable.data) {
    return null;
  }

  const user = userLoadable.data;
  const clerk = clerkLoadable.state === "hasData" ? clerkLoadable.data : null;

  const handleClick = () => {
    detach(clerk?.openUserProfile(), Reason.DomCallback);
  };

  return (
    <div className="p-2">
      <button
        onClick={handleClick}
        className="flex w-full items-center gap-2 p-2 h-12 rounded-lg hover:bg-sidebar-accent transition-colors"
      >
        <div className="h-8 w-8 rounded-lg bg-sidebar-accent overflow-hidden shrink-0">
          <img
            src={user.imageUrl}
            alt={user.fullName ?? ""}
            className="h-full w-full object-cover"
          />
        </div>
        <div className="flex-1 min-w-0 text-left">
          <div className="text-sm leading-5 text-sidebar-foreground truncate">
            {user.fullName}
          </div>
          <div className="text-xs leading-4 text-sidebar-foreground/70 truncate">
            {user.primaryEmailAddress?.emailAddress}
          </div>
        </div>
        <IconDotsVertical
          size={16}
          className="text-sidebar-foreground shrink-0"
        />
      </button>
    </div>
  );
}
