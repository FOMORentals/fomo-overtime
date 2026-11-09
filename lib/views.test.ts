import { test } from "node:test";
import assert from "node:assert/strict";
import { homeView, offerMessage, payRunBlocks, readSlotForm, roundupMessage, routeModal, slotLine, slotMessage, slotModal } from "./views";
import { inviteBody, teamEventBody } from "./calendar";
import { slotInstants, londonToUtc } from "./time";
import type { Claim, Slot } from "./types";

const s: Slot = {
  kind: "Early opening", title: "Andrew Berekdar", rentmanJob: "11887", details: "Keys in the safe", date: "2026-11-10",
  startTime: "05:40", endTime: "06:10", feePence: 5000, spaces: 1, leaveEarlyAt: "15:00", id: "s1",
  ...slotInstants("2026-11-10", "05:40", "06:10"), status: "open", claimedCount: 0, postedBy: "ULOUIS", postedByName: "Louis",
  createdAt: 0, updatedAt: 0, channel: "C1", messageTs: "1.1", repostedAt: null, unclaimedAlertAt: null,
};

const claim: Claim = {
  id: "s1_U1", slotId: "s1", userId: "U1", email: "rosie@fomorentals.co.uk", name: "Rosie", route: "early_finish", amountPence: 0,
  status: "confirmed", claimedAt: 0, withdrawnAt: null, date: s.date, startAt: s.startAt, endAt: s.endAt,
  slotLabel: "Early opening · Andrew Berekdar · #11887", flagged: false, flagReason: null, paidRunId: null, calendarEventId: null,
  calendarError: null, reminderDayBeforeAt: null, reminderHourBeforeAt: null,
};

test("slot line reads like the old Slack posts", () => {
  assert.equal(slotLine(s), "EARLY OPENING · Tue 10 Nov · 05:40 · £50 · Andrew Berekdar · #11887");
});

test("open slot message has Claim and the leave-early note", () => {
  const m = slotMessage(s, [], "https://x");
  const json = JSON.stringify(m.blocks);
  assert.match(json, /"action_id":"claim"/);
  assert.match(json, /leave at 15:00/);
  assert.doesNotMatch(json, /"action_id":"withdraw"/);
});

test("covered slot shows who and offers Withdraw, not Claim", () => {
  const m = slotMessage({ ...s, claimedCount: 1, status: "full" }, [claim], "https://x");
  const json = JSON.stringify(m.blocks);
  assert.match(json, /Covered by <@U1> \(leaving at 15:00\)/);
  assert.match(json, /"action_id":"withdraw"/);
  assert.doesNotMatch(json, /"action_id":"claim"/);
});

test("cancelled slot has no buttons", () => {
  const m = slotMessage({ ...s, status: "cancelled" }, [], "https://x");
  assert.equal(m.blocks.some((b) => b.type === "actions"), false);
});

test("form round trip", () => {
  const modal = slotModal(s, s.date);
  const values: Record<string, Record<string, unknown>> = {};
  for (const b of modal.blocks) {
    const e = b.element;
    const v: Record<string, unknown> = {};
    if (e.type === "static_select") v.selected_option = e.initial_option;
    if (e.type === "plain_text_input" || e.type === "number_input") v.value = e.initial_value;
    if (e.type === "datepicker") v.selected_date = e.initial_date;
    if (e.type === "timepicker") v.selected_time = e.initial_time ?? null;
    values[b.block_id] = { v };
  }
  const f = readSlotForm(values);
  assert.deepEqual(f, {
    kind: "Early opening", title: "Andrew Berekdar", rentmanJob: "", details: "Keys in the safe", date: "2026-11-10",
    startTimeRaw: "05:40", startTime: "05:40", endTime: "06:10", feeRaw: "50", spaces: 1, leaveEarlyAtRaw: "15:00", leaveEarlyAt: "15:00",
  });
  const json = JSON.stringify(modal);
  assert.doesNotMatch(json, /rentmanJob|"endTime"|Early collection|Late return|timepicker/);
});

test("typed times to the minute", () => {
  const f = readSlotForm({ startTime: { v: { value: "5:35pm" } }, leaveEarlyAt: { v: { value: "" } } });
  assert.equal(f.startTime, "17:35");
  assert.equal(f.endTime, "18:05");
  assert.equal(f.leaveEarlyAt, null);
  assert.equal(readSlotForm({ startTime: { v: { value: "nope" } } }).startTime, "");
});

test("editing an old slot keeps its retired type selectable", () => {
  const json = JSON.stringify(slotModal({ ...s, kind: "Late return" }, s.date));
  assert.match(json, /Late return/);
});

test("route modal offers both routes", () => {
  assert.match(JSON.stringify(routeModal(s)), /early_finish/);
});

test("home view and pay run render", () => {
  const home = homeView({ name: "Rosie", adminUrl: null, mine: [claim], openSlots: [s], now: londonToUtc("2026-11-05", "12:00") });
  assert.equal(home.type, "home");
  assert.ok(home.blocks.length < 100);
  const run = { id: "2026-11", createdAt: 0, status: "awaiting_sam" as const, claimIds: ["a"], totalPence: 2500, approvedBy: null, approvedAt: null, sentBy: null, sentAt: null };
  const pr = payRunBlocks(run, [{ ...claim, route: "paid", amountPence: 2500, status: "completed" }], { admin: "https://x/a", csv: "https://x/c" }, "sam");
  assert.match(JSON.stringify(pr.blocks), /payrun_approve/);
  assert.match(pr.text, /£25 total/);
});

