import { setupServer } from "msw/node";
import { handlers } from "./handlers/index";

export const server = setupServer(...handlers);
