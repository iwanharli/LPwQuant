import { verifyAuthenticationResponse } from "@simplewebauthn/server";
import { createSession, rp, takeChallenge } from "../../../../lib/server/auth";
import { db } from "../../../../lib/server/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const body = (await req.json()) as { response: Parameters<typeof verifyAuthenticationResponse>[0]["response"] };
  const id = body?.response?.id;
  if (!id) return Response.json({ detail: "jawaban passkey tidak lengkap" }, { status: 400 });
  const { rows } = await db.query<{ id: string; public_key: Buffer; counter: string; transports: string[] | null }>(
    "select id, public_key, counter::text, transports from auth_credentials where id = $1",
    [id],
  );
  const cred = rows[0];
  if (!cred) return Response.json({ detail: "passkey tidak dikenal" }, { status: 400 });
  const challenge = await takeChallenge("login");
  if (!challenge) return Response.json({ detail: "tantangan kedaluwarsa, coba lagi" }, { status: 400 });
  const { id: rpID, origin } = rp();
  const check = await verifyAuthenticationResponse({
    response: body.response,
    expectedChallenge: challenge,
    expectedOrigin: origin,
    expectedRPID: rpID,
    requireUserVerification: true,
    credential: {
      id: cred.id,
      publicKey: new Uint8Array(cred.public_key),
      counter: Number(cred.counter),
      transports: (cred.transports ?? undefined) as never,
    },
  });
  if (!check.verified) return Response.json({ detail: "passkey ditolak" }, { status: 401 });
  // The counter only ever moves forward; a lower one would mean a cloned key.
  await db.query("update auth_credentials set counter = $2, last_used_at = now() where id = $1", [
    cred.id,
    check.authenticationInfo.newCounter,
  ]);
  await createSession(cred.id, req.headers.get("user-agent"));
  return Response.json({ ok: true });
}
