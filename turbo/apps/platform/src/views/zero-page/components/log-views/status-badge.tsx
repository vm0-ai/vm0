import {
  IconCircleCheck,
  IconClock,
  IconPlayerPlay,
  IconCircleX,
  IconClockExclamation,
  IconBan,
} from "@tabler/icons-react";
import type { LogStatus } from "../../../../signals/zero-page/log-types.ts";

interface StatusBadgeConfig {
  label: string;
  icon: typeof IconCircleCheck;
  iconClassName: string;
}

interface StatusBadgeProps {
  status: LogStatus;
  /** When true, use Zero app pill style (cool gray) */
  zeroStyle?: boolean;
}

function getStatusConfig(): Record<LogStatus, StatusBadgeConfig> {
  return {
    queued: {
      label: "Queued",
      icon: IconClock,
      iconClassName: "text-gray-400",
    },
    pending: {
      label: "Pending",
      icon: IconClock,
      iconClassName: "text-yellow-600",
    },
    running: {
      label: "Running",
      icon: IconPlayerPlay,
      iconClassName: "text-sky-600",
    },
    completed: {
      label: "Done",
      icon: IconCircleCheck,
      iconClassName: "text-green-600",
    },
    failed: {
      label: "Failed",
      icon: IconCircleX,
      iconClassName: "text-red-600",
    },
    timeout: {
      label: "Timeout",
      icon: IconClockExclamation,
      iconClassName: "text-orange-600",
    },
    cancelled: {
      label: "Cancelled",
      icon: IconBan,
      iconClassName: "text-gray-600",
    },
  };
}

export function StatusBadge({ status, zeroStyle }: StatusBadgeProps) {
  const statusConfig = getStatusConfig();
  const config = statusConfig[status];
  const Icon = config.icon;

  return (
    <span
      className={
        zeroStyle
          ? "zero-pill inline-flex items-center gap-1.5 rounded-lg border px-1.5 py-1 text-xs font-medium"
          : "inline-flex items-center gap-1.5 rounded-lg border border-border bg-background px-1.5 py-1 text-xs font-medium text-secondary-foreground"
      }
    >
      <Icon className={`h-3 w-3 ${config.iconClassName}`} />
      {config.label}
    </span>
  );
}
