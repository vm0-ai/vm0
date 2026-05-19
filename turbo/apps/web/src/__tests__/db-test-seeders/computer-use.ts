import { initServices } from "../../lib/init-services";
import { registerHost } from "../../lib/zero/computer-use/computer-use-service";

export async function registerTestComputerUseHost(
  orgId: string,
  userId: string,
): Promise<void> {
  initServices();
  await registerHost(orgId, userId);
}
