import { apiHandlers } from "./api-handlers";
import { npmRegistryHandlers } from "./npm-registry-handlers";
import { scheduleHandlers } from "./schedule-handlers";

export const handlers = [
  ...apiHandlers,
  ...npmRegistryHandlers,
  ...scheduleHandlers,
];
