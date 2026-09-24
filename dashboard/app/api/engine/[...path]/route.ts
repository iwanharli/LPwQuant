import { proxy } from "../../../lib/server/proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const target = () => process.env.ENGINE_URL || "http://127.0.0.1:8000";

export const GET = (req: Request, ctx: { params: Promise<{ path: string[] }> }) => proxy(req, ctx, target());
export const POST = (req: Request, ctx: { params: Promise<{ path: string[] }> }) => proxy(req, ctx, target());
