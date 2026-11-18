/** Slack interaction handling: buttons, forms and the /overtime command. */
import { after } from "next/server";
import {
  afterCancel, afterClaim, afterEdit, afterSwap, afterWithdraw, cancelFreelancerInvite, payRunLinks, postSlotToChannel, publishHome, refreshSlot,
  sendFreelancerInvite, syncTeamCalendar,
} from "./actions";
import { report } from "./report";
import { isLateWithdrawal, money, offersEarlyFinish, parseFee, type ClaimRefusal } from "./rules";
import { actorFor, dm, dmEmail, slack } from "./slack";
import { APPROVER_EMAIL, PAYROLL_SENDER_EMAIL } from "./staff";
import {
  acceptOffer, approvePayRun, assignFreelancer, cancelSlot, claimSlot, claimsForSlot, removeFreelancer, claimsByIds, claimsForUser, createSlot, declineOffer, editSlot, getClaim, getSlot,
  CLASH_WARNING, ClashError, markPayRunSent, offerClaim, UserError, withdrawClaim, type Actor,
} from "./store";
import { londonParts, monthLabel, prettyDate } from "./time";
import type { Route, Slot, SlotInput } from "./types";
import { assignModal, giveModal, offerMessage, unassignModal, payRunBlocks, readSlotForm, routeModal, slotLine, slotModal } from "./views";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Payload = Record<string, any>;

const NOT_STAFF = "Sorry, overtime is only for the FOMO London team. Ask Sam if you should be on it.";

export const REFUSAL_TEXT: Record<ClaimRefusal | "missing", string> = {
  missing: "That slot no longer exists.",
  not_open: "That slot has been cancelled or has already happened.",
  full: "Too late, someone else just claimed the last space.",
  started: "That slot has already started.",
  already_claimed: "You've already claimed this one.",
  clash: CLASH_WARNING,
};

/** Private reply to whoever pressed the button. `replace` overwrites the private message the button was on. */
async function tell(p: Payload, text: string, blocks?: unknown[], replace = false) {
  if (p.response_url) {
    const res = await fetch(p.response_url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ response_type: "ephemeral", replace_original: replace, text, ...(blocks ? { blocks } : {}) }),
    });
    if (!res.ok) throw new Error(`response_url ${res.status}`);
    return;
  }
  await dm(p.user.id, text, blocks);
}

function noticeModal(title: string, text: string) {
  return { type: "modal", title: { type: "plain_text", text: title }, close: { type: "plain_text", text: "Close" }, blocks: [{ type: "section", text: { type: "plain_text", text } }] };
}

/** Shown in place of the Paid / work-the-time form when the slot overlaps overtime they already have. */
export function clashConfirmModal(slot: Slot, route: Route, other: Slot | null) {
  return {
    type: "modal",
    callback_id: "clash_confirm",
    private_metadata: `${slot.id}|${route}`,
    title: { type: "plain_text", text: "Already booked" },
    submit: { type: "plain_text", text: "Yes, claim both" },
    close: { type: "plain_text", text: "No, leave it" },
    blocks: [
      {
        type: "section",
        text: { type: "mrkdwn", text: `:warning: ${CLASH_WARNING}${other ? `\nAlready booked: *${slotLine(other)}*` : ""}\nThis one: *${slotLine(slot)}*` },
      },
    ],
  };
}

/** Overlap warning (Jamie, 18 Nov 2026): the person can confirm and take both slots. */
export function clashWarningBlocks(text: string, confirm: { actionId: string; value: string; label: string }, cancel: { actionId: string; value: string; label: string }) {
  return [
    { type: "section", text: { type: "mrkdwn", text: `:warning: ${text}` } },
    {
      type: "actions",
      elements: [
        { type: "button", style: "primary", text: { type: "plain_text", text: confirm.label }, action_id: confirm.actionId, value: confirm.value },
        { type: "button", text: { type: "plain_text", text: cancel.label }, action_id: cancel.actionId, value: cancel.value },
      ],
    },
  ];
}

function todayLondon() {
  return londonParts(Date.now()).date;
}

