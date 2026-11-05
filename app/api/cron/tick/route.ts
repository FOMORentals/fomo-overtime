import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { report } from "@/lib/report";
import { acquireLock, releaseLock } from "@/lib/store";
import { runTick } from "@/lib/tick";

// Vercel cron, every 15 min (vercel.json). Budget 50s inside a 60s function; lock lease 5 min.
export const maxDuration = 60;
const BUDGET_MS = 50_000;
const LEASE_MS = 5 * 60_000;

function authorised(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) throw new Error("CRON_SECRET is not set");
  const got = Buffer.from(req.headers.get("authorization") ?? "");
  const want = Buffer.from(`Bearer ${secret}`);
  return got.length === want.length && timingSafeEqual(got, want);
}

export async function GET(req: Request) {
  if (!authorised(req)) return new NextResponse("unauthorised", { status: 401 });
  const started = Date.now();
  const token = await acquireLock("tick", LEASE_MS);
  if (!token) return NextResponse.json({ skipped: "locked" }, { status: 409 });
  try {
    const result = await runTick(started + BUDGET_MS);
    console.log(`TICK ${result.incomplete ? "INCOMPLETE" : "DONE"}`, JSON.stringify({ ...result, ms: Date.now() - started }));
    if (result.failures > 0 || result.incomplete) return NextResponse.json(result, { status: 502 });
    return NextResponse.json(result);
  } catch (err) {
    report(err, "tick");
    return NextResponse.json({ error: String(err) }, { status: 502 });
  } finally {
    await releaseLock("tick", token).catch((e) => report(e, "tick.release_lock"));
  }
}
