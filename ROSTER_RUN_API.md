# Roster Run API

Use this endpoint when FlutterFlow collects a personal CrewConnex ID/password
and runs the existing `roster.js` mapping flow.

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