test("claimed slot offers Give away", () => {
  const json = JSON.stringify(slotMessage({ ...s, claimedCount: 1, status: "full" }, [claim], "https://x").blocks);
  assert.match(json, /"action_id":"give_away"/);
  assert.doesNotMatch(JSON.stringify(slotMessage(s, [], "https://x").blocks), /give_away/);
});

test("offer DM carries Take it / No thanks with the slot and giver", () => {
  const m = offerMessage(s, { userId: "U1", name: "Rosie", route: "early_finish" });
  const json = JSON.stringify(m.blocks);
  assert.match(json, /"action_id":"swap_accept","value":"s1\|U1"/);
  assert.match(json, /"action_id":"swap_decline"/);
  assert.match(m.text, /Rosie would like to give you/);
  assert.match(m.text, /leave at 15:00/);
});

test("round-up lists slots with who is on them and what is open", () => {
  const two: Slot = { ...s, id: "s2", kind: "Late closing", spaces: 2, leaveEarlyAt: null };
  const m = roundupMessage([s, two], [claim, { ...claim, id: "s2_U2", slotId: "s2", userId: "U2", name: "Louis" }]);
  assert.match(m.text, /EARLY OPENING.*· Rosie/);
  assert.match(m.text, /LATE CLOSING.*\*OPEN \(1 of 2\)\* · Louis/);
  assert.match(m.text, /1 space is still open/);
  assert.match(roundupMessage([], []).text, /nothing posted yet/);
  assert.match(roundupMessage([s], [claim]).text, /Everything's covered/);
});

test("team calendar event: red OPEN until covered, then green with names", () => {
  const open = teamEventBody(s, [], "https://x");
  assert.equal(open.summary, "OPEN · Early opening · Andrew Berekdar");
  assert.equal(open.colorId, "11");
  const covered = teamEventBody({ ...s, status: "full" }, [claim], "https://x");
  assert.equal(covered.summary, "Rosie (leaves 15:00) · Early opening · Andrew Berekdar");
  assert.equal(covered.colorId, "10");
  const part = teamEventBody({ ...s, spaces: 2 }, [{ ...claim, route: "paid" }], "https://x");
  assert.equal(part.summary, "OPEN (1 of 2) · Rosie · Early opening · Andrew Berekdar");
  assert.equal(teamEventBody({ ...s, status: "cancelled" }, [claim, { ...claim, status: "withdrawn", name: "X" }], "https://x").summary.includes("X"), false);
});

test("route choice without a leave time reads as 'work the time instead'", () => {
  const plain = { ...s, startTime: "17:35", leaveEarlyAt: null };
  assert.match(JSON.stringify(routeModal(plain)), /Work the time instead/);
  assert.match(JSON.stringify(slotMessage(plain, [], "https://x").blocks), /Option to work the time instead/);
  assert.doesNotMatch(JSON.stringify(slotMessage({ ...plain, feePence: 0 }, [], "https://x").blocks), /work the time/);
});

test("the 'work the time' option line goes once nobody can pick it (taken or done)", () => {
  const plain = { ...s, leaveEarlyAt: null, spaces: 1, claimedCount: 1 };
  const paid = { ...claim, route: "paid" as const };
  assert.doesNotMatch(JSON.stringify(slotMessage({ ...plain, status: "full" }, [paid], "https://x").blocks), /Option to work/);
  assert.doesNotMatch(JSON.stringify(slotMessage({ ...plain, status: "completed" }, [paid], "https://x").blocks), /Option to work/);
});

test("freelancers show by name, and the menu offers assign/remove", () => {
  const fl: Claim = { ...claim, id: "s1_fl_eden", userId: "freelancer:s1_fl_eden", name: "Eden", route: "paid", freelancer: true };
  const open = JSON.stringify(slotMessage({ ...s, spaces: 2, claimedCount: 1 }, [fl], "https://x").blocks);
  assert.match(open, /Eden \(freelancer\)/);
  assert.match(open, /assign:s1/);
  assert.match(open, /unassign:s1/);
  const full = JSON.stringify(slotMessage({ ...s, claimedCount: 1, status: "full" }, [fl], "https://x").blocks);
  assert.doesNotMatch(full, /"assign:s1"/);
});

test("freelancer invite: guest is the freelancer, no fee shown, from the assigner", () => {
  const fl: Claim = { ...claim, id: "s1_fl_eden", name: "Eden", email: "eden@example.com", freelancer: true, invitedBy: "louis@fomorentals.co.uk" };
  const b = inviteBody(s, fl, "Louis");
  assert.deepEqual(b.attendees, [{ email: "eden@example.com", displayName: "Eden" }]);
  assert.doesNotMatch(b.description, /£50/);
  assert.match(b.description, /Booked by Louis/);
  assert.equal(b.summary, "FOMO overtime: Early opening · Andrew Berekdar");
});
