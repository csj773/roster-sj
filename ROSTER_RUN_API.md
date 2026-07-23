# Roster Run API

Use this endpoint when FlutterFlow collects a personal CrewConnex ID/password
and runs the existing `roster.js` mapping flow.

## Vercel API -> GitHub Actions

Use this endpoint when FlutterFlow should trigger GitHub Actions instead of
running Puppeteer on Render.

### Vercel Environment Variables

Set these in Vercel:

```text
ROSTER_API_KEY=<long random value>
GITHUB_TOKEN=<GitHub token with Actions workflow dispatch permission>
GITHUB_REPO=csj773/roster-sj
GITHUB_WORKFLOW_FILE=update-roster.yml
CORS_ORIGINS=https://your-flutterflow-app.web.app,https://your-flutterflow-app.firebaseapp.com
```

### FlutterFlow API Call

Method:

```text
POST
```

URL:

```text
https://<your-vercel-project>.vercel.app/api/runRoster
```

Headers:

```text
Content-Type: application/json
x-api-key: <ROSTER_API_KEY value>
```

Body:

```json
{
  "username": "<CrewConnex ID>",
  "password": "<CrewConnex password>",
  "currentUserUid": "<Firebase Authentication UID>",
  "currentUserEmail": "<Firebase Authentication email>"
}
```

The Vercel function only queues `.github/workflows/update-roster.yml`.
`roster.js` still runs inside GitHub Actions.

## Render Environment Variables

Set these in Render for the `roster-sj` service:

```text
ROSTER_API_KEY=<long random value>
CORS_ORIGINS=https://your-flutterflow-app.web.app,https://your-flutterflow-app.firebaseapp.com
```

The server also needs the existing automation secrets:

```text
FIREBASE_SERVICE_ACCOUNT
FIREBASE_UID
ADMIN_FIREBASE_UID
GOOGLE_SHEETS_CREDENTIALS
GOOGLE_CALENDAR_ID
GOOGLE_CALENDAR_CREDENTIALS
USER_ID
```

Kakao Talk Calendar sync is intentionally separated from `Update Roster &
Google Calendar`. Run the separate `Update Kakao Calendar` workflow only when
you want to write roster events to Kakao Talk Calendar.

Optional Kakao Talk Calendar sync needs these GitHub Actions secrets:

```text
KAKAO_REFRESH_TOKEN
KAKAO_REST_API_KEY
KAKAO_CLIENT_SECRET
KAKAO_CALENDAR_ID=primary
```

`KAKAO_CALENDAR_ID` may be omitted to use the user's primary Talk Calendar.
The Kakao access token must be issued with Talk Calendar event permission
(`talk_calendar`) for the Kakao Developers app.
`KAKAO_CLIENT_SECRET` is only required when the Kakao app's client secret
setting is enabled. `KAKAO_CALENDAR_ACCESS_TOKEN` can be used instead of
refresh-token renewal for short manual tests, but it expires quickly.

To issue the Kakao refresh token, open this URL after deploying the API:

```text
https://<your-vercel-project>.vercel.app/api/kakaoStart?calendarToken=1
```

After Kakao Login consent, the callback page displays `KAKAO_REFRESH_TOKEN`.
The Kakao Developers app must have the `talk_calendar` consent item enabled
or approved.

## Kakao C/I Reminder

`Kakao CI Reminder` is a separate scheduled GitHub Actions workflow. It checks
Firestore roster records every 15 minutes and sends a KakaoTalk "memo to me"
message 3 hours before each flight `C/I(L)` time. Sent reminders are recorded
in the `kakao_ci_reminders` Firestore collection to prevent duplicate messages.

This workflow also uses the Kakao secrets above. The Kakao refresh token must
include the `talk_calendar` and `talk_message` scopes. To issue or renew a
token with both scopes, open this URL after deploying the API:

```text
https://<your-vercel-project>.vercel.app/api/kakaoStart?calendarToken=1&messageToken=1
```

## Roster Share MVP APIs

These Vercel APIs support explicit roster sharing between signed-in users.
They use Firebase ID tokens in the `Authorization` header and write sharing
state to Firestore with the Firebase Admin SDK.

### Create Share Invite

```text
POST /api/shareInvite
Authorization: Bearer <Firebase ID token>
Content-Type: application/json
```

```json
{
  "scope": "layover_only",
  "expiresInDays": 14,
  "note": "Share my roster with this crew friend.",
  "recipientEmail": "friend@example.com",
  "confirmationRequired": true
}
```

Response includes `inviteCode` and `inviteUrl`.
When `recipientEmail` is provided, the invite records `deliveryMethod: "email"`
and starts with `confirmationStatus: "pending"`.

Invite email delivery uses Resend when these Vercel environment variables are
configured:

```text
RESEND_API_KEY=<Resend API key>
RESEND_FROM_EMAIL=Roster Share <verified-sender@example.com>
RESEND_REPLY_TO=optional-reply-address@example.com
```

For a quick Resend test, `RESEND_FROM_EMAIL` can be omitted to use
`Roster Share <onboarding@resend.dev>`, but production delivery should use a
verified sender/domain. The create response includes `emailSent`,
`emailStatus`, `emailProvider`, and `resendEmailId`. If Resend is not
configured or delivery fails, the invite link is still created and the email
status is saved on the invite document.

### Accept Share Invite

