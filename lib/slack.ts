/** Thin Slack Web API wrapper. Every failure throws (FOMO engineering rule 1: nothing fails silently). */
import { createHmac, timingSafeEqual } from "node:crypto";
import { staffByEmail } from "./staff";
import type { Actor } from "./store";

const API = "https://slack.com/api";

function token(): string {
  const t = process.env.SLACK_BOT_TOKEN?.trim();
  if (!t) throw new Error("SLACK_BOT_TOKEN is not set");
  return t;
}

export function overtimeChannel(): string {
  const c = process.env.SLACK_OVERTIME_CHANNEL_ID?.trim();
  if (!c) throw new Error("SLACK_OVERTIME_CHANNEL_ID is not set");
  return c;
}

export class SlackError extends Error {
  constructor(public method: string, public code: string) {
    super(`Slack ${method} failed: ${code}`);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function slack<T = any>(method: string, body: Record<string, unknown>): Promise<T> {
  // Form-encoded, because some read methods (users.info, users.lookupByEmail, chat.getPermalink)
  // ignore JSON bodies. Objects such as blocks and views go in as JSON strings, which Slack accepts.
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(body)) {
    if (v === undefined || v === null) continue;
    form.set(k, typeof v === "string" ? v : JSON.stringify(v));
  }
  const res = await fetch(`${API}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Bearer ${token()}` },
    body: form,
  });
  if (!res.ok) throw new SlackError(method, `HTTP ${res.status}`);
  const json = (await res.json()) as { ok: boolean; error?: string };
  if (!json.ok) throw new SlackError(method, json.error ?? "unknown_error");
  return json as T;
}

/** Slack request signing check (https://api.slack.com/authentication/verifying-requests-from-slack). */
export function verifySlackSignature(rawBody: string, timestamp: string | null, signature: string | null, now = Date.now()): boolean {
  const secret = process.env.SLACK_SIGNING_SECRET?.trim();
  if (!secret) throw new Error("SLACK_SIGNING_SECRET is not set");
  if (!timestamp || !signature) return false;
  if (Math.abs(now / 1000 - Number(timestamp)) > 60 * 5) return false;
  const expected = "v0=" + createHmac("sha256", secret).update(`v0:${timestamp}:${rawBody}`).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

const actorCache = new Map<string, { actor: Actor | null; at: number }>();

/** Slack user → FOMO staff member, by their verified Slack email. null = not on the overtime list. */
export async function actorFor(userId: string): Promise<Actor | null> {
  const hit = actorCache.get(userId);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.actor;
  let res: { user: { profile: { email?: string; display_name?: string; real_name?: string } } };
  try {
    res = await slack("users.info", { user: userId });
  } catch (err) {
    if (err instanceof SlackError && err.code === "user_not_found") {
      // Usually means SLACK_BOT_TOKEN belongs to a different app or workspace. Say which.
      const who = await slack<{ team: string; team_id: string; user: string; bot_id?: string }>("auth.test", {}).catch(() => null);
      throw new SlackError("users.info", `user_not_found (user ${userId}; token is for team ${who?.team_id ?? "?"} ${who?.team ?? ""}, bot ${who?.user ?? "?"})`);
    }
    throw err;
  }
  const staff = staffByEmail(res.user.profile.email);
  const actor = staff ? { userId, email: staff.email, name: staff.name, admin: staff.admin } : null;
  actorCache.set(userId, { actor, at: Date.now() });
  return actor;
}

/** Slack user id for a staff email (for DMs to Sam/Jamie). */
export async function userIdForEmail(email: string): Promise<string> {
  const res = await slack<{ user: { id: string } }>("users.lookupByEmail", { email });
  return res.user.id;
}

export async function dm(userId: string, text: string, blocks?: unknown[]) {
  return slack<{ ts: string; channel: string }>("chat.postMessage", { channel: userId, text, ...(blocks ? { blocks } : {}) });
}

export async function dmEmail(email: string, text: string, blocks?: unknown[]) {
  return dm(await userIdForEmail(email), text, blocks);
}
