import { revalidatePath } from "next/cache";
import { adminEmail } from "@/lib/admin-session";
import { COL, db } from "@/lib/firestore";
import { money, pairedSlotWarnings, totalsByPerson } from "@/lib/rules";
import { staffByEmail } from "@/lib/staff";
import { claimsInMonth, getPayRun, liveSlots, setClaimFlag, type Actor } from "@/lib/store";
import { finalFriday, londonParts, monthLabel, prettyDate } from "@/lib/time";
import type { Claim } from "@/lib/types";

export const dynamic = "force-dynamic";

async function adminActor(): Promise<Actor> {
  const staff = staffByEmail(await adminEmail());
  if (!staff?.admin) throw new Error("Admins only");
  return { userId: `web:${staff.email}`, email: staff.email, name: staff.name, admin: true };
}

async function flagAction(form: FormData) {
  "use server";
  const actor = await adminActor();
  await setClaimFlag(String(form.get("claimId")), true, String(form.get("reason") || "Didn't happen"), actor);
  revalidatePath("/admin");
}

async function unflagAction(form: FormData) {
  "use server";
  const actor = await adminActor();
  await setClaimFlag(String(form.get("claimId")), false, null, actor);
  revalidatePath("/admin");
}

/** Server component: the time of this request. */
async function requestTime() {
  return Date.now();
}

function shiftMonth(month: string, delta: number) {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return d.toISOString().slice(0, 7);
}

function state(c: Claim, now: number) {
  if (c.status === "withdrawn") return <span className="pill">withdrawn</span>;
  if (c.status === "cancelled") return <span className="pill">cancelled</span>;
  if (c.paidRunId) return <span className="pill ok">paid ({c.paidRunId})</span>;
  if (c.flagged) return <span className="pill bad">flagged: {c.flagReason}</span>;
  if (c.status === "completed" || c.endAt <= now) return <span className="pill">done, unpaid</span>;
  return <span className="pill">upcoming</span>;
}

