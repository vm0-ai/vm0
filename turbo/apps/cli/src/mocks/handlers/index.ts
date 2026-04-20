import { apiHandlers } from "./api-handlers";
import { npmRegistryHandlers } from "./npm-registry-handlers";

export const handlers = [...apiHandlers, ...npmRegistryHandlers];
