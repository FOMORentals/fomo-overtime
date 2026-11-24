# Overtime tracker: agreed design (5 Nov 2026)

Agreed with Jamie in a grill-me interview on Sam's "Overtime Tracker: Project Brief". Sam's pain points: overtime posted but never claimed; claimed but forgotten; adding up earnings is laborious.

## App card
Approved by Jamie, 24 Nov 2026. #app-requests uses this card to tell which app a request belongs to; a request
for something under "Must never" goes against Jamie's decision, so it goes to Jamie as a proposal. Change it
only with Jamie's OK, in the same pull request as the change.

- **What it's for:** Overtime slots in #rentals_overtime: post, claim, give away; the admin page and CSV.
- **Who uses it:** The whole team; admins Sam and Jamie.
- **Must never:** Change what anyone is paid; let someone claim a slot for someone else.
- **Belongs elsewhere:** Rotas and holidays (not an app yet).

## Design

**Where it lives.** Slack (#rentals_overtime), because that's where the team already works. A small web page (`/admin`) is only for Sam and Jamie: monthly view, flagging, CSV. They open it from a signed link in the Slack app (no separate login).

**Who.** Sam, Louis, Rosie, Will, Margarita, plus Jamie. Admins: Sam and Jamie. Matched by fomorentals.co.uk email (`lib/staff.ts`).

**Posting.** Anyone runs `/overtime` (or "Post overtime" on the app's Home tab): type (Early opening, Late closing, Weekend opening, Weekend closing, Other), client/job, date, a single time typed to the minute (e.g. 17:35; Sam, 6 Nov: no end time and no Rentman number, slots count as 30 minutes for clash checks and calendars), fee in £ or Free, people needed, notes, and for slots starting before 9am an optional leave-early time. The slot is posted to the channel with Claim / Withdraw buttons and an Edit / Cancel menu (poster or admin).

**Free slots.** Sam: "Free are unpaid overtime opportunities, mostly between 8am and 7pm, or before or after other overtime slots" (only the first of two back-to-back slots is paid). So any time is allowed, the poster sets the fee, and INCLUDED is treated as Free. Two paid slots one person does within an hour of each other are flagged in the month-end summary for Sam to check, unless they overlap (18 Nov 2026, Jamie, via #app-requests: overlapping slots someone confirmed are both paid as posted and not flagged).

**Claiming.** One click, first come first served (transaction: two people can't take the last space). Overlapping overtime is a warning, not a block (18 Nov 2026, Jamie, via #app-requests; replaces "Overlapping overtime is blocked", 5 Nov): the person sees "You already have overtime booked at that time. Are you sure?" and can press *Yes, claim both*. They are then on both slots, each paid at its posted fee, each its own event in their calendar and on the team calendar. The same warning and confirm applies when taking a slot someone gives away. Audit rows note `clashConfirmed`. A busy Google Calendar is a warning only. On slots with a leave-early time the person chooses Paid, or Leave early (£0, calendar runs from arrival to the leave time).

**Calendar.** Event added to the person's Google Calendar on claim (service account with domain-wide delegation, one approval for the domain), updated on edits, removed on withdraw/cancel.

**Reminders.** DM at 5pm the day before; also 1 hour before for starts before 8am. Unclaimed slots: reposted in the channel at noon two days before; Sam and the poster DM'd at 4pm the same day if still empty.

**Work the time instead (6 Nov, Sam).** Anyone claiming a paid slot chooses Paid, or work the time instead (£0). The poster can optionally add a leave time for slots before 9am, which then goes in the choice and the calendar. Free slots skip the choice. The post shows the option only while a space is still open; once taken, the name shows "(working the time instead)" if that was picked, otherwise it is paid (9 Nov, Louis).

**Admins can switch Paid and Time instead (23 Nov 2026, Jamie, via #app-requests from Sam).** On the admin page each team member's shift on a paid slot has a *Switch to Paid* / *Switch to Time instead* button. Paid uses the slot's posted fee; Time instead is £0 and, where the slot has a leave time, the calendar runs to it. The person gets a Slack DM, their calendar, the slot post and their Home tab are updated, and the switch is logged (`claim.switch_route`, who and when). Allowed until Jamie presses "Sent to payroll", then locked. Free slots and freelancer rows have no switch. If a month-end summary not yet sent includes the shift and it becomes Time instead, it is taken out of that summary and its total lowered; a shift switched to Paid after the summary was made goes in the next month's summary.

**Freelancers (9 Nov, Louis).** The poster or an admin can pick "Assign to a freelancer" on a post's ⋮ menu and type a name (e.g. Eden). It takes a space like a claim and shows on the post, the team calendar and the round-up, marked "(freelancer)". Freelancers aren't on Slack, so they get no DMs or reminders. An optional email (added 9 Nov, Jamie) sends them a Google Calendar invite from the assigner's own calendar (sendUpdates=all, so edits and cancellations reach them too); assigning the same name again with an email adds it later. Without an email there's no invite, and they're paid outside overtime payroll (£0 here, never in the month-end summary). "Remove freelancer" frees the space. Audit: `claim.assign_freelancer`, `claim.remove_freelancer`. The admin page shows the slot fee on a freelancer's row ("Invoices" tag) and a freelancer subtotal under Totals, so Sam can check it against their invoice; it never joins the payroll totals (11 Nov, Sam).

**Give away (added 6 Nov).** Someone on a slot can press *Give away* on the post and pick a colleague. The colleague gets a DM with *Take it* / *No thanks*. The giver stays on the slot until it's accepted; on accept the claim moves across in one transaction (spaces unchanged, same paid/leave-early route, the taker's clash check applies), calendars move, both are told. Not treated as a drop-out, so no Sam alert. Audit: `claim.offer`, `claim.offer_decline`, `claim.swap`.

**Shared team calendar (added 6 Nov).** A "FOMO Overtime" Google Calendar owned by Jamie and shared with the team shows every slot: red "OPEN" while a space is free, green with names once covered, removed if cancelled. Events are "free" time so nobody looks busy. Kept in step on every change; the 15-minute cron catches up anything missed. Off until `OT_TEAM_CALENDAR_ID` is set.

**Monday round-up (added 6 Nov).** Mondays from 8am, one message in #rentals_overtime listing this week's slots (Mon to Sun), who's on each and how many spaces are open.

**Drop-outs.** Withdraw freely until 48 hours before. After that it's still allowed, but the slot is reposted and Sam is alerted.

**Earnings.** A finished shift counts automatically unless an admin flags it. Each person sees upcoming overtime and earnings by month on the Home tab or with `/overtime me`.

**Month end.** At 9am on the Monday before pay day (final Friday), Sam is DM'd a per-person summary of all finished, unpaid overtime up to then. He approves it, it goes to Jamie with a CSV link for Mark Pearson's team, and when Jamie presses "Sent to payroll" everything in it is marked paid. Note: overtime worked between the summary and month end lands in the next month's summary (same as today's "no 💲 yet" approach).

**Audit.** Every create, claim, withdraw, edit, cancel, completion, flag and pay-run step is written to `ot_audit` with who and when.

**Not in v1.** Payroll integration (export only). Rentman-suggested slots. Rentman job numbers (removed from the form on 6 Nov at Sam's request).
