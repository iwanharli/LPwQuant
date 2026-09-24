import { generateAuthenticationOptions } from "@simplewebauthn/server";
import { rp, saveChallenge } from "../../../../lib/server/auth";
import { db } from "../../../../lib/server/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  const { rows } = await db.query<{ id: string; transports: string[] | null }>("select id, transports from auth_credentials");
  if (rows.length === 0) return Response.json({ detail: "belum ada passkey terdaftar" }, { status: 400 });
  const options = await generateAuthenticationOptions({
    rpID: rp().id,
    userVerification: "required",
    allowCredentials: rows.map((r) => ({ id: r.id, transports: (r.transports ?? undefined) as never })),
  });
  await saveChallenge(options.challenge, "login");
  return Response.json(options);
}
