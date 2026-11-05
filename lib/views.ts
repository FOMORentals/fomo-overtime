/** Slack Block Kit layouts. Pure functions (tested in views.test.ts). */
import { money, offersEarlyFinish, pairedSlotWarnings, spacesLeft, totalsByPerson } from "./rules";
import { londonParts, monthLabel, prettyDate } from "./time";
import { SLOT_KINDS, type Claim, type PayRun, type Slot } from "./types";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Block = Record<string, any>;

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function timeRange(s: Pick<Slot, "startTime" | "endTime">) {
  return `${s.startTime}–${s.endTime}`;
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
  if (offersEarlyFinish(s)) lines.push(`:sunrise: Option to work through and *leave at ${s.leaveEarlyAt}* instead of being paid.`);
  const who = active.map((c) => `<@${c.userId}>${c.route === "early_finish" ? ` (leaving ${s.leaveEarlyAt})` : ""}`).join(", ");
  const left = spacesLeft(s);
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
    if (active.length) elements.push({ type: "button", text: { type: "plain_text", text: "Withdraw" }, action_id: "withdraw", value: s.id });
    elements.push({
      type: "overflow",
      action_id: "manage",
      options: [
        { text: { type: "plain_text", text: "Edit" }, value: `edit:${s.id}` },
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
        options: SLOT_KINDS.map((k) => opt(k)),
        initial_option: opt(v?.kind ?? "Early opening"),
      }),
      input("title", "Client / job", { type: "plain_text_input", initial_value: v?.title ?? "", placeholder: { type: "plain_text", text: "e.g. Andrew Berekdar" } }),
      input("rentmanJob", "Rentman job number", { type: "plain_text_input", initial_value: v?.rentmanJob ?? "" }, true),
      input("date", "Date", { type: "datepicker", initial_date: v?.date ?? defaultDate }),
      input("startTime", "Start", { type: "timepicker", initial_time: v?.startTime ?? "07:00" }),
      input("endTime", "End", { type: "timepicker", initial_time: v?.endTime ?? "07:30" }, false, "An end time earlier than the start means it runs past midnight."),
      input("fee", "Fee", { type: "plain_text_input", initial_value: v ? (v.feePence ? String(v.feePence / 100) : "Free") : "25" }, false, "Pounds, e.g. 25, or Free"),
      input("spaces", "People needed", { type: "number_input", is_decimal_allowed: false, min_value: "1", max_value: "10", initial_value: String(v?.spaces ?? 1) }),
      input(
        "leaveEarlyAt",
        "Leave-early option",
        { type: "timepicker", ...(v?.leaveEarlyAt ? { initial_time: v.leaveEarlyAt } : {}) },
        true,
        "Only for slots before 9am: the time they can leave if they choose to work through instead of being paid.",
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
    rentmanJob: (g("rentmanJob")?.value ?? "").trim().replace(/^#/, ""),
    details: (g("details")?.value ?? "").trim(),
    date: g("date")?.selected_date ?? "",
    startTime: g("startTime")?.selected_time ?? "",
    endTime: g("endTime")?.selected_time ?? "",
    feeRaw: g("fee")?.value ?? "",
    spaces: Number(g("spaces")?.value ?? 1),
    leaveEarlyAt: g("leaveEarlyAt")?.selected_time || null,
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
              text: { type: "mrkdwn", text: `*Leave early*: work through from ${s.startTime} and leave at *${s.leaveEarlyAt}*, no extra pay` },
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
  if (c.route === "early_finish") parts.push(`You chose to work through and *leave at ${s.leaveEarlyAt}* (no extra pay).`);
  else if (c.amountPence > 0) parts.push(`${money(c.amountPence)} will be added to your overtime for ${monthLabel(s.date.slice(0, 7))}.`);
  parts.push("It's in your Google Calendar, and I'll remind you at 5pm the day before.");
  if (calendarBusy) parts.push(":warning: Heads up: your calendar already has something else at that time.");
  parts.push("Can't make it? Press *Withdraw* on the post. Up to 48 hours before is fine; after that Sam gets told.");
  return parts.join("\n");
}

function claimLine(c: Claim, showPay = true) {
  const p = londonParts(c.startAt);
  const pay = c.route === "early_finish" ? "leave early" : money(c.amountPence);
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
