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
  const raw = process.env.GOOGLE_CALENDAR_SA_BASE64;
  if (!raw) throw new Error("GOOGLE_CALENDAR_SA_BASE64 is not set");
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
    claim.route === "early_finish" ? `Leave-early route: work through and leave at ${slot.leaveEarlyAt} (no extra pay).` : "",
    slot.details,
    `Posted by ${slot.postedByName}. Manage it in Slack (#rentals_overtime) or ${appUrl}.`,
  ].filter(Boolean);
  return {
    summary: `Overtime: ${slot.kind}${slot.title ? ` · ${slot.title}` : ""}${claim.route === "early_finish" ? ` (leave ${slot.leaveEarlyAt})` : ""}`,
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
