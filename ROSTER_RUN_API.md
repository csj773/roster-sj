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

Optional Kakao Talk Calendar sync also needs these GitHub Actions secrets:

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
