/**
 * POST /api/zero/schedules/:name/enable
 * Proxies to /api/agent/schedules/:name/enable
 */
import { proxyToInfra } from "../../../../../../src/lib/infra-client";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params;
  return proxyToInfra(
    `/api/agent/schedules/${encodeURIComponent(name)}/enable`,
    request,
  );
}
