# Slack Roster Bot Setup

This MVP adds Slack slash commands for roster sharing and layover lookup.

## Slack App

1. Open Slack API app management.
2. Create a Slack app for the crew workspace.
3. Add slash commands:
   - `/roster-share`
   - `/layover`
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

Create a Roster Share invite:

```text
/roster-share
```

Import a personal iCal roster link without using FlutterFlow:

```text
/roster-share import webcal://your-private-calendar-url
```

The command fetches the calendar privately, imports the events into Firestore
`pdc` with the same duplicate key used by the existing roster upload logic
(`owner`, `Date`, `DC`, `Activity`, `From`, `To`). The imported events include
`source: slack_ical`, and the original calendar URL is not stored.

Create an invite with a custom scope:

```text
/roster-share layover_only
```

Look up shared layover crew:

```text
/layover HNL
```

Choose start date and range:

```text
/layover HNL 2026-07-22 14
```

The command returns the signed-in Slack user's own roster plus rosters shared
with that Firebase user through `roster_shares`.

## Firestore Collections

- `slack_user_links`: Slack user to Firebase UID mapping
- `roster_share_invites`: invite links generated from Slack
- `roster_shares`: accepted roster share relationships
- `roster_friendships`: friendship/group state

The server uses Firebase Admin SDK for these operations. Firestore client rules
deny direct client reads/writes to `slack_user_links`.
