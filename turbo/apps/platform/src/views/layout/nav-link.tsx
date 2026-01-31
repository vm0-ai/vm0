import { useGet, useSet } from "ccstate-react";
import {
  IconRobot,
  IconCircleDotFilled,
  IconChartBar,
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
import type { NavItem } from "../../types/navigation.ts";
import { navigateInReact$ } from "../../signals/route.ts";
import { sidebarCollapsed$ } from "../../signals/sidebar.ts";

// eslint-disable-next-line ccstate/no-package-variable -- static readonly icon mapping
const ICON_MAP = {
  Bot: IconRobot,
  CircleDot: IconCircleDotFilled,
  FileBarChart: IconChartBar,
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
} as const satisfies Record<string, Icon>;

interface NavLinkProps {
  item: NavItem;
  isActive: boolean;
}

export function NavLink({ item, isActive }: NavLinkProps) {
  const navigate = useSet(navigateInReact$);
  const collapsed = useGet(sidebarCollapsed$);
  const IconComponent = ICON_MAP[item.icon];

  const handleClick = () => {
    if (item.path) {
      navigate(item.path);
    } else if (item.url) {
      if (item.newTab) {
        window.open(item.url, "_blank");
      } else {
        window.location.href = item.url;
      }
    }
  };

  const button = (
    <button
      onClick={handleClick}
      className={`flex w-full items-center h-8 p-2 rounded-lg text-sm leading-5 transition-colors ${
        collapsed ? "justify-center" : "gap-2"
      } ${
        isActive
          ? "bg-sidebar-active text-sidebar-primary font-medium"
          : "text-sidebar-foreground hover:bg-sidebar-accent"
      }`}
    >
      {IconComponent && (
        <IconComponent size={16} stroke={1.5} className="shrink-0" />
      )}
      {!collapsed && <span className="truncate">{item.label}</span>}
    </button>
  );

  if (collapsed) {
    return (
      <TooltipProvider delayDuration={100}>
        <Tooltip>
          <TooltipTrigger asChild>{button}</TooltipTrigger>
          <TooltipContent side="right">
            <p className="text-xs">{item.label}</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  return button;
}
