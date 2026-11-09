/** Shapes stored in Firestore (collections prefixed ot_). Money is whole pence. Instants are UTC ms. */

export type SlotStatus = "open" | "full" | "cancelled" | "completed";
export type Route = "paid" | "early_finish";
export type ClaimStatus = "confirmed" | "withdrawn" | "cancelled" | "completed";

export const SLOT_KINDS = ["Early opening", "Late closing", "Weekend opening", "Weekend closing", "Other"] as const;
/** Slots are a single time (Sam, 6 Nov): the end is set this many minutes after the start, for clash checks and calendars. */
export const SLOT_MINUTES = 30;

export interface SlotInput {
  kind: string;
  title: string; // client / job name, e.g. "Andrew Berekdar"
  rentmanJob: string; // digits or ""
  details: string;
  date: string; // YYYY-MM-DD London
  startTime: string; // HH:MM
  endTime: string; // HH:MM (≤ start means past midnight)
  feePence: number; // 0 = Free
  spaces: number;
  leaveEarlyAt: string | null; // HH:MM, only on slots starting before 09:00
}

export interface Slot extends SlotInput {
  id: string;
  startAt: number;
  endAt: number;
  status: SlotStatus;
  claimedCount: number;
  postedBy: string; // Slack user id
  postedByName: string;
  createdAt: number;
  updatedAt: number;
  channel: string | null;
  messageTs: string | null;
  repostedAt: number | null;
  unclaimedAlertAt: number | null;
  /** The slot's updatedAt last written to the shared team calendar (missing on older slots). */
  teamCalendarSyncedAt?: number | null;
}

export interface Claim {
  id: string; // `${slotId}_${userId}`
  slotId: string;
  userId: string;
  email: string;
  name: string;
  route: Route;
  amountPence: number;
  status: ClaimStatus;
  claimedAt: number;
  withdrawnAt: number | null;
  /** Copied from the slot so lists and month-end work without joins. */
  date: string;
  startAt: number;
  endAt: number;
  slotLabel: string;
  flagged: boolean;
  flagReason: string | null;
  paidRunId: string | null;
  calendarEventId: string | null;
  calendarError: string | null;
  reminderDayBeforeAt: number | null;
  reminderHourBeforeAt: number | null;
  /** Give away: offered to this colleague, waiting for them to accept (missing on older claims). */
  offerTo?: string | null;
  offerToName?: string | null;
  offerAt?: number | null;
  /** A freelancer (not on Slack) assigned by the poster or an admin. Paid outside payroll: no DMs, reminders or pay run. */
  freelancer?: boolean;
  /** Set on the old claim when someone else took it over. */
  swappedTo?: string | null;
}

export interface PayRun {
  id: string; // YYYY-MM of pay day
  createdAt: number;
  status: "awaiting_sam" | "awaiting_jamie" | "sent";
  claimIds: string[];
  totalPence: number;
  approvedBy: string | null;
  approvedAt: number | null;
  sentBy: string | null;
  sentAt: number | null;
}
