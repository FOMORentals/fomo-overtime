import { test } from "node:test";
import assert from "node:assert/strict";
import {
  amountFor, calendarWindow, canClaim, claimsToComplete, dueNudges, isLateWithdrawal, money, pairedSlotWarnings,
  parseFee, payRunCsv, payRunDue, payableClaims, statusAfterCount, roundupDue, slotsInWeek, canOffer, totalsByPerson, validateSlotInput, HOUR,
} from "./rules";
import { londonToUtc, slotInstants, summaryDay } from "./time";
import type { Claim, Slot, SlotInput } from "./types";

const NOW = londonToUtc("2026-11-05", "15:00");

function input(over: Partial<SlotInput> = {}): SlotInput {
  return {
    kind: "Early opening", title: "Andrew Berekdar", rentmanJob: "11887", details: "",
    date: "2026-11-10", startTime: "05:40", endTime: "06:10", feePence: 5000, spaces: 1, leaveEarlyAt: null, ...over,
  };
}

function slot(over: Partial<Slot> = {}): Slot {
  const base = input(over);
  return {
    ...base, id: "s1", ...slotInstants(base.date, base.startTime, base.endTime), status: "open", claimedCount: 0,
    postedBy: "ULOUIS", postedByName: "Louis", createdAt: NOW, updatedAt: NOW, channel: "C1", messageTs: "1.1",
    repostedAt: null, unclaimedAlertAt: null, ...over,
  };
}

function claim(over: Partial<Claim> = {}): Claim {
  const s = slot();
  return {
    id: "s1_U1", slotId: "s1", userId: "U1", email: "rosie@fomorentals.co.uk", name: "Rosie", route: "paid",
    amountPence: 5000, status: "confirmed", claimedAt: NOW, withdrawnAt: null, date: s.date, startAt: s.startAt,
    endAt: s.endAt, slotLabel: "Early opening · Andrew Berekdar · 11887", flagged: false, flagReason: null,
    paidRunId: null, calendarEventId: null, calendarError: null, reminderDayBeforeAt: null, reminderHourBeforeAt: null,
    ...over,
  };
}

test("valid slot passes", () => assert.deepEqual(validateSlotInput(input(), NOW), []));

test("any time of day is allowed, including core hours (FREE 8am slots)", () => {
  assert.deepEqual(validateSlotInput(input({ startTime: "11:00", endTime: "12:00", feePence: 0 }), NOW), []);
});

test("past slots are rejected", () => {
  assert.match(validateSlotInput(input({ date: "2026-11-01" }), NOW).join(), /already passed/);
});

test("leave early only on pre-9am slots, after start", () => {
  assert.deepEqual(validateSlotInput(input({ leaveEarlyAt: "15:00" }), NOW), []);
  assert.match(validateSlotInput(input({ startTime: "19:00", endTime: "20:00", leaveEarlyAt: "15:00" }), NOW).join(), /before 9am/);
  assert.match(validateSlotInput(input({ leaveEarlyAt: "05:00" }), NOW).join(), /after the start/);
});

test("bad Rentman number and fee", () => {
  assert.match(validateSlotInput(input({ rentmanJob: "abc" }), NOW).join(), /digits/);
  assert.match(validateSlotInput(input({ feePence: -1 }), NOW).join(), /Fee/);
});

test("early finish pays nothing and the calendar runs to the leave time", () => {
  const s = slot({ leaveEarlyAt: "15:00" });
  assert.equal(amountFor(s, "early_finish"), 0);
  assert.equal(amountFor(s, "paid"), 5000);
  const w = calendarWindow(s, "early_finish");
  assert.equal(w.endAt, londonToUtc("2026-11-10", "15:00"));
});

test("claim: first come first served", () => {
  assert.deepEqual(canClaim(slot(), "U1", [], NOW, "paid"), { ok: true });
  assert.equal((canClaim(slot({ claimedCount: 1 }), "U1", [], NOW, "paid") as { reason: string }).reason, "full");
  assert.equal((canClaim(slot({ status: "cancelled" }), "U1", [], NOW, "paid") as { reason: string }).reason, "not_open");
  assert.equal((canClaim(slot(), "U1", [], slot().startAt, "paid") as { reason: string }).reason, "started");
  assert.equal(
    (canClaim(slot({ spaces: 2, claimedCount: 1 }), "U1", [{ slotId: "s1", startAt: 0, endAt: 1, route: "paid" }], NOW, "paid") as { reason: string }).reason,
    "already_claimed",
  );
});

