/**
 * All reads and writes. Claims, withdrawals, edits and cancellations run in Firestore
 * transactions so two people clicking at once can never oversell a slot. Every change
 * writes an audit row (who, what, when) in the same transaction. Writes only touch the
 * fields they change (FOMO engineering rule 3).
 */
import { randomUUID } from "node:crypto";
import { FieldValue, type Transaction } from "firebase-admin/firestore";
import { COL, db } from "./firestore";
import { amountFor, canClaim, canOffer, offersEarlyFinish, spacesLeft, statusAfterCount, validateSlotInput, type ClaimRefusal, type OfferRefusal } from "./rules";
import { slotInstants } from "./time";
import { slotLabel } from "./labels";
import type { Claim, PayRun, Route, Slot, SlotInput } from "./types";

export interface Actor {
  userId: string; // Slack user id, or "web:<email>" for the admin page, or "system"
  email: string;
  name: string;
  admin: boolean;
}

export const SYSTEM: Actor = { userId: "system", email: "", name: "Overtime bot", admin: true };

export class UserError extends Error {}


function audit(tx: Transaction | null, actor: Actor, action: string, data: Record<string, unknown>) {
  const ref = db().collection(COL.audit).doc();
  const row = { at: Date.now(), actorId: actor.userId, actorEmail: actor.email, actorName: actor.name, action, ...data };
  if (tx) tx.set(ref, row);
  else return ref.set(row);
}

export async function writeAudit(actor: Actor, action: string, data: Record<string, unknown>) {
  await audit(null, actor, action, data);
}

// ---------- reads ----------

export async function getSlot(id: string): Promise<Slot | null> {
  const snap = await db().collection(COL.slots).doc(id).get();
  return snap.exists ? ({ ...(snap.data() as Omit<Slot, "id">), id: snap.id } as Slot) : null;
}

export async function getClaim(id: string): Promise<Claim | null> {
  const snap = await db().collection(COL.claims).doc(id).get();
  return snap.exists ? ({ ...(snap.data() as Omit<Claim, "id">), id: snap.id } as Claim) : null;
}

export async function claimsForSlot(slotId: string, statuses: Claim["status"][] = ["confirmed", "completed"]): Promise<Claim[]> {
  const snap = await db().collection(COL.claims).where("slotId", "==", slotId).get();
  return snap.docs.map((d) => ({ ...(d.data() as Omit<Claim, "id">), id: d.id })).filter((c) => statuses.includes(c.status));
}

/** Open/full slots that haven't started yet (plus a day of slack). */
export async function liveSlots(now: number): Promise<Slot[]> {
  const snap = await db().collection(COL.slots).where("status", "in", ["open", "full"]).get();
  return snap.docs
    .map((d) => ({ ...(d.data() as Omit<Slot, "id">), id: d.id }))
    .filter((s) => s.endAt > now - 86_400_000)
    .sort((a, b) => a.startAt - b.startAt);
}

/** Upcoming slots plus ones finished in the last two weeks: the posts still worth keeping current. */
export async function recentSlots(now: number): Promise<Slot[]> {
  const snap = await db().collection(COL.slots).where("status", "in", ["open", "full", "completed"]).get();
  return snap.docs
    .map((d) => ({ ...(d.data() as Omit<Slot, "id">), id: d.id }))
    .filter((s) => s.endAt > now - 14 * 86_400_000);
}

export async function confirmedClaims(): Promise<Claim[]> {
  const snap = await db().collection(COL.claims).where("status", "==", "confirmed").get();
  return snap.docs.map((d) => ({ ...(d.data() as Omit<Claim, "id">), id: d.id }));
}

export async function claimsForUser(userId: string): Promise<Claim[]> {
  const snap = await db().collection(COL.claims).where("userId", "==", userId).get();
  return snap.docs.map((d) => ({ ...(d.data() as Omit<Claim, "id">), id: d.id })).sort((a, b) => a.startAt - b.startAt);
}

export async function unpaidCompletedClaims(): Promise<Claim[]> {
  const snap = await db().collection(COL.claims).where("status", "==", "completed").where("paidRunId", "==", null).get();
  return snap.docs.map((d) => ({ ...(d.data() as Omit<Claim, "id">), id: d.id }));
}

