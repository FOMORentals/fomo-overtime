# Overtime tracker: agreed design (5 Nov 2026)

Agreed with Jamie in a grill-me interview on Sam's "Overtime Tracker: Project Brief". Sam's pain points: overtime posted but never claimed; claimed but forgotten; adding up earnings is laborious.

**Where it lives.** Slack (#rentals_overtime), because that's where the team already works. A small web page (`/admin`) is only for Sam and Jamie: monthly view, flagging, CSV. They open it from a signed link in the Slack app (no separate login).

**Who.** Sam, Louis, Rosie, Will, Margarita, plus Jamie. Admins: Sam and Jamie. Matched by fomorentals.co.uk email (`lib/staff.ts`).

**Posting.** Anyone runs `/overtime` (or "Post overtime" on the app's Home tab): type, client/job, Rentman job number, date, start and end (any time of day; an end before the start runs past midnight), fee in £ or Free, people needed, notes, and for slots starting before 9am an optional leave-early time. The slot is posted to the channel with Claim / Withdraw buttons and an Edit / Cancel menu (poster or admin).

**Free slots.** Sam: "Free are unpaid overtime opportunities, mostly between 8am and 7pm, or before or after other overtime slots" (only the first of two back-to-back slots is paid). So any time is allowed, the poster sets the fee, and INCLUDED is treated as Free. Two paid slots one person does within an hour of each other are flagged in the month-end summary for Sam to check.

**Claiming.** One click, first come first served (transaction: two people can't take the last space). Overlapping overtime is blocked. A busy Google Calendar is a warning only. On slots with a leave-early time the person chooses Paid, or Leave early (£0, calendar runs from arrival to the leave time).

**Calendar.** Event added to the person's Google Calendar on claim (service account with domain-wide delegation, one approval for the domain), updated on edits, removed on withdraw/cancel.

**Reminders.** DM at 5pm the day before; also 1 hour before for starts before 8am. Unclaimed slots: reposted in the channel at noon two days before; Sam and the poster DM'd at 4pm the same day if still empty.

**Give away (added 6 Nov).** Someone on a slot can press *Give away* on the post and pick a colleague. The colleague gets a DM with *Take it* / *No thanks*. The giver stays on the slot until it's accepted; on accept the claim moves across in one transaction (spaces unchanged, same paid/leave-early route, the taker's clash check applies), calendars move, both are told. Not treated as a drop-out, so no Sam alert. Audit: `claim.offer`, `claim.offer_decline`, `claim.swap`.

**Shared team calendar (added 6 Nov).** A "FOMO Overtime" Google Calendar owned by Jamie and shared with the team shows every slot: red "OPEN" while a space is free, green with names once covered, removed if cancelled. Events are "free" time so nobody looks busy. Kept in step on every change; the 15-minute cron catches up anything missed. Off until `OT_TEAM_CALENDAR_ID` is set.

**Monday round-up (added 6 Nov).** Mondays from 8am, one message in #rentals_overtime listing this week's slots (Mon to Sun), who's on each and how many spaces are open.

**Drop-outs.** Withdraw freely until 48 hours before. After that it's still allowed, but the slot is reposted and Sam is alerted.

**Earnings.** A finished shift counts automatically unless an admin flags it. Each person sees upcoming overtime and earnings by month on the Home tab or with `/overtime me`.

**Month end.** At 9am on the Monday before pay day (final Friday), Sam is DM'd a per-person summary of all finished, unpaid overtime up to then. He approves it, it goes to Jamie with a CSV link for Mark Pearson's team, and when Jamie presses "Sent to payroll" everything in it is marked paid. Note: overtime worked between the summary and month end lands in the next month's summary (same as today's "no 💲 yet" approach).

**Audit.** Every create, claim, withdraw, edit, cancel, completion, flag and pay-run step is written to `ot_audit` with who and when.

**Not in v1.** Payroll integration (export only). Rentman-suggested slots. Rentman job numbers are shown as text, not links (a link needs Rentman's internal project id, which would mean extra Rentman API calls).