test("claim: overlapping overtime is blocked, back-to-back is fine", () => {
  const s = slot();
  const clash = { slotId: "other", startAt: s.startAt + 10 * 60000, endAt: s.endAt + HOUR, route: "paid" as const };
  assert.equal((canClaim(s, "U1", [clash], NOW, "paid") as { reason: string }).reason, "clash");
  const after = { slotId: "other", startAt: s.endAt, endAt: s.endAt + HOUR, route: "paid" as const };
  assert.deepEqual(canClaim(s, "U1", [after], NOW, "paid"), { ok: true });
});

test("slot status follows claims", () => {
  assert.equal(statusAfterCount({ status: "open", spaces: 1 }, 1), "full");
  assert.equal(statusAfterCount({ status: "full", spaces: 2 }, 1), "open");
  assert.equal(statusAfterCount({ status: "cancelled", spaces: 1 }, 0), "cancelled");
});

test("withdrawal inside 48h is late", () => {
  const s = slot();
  assert.equal(isLateWithdrawal(s.startAt, s.startAt - 49 * HOUR), false);
  assert.equal(isLateWithdrawal(s.startAt, s.startAt - 47 * HOUR), true);
});

test("nudges: repost at noon and alert at 4pm two days before, only while unclaimed", () => {
  const s = slot({ createdAt: londonToUtc("2026-11-03", "10:00") });
  assert.deepEqual(dueNudges([s], [], londonToUtc("2026-11-08", "11:59")), []);
  assert.deepEqual(dueNudges([s], [], londonToUtc("2026-11-08", "12:00")), [{ kind: "repost", slotId: "s1" }]);
  assert.deepEqual(
    dueNudges([{ ...s, repostedAt: 1 }], [], londonToUtc("2026-11-08", "16:05")),
    [{ kind: "unclaimed_alert", slotId: "s1" }],
  );
  assert.deepEqual(dueNudges([{ ...s, claimedCount: 1, status: "full" }], [], londonToUtc("2026-11-08", "16:05")), []);
});

test("nudges: 5pm day-before reminder, plus 1h before for pre-8am starts", () => {
  const s = slot();
  const c = claim({ claimedAt: londonToUtc("2026-11-06", "10:00") });
  assert.deepEqual(dueNudges([{ ...s, status: "full", claimedCount: 1 }], [c], londonToUtc("2026-11-09", "17:00")), [
    { kind: "reminder_day_before", claimId: "s1_U1" },
  ]);
  const later = dueNudges([{ ...s, status: "full", claimedCount: 1 }], [{ ...c, reminderDayBeforeAt: 1 }], s.startAt - HOUR + 1);
  assert.deepEqual(later, [{ kind: "reminder_hour_before", claimId: "s1_U1" }]);
  // 7pm slot: no hour-before reminder
  const eve = slot({ startTime: "19:00", endTime: "20:00", status: "full", claimedCount: 1 });
  const ce = claim({ ...slotInstants("2026-11-10", "19:00", "20:00"), reminderDayBeforeAt: 1 });
  assert.deepEqual(dueNudges([eve], [ce], eve.startAt - 30 * 60000), []);
});

test("claimed after 5pm the day before: no day-before nudge", () => {
  const s = slot({ status: "full", claimedCount: 1 });
  const c = claim({ claimedAt: londonToUtc("2026-11-09", "18:00") });
  assert.deepEqual(dueNudges([s], [c], londonToUtc("2026-11-09", "18:15")), []);
});

test("shifts complete automatically after they end", () => {
  const c = claim();
  assert.equal(claimsToComplete([c], c.endAt - 1).length, 0);
  assert.equal(claimsToComplete([c], c.endAt).length, 1);
});

