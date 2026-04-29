import { setupServer } from "msw/node";

import { handlers } from "./handlers/index.ts";

export const server = setupServer(...handlers);