/** Every claim whose shift falls in a calendar month (for the admin page). */
export async function claimsInMonth(month: string): Promise<Claim[]> {
  const snap = await db()
    .collection(COL.claims)
    .where("date", ">=", `${month}-01`)
    .where("date", "<=", `${month}-31`)
    .get();
  return snap.docs.map((d) => ({ ...(d.data() as Omit<Claim, "id">), id: d.id })).sort((a, b) => a.startAt - b.startAt);
}

export async function claimsByIds(ids: string[]): Promise<Claim[]> {
  if (!ids.length) return [];
  const refs = ids.map((id) => db().collection(COL.claims).doc(id));
  const snaps = await db().getAll(...refs);
  return snaps.filter((s) => s.exists).map((s) => ({ ...(s.data() as Omit<Claim, "id">), id: s.id }));
}

// ---------- slots ----------

export async function createSlot(input: SlotInput, actor: Actor, now = Date.now()): Promise<Slot> {
  const errors = validateSlotInput(input, now);
  if (errors.length) throw new UserError(errors.join(" "));
  const ref = db().collection(COL.slots).doc();
  const slot: Slot = {
    ...input,
    leaveEarlyAt: input.leaveEarlyAt || null,
    id: ref.id,
    ...slotInstants(input.date, input.startTime, input.endTime),
    status: "open",
    claimedCount: 0,
    postedBy: actor.userId,
    postedByName: actor.name,
    createdAt: now,
    updatedAt: now,
    channel: null,
    messageTs: null,
    repostedAt: null,
    unclaimedAlertAt: null,
  };
  await db().runTransaction(async (tx) => {
    const { id: _id, ...data } = slot;
    void _id;
    tx.create(ref, data);
    audit(tx, actor, "slot.create", { slotId: ref.id, slot: data });
  });
  return slot;
}

export async function updateSlotFields(id: string, fields: Partial<Omit<Slot, "id">>) {
  await db().collection(COL.slots).doc(id).update(fields);
}

export async function updateClaimFields(id: string, fields: Partial<Omit<Claim, "id">>) {
  await db().collection(COL.claims).doc(id).update(fields);
}

function canManage(slot: Slot, actor: Actor) {
  return actor.admin || slot.postedBy === actor.userId;
}

/** Edit a slot. Returns the claims affected so callers can update calendars and DM people. */
export async function editSlot(id: string, input: SlotInput, actor: Actor, now = Date.now()): Promise<{ slot: Slot; claims: Claim[] }> {
  const errors = validateSlotInput(input, now);
  if (errors.length) throw new UserError(errors.join(" "));
  return db().runTransaction(async (tx) => {
    const ref = db().collection(COL.slots).doc(id);
    const snap = await tx.get(ref);
    if (!snap.exists) throw new UserError("That slot no longer exists.");
    const before = { ...(snap.data() as Omit<Slot, "id">), id };
    if (!canManage(before, actor)) throw new UserError("Only the person who posted it, Sam or Jamie can edit this slot.");
    if (before.status === "cancelled" || before.status === "completed") throw new UserError("This slot is closed.");
    const claimSnaps = await tx.get(db().collection(COL.claims).where("slotId", "==", id).where("status", "==", "confirmed"));
    if (input.spaces < claimSnaps.size) throw new UserError(`${claimSnaps.size} people have already claimed it, so spaces can't go below that.`);

    const instants = slotInstants(input.date, input.startTime, input.endTime);
    const after: Slot = {
      ...before,
      ...input,
      leaveEarlyAt: input.leaveEarlyAt || null,
      ...instants,
      status: statusAfterCount({ status: before.status, spaces: input.spaces }, claimSnaps.size),
      updatedAt: now,
    };
    // A moved slot gets its nudges again.
    if (before.date !== after.date) {
      after.repostedAt = null;
      after.unclaimedAlertAt = null;
    }
    const { id: _id, ...data } = after;
    void _id;
    tx.update(ref, data);

    const claims: Claim[] = [];
    for (const cs of claimSnaps.docs) {
      const c = { ...(cs.data() as Omit<Claim, "id">), id: cs.id };
      const route: Route = c.route === "early_finish" && !offersEarlyFinish(after) ? "paid" : c.route;
      const changes = {
        route,
        amountPence: c.freelancer ? 0 : amountFor(after, route),
        date: after.date,
        startAt: after.startAt,
        endAt: after.endAt,
        slotLabel: slotLabel(after),
        ...(before.date !== after.date || before.startTime !== after.startTime
          ? { reminderDayBeforeAt: null, reminderHourBeforeAt: null }
          : {}),
      };
      tx.update(cs.ref, changes);
      claims.push({ ...c, ...changes });
    }
    audit(tx, actor, "slot.edit", { slotId: id, before: snap.data(), after: data, claimIds: claims.map((c) => c.id) });
    return { slot: after, claims };
  });
}

