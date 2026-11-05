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
