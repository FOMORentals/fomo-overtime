/** Slack Block Kit layouts. Pure functions (tested in views.test.ts). */
import { money, offersEarlyFinish, pairedSlotWarnings, spacesLeft, timeInsteadLabel, totalsByPerson } from "./rules";
import { addMinutesToTime, londonParts, monthLabel, parseTime, prettyDate } from "./time";
import { SLOT_KINDS, SLOT_MINUTES, type Claim, type PayRun, type Slot } from "./types";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Block = Record<string, any>;

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Slots are a single time now (Sam, 6 Nov). */
export function timeRange(s: Pick<Slot, "startTime">) {
  return s.startTime;
}

/** One line, like the old Slack posts: "EARLY OPENING · Tue 10 Nov · 05:40–06:10 · £50 · Andrew Berekdar · 11887" */
export function slotLine(s: Slot): string {
  return [s.kind.toUpperCase(), prettyDate(s.date), timeRange(s), money(s.feePence), esc(s.title), s.rentmanJob ? `#${s.rentmanJob}` : ""]
    .filter(Boolean)
    .join(" · ");
}

export function slotMessage(s: Slot, claims: Claim[], appUrl: string): { text: string; blocks: Block[] } {
  const active = claims.filter((c) => c.status === "confirmed" || c.status === "completed");
  const closed = s.status === "cancelled" || s.status === "completed";
  const head = s.status === "cancelled" ? `~${slotLine(s)}~  *CANCELLED*` : `*${slotLine(s)}*`;
  const lines: string[] = [head];
  if (s.details) lines.push(esc(s.details));
  // Only while someone can still pick it: on a taken or finished slot it read as if the claim had changed (Louis, 9 Nov).
  const left = spacesLeft(s);
  if (offersEarlyFinish(s) && !closed && left > 0)
    lines.push(s.leaveEarlyAt ? `:sunrise: Option to work the time instead of being paid, and *leave at ${s.leaveEarlyAt}*.` : ":sunrise: Option to work the time instead of being paid.");
  const who = active.map((c) => `${c.freelancer ? `${esc(c.name)} (freelancer)` : `<@${c.userId}>`}${c.route === "early_finish" ? ` (${timeInsteadLabel(s)})` : ""}`).join(", ");
  let status: string;
  if (s.status === "cancelled") status = "Cancelled";
  else if (s.status === "completed") status = active.length ? `Done: ${who}` : "Done, nobody claimed it";
  else if (left === 0) status = `:white_check_mark: Covered by ${who}`;
  else status = `${active.length ? `Claimed by ${who}. ` : ""}*${left} of ${s.spaces} ${s.spaces === 1 ? "space" : "spaces"} left*`;

  const blocks: Block[] = [
    { type: "section", text: { type: "mrkdwn", text: lines.join("\n") } },
    { type: "context", elements: [{ type: "mrkdwn", text: `${status}  ·  posted by <@${s.postedBy}>` }] },
  ];
  if (!closed) {
    const elements: Block[] = [];
    if (left > 0) elements.push({ type: "button", style: "primary", text: { type: "plain_text", text: "Claim" }, action_id: "claim", value: s.id });
    if (active.length) {
      elements.push({ type: "button", text: { type: "plain_text", text: "Give away" }, action_id: "give_away", value: s.id });
      elements.push({ type: "button", text: { type: "plain_text", text: "Withdraw" }, action_id: "withdraw", value: s.id });
    }
    elements.push({
      type: "overflow",
      action_id: "manage",
      options: [
        { text: { type: "plain_text", text: "Edit" }, value: `edit:${s.id}` },
        ...(left > 0 ? [{ text: { type: "plain_text", text: "Assign to a freelancer" }, value: `assign:${s.id}` }] : []),
        ...(active.some((c) => c.freelancer) ? [{ text: { type: "plain_text", text: "Remove freelancer" }, value: `unassign:${s.id}` }] : []),
        { text: { type: "plain_text", text: "Cancel slot" }, value: `cancel:${s.id}` },
      ],
    });
    blocks.push({ type: "actions", elements });
  }
  void appUrl;
  return { text: slotLine(s).replace(/\*/g, ""), blocks };
}

function opt(text: string, value = text) {
  return { text: { type: "plain_text", text }, value };
}

