import { requireSession } from "./auth";

/**
 * The browser never talks to the engine or the transaction builder directly: it calls this, and only a signed-in
 * session gets through. On a server that means those two can listen on localhost only, so nothing but the
 * dashboard is exposed.
 */
export async function proxy(
  req: Request,
  ctx: { params: Promise<{ path: string[] }> },
  base: string,
): Promise<Response> {
  const denied = await requireSession();
  if (denied) return denied;
  const { path } = await ctx.params;
  const search = new URL(req.url).search;
  const url = `${base}/${(path ?? []).join("/")}${search}`;
  const init: RequestInit = { method: req.method, headers: { Accept: "application/json" }, signal: AbortSignal.timeout(180_000) };
  if (req.method === "POST") {
    init.body = await req.text();
    (init.headers as Record<string, string>)["Content-Type"] = req.headers.get("content-type") ?? "application/json";
  }
  try {
    const res = await fetch(url, init);
    const body = await res.text();
    return new Response(body, {
      status: res.status,
      headers: { "Content-Type": res.headers.get("content-type") ?? "application/json", "Cache-Control": "no-store" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "gagal";
    return Response.json({ detail: `tidak bisa menghubungi layanan: ${message}` }, { status: 502 });
  }
}