async function doClaim(p: Payload, actor: Actor, slotId: string, route: Route, clashConfirmed = false) {
  const r = await claimSlot(slotId, actor, route, Date.now(), clashConfirmed);
  if (!r.ok) {
    if (r.reason === "clash") {
      const other = r.clashWith ? await getSlot(r.clashWith) : null;
      const text = `${CLASH_WARNING}${other ? `\nAlready booked: *${slotLine(other)}*` : ""}${r.slot ? `\nThis one: *${slotLine(r.slot)}*` : ""}`;
      await tell(
        p,
        text.replace(/\*/g, ""),
        clashWarningBlocks(text, { actionId: "claim_anyway", value: `${slotId}|${route}`, label: "Yes, claim both" }, { actionId: "claim_anyway_no", value: slotId, label: "No, leave it" }),
      );
      return;
    }
    await tell(p, REFUSAL_TEXT[r.reason], undefined, clashConfirmed);
    return;
  }
  if (clashConfirmed) await tell(p, `:white_check_mark: You're on both. *${slotLine(r.slot)}* is yours too.`, undefined, true);
  await afterClaim(r.slot, r.claim);
}

async function handleBlockAction(p: Payload) {
  const action = p.actions?.[0];
  if (!action) return;
  const userId: string = p.user.id;
  if (action.action_id === "admin_link") return;
  const actor = await actorFor(userId);
  if (!actor) return tell(p, NOT_STAFF);

  try {
    switch (action.action_id) {
      case "open_post":
        await slack("views.open", { trigger_id: p.trigger_id, view: slotModal(null, todayLondon()) });
        return;
      case "claim": {
        const slot = await getSlot(action.value);
        if (!slot) return tell(p, REFUSAL_TEXT.missing);
        if (offersEarlyFinish(slot)) {
          // Paid slot: ask whether they want the pay or to work the time instead.
          await slack("views.open", { trigger_id: p.trigger_id, view: routeModal(slot) });
          return;
        }
        after(() => doClaim(p, actor, slot.id, "paid").catch((e) => report(e, "claim", { slotId: slot.id })));
        return;
      }
      case "claim_anyway": {
        const [slotId, route] = String(action.value).split("|");
        after(() =>
          doClaim(p, actor, slotId, route === "early_finish" ? "early_finish" : "paid", true).catch(async (e) => {
            report(e, "claim_anyway", { slotId });
            await tell(p, "Something went wrong claiming. Please try again, or message Sam.").catch((e2) => report(e2, "claim_anyway.tell"));
          }),
        );
        return;
      }
      case "claim_anyway_no":
        await tell(p, "OK, you haven't claimed it.", undefined, true);
        return;
      case "withdraw": {
        const slotId = action.value;
        after(async () => {
          try {
            const now = Date.now();
            const { slot, claim } = await withdrawClaim(slotId, actor, now);
            await afterWithdraw(slot, claim, isLateWithdrawal(slot.startAt, now), actor);
          } catch (e) {
            if (e instanceof UserError) await tell(p, e.message);
            else {
              report(e, "withdraw", { slotId });
              await tell(p, "Something went wrong withdrawing. Please try again, or message Sam.");
            }
          }
        });
        return;
      }
      case "give_away": {
        const slot = await getSlot(action.value);
        if (!slot) return tell(p, REFUSAL_TEXT.missing);
        const mine = await getClaim(`${slot.id}_${actor.userId}`);
        if (!mine || mine.status !== "confirmed") return tell(p, "You haven't claimed this slot, so there's nothing to give away.");
        await slack("views.open", { trigger_id: p.trigger_id, view: giveModal(slot) });
        return;
      }
      case "swap_accept":
      case "swap_accept_anyway":
      case "swap_decline": {
        const [slotId, fromUserId] = String(action.value).split("|");
        const accept = action.action_id !== "swap_decline";
        const clashConfirmed = action.action_id === "swap_accept_anyway";
        after(async () => {
          const done = (text: string, blocks?: unknown[]) =>
            slack("chat.update", { channel: p.channel.id, ts: p.message.ts, text: text.replace(/\*/g, ""), blocks: blocks ?? [{ type: "section", text: { type: "mrkdwn", text } }] });
          try {
            if (accept) {
              const { slot, oldClaim, claim } = await acceptOffer(slotId, fromUserId, actor, Date.now(), clashConfirmed);
              await done(`:white_check_mark: You've taken *${slotLine(slot)}* from ${oldClaim.name}.`);
              await afterSwap(slot, oldClaim, claim);
            } else {
              const c = await declineOffer(slotId, fromUserId, actor);
              const slot = await getSlot(slotId);
              await done(`You said no thanks to ${c.name}'s slot.`);
              await dm(fromUserId, `${actor.name} can't take *${slot ? slotLine(slot) : c.slotLabel}*, so you're still on it. You can offer it to someone else, or Withdraw.`);
            }
          } catch (e) {
            if (e instanceof ClashError) {
              const slot = await getSlot(slotId);
              const text = `${e.message}${slot ? `\nThis one: *${slotLine(slot)}*` : ""}`;
              await done(
                text,
                clashWarningBlocks(text, { actionId: "swap_accept_anyway", value: action.value, label: "Yes, take it" }, { actionId: "swap_decline", value: action.value, label: "No thanks" }),
              );
            } else if (e instanceof UserError) await done(e.message);
            else {
              report(e, accept ? "swap.accept" : "swap.decline", { slotId, fromUserId });
              await tell(p, "Something went wrong. Please try again, or message Sam.");
            }
          }
        });
        return;
      }
      case "manage": {
        const [verb, slotId] = String(action.selected_option?.value ?? "").split(":");
        const slot = await getSlot(slotId);
        if (!slot) return tell(p, REFUSAL_TEXT.missing);
        if (!actor.admin && slot.postedBy !== actor.userId) return tell(p, "Only the person who posted it, Sam or Jamie can change this slot.");
        if (verb === "edit") await slack("views.open", { trigger_id: p.trigger_id, view: slotModal(slot, slot.date) });
        if (verb === "assign") await slack("views.open", { trigger_id: p.trigger_id, view: assignModal(slot) });
        if (verb === "unassign") {
          const freelancers = (await claimsForSlot(slot.id, ["confirmed"])).filter((c) => c.freelancer);
          if (!freelancers.length) return tell(p, "There's no freelancer on this slot.");
          await slack("views.open", { trigger_id: p.trigger_id, view: unassignModal(slot, freelancers) });
        }
        if (verb === "cancel")
          await slack("views.open", {
            trigger_id: p.trigger_id,
            view: {
              type: "modal",
              callback_id: "cancel_confirm",
              private_metadata: slot.id,
              title: { type: "plain_text", text: "Cancel slot?" },
              submit: { type: "plain_text", text: "Cancel slot" },
              close: { type: "plain_text", text: "Keep it" },
              blocks: [
                {
                  type: "section",
                  text: {
                    type: "mrkdwn",
                    text: `*${slotLine(slot)}*\n\nAnyone who claimed it will be told, and it comes off their calendar.`,
                  },
                },
              ],
            },
          });
        return;
      }
      case "payrun_approve": {
        if (actor.email !== APPROVER_EMAIL && !actor.admin) return tell(p, "Only Sam can approve this.");
        after(async () => {
          try {
            const run = await approvePayRun(action.value, actor);
            const claims = await claimsByIds(run.claimIds);
            await slack("chat.update", {
              channel: p.channel.id,
              ts: p.message.ts,
              text: "Approved. Sent to Jamie.",
              blocks: [
                {
                  type: "section",
                  text: { type: "mrkdwn", text: `:white_check_mark: You approved overtime for ${monthLabel(run.id)} payroll (${money(run.totalPence)}). It's with Jamie now.` },
                },
              ],
            });
            const forJamie = payRunBlocks(run, claims, payRunLinks(PAYROLL_SENDER_EMAIL, run.id), "jamie");
            await dmEmail(PAYROLL_SENDER_EMAIL, forJamie.text, forJamie.blocks);
          } catch (e) {
            if (e instanceof UserError) await tell(p, e.message);
            else {
              report(e, "payrun.approve", { run: action.value });
              await tell(p, "Something went wrong approving. Please try again.");
            }
          }
        });
        return;
      }
      case "payrun_sent": {
        if (actor.email !== PAYROLL_SENDER_EMAIL && !actor.admin) return tell(p, "Only Jamie can mark this as sent.");
        after(async () => {
          try {
            const run = await markPayRunSent(action.value, actor);
            const claims = await claimsByIds(run.claimIds);
            await slack("chat.update", { channel: p.channel.id, ts: p.message.ts, ...payRunBlocks(run, claims, payRunLinks(actor.email, run.id), "done") });
            await dmEmail(APPROVER_EMAIL, `:white_check_mark: ${actor.name} has sent ${monthLabel(run.id)} overtime (${money(run.totalPence)}) to payroll. All marked paid.`);
          } catch (e) {
            if (e instanceof UserError) await tell(p, e.message);
            else {
              report(e, "payrun.sent", { run: action.value });
              await tell(p, "Something went wrong. Please try again.");
            }
          }
        });
        return;
      }
    }
  } catch (e) {
    report(e, `action.${action.action_id}`);
    await tell(p, "Something went wrong. Please try again, or message Sam.");
  }
}