export async function cancelSlot(id: string, actor: Actor, now = Date.now()): Promise<{ slot: Slot; claims: Claim[] }> {
  return db().runTransaction(async (tx) => {
    const ref = db().collection(COL.slots).doc(id);
    const snap = await tx.get(ref);
    if (!snap.exists) throw new UserError("That slot no longer exists.");
    const slot = { ...(snap.data() as Omit<Slot, "id">), id };
    if (!canManage(slot, actor)) throw new UserError("Only the person who posted it, Sam or Jamie can cancel this slot.");
    if (slot.status === "cancelled") throw new UserError("Already cancelled.");
    if (slot.status === "completed") throw new UserError("This slot has already happened.");
    const claimSnaps = await tx.get(db().collection(COL.claims).where("slotId", "==", id).where("status", "==", "confirmed"));
    tx.update(ref, { status: "cancelled", updatedAt: now });
    const claims: Claim[] = [];
    for (const cs of claimSnaps.docs) {
      tx.update(cs.ref, { status: "cancelled" });
      claims.push({ ...(cs.data() as Omit<Claim, "id">), id: cs.id, status: "cancelled" });
    }
    audit(tx, actor, "slot.cancel", { slotId: id, claimIds: claims.map((c) => c.id) });
    return { slot: { ...slot, status: "cancelled", updatedAt: now }, claims };
  });
}

// ---------- claims ----------

export type ClaimResult =
  | { ok: true; slot: Slot; claim: Claim }
  | { ok: false; reason: ClaimRefusal | "missing"; slot: Slot | null; clashWith?: string };

export async function claimSlot(slotId: string, actor: Actor, route: Route, now = Date.now()): Promise<ClaimResult> {
  return db().runTransaction(async (tx) => {
    const ref = db().collection(COL.slots).doc(slotId);
    const snap = await tx.get(ref);
    if (!snap.exists) return { ok: false, reason: "missing", slot: null };
    const slot = { ...(snap.data() as Omit<Slot, "id">), id: slotId };
    const mineSnap = await tx.get(db().collection(COL.claims).where("userId", "==", actor.userId).where("status", "==", "confirmed"));
    const mine = mineSnap.docs.map((d) => d.data() as Claim);
    const effectiveRoute: Route = route === "early_finish" && offersEarlyFinish(slot) ? "early_finish" : "paid";
    const check = canClaim(slot, actor.userId, mine, now, effectiveRoute);
    if (!check.ok) return { ok: false, reason: check.reason, slot, clashWith: check.clashWith };

    const claim = newClaim(slot, actor, effectiveRoute, now);
    const claimId = claim.id;
    const count = slot.claimedCount + 1;
    const status = statusAfterCount(slot, count);
    const { id: _id, ...data } = claim;
    void _id;
    tx.set(db().collection(COL.claims).doc(claimId), data); // a re-claim after withdrawing replaces the old row; the audit log keeps history
    tx.update(ref, { claimedCount: FieldValue.increment(1), status, updatedAt: now });
    audit(tx, actor, "claim.create", { slotId, claimId, route: effectiveRoute, amountPence: claim.amountPence });
    return { ok: true, slot: { ...slot, claimedCount: count, status }, claim };
  });
}

function newClaim(slot: Slot, actor: Actor, route: Route, now: number): Claim {
  return {
    id: `${slot.id}_${actor.userId}`,
    slotId: slot.id,
    userId: actor.userId,
    email: actor.email,
    name: actor.name,
    route,
    amountPence: amountFor(slot, route),
    status: "confirmed",
    claimedAt: now,
    withdrawnAt: null,
    date: slot.date,
    startAt: slot.startAt,
    endAt: slot.endAt,
    slotLabel: slotLabel(slot),
    flagged: false,
    flagReason: null,
    paidRunId: null,
    calendarEventId: null,
    calendarError: null,
    reminderDayBeforeAt: null,
    reminderHourBeforeAt: null,
    offerTo: null,
    offerToName: null,
    offerAt: null,
    swappedTo: null,
  };
}

