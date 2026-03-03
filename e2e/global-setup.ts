import { clerkSetup } from "@clerk/testing/playwright";
import * as dotenv from "dotenv";

dotenv.config({ path: ".env.local" });

export default async function globalSetup() {
  await clerkSetup();
}
