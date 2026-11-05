# One-off setup

Already done: Slack app installed and its two secrets added; `APP_URL`, `SLACK_OVERTIME_CHANNEL_ID`, `GOOGLE_WORKSPACE_DOMAIN`, `OVERTIME_LOCATION`, `CRON_SECRET`, `AUTH_SECRET` set in Vercel.

What's left is one Google service account that does two jobs: it stores the overtime data (in the same Firestore as the team dashboard) and writes calendar events. About 10 minutes. Never paste a key into Slack or a chat.

## 1. Make the service account

As built (5 Nov 2026): `overtime-app@clever-acolyte-298614.iam.gserviceaccount.com`, made in the clever-acolyte project, with **Cloud Datastore User** granted on fomo-bookings-board-v2 and the Calendar API enabled in clever-acolyte-298614. The steps below are for recreating it.

1. Open https://console.cloud.google.com/apis/library/calendar-json.googleapis.com?project=fomo-bookings-board-v2 and press **Enable** (skip if it says Manage).
2. Open https://console.cloud.google.com/iam-admin/serviceaccounts/create?project=fomo-bookings-board-v2
   - Name: `overtime-app` → **Create and continue**
   - Role: search for **Cloud Datastore User** and pick it → **Continue** → **Done**.
3. Click the new `overtime-app@…` account → **Keys** → **Add key** → **Create new key** → JSON → **Create**. A file downloads.
4. On its **Details** tab, copy the **Unique ID** (a long number).

## 2. Let it write to staff calendars (Google Workspace admin)
1. Open https://admin.google.com/ac/owl/domainwidedelegation → **Add new**.
2. Client ID: the Unique ID from 1.4.
3. OAuth scopes (paste exactly, one line):
   `https://www.googleapis.com/auth/calendar.events,https://www.googleapis.com/auth/calendar.freebusy`
4. **Authorise**.

It can add and remove calendar events and see busy/free times. It can't read email, documents or event details.

## 3. Put the key in Vercel
1. On your Mac, in Terminal: `base64 -i ~/Downloads/fomo-bookings-board-v2-*.json | pbcopy` (copies it).
2. Vercel → **fomo-overtime** → Settings → Environment Variables → **Add**: name `GOOGLE_SERVICE_ACCOUNT_BASE64`, paste, Production, **Sensitive** on → Save.
3. Delete the downloaded JSON file.
4. Tell Claude. It redeploys and runs the test.

Optional: `SENTRY_DSN` (Sentry → project → Settings → Client Keys) so errors reach Sentry, as in the other apps.

## The admin page
No separate login: Sam and Jamie open it from the **Admin page** button on the Overtime app's Home tab in Slack (the link lasts 12 hours). The month-end messages carry their own links too.
