import { IconCircleCheck } from "@tabler/icons-react";
import type { LogStatus } from "../../signals/logs-page/types.ts";

interface StatusBadgeConfig {
  label: string;
  className: string;
  iconClassName?: string;
}

interface StatusBadgeProps {
  status: LogStatus;
  /** Use compact variant for table rows (shows status text as-is) */
  variant?: "default" | "compact";
}

function getStatusConfig(): Record<LogStatus, StatusBadgeConfig> {
  return {
    pending: { label: "Pending", className: "bg-yellow-100 text-yellow-800" },
    running: { label: "Running", className: "bg-blue-100 text-blue-800" },
    completed: {
      label: "Done",
      className: "border border-border bg-background text-muted-foreground",
      iconClassName: "text-green-600",
    },
    failed: { label: "Failed", className: "bg-red-100 text-red-800" },
    timeout: { label: "Timeout", className: "bg-orange-100 text-orange-800" },
    cancelled: { label: "Cancelled", className: "bg-gray-100 text-gray-800" },
  };
}

export function StatusBadge({ status, variant = "default" }: StatusBadgeProps) {
  const statusConfig = getStatusConfig();
  const config = statusConfig[status];
  const showIcon = variant === "default" && config.iconClassName;
  const label = variant === "compact" ? status : config.label;

  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium ${config.className}`}
    >
      {showIcon && (
        <IconCircleCheck className={`h-3 w-3 ${config.iconClassName}`} />
      )}
      {label}
    </span>
  );
}
