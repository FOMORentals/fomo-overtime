/**
 * Admin page access without a separate Google sign-in: the Overtime app in Slack hands Sam and
 * Jamie a signed link (HMAC with AUTH_SECRET, 12 hours). Opening it sets a 12-hour cookie.
 * Slack already proves who they are, and only admins (lib/staff.ts) are ever given a link.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { isAdminEmail } from "./staff";

export const COOKIE = "ot_admin";
export const TTL_MS = 12 * 3_600_000;

function secret(): string {
  const s = process.env.AUTH_SECRET;
  if (!s) throw new Error("AUTH_SECRET is not set");
  return s;
}

function sig(payload: string): string {
  return createHmac("sha256", secret()).update(payload).digest("base64url");
}

export function signAdminToken(email: string, now = Date.now()): string {
  const payload = Buffer.from(JSON.stringify({ e: email, x: now + TTL_MS })).toString("base64url");
  return `${payload}.${sig(payload)}`;
}

/** Returns the admin's email if the token is genuine, unexpired and for an admin. */
export function verifyAdminToken(token: string | null | undefined, now = Date.now()): string | null {
  if (!token) return null;
  const [payload, s] = token.split(".");
  if (!payload || !s) return null;
  const a = Buffer.from(sig(payload));
  const b = Buffer.from(s);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const { e, x } = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { e: string; x: number };
    if (typeof x !== "number" || x < now) return null;
    return isAdminEmail(e) ? e : null;
  } catch {
    return null;
  }
}

/** Link that signs an admin in and lands on `next` (e.g. "/admin" or "/api/export?run=2026-11"). */
export function adminLink(appUrl: string, email: string, next = "/admin"): string {
  return `${appUrl}/admin/enter?t=${encodeURIComponent(signAdminToken(email))}&next=${encodeURIComponent(next)}`;
}
