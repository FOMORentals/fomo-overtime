import { NextResponse } from "next/server";
import { COOKIE, TTL_MS, verifyAdminToken } from "@/lib/admin-link";

/** Opened from the admin links the Overtime app sends in Slack. */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const token = url.searchParams.get("t");
  const next = url.searchParams.get("next") || "/admin";
  if (!verifyAdminToken(token)) return new NextResponse("This link has expired. Open the Admin page button in the Overtime app's Home tab in Slack.", { status: 403 });
  const safeNext = next.startsWith("/") && !next.startsWith("//") ? next : "/admin";
  const res = NextResponse.redirect(new URL(safeNext, url.origin));
  res.cookies.set(COOKIE, token!, { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: TTL_MS / 1000 });
  return res;
}