test("payable: completed, unflagged, unpaid, above £0", () => {
  const list = [
    claim({ id: "a", status: "completed" }),
    claim({ id: "b", status: "completed", flagged: true }),
    claim({ id: "c", status: "completed", paidRunId: "2026-10" }),
    claim({ id: "d", status: "completed", amountPence: 0 }),
    claim({ id: "e", status: "confirmed" }),
  ];
  assert.deepEqual(payableClaims(list).map((c) => c.id), ["a"]);
});

test("paired paid slots within an hour are flagged", () => {
  const a = claim({ id: "a", startAt: londonToUtc("2026-11-10", "07:00") });
  const b = claim({ id: "b", startAt: londonToUtc("2026-11-10", "07:30") });
  const c = claim({ id: "c", startAt: londonToUtc("2026-11-10", "19:00") });
  const free = claim({ id: "f", startAt: londonToUtc("2026-11-10", "07:15"), amountPence: 0 });
  const w = pairedSlotWarnings([a, b, c, free]);
  assert.equal(w.length, 1);
  assert.deepEqual([w[0].a.id, w[0].b.id], ["a", "b"]);
});

test("totals and CSV", () => {
  const list = [claim({ id: "a", amountPence: 2500 }), claim({ id: "b", amountPence: 5000 }), claim({ id: "c", userId: "U2", name: "Louis", amountPence: 2500 })];
  const t = totalsByPerson(list);
  assert.deepEqual(t.map((x) => [x.name, x.totalPence]), [["Louis", 2500], ["Rosie", 7500]]);
  const csv = payRunCsv(list);
  assert.match(csv, /^Name,Email,Date,Job,Amount/);
  assert.match(csv, /Rosie,rosie@fomorentals.co.uk,,TOTAL,75.00/);
});

test("pay run is due on the summary Monday from 9am", () => {
  const day = summaryDay("2026-11");
  assert.equal(payRunDue(londonToUtc(day, "08:59"), summaryDay), null);
  assert.equal(payRunDue(londonToUtc(day, "09:00"), summaryDay), "2026-11");
  assert.equal(payRunDue(londonToUtc("2026-11-24", "09:00"), summaryDay), null);
});

test("fee parsing and display", () => {
  assert.equal(parseFee("£25"), 2500);
  assert.equal(parseFee("free"), 0);
  assert.equal(parseFee(""), 0);
  assert.equal(parseFee("12.5"), 1250);
  assert.equal(parseFee("abc"), null);
  assert.equal(money(0), "Free");
  assert.equal(money(2500), "£25");
  assert.equal(money(1250), "£12.50");
});

test("Monday round-up is due on Mondays from 8am only", () => {
  assert.equal(roundupDue(londonToUtc("2026-11-09", "07:59")), null);
  assert.equal(roundupDue(londonToUtc("2026-11-09", "08:00")), "2026-11-09");
  assert.equal(roundupDue(londonToUtc("2026-11-10", "09:00")), null);
});

test("round-up covers Monday to Sunday, without cancelled slots", () => {
  const list = [
    slot({ id: "a", date: "2026-11-09" }),
    slot({ id: "b", date: "2026-11-15" }),
    slot({ id: "c", date: "2026-11-16" }),
    slot({ id: "d", date: "2026-11-11", status: "cancelled" }),
  ];
  assert.deepEqual(slotsInWeek(list, "2026-11-09").map((s) => s.id), ["a", "b"]);
});

test("give away: only your own confirmed claim, before it starts, to someone not already on it", () => {
  const s = slot();
  const mine = claim();
  assert.equal(canOffer(s, mine, "U1", "U2", null, NOW), null);
  assert.equal(canOffer(s, null, "U1", "U2", null, NOW), "not_yours");
  assert.equal(canOffer(s, { status: "withdrawn" }, "U1", "U2", null, NOW), "not_yours");
  assert.equal(canOffer(s, mine, "U1", "U1", null, NOW), "self");
  assert.equal(canOffer(s, mine, "U1", "U2", { status: "confirmed" }, NOW), "already_on_it");
  assert.equal(canOffer(s, mine, "U1", "U2", { status: "withdrawn" }, NOW), null);
  assert.equal(canOffer(s, mine, "U1", "U2", null, s.startAt), "started");
});
