/**
 * PATCH /api/zero/composes/:id/metadata
 * Proxies to /api/agent/composes/:id/metadata
 */
import { proxyToInfra } from "../../../../../../src/lib/infra-client";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  return proxyToInfra(`/api/agent/composes/${id}/metadata`, request);
}
