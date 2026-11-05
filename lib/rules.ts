/**
 * The business rules agreed with Jamie on 5 Nov 2026 (thread "Build Sam's overtime tracker").
 * Pure functions only, so every rule here is covered by rules.test.ts.
 */
import { addDays, isDateString, isTimeString, londonParts, londonToUtc, minutesOf, slotInstants } from "./time";
import type { Claim, Route, Slot, SlotInput } from "./types";

export const HOUR = 3_600_000;
export const WITHDRAW_FREE_UNTIL_HOURS = 48;
/** Two paid slots starting within this many minutes of each other get flagged for Sam (Sam: "not compounded"). */
export const PAIRED_SLOT_MINUTES = 60;
export const MAX_SLOT_HOURS = 16;

export function validateSlotInput(input: SlotInput, now: number, { allowPast = false } = {}): string[] {
  const errors: string[] = [];
  if (!input.title.trim()) errors.push("Add the client or job name.");
  if (!isDateString(input.date)) errors.push("Pick a date.");
  if (!isTimeString(input.startTime)) errors.push("Start time must look like 07:30.");
  if (!isTimeString(input.endTime)) errors.push("End time must look like 08:00.");
  if (input.rentmanJob && !/^\d{3,7}$/.test(input.rentmanJob)) errors.push("Rentman job number should be digits only, e.g. 11887.");
  if (!Number.isInteger(input.feePence) || input.feePence < 0 || input.feePence > 100_000)
    errors.push("Fee must be between £0 (Free) and £1,000.");
  if (!Number.isInteger(input.spaces) || input.spaces < 1 || input.spaces > 10) errors.push("Spaces must be 1 to 10.");
  if (errors.length) return errors;

  if (input.startTime === input.endTime) errors.push("Start and end time can't be the same.");
  const { startAt, endAt } = slotInstants(input.date, input.startTime, input.endTime);
  if (endAt - startAt > MAX_SLOT_HOURS * HOUR) errors.push(`A slot can't be longer than ${MAX_SLOT_HOURS} hours.`);
  if (!allowPast && startAt <= now) errors.push("That start time has already passed.");

  if (input.leaveEarlyAt) {
    if (!isTimeString(input.leaveEarlyAt)) errors.push("Leave-early time must look like 15:00.");
    else if (!startsBefore9(input.startTime)) errors.push("Leave early only applies to slots starting before 9am.");
    else if (minutesOf(input.leaveEarlyAt) <= minutesOf(input.startTime))
      errors.push("Leave-early time must be after the start time.");
  }
  return errors;
}

export function startsBefore9(startTime: string): boolean {
  return minutesOf(startTime) < 9 * 60;
}

export function offersEarlyFinish(slot: Pick<Slot, "startTime" | "leaveEarlyAt">): boolean {
  return !!slot.leaveEarlyAt && startsBefore9(slot.startTime);
}

export function amountFor(slot: Pick<Slot, "feePence">, route: Route): number {
  return route === "early_finish" ? 0 : slot.feePence;
}

/** What goes in the calendar: early finish runs from arrival to the agreed leave time. */
export function calendarWindow(slot: Pick<Slot, "date" | "startAt" | "endAt" | "leaveEarlyAt">, route: Route) {
  if (route === "early_finish" && slot.leaveEarlyAt) {
    return { startAt: slot.startAt, endAt: londonToUtc(slot.date, slot.leaveEarlyAt) };
  }
  return { startAt: slot.startAt, endAt: slot.endAt };
}

export function overlaps(a: { startAt: number; endAt: number }, b: { startAt: number; endAt: number }): boolean {
  return a.startAt < b.endAt && b.startAt < a.endAt;
}

export function spacesLeft(slot: Pick<Slot, "spaces" | "claimedCount">): number {
  return Math.max(0, slot.spaces - slot.claimedCount);
}

export type ClaimRefusal = "not_open" | "full" | "started" | "already_claimed" | "clash";

/** First-come-first-served check, run inside the database transaction. */
export function canClaim(
  slot: Slot,
  userId: string,
  usersActiveClaims: Pick<Claim, "slotId" | "startAt" | "endAt" | "route">[],
  now: number,
  route: Route,
): { ok: true } | { ok: false; reason: ClaimRefusal; clashWith?: string } {
  if (slot.status !== "open" && slot.status !== "full") return { ok: false, reason: "not_open" };
  if (slot.startAt <= now) return { ok: false, reason: "started" };
  if (usersActiveClaims.some((c) => c.slotId === slot.id)) return { ok: false, reason: "already_claimed" };
  if (spacesLeft(slot) <= 0) return { ok: false, reason: "full" };
  const mine = calendarWindow(slot, route);
  const clash = usersActiveClaims.find((c) => overlaps(mine, c));
  if (clash) return { ok: false, reason: "clash", clashWith: clash.slotId };
  void userId;
  return { ok: true };
}

export function statusAfterCount(slot: Pick<Slot, "status" | "spaces">, claimedCount: number): Slot["status"] {
  if (slot.status === "cancelled" || slot.status === "completed") return slot.status;
  return claimedCount >= slot.spaces ? "full" : "open";
}

/** Inside 48 hours a drop-out is still allowed, but the slot is reposted and Sam is told. */
export function isLateWithdrawal(startAt: number, now: number): boolean {
  return startAt - now < WITHDRAW_FREE_UNTIL_HOURS * HOUR;
}

// ---------- scheduled nudges ----------

/** 5pm the day before. */
export function dayBeforeReminderAt(date: string): number {
  return londonToUtc(addDays(date, -1), "17:00");
}

