# Slack Roster Bot Setup

Korean version: [SLACK_ROSTER_BOT_SETUP_KO.md](SLACK_ROSTER_BOT_SETUP_KO.md)

This MVP adds Slack slash commands for roster sharing and layover lookup.

## Slack App

1. Open Slack API app management.
2. Create a Slack app for the crew workspace.
3. Add slash commands:
   - `/roster-share`
   - `/my-roster`
   - `/perdiem-report`
   - `/layover`
   - `/roster-update`
4. Set each request URL to:

```text
https://roster-sj-j3bu.vercel.app/api/slackCommand
```

5. Copy the Slack app signing secret.
6. Add it to Vercel:

```text
SLACK_SIGNING_SECRET=<Slack Signing Secret>
```

`SLACK_BOT_TOKEN` is optional for this MVP. The slash command response works
without it. Add `SLACK_BOT_TOKEN=xoxb-...` later when the app needs to send
proactive channel or DM messages with `chat.postMessage`.

## Link Slack User To Firebase User

The Slack command only knows the Slack user ID. It needs a mapping to the
Firebase/Kakao roster owner UID.

Create a Firestore document:

```text
collection: slack_user_links
document: <team_id>_<user_id>
```

Fields:

```json
{
  "firebaseUid": "kakao_1234567890",
  "slackTeamId": "T0123456789",
  "slackUserId": "U0123456789",
  "createdBy": "manual"
}
```

If this document is missing, the slash command returns the exact document ID
that must be created.

For a single-user test, set this Vercel environment variable instead:

```text
SLACK_DEFAULT_FIREBASE_UID=kakao_1234567890
```

## Commands

Show Slack roster command help:

```text
/roster-help
/roster-share help
```

Create a Roster Share invite:

```text
/roster-share
```

Create a Roster Share invite with an email-compose button:

```text
/roster-share friend@example.com
```

Link your Slack user to the configured default Firebase roster user:

```text
/roster-share link-me
```

Import a personal iCal roster link without using FlutterFlow:

```text
/roster-share import webcal://your-private-calendar-url
/roster-update webcal://your-private-calendar-url
```

Import and automatically link the current Slack user to an email-based roster
owner:

```text
/roster-share import friend@example.com webcal://your-private-calendar-url
/roster-update friend@example.com webcal://your-private-calendar-url
```

The following words are treated as the same import action:

```text
import
sync
link
ical
webcal
```

This import command always requires a per-user Firestore link in
`slack_user_links/{teamId}_{slackUserId}`, unless an email is included in the
command. With an email, the command creates that link automatically. It does
not use `SLACK_DEFAULT_FIREBASE_UID`, so each friend's imported roster is saved
under that friend's own Firebase or guest UID.

When `GITHUB_TOKEN` is configured on Vercel, the command queues the separate
GitHub Actions workflow `import-ical-roster-to-pdc.yml`. The workflow imports
the events into Firestore `pdc` with the same duplicate key used by the existing
roster upload logic
(`owner`, `Date`, `DC`, `Activity`, `From`, `To`). The imported events include
`source: slack_ical`, and the original calendar URL is not stored in Firestore.

Create an invite with a custom scope:

```text
/roster-share layover_only
```

Look up shared layover crew:

```text
/layover HNL
/layover HNL 2026-07-22 14
```

Look up only your own roster:

```text
/my-roster
/my-roster HNL
/my-roster HNL 2026-07-22 14
```

Post a monthly PerDiem report back to Slack:

```text
/perdiem-report
/perdiem-report user@example.com jul
/perdiem-report set-email user@example.com
/perdiem-report jul
/perdiem-report 2026-07
```

The `/my-roster` command returns only the signed-in Slack user's linked roster.
The `/layover` command returns that user's own roster plus rosters shared with
that Firebase user through `roster_shares`, plus same-team owners registered in
`slack_team_roster_owners` and `slack_user_links`. Roster search uses the
`roster` collection first and falls back to `pdc/{uid}/events` when that owner
has no `roster` rows.

The `/perdiem-report` command queues the separate
`monthly-perdiem-slack-report.yml` workflow, builds the report from the user's
Firestore `Perdiem/{uid}/events` rows, and posts the saved monthly result back
to Slack instead of sending email. Email-specific reports resolve the owner from
Firestore `pdc` or `users`; they do not use `slack_team_roster_owners`
directly.

## Firestore Collections

- `slack_user_links`: Slack user to Firebase UID mapping
- `slack_team_roster_owners`: same Slack team owner candidates for roster search
- `roster_share_invites`: invite links generated from Slack
- `roster_shares`: accepted roster share relationships
- `roster_friendships`: friendship/group state

The server uses Firebase Admin SDK for these operations. Firestore client rules
deny direct client reads/writes to `slack_user_links`.