const OFFER_TEXT: Record<OfferRefusal, string> = {
  not_yours: "You haven't claimed this slot.",
  started: "This slot has already started or closed.",
  self: "You can't give it to yourself.",
  already_on_it: "They're already on this slot.",
};

/** Give away, step 1: offer my claim to a colleague. I stay on it until they accept. */
export async function offerClaim(slotId: string, from: Actor, to: Actor, now = Date.now()): Promise<{ slot: Slot; claim: Claim }> {
  return db().runTransaction(async (tx) => {
    const slotRef = db().collection(COL.slots).doc(slotId);
    const claimRef = db().collection(COL.claims).doc(`${slotId}_${from.userId}`);
    const toRef = db().collection(COL.claims).doc(`${slotId}_${to.userId}`);
    const [slotSnap, claimSnap, toSnap] = await Promise.all([tx.get(slotRef), tx.get(claimRef), tx.get(toRef)]);
    if (!slotSnap.exists) throw new UserError("That slot no longer exists.");
    const slot = { ...(slotSnap.data() as Omit<Slot, "id">), id: slotId };
    const claim = claimSnap.exists ? { ...(claimSnap.data() as Omit<Claim, "id">), id: claimSnap.id } : null;
    const refusal = canOffer(slot, claim, from.userId, to.userId, toSnap.exists ? (toSnap.data() as Claim) : null, now);
    if (refusal) throw new UserError(OFFER_TEXT[refusal]);
    const fields = { offerTo: to.userId, offerToName: to.name, offerAt: now };
    tx.update(claimRef, fields);
    audit(tx, from, "claim.offer", { slotId, claimId: claim!.id, toUserId: to.userId, toName: to.name });
    return { slot, claim: { ...claim!, ...fields } };
  });
}

/** Give away, step 2: the colleague accepts. Their claim replaces mine in one transaction; spaces don't change. */
export async function acceptOffer(
  slotId: string,
  fromUserId: string,
  to: Actor,
  now = Date.now(),
): Promise<{ slot: Slot; oldClaim: Claim; claim: Claim }> {
  return db().runTransaction(async (tx) => {
    const slotRef = db().collection(COL.slots).doc(slotId);
    const oldRef = db().collection(COL.claims).doc(`${slotId}_${fromUserId}`);
    const [slotSnap, oldSnap, mineSnap] = await Promise.all([
      tx.get(slotRef),
      tx.get(oldRef),
      tx.get(db().collection(COL.claims).where("userId", "==", to.userId).where("status", "==", "confirmed")),
    ]);
    if (!slotSnap.exists) throw new UserError("That slot no longer exists.");
    const slot = { ...(slotSnap.data() as Omit<Slot, "id">), id: slotId };
    const old = oldSnap.exists ? { ...(oldSnap.data() as Omit<Claim, "id">), id: oldSnap.id } : null;
    if (!old || old.status !== "confirmed" || old.offerTo !== to.userId) throw new UserError("This offer is no longer open.");
    const route: Route = old.route === "early_finish" && offersEarlyFinish(slot) ? "early_finish" : "paid";
    // Check as if the giver's space were free, so "full" doesn't block the hand-over.
    const check = canClaim({ ...slot, claimedCount: slot.claimedCount - 1 }, to.userId, mineSnap.docs.map((d) => d.data() as Claim), now, route);
    if (!check.ok) {
      const why: Record<ClaimRefusal, string> = {
        not_open: "That slot has been cancelled or has already happened.",
        started: "That slot has already started.",
        full: "That slot is full.",
        already_claimed: "You're already on this slot.",
        clash: "You already have overtime booked at that time, so you can't take this one.",
      };
      throw new UserError(why[check.reason]);
    }
    const claim = newClaim(slot, to, route, now);
    const { id: _id, ...data } = claim;
    void _id;
    const oldFields = { status: "withdrawn" as const, withdrawnAt: now, offerTo: null, offerToName: null, offerAt: null, swappedTo: to.userId };
    tx.update(oldRef, oldFields);
    tx.set(db().collection(COL.claims).doc(claim.id), data);
    tx.update(slotRef, { updatedAt: now });
    audit(tx, to, "claim.swap", { slotId, fromClaimId: old.id, toClaimId: claim.id, route, amountPence: claim.amountPence });
    return { slot: { ...slot, updatedAt: now }, oldClaim: { ...old, ...oldFields }, claim };
  });
}