```text
POST /api/acceptShareInvite
Authorization: Bearer <Firebase ID token>
Content-Type: application/json
```

```json
{
  "inviteCode": "<inviteCode>",
  "mutual": true
}
```

This creates `roster_shares` records. With `mutual: true`, both users share
their roster with each other.
Accepting an invite updates the invite confirmation fields to
`confirmationStatus: "accepted"` and `confirmed: true`.

### Accept Share Invite By Code

```text
POST /api/acceptShareInviteByCode
Content-Type: application/json
```

```json
{
  "inviteCode": "<inviteCode>"
}
```

This public endpoint accepts the invite with the invite code only. It is used
by the Vercel `/roster-share?invite=...` landing page so invitees do not need
to go through FlutterFlow. The accepted user is recorded as
`guest_<inviteCode>`, and the invite confirmation fields are updated to
`confirmationStatus: "accepted"` and `confirmed: true`.

### Public Share Invite Status

```text
GET /api/publicShareInviteStatus?invite=<inviteCode>
```

Returns invite status and confirmation status for anyone holding the invite
code.

### Check Share Invite Confirmation

```text
GET /api/shareInviteStatus?inviteCode=<inviteCode>
Authorization: Bearer <Firebase ID token>
```

Only the invite owner or the accepted user can read the status. The response
includes `status`, `deliveryMethod`, `recipientEmail`, `confirmationRequired`,
`confirmationStatus`, `confirmed`, `confirmedByUid`, `confirmedAt`,
`emailStatus`, `emailSent`, and `emailSentAt`.

### Read Shared Calendar and Layovers

```text
GET /api/sharedRoster?startDate=2026-07-22&days=14&station=HNL&mode=layover
Authorization: Bearer <Firebase ID token>
```

The response includes:

- `items`: the signed-in user's roster plus rosters shared with them
- `layovers`: station/date grouped crew presence data for layover screens

Firestore collections used:

- `roster_share_invites`
- `roster_shares`
- `roster_friendships`

## Slack Roster Bot

Slack slash commands can create roster share invite links and look up shared
layover crew without building additional FlutterFlow pages.
The `/roster-share` response includes copy-ready text for Slack DM/channel
sharing and an HTTPS email-compose button that redirects to `mailto:` so the
user can send the invite link through their existing Gmail/Yahoo/Mail app
without Resend domain verification. Because `mailto:` creates a plain email,
the message includes plain accept/status/channel URLs instead of embedded HTML
buttons.

Endpoint:

```text
POST /api/slackCommand
```

Slack commands:

```text
/roster-share
/roster-share friend@example.com
/roster-share link-me
/roster-share import webcal://your-private-calendar-url
/roster-share import friend@example.com webcal://your-private-calendar-url
/my-roster
/my-roster HNL
/my-roster HNL 2026-07-22 14
/perdiem-report
/perdiem-report jul
/perdiem-report 2026-07
/layover HNL
/layover HNL 2026-07-22 14
```

The iCal import command queues the separate GitHub Actions workflow
`import-ical-roster-to-pdc.yml` when `GITHUB_TOKEN` is configured on Vercel.
The workflow writes parsed events to the `pdc` collection using the same
duplicate key as the existing roster upload logic:
`owner`, `Date`, `DC`, `Activity`, `From`, `To`. Imported events include
`source: slack_ical`. The original calendar URL is used only for that import
request and is not stored in Firestore.

For easier Firestore console management, each imported event is also mirrored
under `pdc/{ownerUid}/events/{eventId}` while the existing flat `pdc` event
documents remain available for current roster and layover queries.

When an email is included in the import command, the Slack user is linked
automatically to that email's accepted invite owner. If no accepted invite is
found, the import uses a generated `guest_email_<email>` owner UID. This lets a
friend import with one command after joining Slack:

```text
/roster-share import friend@example.com webcal://your-private-calendar-url
```

Email-based imports are automatically shared with the current Slack team's
linked roster participants, and invite-code acceptances automatically share the
accepted guest owner with existing Roster Share participants.

The `/perdiem-report` command dispatches `monthly-perdiem-slack-report.yml`.
That workflow reads only the linked Slack user's Firestore `pdc` roster rows,
calculates PerDiem from those roster rows, stores the calculated rows under
`Perdiem/{ownerUid}/items`, and posts a table from the saved monthly data back
to Slack through the command `response_url`; the existing monthly email
workflow remains unchanged.

Required Vercel environment variable:

```text
SLACK_SIGNING_SECRET=<Slack app signing secret>
```

Optional environment variables:

```text
SLACK_BOT_TOKEN=xoxb-...
SLACK_DEFAULT_FIREBASE_UID=kakao_...
```

Slack users must be linked to Firebase roster owner UIDs through the
`slack_user_links` Firestore collection. See:

```text
docs/SLACK_ROSTER_BOT_SETUP.md
```

## FlutterFlow API Call

Method:

```text
POST
```

URL:

```text
https://roster-sj.onrender.com/runRoster
```

Headers:

```text
Content-Type: application/json
x-api-key: <ROSTER_API_KEY value>
```

Body:

```json
{
  "username": "<CrewConnex ID>",
  "password": "<CrewConnex password>",
  "firebaseUid": "<optional Firebase UID>"
}
```

The ID/password are passed to `roster.js` only as process environment variables
for the current run. The server masks them from the response logs.
