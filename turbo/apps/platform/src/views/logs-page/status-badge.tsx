import { IconCheck } from "@tabler/icons-react";
import type { LogStatus } from "../../signals/logs-page/types.ts";

interface StatusBadgeConfig {
  label: string;
  className: string;
  icon?: boolean;
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
      className: "border border-green-200 text-green-700",
      icon: true,
    },
    failed: { label: "Failed", className: "bg-red-100 text-red-800" },
    timeout: { label: "Timeout", className: "bg-orange-100 text-orange-800" },
    cancelled: { label: "Cancelled", className: "bg-gray-100 text-gray-800" },
  };
}

export function StatusBadge({ status, variant = "default" }: StatusBadgeProps) {
  const statusConfig = getStatusConfig();
  const config = statusConfig[status];
  const showIcon = variant === "default" && config.icon;
  const label = variant === "compact" ? status : config.label;

  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium ${config.className}`}
    >
      {showIcon && <IconCheck className="h-3 w-3" />}
      {label}
    </span>
  );
}
