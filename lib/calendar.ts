/**
 * Google Calendar via a service account with domain-wide delegation (approved once by the
 * fomorentals.co.uk Workspace admin). The service account acts as each staff member to write
 * to their primary calendar. Event ids are derived from the claim id, so writes are idempotent.
 */
import { createHash } from "node:crypto";
import { JWT } from "google-auth-library";
import { calendarWindow } from "./rules";
import { slotLine } from "./views";
import type { Claim, Slot } from "./types";

const SCOPES = ["https://www.googleapis.com/auth/calendar.events", "https://www.googleapis.com/auth/calendar.freebusy"];
const BASE = "https://www.googleapis.com/calendar/v3";

function credentials(): { client_email: string; private_key: string } {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_BASE64;
  if (!raw) throw new Error("GOOGLE_SERVICE_ACCOUNT_BASE64 is not set");
  return JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
}

function clientFor(email: string): JWT {
  const c = credentials();
  return new JWT({ email: c.client_email, key: c.private_key, scopes: SCOPES, subject: email });
}

/** Google event ids allow a–v and 0–9; hex is a subset. */
export function eventIdFor(claimId: string): string {
  return "ot" + createHash("sha256").update(claimId).digest("hex").slice(0, 40);
}

function status(err: unknown): number | undefined {
  return (err as { response?: { status?: number } })?.response?.status ?? (err as { status?: number })?.status;
}

export function eventBody(slot: Slot, claim: Claim, appUrl: string) {
  const w = calendarWindow(slot, claim.route);
  const notes = [
    slotLine(slot).replace(/\*/g, ""),
    claim.route === "early_finish" ? `Working the time instead of being paid${slot.leaveEarlyAt ? `: leave at ${slot.leaveEarlyAt}` : ""} (no extra pay).` : "",
    slot.details,
    `Posted by ${slot.postedByName}. Manage it in Slack (#rentals_overtime) or ${appUrl}.`,
  ].filter(Boolean);
  return {
    summary: `Overtime: ${slot.kind}${slot.title ? ` · ${slot.title}` : ""}${claim.route === "early_finish" ? (slot.leaveEarlyAt ? ` (leave ${slot.leaveEarlyAt})` : " (time instead)") : ""}`,
    description: notes.join("\n\n"),
    location: process.env.OVERTIME_LOCATION || "FOMO Rentals",
    start: { dateTime: new Date(w.startAt).toISOString(), timeZone: "Europe/London" },
    end: { dateTime: new Date(w.endAt).toISOString(), timeZone: "Europe/London" },
    status: "confirmed",
    reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 60 }] },
  };
}

/** Create or update the event. Returns the event id. */
export async function upsertEvent(slot: Slot, claim: Claim, appUrl: string): Promise<string> {
  const client = clientFor(claim.email);
  const id = eventIdFor(claim.id);
  const body = eventBody(slot, claim, appUrl);
  try {
    await client.request({ url: `${BASE}/calendars/primary/events/${id}`, method: "PUT", data: body });
  } catch (err) {
    if (status(err) !== 404) throw err;
    await client.request({ url: `${BASE}/calendars/primary/events`, method: "POST", data: { ...body, id } });
  }
  return id;
}

export async function deleteEvent(claim: Pick<Claim, "id" | "email">): Promise<void> {
  const client = clientFor(claim.email);
  try {
    await client.request({ url: `${BASE}/calendars/primary/events/${eventIdFor(claim.id)}`, method: "DELETE" });
  } catch (err) {
    const s = status(err);
    if (s === 404 || s === 410) return; // already gone
    throw err;
  }
}

/** Is anything else in their calendar during this window? (Warning only, never blocks.) */
export async function isBusy(email: string, startAt: number, endAt: number): Promise<boolean> {
  const client = clientFor(email);
  const res = await client.request<{ calendars: Record<string, { busy: unknown[]; errors?: unknown[] }> }>({
    url: `${BASE}/freeBusy`,
    method: "POST",
    data: { timeMin: new Date(startAt).toISOString(), timeMax: new Date(endAt).toISOString(), items: [{ id: email }] },
  });
  const cal = res.data.calendars?.[email];
  if (!cal || cal.errors?.length) throw new Error(`freeBusy failed for ${email}`);
  return cal.busy.length > 0;
}

// ---------- shared team calendar ("FOMO Overtime") ----------
// One event per slot on a calendar Jamie owns and shares with the team: red while a space is
// open, green once covered. Written as the calendar's owner. Off until OT_TEAM_CALENDAR_ID is set.

export function teamCalendarId(): string | null {
  return process.env.OT_TEAM_CALENDAR_ID?.trim() || null;
}

function teamCalendarOwner(): string {
  return process.env.OT_TEAM_CALENDAR_OWNER?.trim() || "jamie@fomorentals.co.uk";
}

const TOMATO = "11";
const BASIL = "10";

/** Pure: what the slot looks like on the team calendar. */
export function teamEventBody(slot: Slot, claims: Claim[], appUrl: string) {
  const active = claims.filter((c) => c.status === "confirmed" || c.status === "completed");
  const names = active.map((c) => c.name + (c.route === "early_finish" ? (slot.leaveEarlyAt ? ` (leaves ${slot.leaveEarlyAt})` : " (time instead)") : ""));
  const open = Math.max(0, slot.spaces - active.length);
  const what = `${slot.kind}${slot.title ? ` · ${slot.title}` : ""}`;
  const prefix = open > 0 && slot.status !== "completed" ? (slot.spaces > 1 ? `OPEN (${open} of ${slot.spaces})` : "OPEN") : "";
  const summary = [prefix, names.join(", "), what].filter(Boolean).join(" · ");
  return {
    summary,
    description: [
      slotLine(slot).replace(/\*/g, ""),
      slot.details,
      open > 0 ? "Claim it in Slack: #rentals_overtime or the Overtime app's Home tab." : "",
      `Posted by ${slot.postedByName}. ${appUrl}`,
    ]
      .filter(Boolean)
      .join("\n\n"),
    location: process.env.OVERTIME_LOCATION || "FOMO Rentals",
    start: { dateTime: new Date(slot.startAt).toISOString(), timeZone: "Europe/London" },
    end: { dateTime: new Date(slot.endAt).toISOString(), timeZone: "Europe/London" },
    status: "confirmed",
    colorId: open > 0 && slot.status !== "completed" ? TOMATO : BASIL,
    transparency: "transparent", // doesn't make anyone look busy
    reminders: { useDefault: false, overrides: [] },
  };
}

export async function upsertTeamEvent(slot: Slot, claims: Claim[], appUrl: string): Promise<void> {
  const cal = teamCalendarId();
  if (!cal) return;
  const client = clientFor(teamCalendarOwner());
  const id = eventIdFor(`team_${slot.id}`);
  const body = teamEventBody(slot, claims, appUrl);
  const base = `${BASE}/calendars/${encodeURIComponent(cal)}/events`;
  try {
    await client.request({ url: `${base}/${id}`, method: "PUT", data: body });
  } catch (err) {
    if (status(err) !== 404) throw err;
    await client.request({ url: base, method: "POST", data: { ...body, id } });
  }
}

export async function deleteTeamEvent(slotId: string): Promise<void> {
  const cal = teamCalendarId();
  if (!cal) return;
  const client = clientFor(teamCalendarOwner());
  try {
    await client.request({ url: `${BASE}/calendars/${encodeURIComponent(cal)}/events/${eventIdFor(`team_${slotId}`)}`, method: "DELETE" });
  } catch (err) {
    const s = status(err);
    if (s === 404 || s === 410) return;
    throw err;
  }
}
