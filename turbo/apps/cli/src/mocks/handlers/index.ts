import { apiHandlers } from "./api-handlers";
import { npmRegistryHandlers } from "./npm-registry-handlers";
import { githubHandlers } from "./github-handlers";

export const handlers = [
  ...apiHandlers,
  ...npmRegistryHandlers,
  ...githubHandlers,
];
