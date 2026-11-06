import { test } from "node:test";
import assert from "node:assert/strict";
import { addMinutesToTime, finalFriday, londonParts, londonToUtc, parseTime, slotInstants, summaryDay, prettyDate } from "./time";

test("parseTime understands how people type times", () => {
  for (const [raw, want] of [["17:35", "17:35"], ["1735", "17:35"], ["17.35", "17:35"], ["5:35pm", "17:35"], ["5:35 PM", "17:35"], ["7am", "07:00"], ["12am", "00:00"], ["12pm", "12:00"], ["0540", "05:40"], ["5:40", "05:40"], ["7", "07:00"]] as const)
    assert.equal(parseTime(raw), want, raw);
  for (const bad of ["", "25:00", "17:60", "13pm", "abc", "17:3"]) assert.equal(parseTime(bad), null, bad);
});

test("addMinutesToTime wraps past midnight", () => {
  assert.equal(addMinutesToTime("17:35", 30), "18:05");
  assert.equal(addMinutesToTime("23:45", 30), "00:15");
});

test("London winter time is UTC", () => {
  assert.equal(new Date(londonToUtc("2026-11-10", "05:40")).toISOString(), "2026-11-10T05:40:00.000Z");
});

test("London summer time is UTC+1", () => {
  assert.equal(new Date(londonToUtc("2026-07-10", "07:30")).toISOString(), "2026-07-10T06:30:00.000Z");
});

test("clock-change day (29 Mar 2026, clocks go forward at 1am)", () => {
  assert.equal(new Date(londonToUtc("2026-03-29", "06:00")).toISOString(), "2026-03-29T05:00:00.000Z");
});

test("londonParts round-trips", () => {
  const p = londonParts(londonToUtc("2026-07-10", "19:15"));
  assert.deepEqual(p, { date: "2026-07-10", time: "19:15", weekday: 5 });
});

test("slot running past midnight ends next day", () => {
  const { startAt, endAt } = slotInstants("2026-11-14", "22:00", "01:00");
  assert.equal(endAt - startAt, 3 * 3_600_000);
});

test("pay day is the final Friday; summary is the Monday before", () => {
  assert.equal(finalFriday("2026-11"), "2026-11-27");
  assert.equal(summaryDay("2026-11"), "2026-11-23");
  assert.equal(finalFriday("2026-10"), "2026-10-30");
  assert.equal(finalFriday("2027-01"), "2027-01-29");
  assert.equal(finalFriday("2026-07"), "2026-07-31");
});

test("prettyDate", () => {
  assert.equal(prettyDate("2026-11-10"), "Tue 10 Nov");
});
