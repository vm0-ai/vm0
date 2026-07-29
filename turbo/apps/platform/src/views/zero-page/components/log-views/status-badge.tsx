import {
  IconCircleCheck,
  IconClock,
  IconPlayerPlay,
  IconCircleX,
  IconClockExclamation,
  IconBan,
} from "@tabler/icons-react";
import type { LogStatus } from "../../../../signals/zero-page/log-types.ts";
import { i18n } from "../../../../i18n/index.ts";

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

export function getStatusFilterLabel(status: LogStatus): string {
  switch (status) {
    case "queued": {
      return i18n.t(($) => {
        return $.activity.statusFilters.queued;
      });
    }
    case "pending": {
      return i18n.t(($) => {
        return $.activity.statusFilters.pending;
      });
    }
    case "running": {
      return i18n.t(($) => {
        return $.activity.statusFilters.running;
      });
    }
    case "completed": {
      return i18n.t(($) => {
        return $.activity.statusFilters.completed;
      });
    }
    case "failed": {
      return i18n.t(($) => {
        return $.activity.statusFilters.failed;
      });
    }
    case "timeout": {
      return i18n.t(($) => {
        return $.activity.statusFilters.timeout;
      });
    }
    case "cancelled": {
      return i18n.t(($) => {
        return $.activity.statusFilters.cancelled;
      });
    }
  }
}

function getStatusLabel(status: LogStatus): string {
  switch (status) {
    case "queued": {
      return i18n.t(($) => {
        return $.activity.statuses.queued;
      });
    }
    case "pending": {
      return i18n.t(($) => {
        return $.activity.statuses.pending;
      });
    }
    case "running": {
      return i18n.t(($) => {
        return $.activity.statuses.running;
      });
    }
    case "completed": {
      return i18n.t(($) => {
        return $.activity.statuses.completed;
      });
    }
    case "failed": {
      return i18n.t(($) => {
        return $.activity.statuses.failed;
      });
    }
    case "timeout": {
      return i18n.t(($) => {
        return $.activity.statuses.timeout;
      });
    }
    case "cancelled": {
      return i18n.t(($) => {
        return $.activity.statuses.cancelled;
      });
    }
  }
}

function getStatusConfig(): Record<LogStatus, StatusBadgeConfig> {
  return {
    queued: {
      label: getStatusLabel("queued"),
      icon: IconClock,
      iconClassName: "text-gray-400",
    },
    pending: {
      label: getStatusLabel("pending"),
      icon: IconClock,
      iconClassName: "text-yellow-600",
    },
    running: {
      label: getStatusLabel("running"),
      icon: IconPlayerPlay,
      iconClassName: "text-sky-600",
    },
    completed: {
      label: getStatusLabel("completed"),
      icon: IconCircleCheck,
      iconClassName: "text-green-600",
    },
    failed: {
      label: getStatusLabel("failed"),
      icon: IconCircleX,
      iconClassName: "text-red-600",
    },
    timeout: {
      label: getStatusLabel("timeout"),
      icon: IconClockExclamation,
      iconClassName: "text-orange-600",
    },
    cancelled: {
      label: getStatusLabel("cancelled"),
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
      data-testid="status-badge"
      data-status={status}
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
