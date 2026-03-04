import {
  IconRobot,
  IconCircleDotFilled,
  IconClock,
  IconDatabase,
  IconChartBar,
  IconLayoutDashboard,
  IconList,
  IconKey,
  IconReceipt,
  IconHelpCircle,
  IconRocket,
  IconLock,
  IconFile,
  IconFiles,
  IconSquareKey,
  IconSparkles,
  IconSettings,
  type Icon,
} from "@tabler/icons-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@vm0/ui/components/ui/tooltip";
import type { NavIconName, NavItem } from "../../types/navigation.ts";
import { Link } from "../router/link.tsx";

function getIconComponent(name: NavIconName): Icon {
  const map: Record<NavIconName, Icon> = {
    Bot: IconRobot,
    CircleDot: IconCircleDotFilled,
    Clock: IconClock,
    Database: IconDatabase,
    FileBarChart: IconChartBar,
    LayoutDashboard: IconLayoutDashboard,
    List: IconList,
    KeyRound: IconKey,
    Receipt: IconReceipt,
    HelpCircle: IconHelpCircle,
    Rocket: IconRocket,
    Lock: IconLock,
    File: IconFile,
    Files: IconFiles,
    SquareKey: IconSquareKey,
    Sparkles: IconSparkles,
    Settings: IconSettings,
  };
  return map[name];
}

interface NavLinkProps {
  item: NavItem;
  isActive: boolean;
  collapsed: boolean;
}

export function NavLink({ item, isActive, collapsed }: NavLinkProps) {
  const IconComponent = getIconComponent(item.icon);

  const className = `flex w-full items-center h-8 p-2 rounded-lg text-sm leading-5 transition-colors ${
    collapsed ? "justify-center" : "gap-2"
  } ${
    isActive
      ? "bg-sidebar-active text-sidebar-primary font-medium"
      : "text-sidebar-foreground hover:bg-sidebar-accent"
  }`;

  const content = (
    <>
      {IconComponent && (
        <IconComponent size={16} stroke={1.5} className="shrink-0" />
      )}
      {!collapsed && <span className="truncate">{item.label}</span>}
    </>
  );

  // Internal path → use Link for SPA navigation with cmd+click support
  const element = item.path ? (
    <Link
      pathname={item.path}
      options={{ searchParams: new URLSearchParams() }}
      className={className}
    >
      {content}
    </Link>
  ) : (
    // External URL → native <a> tag
    <a
      href={item.url}
      target={item.newTab ? "_blank" : undefined}
      rel={item.newTab ? "noopener noreferrer" : undefined}
      className={className}
    >
      {content}
    </a>
  );

  if (collapsed) {
    return (
      <TooltipProvider delayDuration={100}>
        <Tooltip>
          <TooltipTrigger asChild>{element}</TooltipTrigger>
          <TooltipContent side="right">
            <p className="text-xs">{item.label}</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  return element;
}