export function slotModal(existing: Slot | null, defaultDate: string): Block {
  const v = existing;
  const input = (block_id: string, label: string, element: Block, optional = false, hint?: string) => ({
    type: "input",
    block_id,
    optional,
    label: { type: "plain_text", text: label },
    element: { ...element, action_id: "v" },
    ...(hint ? { hint: { type: "plain_text", text: hint } } : {}),
  });
  return {
    type: "modal",
    callback_id: "slot_form",
    private_metadata: v?.id ?? "",
    title: { type: "plain_text", text: v ? "Edit overtime" : "Post overtime" },
    submit: { type: "plain_text", text: v ? "Save" : "Post" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      input("kind", "Type", {
        type: "static_select",
        // An older slot may carry a type that's since been retired; keep it selectable when editing.
        options: [...SLOT_KINDS, ...(v && !(SLOT_KINDS as readonly string[]).includes(v.kind) ? [v.kind] : [])].map((k) => opt(k)),
        initial_option: opt(v?.kind ?? "Early opening"),
      }),
      input("title", "Client / job", { type: "plain_text_input", initial_value: v?.title ?? "", placeholder: { type: "plain_text", text: "e.g. Andrew Berekdar" } }),
      input("date", "Date", { type: "datepicker", initial_date: v?.date ?? defaultDate }),
      input("startTime", "Time", { type: "plain_text_input", initial_value: v?.startTime ?? "", placeholder: { type: "plain_text", text: "e.g. 05:40 or 17:35" } }, false, "24-hour clock, to the minute."),
      input("fee", "Fee", { type: "plain_text_input", initial_value: v ? (v.feePence ? String(v.feePence / 100) : "Free") : "25" }, false, "Pounds, e.g. 25, or Free"),
      input("spaces", "People needed", { type: "number_input", is_decimal_allowed: false, min_value: "1", max_value: "10", initial_value: String(v?.spaces ?? 1) }),
      input(
        "leaveEarlyAt",
        "Leave time if they work it (optional)",
        { type: "plain_text_input", initial_value: v?.leaveEarlyAt ?? "", placeholder: { type: "plain_text", text: "e.g. 15:30" } },
        true,
        "Anyone claiming a paid slot can choose to work the time instead of being paid. For slots before 9am you can add the time they'd leave.",
      ),
      input("details", "Notes", { type: "plain_text_input", multiline: true, initial_value: v?.details ?? "" }, true),
    ],
  };
}

/** Read the modal's submitted values. */
export function readSlotForm(values: Record<string, Record<string, any>>) {
  const g = (b: string) => values[b]?.v;
  return {
    kind: g("kind")?.selected_option?.value ?? "Other",
    title: (g("title")?.value ?? "").trim(),
    rentmanJob: "",
    details: (g("details")?.value ?? "").trim(),
    date: g("date")?.selected_date ?? "",
    startTimeRaw: (g("startTime")?.value ?? "").trim(),
    startTime: parseTime(g("startTime")?.value) ?? "",
    endTime: addMinutesToTime(parseTime(g("startTime")?.value) ?? "00:00", SLOT_MINUTES),
    feeRaw: g("fee")?.value ?? "",
    spaces: Number(g("spaces")?.value ?? 1),
    leaveEarlyAtRaw: (g("leaveEarlyAt")?.value ?? "").trim(),
    leaveEarlyAt: parseTime(g("leaveEarlyAt")?.value),
  };
}

export function routeModal(s: Slot): Block {
  return {
    type: "modal",
    callback_id: "route_form",
    private_metadata: s.id,
    title: { type: "plain_text", text: "Claim overtime" },
    submit: { type: "plain_text", text: "Claim" },
    close: { type: "plain_text", text: "Back" },
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: `*${slotLine(s)}*` } },
      {
        type: "input",
        block_id: "route",
        label: { type: "plain_text", text: "How do you want to do it?" },
        element: {
          type: "radio_buttons",
          action_id: "v",
          initial_option: { text: { type: "mrkdwn", text: `*Paid overtime* (${money(s.feePence)}): work the slot only` }, value: "paid" },
          options: [
            { text: { type: "mrkdwn", text: `*Paid overtime* (${money(s.feePence)}): work the slot only` }, value: "paid" },
            {
              text: {
                type: "mrkdwn",
                text: s.leaveEarlyAt
                  ? `*Work the time instead*: start at ${s.startTime} and leave at *${s.leaveEarlyAt}*, no extra pay`
                  : "*Work the time instead*: take the time back rather than being paid, no extra pay",
              },
              value: "early_finish",
            },
          ],
        },
      },
    ],
  };
}

