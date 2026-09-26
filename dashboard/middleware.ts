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
  // API routes are left out on purpose: they check the session against the database and answer 401, which a fetch
  // can handle. A redirect there would turn a refused call into a login page in the response body.
  // The service worker, manifest and icons must load without a session: phones install and update them on their own.
  matcher: ["/((?!login|api|_next|favicon.ico|sw.js|manifest.webmanifest|icon-192.png|icon-512.png|apple-touch-icon.png).*)"],
};