/** Give away: the colleague says no. The giver stays on it. */
export async function declineOffer(slotId: string, fromUserId: string, to: Actor): Promise<Claim> {
  return db().runTransaction(async (tx) => {
    const ref = db().collection(COL.claims).doc(`${slotId}_${fromUserId}`);
    const snap = await tx.get(ref);
    const c = snap.exists ? { ...(snap.data() as Omit<Claim, "id">), id: snap.id } : null;
    if (!c || c.status !== "confirmed" || c.offerTo !== to.userId) throw new UserError("This offer is no longer open.");
    tx.update(ref, { offerTo: null, offerToName: null, offerAt: null });
    audit(tx, to, "claim.offer_decline", { slotId, claimId: c.id });
    return c;
  });
}

/** Freelancer claim ids are `${slotId}_fl_${slug}`. */
export function freelancerClaimId(slotId: string, name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "freelancer";
  return `${slotId}_fl_${slug}`;
}

/** Poster or admin puts a freelancer (not on Slack) on a slot. Takes a space like a claim; never paid through payroll. */
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Freelancer email is optional: with one, they get a Google Calendar invite from the assigner's calendar.
 * Assigning someone already on the slot with a (new) email just updates the email so the invite goes out.
 */
export async function assignFreelancer(
  slotId: string,
  name: string,
  actor: Actor,
  now = Date.now(),
  email = "",
): Promise<{ slot: Slot; claim: Claim; updated: boolean }> {
  const clean = name.trim().replace(/\s+/g, " ").slice(0, 60);
  if (!clean) throw new UserError("Type the freelancer's name.");
  const mail = email.trim().toLowerCase();
  if (mail && !EMAIL_RE.test(mail)) throw new UserError("That email doesn't look right. Leave it blank to skip the invite.");
  return db().runTransaction(async (tx) => {
    const ref = db().collection(COL.slots).doc(slotId);
    const snap = await tx.get(ref);
    if (!snap.exists) throw new UserError("That slot no longer exists.");
    const slot = { ...(snap.data() as Omit<Slot, "id">), id: slotId };
    if (!canManage(slot, actor)) throw new UserError("Only the person who posted it, Sam or Jamie can assign a freelancer.");
    if (slot.status !== "open" && slot.status !== "full") throw new UserError("This slot is closed.");
    if (slot.startAt <= now) throw new UserError("This slot has already started.");
    const id = freelancerClaimId(slotId, clean);
    const existingRef = db().collection(COL.claims).doc(id);
    const existing = await tx.get(existingRef);
    if (existing.exists && (existing.data() as Claim).status === "confirmed") {
      const cur = { ...(existing.data() as Omit<Claim, "id">), id };
      if (!mail || mail === cur.email) throw new UserError(`${clean} is already on this slot.`);
      const fields = { email: mail, invitedBy: actor.email };
      tx.update(existingRef, fields);
      audit(tx, actor, "claim.freelancer_email", { slotId, claimId: id });
      return { slot, claim: { ...cur, ...fields }, updated: true };
    }
    if (spacesLeft(slot) <= 0) throw new UserError("Every space is already taken. Someone needs to withdraw first.");
    const base = newClaim(slot, { userId: `freelancer:${id}`, email: mail, name: clean, admin: false }, "paid", now);
    const claim: Claim = { ...base, id, amountPence: 0, freelancer: true, invitedBy: mail ? actor.email : null };
    const { id: _id, ...data } = claim;
    void _id;
    const count = slot.claimedCount + 1;
    const status = statusAfterCount(slot, count);
    tx.set(db().collection(COL.claims).doc(id), data);
    tx.update(ref, { claimedCount: FieldValue.increment(1), status, updatedAt: now });
    audit(tx, actor, "claim.assign_freelancer", { slotId, claimId: id, name: clean });
    return { slot: { ...slot, claimedCount: count, status, updatedAt: now }, claim, updated: false };
  });
}

