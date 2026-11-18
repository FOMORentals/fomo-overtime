# fomo-overtime

Read `../FOMO-ENGINEERING-RULES.md` first (and the guidelines it points to). Jamie is not an engineer: explain in business terms.

What this is: the FOMO London team's overtime tracker, Slack-first. Designed with Jamie on 5 Nov 2026 from Sam Knight's brief. Decisions are in `docs/DESIGN.md`; keep it current.

- `lib/rules.ts` all business rules, pure and tested (`npm test`).
- `lib/store.ts` Firestore reads/writes. Claims/withdrawals/edits/cancels are transactions; every change writes `ot_audit`. Tested against the emulator with `npm run test:db` (needs `npx firebase emulators:start --only firestore --project demo-ot`).
- `lib/handlers.ts` Slack buttons/forms/command; `lib/actions.ts` side effects (Slack messages, calendar, DMs); `lib/tick.ts` the 15-minute cron.
- `app/admin` admin page (Sam, Jamie) with CSV export.
- Staff list and admins: `lib/staff.ts`.

External calls: Slack, Google Calendar, Firestore. No Rentman, HubSpot or Xero calls; keep it that way unless Jamie decides otherwise (rule 4).
Before saying done: `npm test`, `npm run test:db`, `npm run lint`, `npm run build`.

Every PR description has a `## Team note` section (see `.github/pull_request_template.md`). It is what the team reads in Slack #whats-new (repo FOMORentals/fomo-whats-new): a headline, what changed, what they do differently, a picture added in the same PR under `whats-new/`, always (a screenshot, or a mock-up or diagram/workflow when there is nothing to screenshot; "to follow" and "None" are not accepted, and the "Team note picture" check fails without one), and a link or command to try it. Few words, plain English. Write `None` when the team won't notice the change.

## Design notes
Jamie's decisions for this app are in `docs/DESIGN.md`, with who made each and when. Claude reads it at every #app-requests request, so it must be current: when a decision is made or changed (in a pull request, in a chat with Jamie, anywhere), write it there the same day (rule 7). Every pull request either updates it or says under `## Design notes` "No decision changed: <why>"; the "Design notes" check fails otherwise.
