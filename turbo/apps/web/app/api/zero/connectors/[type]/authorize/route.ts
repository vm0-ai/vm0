/**
 * Zero alias for connector OAuth authorize endpoint.
 *
 * Re-exports the handler from the original /api/connectors/[type]/authorize path.
 * This is a browser redirect endpoint (not JSON API), so it doesn't use ts-rest contracts.
 */
export { GET } from "../../../../connectors/[type]/authorize/route";
