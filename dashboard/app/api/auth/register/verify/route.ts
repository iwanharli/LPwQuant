import { verifyRegistrationResponse } from "@simplewebauthn/server";
import { createSession, currentSession, rp, takeChallenge } from "../../../../lib/server/auth";
import { db } from "../../../../lib/server/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const body = (await req.json()) as { response: Parameters<typeof verifyRegistrationResponse>[0]["response"]; label?: string };
  const { rows } = await db.query<{ n: string }>("select count(*)::text n from auth_credentials");
  if (Number(rows[0]?.n ?? 0) > 0 && !(await currentSession())) {
    return Response.json({ detail: "perlu login" }, { status: 403 });
  }
  const challenge = await takeChallenge("register");
  if (!challenge) return Response.json({ detail: "tantangan kedaluwarsa, coba lagi" }, { status: 400 });
  const { id, origin } = rp();
  const check = await verifyRegistrationResponse({
    response: body.response,
    expectedChallenge: challenge,
    expectedOrigin: origin,
    expectedRPID: id,
    requireUserVerification: true,
  });
  if (!check.verified || !check.registrationInfo) return Response.json({ detail: "passkey tidak terverifikasi" }, { status: 400 });
  const c = check.registrationInfo.credential;
  await db.query(
    `insert into auth_credentials (id, label, public_key, counter, transports, backed_up)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (id) do update set label = excluded.label, public_key = excluded.public_key`,
    [c.id, (body.label || "Perangkat ini").slice(0, 60), Buffer.from(c.publicKey), c.counter,
     c.transports ?? null, check.registrationInfo.credentialBackedUp],
  );
  await createSession(c.id, req.headers.get("user-agent"));
  return Response.json({ ok: true });
}
