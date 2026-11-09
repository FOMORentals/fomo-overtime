/**
 * Database tests against the Firestore emulator (npm run test:db). Skipped without it.
 * These prove the transaction rules: no overselling under simultaneous clicks, no double-booking,
 * and the pay run marks exactly what Sam approved.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const enabled = !!process.env.FIRESTORE_EMULATOR_HOST;

test("database rules", { skip: !enabled && "set FIRESTORE_EMULATOR_HOST to run" }, async (t) => {
  const store = await import("./store");
  const { db } = await import("./firestore");
  const { londonToUtc } = await import("./time");
  for (const col of ["ot_slots", "ot_claims", "ot_pay_runs", "ot_audit", "ot_meta"]) {
    const snap = await db().collection(col).get();
    await Promise.all(snap.docs.map((d) => d.ref.delete()));
  }
  const now = londonToUtc("2026-11-05", "15:00");
  const louis = { userId: "ULOUIS", email: "louis@fomorentals.co.uk", name: "Louis", admin: false };
  const people = ["U1", "U2", "U3", "U4", "U5"].map((id) => ({ userId: id, email: `${id}@x`, name: id, admin: false }));
  const sam = { userId: "USAM", email: "sam@fomorentals.co.uk", name: "Sam", admin: true };
  const base = { kind: "Early opening", title: "Test", rentmanJob: "", details: "", date: "2026-11-10", startTime: "07:00", endTime: "07:30", feePence: 2500, spaces: 1, leaveEarlyAt: null };

  await t.test("five simultaneous claims on a one-space slot: exactly one wins", async () => {
    const slot = await store.createSlot(base, louis, now);
    const results = await Promise.all(people.map((p) => store.claimSlot(slot.id, p, "paid", now)));
    assert.equal(results.filter((r) => r.ok).length, 1);
    assert.ok(results.filter((r) => !r.ok).every((r) => !r.ok && r.reason === "full"));
    const fresh = await store.getSlot(slot.id);
    assert.equal(fresh?.claimedCount, 1);
    assert.equal(fresh?.status, "full");
  });

  await t.test("overlapping overtime is blocked; withdraw frees the space", async () => {
    const a = await store.createSlot({ ...base, date: "2026-11-11" }, louis, now);
    const b = await store.createSlot({ ...base, date: "2026-11-11", startTime: "07:15", endTime: "08:00", spaces: 2 }, louis, now);
    assert.equal((await store.claimSlot(a.id, people[0], "paid", now)).ok, true);
    const clash = await store.claimSlot(b.id, people[0], "paid", now);
    assert.equal(!clash.ok && clash.reason, "clash");
    const w = await store.withdrawClaim(a.id, people[0], now);
    assert.equal(w.slot.status, "open");
    assert.equal((await store.getSlot(a.id))?.claimedCount, 0);
    assert.equal((await store.claimSlot(b.id, people[0], "paid", now)).ok, true);
    // Re-claim after withdrawing works too.
    assert.equal((await store.claimSlot(a.id, people[1], "paid", now)).ok, true);
  });

  await t.test("early finish claims pay £0", async () => {
    const s = await store.createSlot({ ...base, date: "2026-11-12", startTime: "06:00", endTime: "06:30", leaveEarlyAt: "15:00" }, louis, now);
    const r = await store.claimSlot(s.id, people[2], "early_finish", now);
    assert.ok(r.ok && r.claim.amountPence === 0 && r.claim.route === "early_finish");
    const evening = await store.createSlot({ ...base, date: "2026-11-12", startTime: "17:35", endTime: "18:05" }, louis, now);
    const r2 = await store.claimSlot(evening.id, people[2], "early_finish", now);
    assert.ok(r2.ok && r2.claim.amountPence === 0 && r2.claim.route === "early_finish", "any paid slot can be worked as time");
    const free = await store.createSlot({ ...base, date: "2026-11-12", startTime: "19:00", endTime: "19:30", feePence: 0 }, louis, now);
    const r3 = await store.claimSlot(free.id, people[3], "early_finish", now);
    assert.ok(r3.ok && r3.claim.route === "paid");
  });

  await t.test("only the poster or an admin can edit; spaces can't drop below claims", async () => {
    const s = await store.createSlot({ ...base, date: "2026-11-13", spaces: 2 }, louis, now);
    await store.claimSlot(s.id, people[0], "paid", now);
    await store.claimSlot(s.id, people[1], "paid", now);
    await assert.rejects(store.editSlot(s.id, { ...base, date: "2026-11-13", spaces: 3 }, people[3], now), /Only the person/);
    await assert.rejects(store.editSlot(s.id, { ...base, date: "2026-11-13", spaces: 1 }, louis, now), /can't go below/);
    const e = await store.editSlot(s.id, { ...base, date: "2026-11-13", spaces: 2, feePence: 4000 }, sam, now);
    assert.deepEqual(e.claims.map((c) => c.amountPence), [4000, 4000]);
  });

  await t.test("cancel removes everyone's claim", async () => {
    const s = await store.createSlot({ ...base, date: "2026-11-14" }, louis, now);
    await store.claimSlot(s.id, people[4], "paid", now);
    const r = await store.cancelSlot(s.id, louis, now);
    assert.equal(r.claims.length, 1);
    assert.equal((await store.getClaim(r.claims[0].id))?.status, "cancelled");
    assert.equal((await store.claimSlot(s.id, people[3], "paid", now)).ok, false);
  });

  await t.test("pay run: approve, then sent marks claims paid", async () => {
    const s = await store.createSlot({ ...base, date: "2026-11-15" }, louis, now);
    const r = await store.claimSlot(s.id, people[3], "paid", now);
    assert.ok(r.ok);
    await store.completeClaim(r.claim);
    const { payableClaims } = await import("./rules");
    const payable = payableClaims(await store.unpaidCompletedClaims());
    assert.deepEqual(payable.map((c) => c.id), [r.claim.id]);
    const run = await store.createPayRun("2026-11", payable, now);
    assert.ok(run);
    assert.equal(await store.createPayRun("2026-11", payable, now), null, "only once");
    await assert.rejects(store.markPayRunSent("2026-11", sam, now), /hasn't approved/);
    await store.approvePayRun("2026-11", sam, now);
    await store.markPayRunSent("2026-11", { ...sam, name: "Jamie" }, now);
    assert.equal((await store.getClaim(r.claim.id))?.paidRunId, "2026-11");
    assert.equal((await store.unpaidCompletedClaims()).length, 0);
    await assert.rejects(store.setClaimFlag(r.claim.id, true, "x", sam), /Already paid/);
  });

  await t.test("give away: offer, decline, offer again, accept swaps the claim without changing spaces", async () => {
    const s = await store.createSlot({ ...base, date: "2026-11-16" }, louis, now);
    await store.claimSlot(s.id, people[0], "paid", now);
    await assert.rejects(store.offerClaim(s.id, people[1], people[2], now), /haven't claimed/);
    await store.offerClaim(s.id, people[0], people[1], now);
    await assert.rejects(store.acceptOffer(s.id, people[0].userId, people[2], now), /no longer open/);
    await store.declineOffer(s.id, people[0].userId, people[1]);
    await assert.rejects(store.acceptOffer(s.id, people[0].userId, people[1], now), /no longer open/);
    await store.offerClaim(s.id, people[0], people[1], now);
    const r = await store.acceptOffer(s.id, people[0].userId, people[1], now);
    assert.equal(r.claim.userId, people[1].userId);
    assert.equal((await store.getClaim(r.oldClaim.id))?.status, "withdrawn");
    assert.equal((await store.getClaim(r.oldClaim.id))?.swappedTo, people[1].userId);
    const fresh = await store.getSlot(s.id);
    assert.equal(fresh?.claimedCount, 1);
    assert.equal(fresh?.status, "full");
    await assert.rejects(store.acceptOffer(s.id, people[0].userId, people[1], now), /no longer open/);
  });

  await t.test("give away: the taker's clash is checked on accept", async () => {
    const a = await store.createSlot({ ...base, date: "2026-11-17" }, louis, now);
    const b = await store.createSlot({ ...base, date: "2026-11-17", startTime: "07:15", endTime: "07:45" }, louis, now);
    await store.claimSlot(a.id, people[2], "paid", now);
    await store.claimSlot(b.id, people[3], "paid", now);
    await store.offerClaim(a.id, people[2], people[3], now);
    await assert.rejects(store.acceptOffer(a.id, people[2].userId, people[3], now), /already have overtime/);
    assert.equal((await store.getClaim(`${a.id}_${people[2].userId}`))?.status, "confirmed");
  });

  await t.test("freelancer: poster assigns, it takes a space at £0, edits keep it £0, remove frees it", async () => {
    const s = await store.createSlot({ ...base, date: "2026-11-18", spaces: 2 }, louis, now);
    await assert.rejects(store.assignFreelancer(s.id, "Eden", people[0], now), /Only the person/);
    const r = await store.assignFreelancer(s.id, "Eden", louis, now);
    assert.equal(r.claim.amountPence, 0);
    assert.equal(r.claim.freelancer, true);
    await assert.rejects(store.assignFreelancer(s.id, "eden", louis, now), /already on this slot/);
    await store.claimSlot(s.id, people[0], "paid", now);
    assert.equal((await store.getSlot(s.id))?.status, "full");
    await assert.rejects(store.assignFreelancer(s.id, "Sky", louis, now), /Every space/);
    const e = await store.editSlot(s.id, { ...base, date: "2026-11-18", spaces: 2, feePence: 4000 }, louis, now);
    assert.deepEqual(e.claims.map((c) => [c.freelancer ?? false, c.amountPence]).sort(), [[false, 4000], [true, 0]]);
    await store.removeFreelancer(r.claim.id, sam, now);
    const fresh = await store.getSlot(s.id);
    assert.equal(fresh?.claimedCount, 1);
    assert.equal(fresh?.status, "open");
  });

  await t.test("freelancer email: optional, validated, and can be added later", async () => {
    const s = await store.createSlot({ ...base, date: "2026-11-19" }, louis, now);
    await assert.rejects(store.assignFreelancer(s.id, "Eden", louis, now, "not-an-email"), /doesn't look right/);
    const a = await store.assignFreelancer(s.id, "Eden", louis, now);
    assert.equal(a.claim.invitedBy, null);
    const b = await store.assignFreelancer(s.id, "Eden", louis, now, "Eden@Example.com");
    assert.equal(b.updated, true);
    const stored = await store.getClaim(a.claim.id);
    assert.equal(stored?.email, "eden@example.com");
    assert.equal(stored?.invitedBy, louis.email);
    assert.equal((await store.getSlot(s.id))?.claimedCount, 1, "adding the email doesn't take another space");
    await assert.rejects(store.assignFreelancer(s.id, "Eden", louis, now, "eden@example.com"), /already on this slot/);
  });

  await t.test("every change is in the audit log", async () => {
    const snap = await db().collection("ot_audit").get();
    const actions = new Set(snap.docs.map((d) => d.data().action));
    for (const a of ["slot.create", "claim.create", "claim.withdraw", "slot.edit", "slot.cancel", "claim.complete", "payrun.create", "payrun.approve", "payrun.sent", "claim.offer", "claim.offer_decline", "claim.swap", "claim.assign_freelancer", "claim.remove_freelancer"])
      assert.ok(actions.has(a), a);
  });

  await t.test("scheduler lock is exclusive", async () => {
    const t1 = await store.acquireLock("x", 60_000);
    assert.ok(t1);
    assert.equal(await store.acquireLock("x", 60_000), null);
    await store.releaseLock("x", "wrong-token");
    assert.equal(await store.acquireLock("x", 60_000), null);
    await store.releaseLock("x", t1!);
    assert.ok(await store.acquireLock("x", 60_000));
  });
});