export function claimConfirmation(s: Slot, c: Claim, calendarBusy: boolean): string {
  const parts = [`You're down for *${slotLine(s)}*.`];
  if (c.route === "early_finish") parts.push(s.leaveEarlyAt ? `You chose to work the time and *leave at ${s.leaveEarlyAt}* (no extra pay).` : "You chose to work the time instead of being paid (no extra pay).");
  else if (c.amountPence > 0) parts.push(`${money(c.amountPence)} will be added to your overtime for ${monthLabel(s.date.slice(0, 7))}.`);
  parts.push("It's in your Google Calendar, and I'll remind you at 5pm the day before.");
  if (calendarBusy) parts.push(":warning: Heads up: your calendar already has something else at that time.");
  parts.push("Can't make it? Press *Give away* on the post to hand it to a colleague, or *Withdraw*. Withdrawing up to 48 hours before is fine; after that Sam gets told.");
  return parts.join("\n");
}

/**
 * Bump this whenever the buttons or menu on a slot post change. The next cron run then
 * rebuilds every upcoming post, so older posts get the new options too.
 */
export const POST_LAYOUT = 3;

/** Put a freelancer (not on Slack) on a slot. */
export function assignModal(s: Slot): Block {
  return {
    type: "modal",
    callback_id: "assign_form",
    private_metadata: s.id,
    title: { type: "plain_text", text: "Assign to a freelancer" },
    submit: { type: "plain_text", text: "Assign" },
    close: { type: "plain_text", text: "Back" },
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: `*${slotLine(s)}*` } },
      {
        type: "input",
        block_id: "name",
        label: { type: "plain_text", text: "Freelancer's name" },
        element: { type: "plain_text_input", action_id: "v", placeholder: { type: "plain_text", text: "e.g. Eden" } },
        hint: { type: "plain_text", text: "Shows on the post and the team calendar. Freelancers are paid outside the overtime payroll, so this isn't counted at month end." },
      },
      {
        type: "input",
        block_id: "email",
        optional: true,
        label: { type: "plain_text", text: "Their email (for a calendar invite)" },
        element: { type: "email_text_input", action_id: "v", placeholder: { type: "plain_text", text: "eden@example.com" } },
        hint: { type: "plain_text", text: "Optional. Google sends them an invite from your calendar, plus updates if the slot changes or is cancelled." },
      },
    ],
  };
}

/** Choose which freelancer to take off a slot. */
export function unassignModal(s: Slot, freelancers: Claim[]): Block {
  return {
    type: "modal",
    callback_id: "unassign_form",
    private_metadata: s.id,
    title: { type: "plain_text", text: "Remove freelancer" },
    submit: { type: "plain_text", text: "Remove" },
    close: { type: "plain_text", text: "Back" },
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: `*${slotLine(s)}*` } },
      {
        type: "input",
        block_id: "who",
        label: { type: "plain_text", text: "Who's no longer doing it?" },
        element: {
          type: "static_select",
          action_id: "v",
          options: freelancers.map((c) => opt(c.name.slice(0, 70), c.id)),
          ...(freelancers.length === 1 ? { initial_option: opt(freelancers[0].name.slice(0, 70), freelancers[0].id) } : {}),
        },
      },
    ],
  };
}

/** Give away: pick the colleague. */
export function giveModal(s: Slot): Block {
  return {
    type: "modal",
    callback_id: "give_form",
    private_metadata: s.id,
    title: { type: "plain_text", text: "Give away" },
    submit: { type: "plain_text", text: "Offer it" },
    close: { type: "plain_text", text: "Back" },
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: `*${slotLine(s)}*` } },
      {
        type: "input",
        block_id: "to",
        label: { type: "plain_text", text: "Who are you giving it to?" },
        element: { type: "users_select", action_id: "v", placeholder: { type: "plain_text", text: "Pick a colleague" } },
        hint: { type: "plain_text", text: "They get a message to accept. You stay on it until they do." },
      },
    ],
  };
}

