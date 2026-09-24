import { createHash, randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { COOKIE } from "../auth-cookie";
import { db } from "./db";

export { COOKIE };
const SESSION_DAYS = 30;
const CHALLENGE_MINUTES = 5;

/** Where the passkey is bound: the domain it may be used on, and the exact origin the browser must report. */
export function rp() {
  const origin = process.env.AUTH_ORIGIN || "http://localhost:3000";
  const id = process.env.AUTH_RP_ID || new URL(origin).hostname;
  return { id, origin, name: "Quant" };
}

/** Login is enforced when AUTH_REQUIRED is set, or as soon as one passkey is registered, so a server that has been
 * set up can never silently fall back to open access. */
export async function authRequired(): Promise<boolean> {
  if ((process.env.AUTH_REQUIRED || "").toLowerCase() === "true") return true;
  const { rows } = await db.query<{ n: string }>("select count(*)::text n from auth_credentials");
  return Number(rows[0]?.n ?? 0) > 0;
}

const hash = (token: string) => createHash("sha256").update(token).digest("hex");

export async function saveChallenge(challenge: string, kind: "register" | "login") {
  await db.query(
    `insert into auth_challenges (challenge, kind, expires_at) values ($1, $2, now() + ($3 || ' minutes')::interval)
     on conflict (challenge) do nothing`,
    [challenge, kind, String(CHALLENGE_MINUTES)],
  );
  await db.query("delete from auth_challenges where expires_at < now()");
}

/** A challenge is valid once: taking it deletes it, so a replay finds nothing. */
export async function takeChallenge(kind: "register" | "login"): Promise<string | null> {
  const { rows } = await db.query<{ challenge: string }>(
    `delete from auth_challenges where challenge = (
       select challenge from auth_challenges where kind = $1 and expires_at > now() order by expires_at desc limit 1
     ) returning challenge`,
    [kind],
  );
  return rows[0]?.challenge ?? null;
}

export async function createSession(credentialId: string, userAgent: string | null) {
  const token = randomBytes(32).toString("base64url");
  await db.query(
    `insert into auth_sessions (token_hash, credential, expires_at, user_agent)
     values ($1, $2, now() + ($3 || ' days')::interval, $4)`,
    [hash(token), credentialId, String(SESSION_DAYS), userAgent?.slice(0, 300) ?? null],
  );
  const jar = await cookies();
  jar.set(COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: rp().origin.startsWith("https://"),
    path: "/",
    maxAge: SESSION_DAYS * 86_400,
  });
}

export async function currentSession(): Promise<{ credential: string | null } | null> {
  const token = (await cookies()).get(COOKIE)?.value;
  if (!token) return null;
  const { rows } = await db.query<{ credential: string | null }>(
    "select credential from auth_sessions where token_hash = $1 and expires_at > now()",
    [hash(token)],
  );
  return rows[0] ?? null;
}

export async function endSession() {
  const jar = await cookies();
  const token = jar.get(COOKIE)?.value;
  if (token) await db.query("delete from auth_sessions where token_hash = $1", [hash(token)]);
  jar.delete(COOKIE);
}

/** Every protected route starts here: open while no passkey exists, closed the moment one does. */
export async function requireSession(): Promise<Response | null> {
  if (!(await authRequired())) return null;
  if (await currentSession()) return null;
  return Response.json({ detail: "perlu login" }, { status: 401 });
}
