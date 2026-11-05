/**
 * What happens around each change: Slack messages, calendar events, DMs.
 * The database change itself has already succeeded by the time these run. Each side effect
 * is tried separately; a failure is reported to Sentry and recorded on the claim, never swallowed.
 */
import { deleteEvent, isBusy, upsertEvent } from "./calendar";
import { appUrl, report } from "./report";
import { calendarWindow } from "./rules";
import { dm, dmEmail, overtimeChannel, slack } from "./slack";
import { OPS_ALERT_EMAIL } from "./staff";
import { claimsForSlot, claimsForUser, getSlot, liveSlots, updateClaimFields, updateSlotFields, type Actor } from "./store";
import type { Claim, Slot } from "./types";
import { claimConfirmation, homeView, slotLine, slotMessage } from "./views";

export async function postSlotToChannel(slot: Slot): Promise<Slot> {
  const msg = slotMessage(slot, [], appUrl());
  const res = await slack<{ ts: string; channel: string }>("chat.postMessage", { channel: overtimeChannel(), ...msg });
  await updateSlotFields(slot.id, { channel: res.channel, messageTs: res.ts });
  return { ...slot, channel: res.channel, messageTs: res.ts };
}

export async function refreshSlotMessage(slotId: string) {
  const slot = await getSlot(slotId);
  if (!slot?.channel || !slot.messageTs) return;
  const claims = await claimsForSlot(slotId);
  await slack("chat.update", { channel: slot.channel, ts: slot.messageTs, ...slotMessage(slot, claims, appUrl()) });
}

export async function permalink(slot: Slot): Promise<string | null> {
  if (!slot.channel || !slot.messageTs) return null;
  const r = await slack<{ permalink: string }>("chat.getPermalink", { channel: slot.channel, message_ts: slot.messageTs });
  return r.permalink;
}

async function safe(context: string, fn: () => Promise<unknown>, extra: Record<string, unknown> = {}) {
  try {
    await fn();
  } catch (err) {
    report(err, context, extra);
  }
}

async function syncCalendar(slot: Slot, claim: Claim) {
  try {
    const id = await upsertEvent(slot, claim, appUrl());
    await updateClaimFields(claim.id, { calendarEventId: id, calendarError: null });
  } catch (err) {
    report(err, "calendar.upsert", { claimId: claim.id });
    await updateClaimFields(claim.id, { calendarError: String((err as Error).message ?? err).slice(0, 300) });
    await safe("dm.calendar_failed", () => dm(claim.userId, `:warning: I couldn't add *${slotLine(slot)}* to your Google Calendar. You're still booked on it, so please add it yourself.`));
  }
}

async function removeCalendar(claim: Claim) {
  try {
    await deleteEvent(claim);
    await updateClaimFields(claim.id, { calendarEventId: null, calendarError: null });
  } catch (err) {
    report(err, "calendar.delete", { claimId: claim.id });
    await updateClaimFields(claim.id, { calendarError: `delete failed: ${String((err as Error).message ?? err).slice(0, 280)}` });
  }
}

export async function afterClaim(slot: Slot, claim: Claim) {
  let busy = false;
  await safe("calendar.freebusy", async () => {
    const w = calendarWindow(slot, claim.route);
    busy = await isBusy(claim.email, w.startAt, w.endAt);
  });
  await Promise.all([
    syncCalendar(slot, claim),
    safe("slack.refresh", () => refreshSlotMessage(slot.id)),
    safe("dm.claim_confirm", () => dm(claim.userId, claimConfirmation(slot, claim, busy))),
  ]);
  await safe("home.publish", () => publishHome(claim.userId));
}

export async function afterWithdraw(slot: Slot, claim: Claim, late: boolean, actor: Actor) {
  await Promise.all([removeCalendar(claim), safe("slack.refresh", () => refreshSlotMessage(slot.id))]);
  await safe("dm.withdraw_confirm", () => dm(claim.userId, `You've withdrawn from *${slotLine(slot)}*. It's off your calendar.`));
  if (late) {
    await safe("slack.late_repost", () => repostSlot(slot, `:rotating_light: *Back up for grabs* (${actor.name} can't make it): ${slotLine(slot)}`));
    await safe("dm.late_withdraw_alert", async () => {
      const link = await permalink(slot);
      await dmEmail(OPS_ALERT_EMAIL, `:rotating_light: ${actor.name} has dropped out of *${slotLine(slot)}* (less than 48 hours to go). It's been reposted in the channel.${link ? ` <${link}|View post>` : ""}`);
    });
  }
  await safe("home.publish", () => publishHome(claim.userId));
}

export async function afterEdit(slot: Slot, claims: Claim[], actor: Actor) {
  await safe("slack.refresh", () => refreshSlotMessage(slot.id));
  for (const c of claims) {
    await syncCalendar(slot, c);
    if (c.userId !== actor.userId)
      await safe("dm.slot_changed", () =>
        dm(c.userId, `:pencil2: ${actor.name} changed a slot you're on. It's now: *${slotLine(slot)}*${c.route === "early_finish" ? ` (leaving ${slot.leaveEarlyAt})` : ""}. Your calendar has been updated.`),
      );
  }
}

export async function afterCancel(slot: Slot, claims: Claim[], actor: Actor) {
  await safe("slack.refresh", () => refreshSlotMessage(slot.id));
  for (const c of claims) {
    await removeCalendar(c);
    await safe("dm.slot_cancelled", () => dm(c.userId, `:x: ${actor.name} cancelled *${slotLine(slot)}*. It's been taken off your calendar, and nothing is owed for it.`));
    await safe("home.publish", () => publishHome(c.userId));
  }
}

/** Post a reminder in the slot's thread and show it in the channel. */
export async function repostSlot(slot: Slot, text: string) {
  if (!slot.channel || !slot.messageTs) {
    await slack("chat.postMessage", { channel: overtimeChannel(), text });
    return;
  }
  await slack("chat.postMessage", { channel: slot.channel, thread_ts: slot.messageTs, reply_broadcast: true, text });
}

export async function publishHome(userId: string, actor?: Actor | null) {
  const { actorFor } = await import("./slack");
  const who = actor ?? (await actorFor(userId));
  if (!who) {
    await slack("views.publish", {
      user_id: userId,
      view: { type: "home", blocks: [{ type: "section", text: { type: "mrkdwn", text: "This app is for the FOMO London team's overtime. Ask Sam if you should be on it." } }] },
    });
    return;
  }
  const now = Date.now();
  const [mine, open] = await Promise.all([claimsForUser(userId), liveSlots(now)]);
  await slack("views.publish", { user_id: userId, view: homeView({ name: who.name, admin: who.admin, appUrl: appUrl(), mine, openSlots: open, now }) });
}