/** The DM a colleague gets when someone offers them a slot. */
export function offerMessage(s: Slot, from: Pick<Claim, "userId" | "name" | "route">): { text: string; blocks: Block[] } {
  const value = `${s.id}|${from.userId}`;
  const leave = from.route === "early_finish" ? ` They chose to work the time instead of being paid${s.leaveEarlyAt ? ` (leave at ${s.leaveEarlyAt})` : ""}, and you'd do the same.` : "";
  const text = `${from.name} would like to give you *${slotLine(s)}*.${leave}`;
  return {
    text: text.replace(/\*/g, ""),
    blocks: [
      { type: "section", text: { type: "mrkdwn", text } },
      {
        type: "actions",
        elements: [
          { type: "button", style: "primary", text: { type: "plain_text", text: "Take it" }, action_id: "swap_accept", value },
          { type: "button", text: { type: "plain_text", text: "No thanks" }, action_id: "swap_decline", value },
        ],
      },
    ],
  };
}

/** Monday round-up for #rentals_overtime: every slot this week and who's on it. */
export function roundupMessage(week: Slot[], claims: Claim[]): { text: string; blocks: Block[] } {
  if (!week.length) {
    const text = ":calendar: *Overtime this week:* nothing posted yet. Use `/overtime` to post a slot.";
    return { text, blocks: [{ type: "section", text: { type: "mrkdwn", text } }] };
  }
  let open = 0;
  const lines = week.map((s) => {
    const on = claims.filter((c) => c.slotId === s.id && (c.status === "confirmed" || c.status === "completed"));
    const left = Math.max(0, s.spaces - on.length);
    open += left;
    const who = on.map((c) => c.name).join(", ");
    const state = left > 0 ? `*OPEN${s.spaces > 1 ? ` (${left} of ${s.spaces})` : ""}*${who ? ` · ${who}` : ""}` : who;
    return `• ${slotLine(s)} · ${state}`;
  });
  const footer = open
    ? `:raising_hand: ${open} ${open === 1 ? "space is" : "spaces are"} still open. Press *Claim* on the post or on the Overtime app's Home tab.`
    : ":white_check_mark: Everything's covered.";
  const text = `:calendar: *Overtime this week*\n${lines.join("\n")}\n\n${footer}`;
  return { text: text.slice(0, 3000), blocks: [{ type: "section", text: { type: "mrkdwn", text: text.slice(0, 2990) } }] };
}

function claimLine(c: Claim, showPay = true) {
  const p = londonParts(c.startAt);
  const pay = c.route === "early_finish" ? "time instead" : money(c.amountPence);
  const state = c.paidRunId ? "paid" : c.flagged ? `flagged: ${c.flagReason ?? ""}` : c.status === "completed" ? "done" : "upcoming";
  return `• ${prettyDate(c.date)} ${p.time} · ${esc(c.slotLabel)}${showPay ? ` · ${pay}` : ""} · _${state}_`;
}

