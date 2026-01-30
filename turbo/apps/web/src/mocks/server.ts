import { setupServer } from "msw/node";

// Empty handlers - tests will use server.use() for inline handlers
export const server = setupServer();
