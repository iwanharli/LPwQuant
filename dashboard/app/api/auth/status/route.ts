import { authRequired, currentSession } from "../../../lib/server/auth";
import { db } from "../../../lib/server/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** What the login page needs to know: is there a passkey yet, and is this browser already signed in. */
export async function GET() {
  const { rows } = await db.query<{ n: string }>("select count(*)::text n from auth_credentials");
  const registered = Number(rows[0]?.n ?? 0);
  return Response.json({
    registered,
    required: await authRequired(),
    signed_in: !!(await currentSession()),
  });
}