/** Returns the JSON body Slack expects for a view_submission (errors or close). */
async function handleViewSubmission(p: Payload): Promise<Record<string, unknown> | null> {
  const view = p.view;
  const actor = await actorFor(p.user.id);
  if (!actor) return { response_action: "errors", errors: { title: NOT_STAFF } };

  if (view.callback_id === "slot_form") {
    const f = readSlotForm(view.state.values);
    if (!f.startTime) return { response_action: "errors", errors: { startTime: "Type a time like 05:40 or 17:35." } };
    if (f.leaveEarlyAtRaw && !f.leaveEarlyAt) return { response_action: "errors", errors: { leaveEarlyAt: "Type a time like 15:30, or leave it blank." } };
    const feePence = parseFee(f.feeRaw);
    if (feePence === null) return { response_action: "errors", errors: { fee: "Type a number of pounds, e.g. 25, or Free." } };
    const input: SlotInput = {
      kind: f.kind, title: f.title, rentmanJob: f.rentmanJob, details: f.details, date: f.date, startTime: f.startTime,
      endTime: f.endTime, feePence, spaces: f.spaces, leaveEarlyAt: f.leaveEarlyAt,
    };
    const editingId: string = view.private_metadata;
    try {
      if (editingId) {
        const { slot, claims } = await editSlot(editingId, input, actor);
        after(() => afterEdit(slot, claims, actor).catch((e) => report(e, "afterEdit", { slotId: slot.id })));
      } else {
        const slot = await createSlot(input, actor);
        after(async () => {
          try {
            await postSlotToChannel(slot);
            await syncTeamCalendar(slot.id).catch((e) => report(e, "team_calendar.sync", { slotId: slot.id }));
          } catch (e) {
            report(e, "post_to_channel", { slotId: slot.id });
            await dm(actor.userId, `:warning: Your slot was saved but I couldn't post it in the channel: ${slotLine(slot)}. Please tell Jamie.`);
          }
        });
      }
      return null;
    } catch (e) {
      if (e instanceof UserError) return { response_action: "errors", errors: { title: e.message } };
      report(e, "slot_form");
      return { response_action: "errors", errors: { title: "Something went wrong saving. Please try again." } };
    }
  }

  if (view.callback_id === "route_form" || view.callback_id === "clash_confirm") {
    const confirming = view.callback_id === "clash_confirm";
    const [slotId, savedRoute] = String(view.private_metadata).split("|");
    const route = (confirming ? savedRoute : view.state.values.route?.v?.selected_option?.value ?? "paid") as Route;
    const r = await claimSlot(slotId, actor, route, Date.now(), confirming);
    if (!r.ok && r.reason === "clash" && r.slot) {
      const other = r.clashWith ? await getSlot(r.clashWith) : null;
      return { response_action: "update", view: clashConfirmModal(r.slot, route, other) };
    }
    if (!r.ok && confirming) return { response_action: "update", view: noticeModal("Can't claim", REFUSAL_TEXT[r.reason]) };
    if (!r.ok) return { response_action: "errors", errors: { route: REFUSAL_TEXT[r.reason] } };
    after(() => afterClaim(r.slot, r.claim).catch((e) => report(e, "afterClaim", { claimId: r.claim.id })));
    return null;
  }

  if (view.callback_id === "give_form") {
    const toId: string | undefined = view.state.values.to?.v?.selected_user;
    if (!toId) return { response_action: "errors", errors: { to: "Pick a colleague." } };
    const to = await actorFor(toId);
    if (!to) return { response_action: "errors", errors: { to: "They're not on the overtime list. Ask Sam if they should be." } };
    try {
      const { slot, claim } = await offerClaim(view.private_metadata, actor, to);
      after(async () => {
        try {
          const msg = offerMessage(slot, claim);
          await dm(to.userId, msg.text, msg.blocks);
          await dm(actor.userId, `I've offered *${slotLine(slot)}* to ${to.name}. You're still on it until they accept, and I'll tell you when they reply.`);
        } catch (e) {
          report(e, "swap.offer_dm", { slotId: slot.id });
          await dm(actor.userId, `:warning: I couldn't message ${to.name} about your slot. You're still on it. Please try again or tell Jamie.`).catch((e2) => report(e2, "swap.offer_dm_fallback"));
        }
      });
      return null;
    } catch (e) {
      if (e instanceof UserError) return { response_action: "errors", errors: { to: e.message } };
      report(e, "give_form");
      return { response_action: "errors", errors: { to: "Something went wrong. Please try again." } };
    }
  }

  if (view.callback_id === "assign_form" || view.callback_id === "unassign_form") {
    const assigning = view.callback_id === "assign_form";
    try {
      const r = assigning
        ? await assignFreelancer(view.private_metadata, view.state.values.name?.v?.value ?? "", actor, Date.now(), view.state.values.email?.v?.value ?? "")
        : { ...(await removeFreelancer(view.state.values.who?.v?.selected_option?.value ?? "", actor)), updated: false };
      const { slot, claim } = r;
      after(async () => {
        if (!r.updated) await refreshSlot(slot.id);
        let text: string;
        if (!assigning) {
          await cancelFreelancerInvite(claim);
          text = `${claim.name} is off *${slotLine(slot)}*, and the space is open again.${claim.email ? " Their calendar invite has been cancelled." : ""}`;
        } else if (claim.email) {
          const sent = await sendFreelancerInvite(slot, claim, actor.userId);
          text = `:busts_in_silhouette: ${claim.name} (freelancer) is down for *${slotLine(slot)}*.${sent ? ` A calendar invite has gone to ${claim.email} from your calendar.` : ""} They're paid outside the overtime payroll.`;
        } else {
          text = `:busts_in_silhouette: ${claim.name} (freelancer) is down for *${slotLine(slot)}*. They won't get reminders or an invite, so please make sure they know (or assign them again with their email to send one). They're paid outside the overtime payroll.`;
        }
        await dm(actor.userId, text).catch((e) => report(e, "dm.freelancer_confirm", { slotId: slot.id }));
      });
      return null;
    } catch (e) {
      const field = assigning ? "name" : "who";
      if (e instanceof UserError) return { response_action: "errors", errors: { [field]: e.message } };
      report(e, view.callback_id);
      return { response_action: "errors", errors: { [field]: "Something went wrong. Please try again." } };
    }
  }

  if (view.callback_id === "cancel_confirm") {
    try {
      const { slot, claims } = await cancelSlot(view.private_metadata, actor);
      after(() => afterCancel(slot, claims, actor).catch((e) => report(e, "afterCancel", { slotId: slot.id })));
      return null;
    } catch (e) {
      if (e instanceof UserError) return { response_action: "push", view: { type: "modal", title: { type: "plain_text", text: "Can't cancel" }, blocks: [{ type: "section", text: { type: "plain_text", text: e.message } }] } };
      throw e;
    }
  }
  return null;
}

