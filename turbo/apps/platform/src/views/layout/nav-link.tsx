import { useSet } from "ccstate-react";
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
import type { NavItem } from "../../types/navigation.ts";
import { navigateInReact$ } from "../../signals/route.ts";

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
  const IconComponent = ICON_MAP[item.icon];

  return (
    <button
      onClick={() => {
        if (item.path) {
          navigate(item.path);
        } else if (item.url) {
          if (item.newTab) {
            window.open(item.url, "_blank");
          } else {
            window.location.href = item.url;
          }
        }
      }}
      className={`flex w-full items-center gap-2 h-8 p-2 rounded-lg text-sm leading-5 transition-colors ${
        isActive
          ? "bg-sidebar-active text-sidebar-primary font-medium"
          : "text-sidebar-foreground hover:bg-sidebar-accent"
      }`}
    >
      {IconComponent && <IconComponent size={16} className="shrink-0" />}
      <span className="truncate">{item.label}</span>
    </button>
  );
}