export function homeView(opts: {
  name: string;
  /** Signed admin-page link, only for admins. */
  adminUrl: string | null;
  mine: Claim[];
  openSlots: Slot[];
  now: number;
}): Block {
  const { mine, openSlots, now } = opts;
  const upcoming = mine.filter((c) => c.status === "confirmed" && c.endAt > now);
  const counted = mine.filter((c) => c.status === "completed" || (c.status === "confirmed" && c.endAt <= now));
  const thisMonth = londonParts(now).date.slice(0, 7);
  const months = [...new Set(counted.map((c) => c.date.slice(0, 7)))].sort().reverse().slice(0, 4);
  if (!months.includes(thisMonth)) months.unshift(thisMonth);

  const blocks: Block[] = [
    { type: "header", text: { type: "plain_text", text: `Hi ${opts.name}, here's your overtime` } },
    {
      type: "actions",
      elements: [
        { type: "button", style: "primary", text: { type: "plain_text", text: "Post overtime" }, action_id: "open_post" },
        ...(opts.adminUrl ? [{ type: "button", text: { type: "plain_text", text: "Admin page" }, url: opts.adminUrl, action_id: "admin_link" }] : []),
      ],
    },
    { type: "divider" },
    { type: "section", text: { type: "mrkdwn", text: `*Your upcoming overtime*\n${upcoming.length ? upcoming.map((c) => claimLine(c)).join("\n") : "_Nothing booked._"}` } },
    { type: "divider" },
    { type: "section", text: { type: "mrkdwn", text: "*Earnings*" } },
  ];
  for (const m of months) {
    const list = counted.filter((c) => c.date.slice(0, 7) === m && !c.flagged);
    const total = list.reduce((n, c) => n + c.amountPence, 0);
    const pending = upcoming.filter((c) => c.date.slice(0, 7) === m).reduce((n, c) => n + c.amountPence, 0);
    const extra = pending ? ` (+ ${money(pending)} booked)` : "";
    blocks.push({ type: "section", text: { type: "mrkdwn", text: `*${monthLabel(m)}*: ${total ? money(total) : "£0"}${extra}` } });
    const done = counted.filter((c) => c.date.slice(0, 7) === m);
    if (done.length) blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: done.map((c) => claimLine(c)).join("\n").slice(0, 2900) }] });
  }
  blocks.push({ type: "divider" });
  const open = openSlots.filter((s) => s.status === "open" && spacesLeft(s) > 0 && s.startAt > now).slice(0, 15);
  blocks.push({ type: "section", text: { type: "mrkdwn", text: `*Open slots*${open.length ? "" : "\n_None right now._"}` } });
  for (const s of open) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: slotLine(s) },
      accessory: { type: "button", text: { type: "plain_text", text: "Claim" }, action_id: "claim", value: s.id },
    });
  }
  return { type: "home", blocks: blocks.slice(0, 100) };
}

/** links: signed admin-page and CSV links for the person receiving the message (lib/admin-link.ts). */
export function payRunBlocks(
  run: PayRun,
  claims: Claim[],
  links: { admin: string; csv: string },
  forWho: "sam" | "jamie" | "done",
): { text: string; blocks: Block[] } {
  const totals = totalsByPerson(claims);
  const warnings = pairedSlotWarnings(claims);
  const lines = totals.map((t) => `*${t.name}: ${money(t.totalPence)}*\n${t.claims.map((c) => `   ${prettyDate(c.date)} · ${esc(c.slotLabel)} · ${money(c.amountPence)}`).join("\n")}`);
  const title = `Overtime for ${monthLabel(run.id)} payroll: ${money(run.totalPence)} total`;
  const blocks: Block[] = [
    { type: "header", text: { type: "plain_text", text: title.slice(0, 150) } },
    { type: "section", text: { type: "mrkdwn", text: (lines.join("\n\n") || "_No paid overtime to pay this month._").slice(0, 2900) } },
  ];
  if (warnings.length) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `:warning: *Check these* (two paid slots within an hour, normally only one is paid):\n${warnings
          .map((w) => `• ${w.a.name}: ${esc(w.a.slotLabel)} and ${esc(w.b.slotLabel)} on ${prettyDate(w.a.date)}`)
          .join("\n")}`.slice(0, 2900),
      },
    });
  }
  const csvUrl = links.csv;
  if (forWho === "sam") {
    blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: `Covers all finished, unpaid overtime up to now. Fix anything on the <${links.admin}|admin page> first (flag a slot to leave it out), then approve.` }] });
    blocks.push({ type: "actions", elements: [{ type: "button", style: "primary", text: { type: "plain_text", text: "Approve and send to Jamie" }, action_id: "payrun_approve", value: run.id }] });
  } else if (forWho === "jamie") {
    blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: `Approved by ${run.approvedBy}. <${csvUrl}|Download CSV> for Mark's team. Press the button once you've sent it, and everything here is marked paid.` }] });
    blocks.push({ type: "actions", elements: [{ type: "button", style: "primary", text: { type: "plain_text", text: "Sent to payroll" }, action_id: "payrun_sent", value: run.id }] });
  } else {
    blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: `:white_check_mark: Sent to payroll by ${run.sentBy}. All marked paid. <${csvUrl}|CSV>` }] });
  }
  return { text: title, blocks };
}
