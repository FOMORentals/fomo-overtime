/** The "Claims this month" section of the admin page, grouped by what Sam needs to do with each claim. */
import { money } from "@/lib/rules";
import { londonParts } from "@/lib/time";
import type { Claim } from "@/lib/types";

type FormAction = ((form: FormData) => Promise<void>) | string;

const DAY = new Intl.DateTimeFormat("en-GB", { weekday: "short", timeZone: "Europe/London" });
const DATE = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "Europe/London" });

/** "Weekend opening · Flair - 11772" → kind and client. */
function splitLabel(label: string) {
  const [kind, ...rest] = label.split(" · ");
  return { kind, client: rest.join(" · ") };
}

function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("");
}

export type ClaimGroup = "due" | "upcoming" | "flagged" | "paid" | "dropped";

export function groupOf(c: Claim, now: number): ClaimGroup {
  if (c.status === "withdrawn" || c.status === "cancelled") return "dropped";
  if (c.paidRunId) return "paid";
  if (c.flagged) return "flagged";
  if (c.status === "completed" || c.endAt <= now) return "due";
  return "upcoming";
}

function Row({ c, now, flagAction, unflagAction }: { c: Claim; now: number; flagAction: FormAction; unflagAction: FormAction }) {
  const { kind, client } = splitLabel(c.slotLabel);
  const g = groupOf(c, now);
  const timeInstead = c.route === "early_finish";
  // Only claims that cost money can be left out of pay (time-instead and free ones have nothing to leave out).
  const canChange = !c.paidRunId && (c.status === "completed" || c.status === "confirmed") && (c.amountPence > 0 || c.flagged);
  return (
    <li className={`claim ${g}`}>
      <div className="when">
        <span className="day">{DAY.format(c.startAt)} {DATE.format(c.startAt)}</span>
        <span className="time">{londonParts(c.startAt).time}</span>
      </div>
      <div className="who">
        <span className="avatar" aria-hidden>{initials(c.name)}</span>
        <span>{c.name}{c.freelancer ? <span className="muted"> (freelancer)</span> : null}</span>
      </div>
      <div className="what">
        <span className="kind">{kind}</span>
        <span className="client">{client}</span>
      </div>
      <div className="amount">
        {timeInstead ? <span className="tag calm">Time instead</span> : c.amountPence > 0 ? money(c.amountPence) : <span className="muted">Free</span>}
      </div>
      <div className="act">
        {g === "flagged" && <div className="flag-reason">Left out of pay: {c.flagReason}</div>}
        {g === "paid" && <span className="tag good">Paid · {c.paidRunId}</span>}
        {g === "dropped" && <span className="tag">{c.status === "withdrawn" ? "Withdrawn" : "Cancelled"}</span>}
        {canChange && c.flagged && (
          <form action={unflagAction}>
            <input type="hidden" name="claimId" value={c.id} />
            <button>Put back in pay</button>
          </form>
        )}
        {canChange && !c.flagged && (
          <details className="flagger">
            <summary>Leave out of pay</summary>
            <form action={flagAction}>
              <input type="hidden" name="claimId" value={c.id} />
              <input type="text" name="reason" placeholder="Why? e.g. didn't happen" />
              <button className="danger">Leave out</button>
            </form>
          </details>
        )}
      </div>
    </li>
  );
}

function Group({ title, note, claims, ...rest }: {
  title: string; note?: string; claims: Claim[]; now: number; flagAction: FormAction; unflagAction: FormAction;
}) {
  if (!claims.length) return null;
  return (
    <section className="group">
      <h3>{title} <span className="count">{claims.length}</span>{note ? <span className="muted"> · {note}</span> : null}</h3>
      <ul className="claims">{claims.map((c) => <Row key={c.id} c={c} {...rest} />)}</ul>
    </section>
  );
}

export function ClaimsList({ claims, now, flagAction, unflagAction }: {
  claims: Claim[]; now: number; flagAction: FormAction; unflagAction: FormAction;
}) {
  const by = (g: ClaimGroup) => claims.filter((c) => groupOf(c, now) === g).sort((a, b) => a.startAt - b.startAt);
  const due = by("due");
  const dueTotal = due.filter((c) => c.amountPence > 0).reduce((t, c) => t + c.amountPence, 0);
  const dropped = by("dropped");
  const props = { now, flagAction, unflagAction };
  if (!claims.length) return <p className="muted">No claims this month.</p>;
  return (
    <div>
      <Group title="Done, to be paid" note={`${money(dueTotal)} so far`} claims={due} {...props} />
      <Group title="Left out of pay" claims={by("flagged")} {...props} />
      <Group title="Coming up" claims={by("upcoming")} {...props} />
      <Group title="Already paid" claims={by("paid")} {...props} />
      {dropped.length > 0 && (
        <details className="dropped">
          <summary>{dropped.length} withdrawn or cancelled</summary>
          <ul className="claims">{dropped.map((c) => <Row key={c.id} c={c} {...props} />)}</ul>
        </details>
      )}
    </div>
  );
}
