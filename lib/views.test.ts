import { test } from "node:test";
import assert from "node:assert/strict";
import { homeView, payRunBlocks, readSlotForm, routeModal, slotLine, slotMessage, slotModal } from "./views";
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
  assert.equal(slotLine(s), "EARLY OPENING · Tue 10 Nov · 05:40–06:10 · £50 · Andrew Berekdar · #11887");
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
  assert.match(json, /Covered by <@U1> \(leaving 15:00\)/);
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
    kind: "Early opening", title: "Andrew Berekdar", rentmanJob: "11887", details: "Keys in the safe", date: "2026-11-10",
    startTime: "05:40", endTime: "06:10", feeRaw: "50", spaces: 1, leaveEarlyAt: "15:00",
  });
});

test("route modal offers both routes", () => {
  assert.match(JSON.stringify(routeModal(s)), /early_finish/);
});

test("home view and pay run render", () => {
  const home = homeView({ name: "Rosie", admin: false, appUrl: "https://x", mine: [claim], openSlots: [s], now: londonToUtc("2026-11-05", "12:00") });
  assert.equal(home.type, "home");
  assert.ok(home.blocks.length < 100);
  const run = { id: "2026-11", createdAt: 0, status: "awaiting_sam" as const, claimIds: ["a"], totalPence: 2500, approvedBy: null, approvedAt: null, sentBy: null, sentAt: null };
  const pr = payRunBlocks(run, [{ ...claim, route: "paid", amountPence: 2500, status: "completed" }], "https://x", "sam");
  assert.match(JSON.stringify(pr.blocks), /payrun_approve/);
  assert.match(pr.text, /£25 total/);
});
