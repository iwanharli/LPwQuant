import { requireSession } from "../../../lib/server/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * For nginx's auth_request: 204 when the browser has a valid session, 401 when it does not. The websocket cannot
 * go through the proxy route (a route handler cannot upgrade a connection), so nginx forwards it directly to the
 * engine and asks this first.
 */
export async function GET() {
  const denied = await requireSession();
  return denied ? new Response(null, { status: 401 }) : new Response(null, { status: 204 });
}
