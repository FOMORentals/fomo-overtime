/**
 * London-time helpers. Every date and time the team types is London local time
 * (GMT in winter, BST in summer). Stored instants are UTC milliseconds.
 * Pure functions, no I/O.
 */

export const TZ = "Europe/London";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export function isDateString(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export function isTimeString(s: string): boolean {
  return TIME_RE.test(s);
}

export function minutesOf(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
}

const partsFmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  weekday: "short",
  hourCycle: "h23",
});

export interface LondonParts {
  date: string; // YYYY-MM-DD
  time: string; // HH:MM
  weekday: number; // 0 = Sunday … 6 = Saturday
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function londonParts(ms: number): LondonParts {
  const p: Record<string, string> = {};
  for (const part of partsFmt.formatToParts(new Date(ms))) p[part.type] = part.value;
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    time: `${p.hour}:${p.minute}`,
    weekday: WEEKDAYS[p.weekday],
  };
}

/** Offset of London from UTC at instant `ms`, in minutes (0 in GMT, 60 in BST). */
function offsetMinutes(ms: number): number {
  const p: Record<string, string> = {};
  for (const part of partsFmt.formatToParts(new Date(ms))) p[part.type] = part.value;
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60000);
}

/** London wall-clock date + time → UTC ms. */
export function londonToUtc(date: string, time: string): number {
  const [y, mo, d] = date.split("-").map(Number);
  const [h, mi] = time.split(":").map(Number);
  const naive = Date.UTC(y, mo - 1, d, h, mi);
  let guess = naive - offsetMinutes(naive) * 60000;
  // Re-check at the guessed instant (matters on clock-change days).
  guess = naive - offsetMinutes(guess) * 60000;
  return guess;
}

export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

export function weekdayOf(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** What people type for a time: "17:35", "1735", "5:35pm", "17.35", "7am" → "HH:MM", or null if it isn't a time. */
export function parseTime(raw: string | null | undefined): string | null {
  const s = (raw ?? "").trim().toLowerCase().replace(/\s+/g, "");
  const m = s.match(/^(\d{1,2})(?:[:.h]?(\d{2}))?(am|pm)?$/);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2] ?? 0);
  if (m[3]) {
    if (h < 1 || h > 12) return null;
    if (m[3] === "pm" && h !== 12) h += 12;
    if (m[3] === "am" && h === 12) h = 0;
  }
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

/** "23:45" + 30 → "00:15" (wraps past midnight). */
export function addMinutesToTime(time: string, minutes: number): string {
  const t = (minutesOf(time) + minutes) % (24 * 60);
  return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
}

/** Start/end instants for a slot. An end time at or before the start means it runs past midnight. */
export function slotInstants(date: string, startTime: string, endTime: string): { startAt: number; endAt: number } {
  const startAt = londonToUtc(date, startTime);
  const endDate = minutesOf(endTime) <= minutesOf(startTime) ? addDays(date, 1) : date;
  return { startAt, endAt: londonToUtc(endDate, endTime) };
}

/** Last Friday of a month (pay day). month = "YYYY-MM". */
export function finalFriday(month: string): string {
  const [y, m] = month.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)); // day 0 of next month = last day of this one
  const back = (last.getUTCDay() - 5 + 7) % 7;
  return addDays(last.toISOString().slice(0, 10), -back);
}

/** The Monday before pay day, when Sam gets the month-end summary. */
export function summaryDay(month: string): string {
  return addDays(finalFriday(month), -4);
}

const longDate = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" });

/** "Mon 10 Nov" */
export function prettyDate(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return longDate.format(new Date(Date.UTC(y, m - 1, d)));
}

export function monthLabel(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", month: "long", year: "numeric" }).format(
    new Date(Date.UTC(y, m - 1, 1)),
  );
}
