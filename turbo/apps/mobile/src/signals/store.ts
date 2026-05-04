import { createStore } from "ccstate";

export const store = createStore();

export { bootstrap$ } from "./bootstrap.ts";
export { zeroClient$ } from "./api-client.ts";
export { accept } from "../lib/accept.ts";
