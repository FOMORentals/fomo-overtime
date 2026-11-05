# One-off setup (about 20 minutes)

Do these in order. Nothing here touches the existing apps. Never paste a secret into Slack or a chat: only into the Vercel or Google screens named below.

## 1. Google: calendar access (10 min)

**a. Make the service account** (Google Cloud, project *fomo-bookings-board-v2*)
1. Open https://console.cloud.google.com/apis/library/calendar-json.googleapis.com?project=fomo-bookings-board-v2 and press **Enable**.
2. Open https://console.cloud.google.com/iam-admin/serviceaccounts/create?project=fomo-bookings-board-v2
   - Name: `overtime-calendar` → **Create and continue** → skip roles → **Done**.
3. Click the new `overtime-calendar@…` account → **Keys** → **Add key** → **Create new key** → JSON → **Create**. A file downloads.
4. On the **Details** tab copy the **Unique ID** (a long number). You need it in step b.

**b. Approve it for the domain** (Google Workspace admin)
1. Open https://admin.google.com/ac/owl/domainwidedelegation → **Add new**.
2. Client ID: the Unique ID from a4.
3. OAuth scopes (paste exactly, one line):
   `https://www.googleapis.com/auth/calendar.events,https://www.googleapis.com/auth/calendar.freebusy`
4. **Authorise**.

This lets the app add and remove events in staff calendars. It can't read email or anything else.

## 2. Slack: install the app (5 min)
1. Open https://api.slack.com/apps → **Create New App** → **From a manifest** → pick the FOMO workspace.
2. Paste `docs/slack-app-manifest.yml`, with `APP_URL` replaced by `https://fomo-overtime.vercel.app` (4 places). **Next** → **Create**.
3. **Install to Workspace** → Allow.
4. Copy two values for step 3: **OAuth & Permissions → Bot User OAuth Token** (starts `xoxb-`), and **Basic Information → Signing Secret**.
5. In Slack, in #rentals_overtime, type `/invite @Overtime`.

## 3. Vercel: add the secrets (5 min)
Vercel → **fomo-overtime** → Settings → Environment Variables (Production). Add:

| Name | Value |
|---|---|
| `SLACK_BOT_TOKEN` | from 2.4 |
| `SLACK_SIGNING_SECRET` | from 2.4 |
| `GOOGLE_CALENDAR_SA_BASE64` | the JSON key file from 1a.3, base64-encoded (on a Mac: `base64 -i ~/Downloads/<file>.json \| pbcopy`, then paste) |
| `FIREBASE_SERVICE_ACCOUNT_BASE64` | copy the same variable from the **fomo-bookings-board-v2** Vercel project |
| `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET` | copy from the bookings board project, then add `https://fomo-overtime.vercel.app/api/auth/callback/google` to that OAuth client's redirect URIs (Google Cloud → APIs & Services → Credentials) |
| `SENTRY_DSN` | copy from the bookings board project |

Already set by Claude: `APP_URL`, `SLACK_OVERTIME_CHANNEL_ID`, `GOOGLE_WORKSPACE_DOMAIN`, `OVERTIME_LOCATION`, `CRON_SECRET`, `AUTH_SECRET`.

Then **Deployments → Redeploy**.

## 4. Check it works
1. In Slack type `/overtime`, post a test slot for tomorrow, claim it, check it lands in your calendar, then withdraw and cancel it.
2. Open https://fomo-overtime.vercel.app/admin and sign in with Google.
