export type ActivityType = "zero" | "workflow";
export type ActivityStatus = "success" | "error" | "warning";

export interface ActivityItem {
  id: string;
  title: string;
  type: ActivityType;
  status: ActivityStatus;
  duration?: string;
  time: string;
}