/** Slots starting before 8am also get a DM an hour before. */
export function hourBeforeReminderAt(slot: Pick<Slot, "startTime" | "startAt">): number | null {
  return minutesOf(slot.startTime) < 8 * 60 ? slot.startAt - HOUR : null;
}

export function repostAt(date: string): number {
  return londonToUtc(addDays(date, -2), "12:00");
}

export function unclaimedAlertAt(date: string): number {
  return londonToUtc(addDays(date, -2), "16:00");
}

export type Nudge =
  | { kind: "repost"; slotId: string }
  | { kind: "unclaimed_alert"; slotId: string }
  | { kind: "reminder_day_before"; claimId: string }
  | { kind: "reminder_hour_before"; claimId: string };

/** Everything due at `now`. Each nudge fires once (its timestamp field is set after sending). */
export function dueNudges(slots: Slot[], claims: Claim[], now: number): Nudge[] {
  const out: Nudge[] = [];
  for (const s of slots) {
    if (s.status !== "open" || spacesLeft(s) <= 0 || s.startAt <= now) continue;
    const rAt = repostAt(s.date);
    if (!s.repostedAt && now >= rAt && s.createdAt < rAt) out.push({ kind: "repost", slotId: s.id });
    const aAt = unclaimedAlertAt(s.date);
    if (!s.unclaimedAlertAt && now >= aAt && s.createdAt < aAt) out.push({ kind: "unclaimed_alert", slotId: s.id });
  }
  const bySlot = new Map(slots.map((s) => [s.id, s]));
  for (const c of claims) {
    if (c.status !== "confirmed" || c.startAt <= now) continue;
    const slot = bySlot.get(c.slotId);
    if (!slot) continue;
    const dAt = dayBeforeReminderAt(slot.date);
    // Someone who claims after 5pm the day before has just seen it; skip the day-before nudge.
    if (!c.reminderDayBeforeAt && now >= dAt && c.claimedAt < dAt) out.push({ kind: "reminder_day_before", claimId: c.id });
    const hAt = hourBeforeReminderAt(slot);
    if (hAt !== null && !c.reminderHourBeforeAt && now >= hAt) out.push({ kind: "reminder_hour_before", claimId: c.id });
  }
  return out;
}

/** Confirmed claims whose slot has ended count automatically (unless flagged). */
export function claimsToComplete(claims: Claim[], now: number): Claim[] {
  return claims.filter((c) => c.status === "confirmed" && c.endAt <= now);
}

// ---------- month end ----------

/** Earnings ready for the next pay run: completed, not flagged, not already paid, more than £0. */
export function payableClaims(claims: Claim[]): Claim[] {
  return claims.filter((c) => c.status === "completed" && !c.flagged && !c.paidRunId && c.amountPence > 0);
}

/** Pairs of paid slots one person did within an hour of each other ("not compounded"). */
export function pairedSlotWarnings(claims: Claim[]): { userId: string; a: Claim; b: Claim }[] {
  const out: { userId: string; a: Claim; b: Claim }[] = [];
  const byUser = new Map<string, Claim[]>();
  for (const c of claims) {
    if (c.amountPence <= 0) continue;
    byUser.set(c.userId, [...(byUser.get(c.userId) ?? []), c]);
  }
  for (const [userId, list] of byUser) {
    list.sort((x, y) => x.startAt - y.startAt);
    for (let i = 1; i < list.length; i++) {
      if (list[i].startAt - list[i - 1].startAt <= PAIRED_SLOT_MINUTES * 60_000) out.push({ userId, a: list[i - 1], b: list[i] });
    }
  }
  return out;
}

export interface PersonTotal {
  userId: string;
  name: string;
  email: string;
  totalPence: number;
  claims: Claim[];
}

export function totalsByPerson(claims: Claim[]): PersonTotal[] {
  const map = new Map<string, PersonTotal>();
  for (const c of claims) {
    const t = map.get(c.userId) ?? { userId: c.userId, name: c.name, email: c.email, totalPence: 0, claims: [] };
    t.totalPence += c.amountPence;
    t.claims.push(c);
    map.set(c.userId, t);
  }
  for (const t of map.values()) t.claims.sort((a, b) => a.startAt - b.startAt);
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Pay-run id for `now` if today is the summary Monday at/after 9am London, else null. */
export function payRunDue(now: number, summaryDayFor: (month: string) => string): string | null {
  const p = londonParts(now);
  const month = p.date.slice(0, 7);
  if (p.date !== summaryDayFor(month)) return null;
  if (minutesOf(p.time) < 9 * 60) return null;
  return month;
}

export function money(pence: number): string {
  if (pence === 0) return "Free";
  const pounds = pence / 100;
  return `£${Number.isInteger(pounds) ? pounds.toString() : pounds.toFixed(2)}`;
}

/** Parse what people type in the fee box: "25", "£25", "25.50", "free", "" → pence. */
export function parseFee(raw: string): number | null {
  const s = raw.trim().toLowerCase().replace(/^£/, "").replace(/,/g, "");
  if (s === "" || s === "free" || s === "0") return 0;
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  return Math.round(parseFloat(s) * 100);
}

export function csvEscape(v: string | number): string {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function payRunCsv(claims: Claim[]): string {
  const rows: (string | number)[][] = [["Name", "Email", "Date", "Job", "Amount (£)"]];
  for (const t of totalsByPerson(claims)) {
    for (const c of t.claims) rows.push([t.name, t.email, c.date, c.slotLabel, (c.amountPence / 100).toFixed(2)]);
    rows.push([t.name, t.email, "", "TOTAL", (t.totalPence / 100).toFixed(2)]);
  }
  return rows.map((r) => r.map(csvEscape).join(",")).join("\n") + "\n";
}
