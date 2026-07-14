# FlutterFlow Monthly PerDiem Trigger

This Firebase HTTPS Function lets FlutterFlow run the GitHub Actions workflow
`monthly-perdiem-report.yml` without exposing the GitHub token in the app.

## Secrets

Set these Firebase Functions secrets before deploying:

```bash
firebase functions:secrets:set GITHUB_ACTIONS_TOKEN
firebase functions:secrets:set PERDIEM_TRIGGER_API_KEY
```

`GITHUB_ACTIONS_TOKEN` needs permission to dispatch workflows for
`csj773/roster-sj`.

## Deploy

```bash
firebase deploy --only functions:runMonthlyPerdiemReport --project <project-id>
```

## FlutterFlow API Call

Method:

```text
POST
```

URL:

```text
https://asia-northeast3-<project-id>.cloudfunctions.net/runMonthlyPerdiemReport
```

Headers:

```text
Content-Type: application/json
x-api-key: <PERDIEM_TRIGGER_API_KEY value>
```

Body:

```json
{
  "target_month": "8",
  "target_year": "2026"
}
```

To use the workflow default month/year, send an empty body:

```json
{}
```
