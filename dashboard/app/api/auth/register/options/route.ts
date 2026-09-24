import { generateRegistrationOptions } from "@simplewebauthn/server";
import { currentSession, rp, saveChallenge } from "../../../../lib/server/auth";
import { db } from "../../../../lib/server/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Registering a passkey is open only until the first one exists; after that it takes a signed-in session, so
 * nobody who finds the server can add their own key. */
export async function POST() {
  const { rows } = await db.query<{ id: string; transports: string[] | null }>("select id, transports from auth_credentials");
  if (rows.length > 0 && !(await currentSession())) {
    return Response.json({ detail: "sudah ada passkey terdaftar; login dulu untuk menambah perangkat" }, { status: 403 });
  }
  const { id, name } = rp();
  const options = await generateRegistrationOptions({
    rpID: id,
    rpName: name,
    userName: "owner",
    userDisplayName: "Pemilik",
    attestationType: "none",
    excludeCredentials: rows.map((r) => ({ id: r.id, transports: (r.transports ?? undefined) as never })),
    authenticatorSelection: {
      residentKey: "preferred",
      userVerification: "required", // Touch ID, not just the device being present
      authenticatorAttachment: "platform",
    },
  });
  await saveChallenge(options.challenge, "register");
  return Response.json(options);
}
