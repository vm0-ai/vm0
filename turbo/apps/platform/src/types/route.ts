export type RoutePath =
  | "/"
  | "/logs"
  | "/logs/:id"
  | "/settings"
  | "/agents"
  | "/schedules"
  | `/projects/${string}`;
