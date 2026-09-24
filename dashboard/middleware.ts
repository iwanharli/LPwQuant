import { NextResponse, type NextRequest } from "next/server";
import { COOKIE } from "./app/lib/auth-cookie";

/**
 * A first, cheap gate: no session cookie, no pages. The real check is in the API routes, which verify the cookie
 * against the database -- middleware runs on the edge runtime and cannot reach Postgres.
 */
export function middleware(req: NextRequest) {
  // Only a server told to require login redirects; a laptop running this locally keeps working untouched. The API
  // routes still refuse without a session once a passkey exists, whatever this says.
  if ((process.env.AUTH_REQUIRED || "").toLowerCase() !== "true") return NextResponse.next();
  if (req.cookies.get(COOKIE)) return NextResponse.next();
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/((?!login|api/auth|_next|favicon.ico).*)"],
};
