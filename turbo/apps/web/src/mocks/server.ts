import { setupServer } from "msw/node";

// No default handlers - tests supply their own via server.use()
export const server = setupServer();