export async function removeFreelancer(claimId: string, actor: Actor, now = Date.now()): Promise<{ slot: Slot; claim: Claim }> {
  return db().runTransaction(async (tx) => {
    const claimRef = db().collection(COL.claims).doc(claimId);
    const claimSnap = await tx.get(claimRef);
    const claim = claimSnap.exists ? { ...(claimSnap.data() as Omit<Claim, "id">), id: claimId } : null;
    if (!claim || !claim.freelancer || claim.status !== "confirmed") throw new UserError("That freelancer isn't on this slot any more.");
    const slotRef = db().collection(COL.slots).doc(claim.slotId);
    const slotSnap = await tx.get(slotRef);
    if (!slotSnap.exists) throw new UserError("That slot no longer exists.");
    const slot = { ...(slotSnap.data() as Omit<Slot, "id">), id: claim.slotId };
    if (!canManage(slot, actor)) throw new UserError("Only the person who posted it, Sam or Jamie can remove a freelancer.");
    const count = Math.max(0, slot.claimedCount - 1);
    const status = statusAfterCount(slot, count);
    tx.update(claimRef, { status: "withdrawn", withdrawnAt: now });
    tx.update(slotRef, { claimedCount: FieldValue.increment(-1), status, updatedAt: now });
    audit(tx, actor, "claim.remove_freelancer", { slotId: slot.id, claimId });
    return { slot: { ...slot, claimedCount: count, status, updatedAt: now }, claim: { ...claim, status: "withdrawn", withdrawnAt: now } };
  });
}

export async function withdrawClaim(slotId: string, actor: Actor, now = Date.now()): Promise<{ slot: Slot; claim: Claim }> {
  return db().runTransaction(async (tx) => {
    const slotRef = db().collection(COL.slots).doc(slotId);
    const claimRef = db().collection(COL.claims).doc(`${slotId}_${actor.userId}`);
    const [slotSnap, claimSnap] = await Promise.all([tx.get(slotRef), tx.get(claimRef)]);
    if (!slotSnap.exists || !claimSnap.exists) throw new UserError("You haven't claimed this slot.");
    const slot = { ...(slotSnap.data() as Omit<Slot, "id">), id: slotId };
    const claim = { ...(claimSnap.data() as Omit<Claim, "id">), id: claimSnap.id };
    if (claim.status !== "confirmed") throw new UserError("You haven't claimed this slot.");
    if (slot.startAt <= now) throw new UserError("This slot has already started. Message Sam if you can't make it.");
    const count = Math.max(0, slot.claimedCount - 1);
    const status = statusAfterCount(slot, count);
    tx.update(claimRef, { status: "withdrawn", withdrawnAt: now });
    tx.update(slotRef, { claimedCount: FieldValue.increment(-1), status, updatedAt: now });
    audit(tx, actor, "claim.withdraw", { slotId, claimId: claim.id });
    return { slot: { ...slot, claimedCount: count, status }, claim: { ...claim, status: "withdrawn", withdrawnAt: now } };
  });
}

export async function completeClaim(claim: Claim) {
  await db().runTransaction(async (tx) => {
    const ref = db().collection(COL.claims).doc(claim.id);
    const snap = await tx.get(ref);
    if (!snap.exists || (snap.data() as Claim).status !== "confirmed") return;
    tx.update(ref, { status: "completed" });
    audit(tx, SYSTEM, "claim.complete", { claimId: claim.id, slotId: claim.slotId, amountPence: claim.amountPence });
  });
}

export async function completeSlotIfDone(slotId: string, now: number) {
  await db().runTransaction(async (tx) => {
    const ref = db().collection(COL.slots).doc(slotId);
    const snap = await tx.get(ref);
    if (!snap.exists) return;
    const s = snap.data() as Slot;
    if ((s.status === "open" || s.status === "full") && s.endAt <= now) tx.update(ref, { status: "completed", updatedAt: now });
  });
}

/** Admin: flag (exclude from pay) or unflag a claim. */
export async function setClaimFlag(claimId: string, flagged: boolean, reason: string | null, actor: Actor) {
  if (!actor.admin) throw new UserError("Only Sam or Jamie can flag overtime.");
  await db().runTransaction(async (tx) => {
    const ref = db().collection(COL.claims).doc(claimId);
    const snap = await tx.get(ref);
    if (!snap.exists) throw new UserError("Not found.");
    if ((snap.data() as Claim).paidRunId) throw new UserError("Already paid, so it can't be changed here.");
    tx.update(ref, { flagged, flagReason: flagged ? reason || "Flagged" : null });
    audit(tx, actor, flagged ? "claim.flag" : "claim.unflag", { claimId, reason });
  });
}