export default async function Admin({ searchParams }: { searchParams: Promise<{ month?: string }> }) {
  const email = await adminEmail();
  if (!email)
    return (
      <main>
        <h1>FOMO Overtime</h1>
        <p className="muted">
          This page is for Sam and Jamie. Open it from the <b>Admin page</b> button on the Overtime app&apos;s Home tab in Slack
          (links last 12 hours).
        </p>
      </main>
    );

  const now = await requestTime();
  const thisMonth = londonParts(now).date.slice(0, 7);
  const sp = await searchParams;
  const month = sp.month && /^\d{4}-\d{2}$/.test(sp.month) ? sp.month : thisMonth;
  const [all, slots, run, tickSnap] = await Promise.all([
    claimsInMonth(month),
    liveSlots(now),
    getPayRun(month),
    db().collection(COL.meta).doc("tick").get(),
  ]);
  const counted = all.filter((c) => c.status === "completed" || (c.status === "confirmed" && c.endAt <= now));
  const payable = counted.filter((c) => !c.flagged && c.amountPence > 0);
  const totals = totalsByPerson(payable);
  const warnings = pairedSlotWarnings(payable);
  const tick = tickSnap.data() as { lastRunAt?: number; lastSuccessAt?: number; lastFailures?: number } | undefined;
  const tickAgeMin = tick?.lastSuccessAt ? Math.round((now - tick.lastSuccessAt) / 60000) : null;
  const calendarProblems = all.filter((c) => c.calendarError && c.status === "confirmed");

  return (
    <main>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <div>
          <h1>Overtime · {monthLabel(month)}</h1>
          <div className="muted">
            Pay day {prettyDate(finalFriday(month))}.{" "}
            {run ? `Pay run: ${run.status.replace("_", " ")} (${money(run.totalPence)}).` : "Month-end summary not sent yet."}
          </div>
        </div>
        <div className="row">
          <a className="btn" href={`/admin?month=${shiftMonth(month, -1)}`}>← {monthLabel(shiftMonth(month, -1))}</a>
          {month !== thisMonth && <a className="btn" href={`/admin?month=${shiftMonth(month, 1)}`}>{monthLabel(shiftMonth(month, 1))} →</a>}
          <a className="btn" href={`/api/export?month=${month}`}>Download CSV</a>
        </div>
      </div>

      <p className={tickAgeMin === null || tickAgeMin > 40 || (tick?.lastFailures ?? 0) > 0 ? "bad" : "muted"}>
        Reminders and checks last ran OK {tickAgeMin === null ? "never" : `${tickAgeMin} min ago`}
        {(tick?.lastFailures ?? 0) > 0 ? `; the latest run had ${tick?.lastFailures} problem(s), see Sentry.` : "."}
      </p>

      <h2>Totals (finished, not flagged)</h2>
      <div className="scroll">
        <table>
          <thead><tr><th>Person</th><th className="num">Slots</th><th className="num">Total</th></tr></thead>
          <tbody>
            {totals.map((t) => (
              <tr key={t.userId}><td>{t.name}</td><td className="num">{t.claims.length}</td><td className="num">{money(t.totalPence)}</td></tr>
            ))}
            {!totals.length && <tr><td colSpan={3} className="muted">Nothing paid yet this month.</td></tr>}
          </tbody>
        </table>
      </div>

      {warnings.length > 0 && (
        <>
          <h2 className="warn">Check these: two paid slots within an hour</h2>
          <ul>
            {warnings.map((w) => (
              <li key={w.a.id + w.b.id}>{w.a.name}: {w.a.slotLabel} and {w.b.slotLabel} on {prettyDate(w.a.date)}. Flag one if only one should be paid.</li>
            ))}
          </ul>
        </>
      )}

      {calendarProblems.length > 0 && (
        <>
          <h2 className="bad">Calendar problems</h2>
          <ul>{calendarProblems.map((c) => <li key={c.id}>{c.name}: {c.slotLabel} on {prettyDate(c.date)}. {c.calendarError}</li>)}</ul>
        </>
      )}

      <h2>Every claim this month</h2>
      <div className="scroll">
        <table>
          <thead><tr><th>Date</th><th>Person</th><th>Slot</th><th className="num">Amount</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {all.map((c) => (
              <tr key={c.id}>
                <td>{prettyDate(c.date)} {londonParts(c.startAt).time}</td>
                <td>{c.name}</td>
                <td>{c.slotLabel}{c.route === "early_finish" ? " (leave early)" : ""}</td>
                <td className="num">{money(c.amountPence)}</td>
                <td>{state(c, now)}</td>
                <td>
                  {!c.paidRunId && (c.status === "completed" || c.status === "confirmed") &&
                    (c.flagged ? (
                      <form action={unflagAction}><input type="hidden" name="claimId" value={c.id} /><button>Unflag</button></form>
                    ) : (
                      <form action={flagAction} className="row">
                        <input type="hidden" name="claimId" value={c.id} />
                        <input type="text" name="reason" placeholder="Reason" />
                        <button>Flag</button>
                      </form>
                    ))}
                </td>
              </tr>
            ))}
            {!all.length && <tr><td colSpan={6} className="muted">No claims this month.</td></tr>}
          </tbody>
        </table>
      </div>

      <h2>Upcoming slots</h2>
      <div className="scroll">
        <table>
          <thead><tr><th>When</th><th>Slot</th><th className="num">Fee</th><th>Claimed</th></tr></thead>
          <tbody>
            {slots.filter((s) => s.startAt > now).map((s) => (
              <tr key={s.id}>
                <td>{prettyDate(s.date)} {s.startTime}</td>
                <td>{s.kind} · {s.title}</td>
                <td className="num">{money(s.feePence)}</td>
                <td className={s.claimedCount < s.spaces ? "warn" : "ok"}>{s.claimedCount} of {s.spaces}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted">Signed in as {email}. Flagging leaves a slot out of pay; every change is logged.</p>
    </main>
  );
}