export async function handleInteraction(p: Payload): Promise<Record<string, unknown> | null> {
  if (p.type === "block_actions") {
    await handleBlockAction(p);
    return null;
  }
  if (p.type === "view_submission") return handleViewSubmission(p);
  return null;
}

/** /overtime → post form. /overtime me → your summary. */
export async function handleCommand(form: URLSearchParams): Promise<Record<string, unknown>> {
  const userId = form.get("user_id") ?? "";
  const text = (form.get("text") ?? "").trim().toLowerCase();
  const actor = await actorFor(userId);
  if (!actor) return { response_type: "ephemeral", text: NOT_STAFF };
  if (text === "me" || text === "mine") {
    const now = Date.now();
    const mine = await claimsForUser(userId);
    const upcoming = mine.filter((c) => c.status === "confirmed" && c.endAt > now);
    const month = londonParts(now).date.slice(0, 7);
    const earned = mine
      .filter((c) => c.date.startsWith(month) && !c.flagged && (c.status === "completed" || (c.status === "confirmed" && c.endAt <= now)))
      .reduce((n, c) => n + c.amountPence, 0);
    after(() => publishHome(userId, actor).catch((e) => report(e, "home.publish")));
    return {
      response_type: "ephemeral",
      text: [
        `*${monthLabel(month)} so far:* ${earned ? money(earned) : "£0"}`,
        upcoming.length ? `*Coming up:*\n${upcoming.map((c) => `• ${prettyDate(c.date)} · ${c.slotLabel}`).join("\n")}` : "Nothing booked.",
        "More detail on the overtime app's *Home* tab.",
      ].join("\n"),
    };
  }
  const trigger = form.get("trigger_id");
  await slack("views.open", { trigger_id: trigger, view: slotModal(null, londonParts(Date.now()).date) });
  return { response_type: "ephemeral", text: "" };
}

export { publishHome };