// ---------- pay runs ----------

export async function getPayRun(id: string): Promise<PayRun | null> {
  const snap = await db().collection(COL.payRuns).doc(id).get();
  return snap.exists ? ({ ...(snap.data() as Omit<PayRun, "id">), id } as PayRun) : null;
}

/** Create this month's pay run once. Returns null if it already exists. */
export async function createPayRun(id: string, claims: Claim[], now = Date.now()): Promise<PayRun | null> {
  return db().runTransaction(async (tx) => {
    const ref = db().collection(COL.payRuns).doc(id);
    if ((await tx.get(ref)).exists) return null;
    const run: Omit<PayRun, "id"> = {
      createdAt: now,
      status: "awaiting_sam",
      claimIds: claims.map((c) => c.id),
      totalPence: claims.reduce((n, c) => n + c.amountPence, 0),
      approvedBy: null,
      approvedAt: null,
      sentBy: null,
      sentAt: null,
    };
    tx.create(ref, run);
    audit(tx, SYSTEM, "payrun.create", { payRunId: id, claimIds: run.claimIds, totalPence: run.totalPence });
    return { ...run, id };
  });
}

export async function approvePayRun(id: string, actor: Actor, now = Date.now()): Promise<PayRun> {
  return db().runTransaction(async (tx) => {
    const ref = db().collection(COL.payRuns).doc(id);
    const snap = await tx.get(ref);
    if (!snap.exists) throw new UserError("Pay run not found.");
    const run = { ...(snap.data() as Omit<PayRun, "id">), id };
    if (run.status !== "awaiting_sam") throw new UserError("This summary has already been approved.");
    tx.update(ref, { status: "awaiting_jamie", approvedBy: actor.name, approvedAt: now });
    audit(tx, actor, "payrun.approve", { payRunId: id });
    return { ...run, status: "awaiting_jamie", approvedBy: actor.name, approvedAt: now };
  });
}

/** Jamie has sent the figures to payroll: mark every claim in the run as paid. */
export async function markPayRunSent(id: string, actor: Actor, now = Date.now()): Promise<PayRun> {
  return db().runTransaction(async (tx) => {
    const ref = db().collection(COL.payRuns).doc(id);
    const snap = await tx.get(ref);
    if (!snap.exists) throw new UserError("Pay run not found.");
    const run = { ...(snap.data() as Omit<PayRun, "id">), id };
    if (run.status === "sent") throw new UserError("Already marked as sent.");
    if (run.status !== "awaiting_jamie") throw new UserError("Sam hasn't approved this summary yet.");
    for (const claimId of run.claimIds) tx.update(db().collection(COL.claims).doc(claimId), { paidRunId: id });
    tx.update(ref, { status: "sent", sentBy: actor.name, sentAt: now });
    audit(tx, actor, "payrun.sent", { payRunId: id, claimIds: run.claimIds });
    return { ...run, status: "sent", sentBy: actor.name, sentAt: now };
  });
}

// ---------- scheduler lock (FOMO engineering rule 2) ----------

export async function acquireLock(name: string, leaseMs: number): Promise<string | null> {
  const token = randomUUID();
  const ref = db().collection(COL.meta).doc(`lock_${name}`);
  const ok = await db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const cur = snap.data() as { token: string; until: number } | undefined;
    if (cur && cur.until > Date.now()) return false;
    tx.set(ref, { token, until: Date.now() + leaseMs });
    return true;
  });
  return ok ? token : null;
}

export async function releaseLock(name: string, token: string) {
  const ref = db().collection(COL.meta).doc(`lock_${name}`);
  await db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if ((snap.data() as { token?: string } | undefined)?.token === token) tx.delete(ref);
  });
}

export async function getMeta(key: string): Promise<Record<string, unknown> | null> {
  const snap = await db().collection(COL.meta).doc(key).get();
  return snap.exists ? (snap.data() as Record<string, unknown>) : null;
}

export async function setMeta(key: string, data: Record<string, unknown>) {
  await db().collection(COL.meta).doc(key).set(data, { merge: true });
}
