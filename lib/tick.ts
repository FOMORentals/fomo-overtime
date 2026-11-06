/**
 * The scheduled job (Vercel cron, every 15 minutes, see vercel.json).
 * Calls no Rentman, HubSpot or Xero APIs: only Firestore, Slack and Google Calendar.
 * Each nudge fires once: its timestamp is stored after sending, so re-runs are safe.
 */
import { payRunLinks, permalink, refreshSlot, repostSlot, syncTeamCalendar } from "./actions";
import { teamCalendarId } from "./calendar";
import { report } from "./report";
import { claimsToComplete, dueNudges, payRunDue, payableClaims, roundupDue, slotsInWeek } from "./rules";
import { dm, dmEmail, overtimeChannel, slack } from "./slack";
import { APPROVER_EMAIL, OPS_ALERT_EMAIL } from "./staff";
import {
  completeClaim, completeSlotIfDone, confirmedClaims, createPayRun, getMeta, getPayRun, liveSlots, setMeta, unpaidCompletedClaims,
  updateClaimFields, updateSlotFields,
} from "./store";
import { summaryDay } from "./time";
import { payRunBlocks, roundupMessage, slotLine } from "./views";

export interface TickResult {
  completed: number;
  nudges: number;
  payRun: string | null;
  failures: number;
  incomplete: boolean;
}

export async function runTick(deadline: number, now = Date.now()): Promise<TickResult> {
  const out: TickResult = { completed: 0, nudges: 0, payRun: null, failures: 0, incomplete: false };
  const timeUp = () => {
    if (Date.now() > deadline) {
      out.incomplete = true;
      return true;
    }
    return false;
  };
  const attempt = async (context: string, fn: () => Promise<void>, extra: Record<string, unknown> = {}) => {
    try {
      await fn();
    } catch (err) {
      out.failures++;
      report(err, `tick.${context}`, extra);
    }
  };

  const [slots, claims] = await Promise.all([liveSlots(now), confirmedClaims()]);

  // 1. Finished shifts count automatically.
  for (const c of claimsToComplete(claims, now)) {
    if (timeUp()) break;
    await attempt("complete_claim", async () => {
      await completeClaim(c);
      out.completed++;
    }, { claimId: c.id });
  }
  for (const s of slots.filter((s) => s.endAt <= now)) {
    if (timeUp()) break;
    await attempt("complete_slot", async () => {
      await completeSlotIfDone(s.id, now);
      await refreshSlot(s.id);
    }, { slotId: s.id });
  }

  // 2. Reminders, reposts and unclaimed alerts.
  const bySlot = new Map(slots.map((s) => [s.id, s]));
  const byClaim = new Map(claims.map((c) => [c.id, c]));
  for (const n of dueNudges(slots, claims, now)) {
    if (timeUp()) break;
    await attempt(n.kind, async () => {
      if (n.kind === "repost") {
        const s = bySlot.get(n.slotId)!;
        await repostSlot(s, `:raising_hand: *Still needed:* ${slotLine(s)}`);
        await updateSlotFields(s.id, { repostedAt: now });
      } else if (n.kind === "unclaimed_alert") {
        const s = bySlot.get(n.slotId)!;
        const link = await permalink(s);
        const text = `:warning: Nobody has claimed *${slotLine(s)}* yet (2 days to go).${link ? ` <${link}|View post>` : ""}`;
        await dmEmail(OPS_ALERT_EMAIL, text);
        if (s.postedBy && !(await isSameUser(s.postedBy, OPS_ALERT_EMAIL))) await dm(s.postedBy, text);
        await updateSlotFields(s.id, { unclaimedAlertAt: now });
      } else {
        const c = byClaim.get(n.claimId)!;
        const s = bySlot.get(c.slotId)!;
        const when = n.kind === "reminder_day_before" ? "tomorrow" : "in an hour";
        const leave = c.route === "early_finish" ? ` You're leaving at ${s.leaveEarlyAt}.` : "";
        await dm(c.userId, `:alarm_clock: Reminder: you're on *${slotLine(s)}* ${when}.${leave}`);
        await updateClaimFields(c.id, n.kind === "reminder_day_before" ? { reminderDayBeforeAt: now } : { reminderHourBeforeAt: now });
      }
      out.nudges++;
    }, { nudge: n });
  }

  // 3. Month-end summary to Sam, the Monday before pay day.
  const runId = payRunDue(now, summaryDay);
  if (runId && !timeUp()) {
    await attempt("payrun", async () => {
      if (await getPayRun(runId)) return;
      const payable = payableClaims(await unpaidCompletedClaims());
      const run = await createPayRun(runId, payable, now);
      if (!run) return;
      const msg = payRunBlocks(run, payable, payRunLinks(APPROVER_EMAIL, run.id), "sam");
      await dmEmail(APPROVER_EMAIL, msg.text, msg.blocks);
      out.payRun = runId;
    }, { runId });
  }

  // 4. Monday round-up in the channel, once a week from 8am.
  const week = roundupDue(now);
  if (week && !timeUp()) {
    await attempt("roundup", async () => {
      const key = `roundup_${week}`;
      if (await getMeta(key)) return;
      const msg = roundupMessage(slotsInWeek(slots, week), claims);
      await slack("chat.postMessage", { channel: overtimeChannel(), ...msg });
      await setMeta(key, { postedAt: now });
      out.nudges++;
    }, { week });
  }

  // 5. Team calendar catch-up: anything changed since it was last written (also fills it in the first time).
  if (teamCalendarId()) {
    for (const s of slots.filter((s) => (s.teamCalendarSyncedAt ?? -1) < s.updatedAt)) {
      if (timeUp()) break;
      await attempt("team_calendar", () => syncTeamCalendar(s.id), { slotId: s.id });
    }
  }

  await setMeta("tick", { lastRunAt: now, lastFailures: out.failures, lastIncomplete: out.incomplete, ...(out.failures === 0 ? { lastSuccessAt: now } : {}) });
  return out;
}

const userEmailCache = new Map<string, string>();
async function isSameUser(userId: string, email: string): Promise<boolean> {
  if (!userEmailCache.has(email)) {
    const { userIdForEmail } = await import("./slack");
    userEmailCache.set(email, await userIdForEmail(email));
  }
  return userEmailCache.get(email) === userId;
}
