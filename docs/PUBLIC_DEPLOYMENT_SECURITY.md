# Public FlutterFlow Deployment Security

## Current Exposure Risks

- Do not publish repository files that contain real credentials or personal schedule data.
- `.env` was tracked in git and contains sensitive runtime settings. Remove it from the repository and rotate every value that was ever committed.
- `public/roster.json`, `public/roster.csv`, `public/perdiem.csv`, and `public/my_flightlog.csv` can contain personal roster and payment data. They must stay generated runtime files, not committed public assets.
- Firebase web config values are not secrets, but Firestore data must be protected by Firebase Authentication, Firestore Security Rules, and App Check.
- Service account JSON values must exist only in GitHub Secrets, Render Secret Files, or Firebase/Google Cloud secret storage. Never place them in FlutterFlow custom code, public assets, or client-side API calls.

## Required Firestore Model

Each user-owned document should include:

- `owner`: Firebase Auth UID of the user who owns the document.
- Optional display fields such as `email` may exist, but access control should not depend on editable email fields long term.

Recommended collections:

- `roster`
- `Pilotlog`
- `Perdiem`
- `Payments`

The secure query pattern in FlutterFlow is:

```text
collection.where("owner", "==", currentUserUid)
```

Avoid queries that read a whole collection and filter inside the app.

## Firestore Rules Deployment

Use the included `firestore.rules` as the starting policy. It blocks unknown collections and allows users to read/write only their own documents.

Before publishing:

1. Firebase Console > Firestore Database > Rules.
2. Paste `firestore.rules`.
3. Publish.
4. Test with two accounts:
   - Account A can read Account A documents.
   - Account A cannot read Account B documents.
   - Signed-out user cannot read anything.

## FlutterFlow Settings

- Require Firebase Authentication before showing roster, Pilotlog, Perdiem, or Salary pages.
- Every Firestore query must include `owner == currentUserUid`.
- Every created document must write `owner = currentUserUid`.
- Do not expose PDC ID/password fields outside the logged-in user flow.
- Do not store PDC password in Firestore. Send it only to the backend endpoint over HTTPS for the current run.
- Do not rely on a static Render API key inside FlutterFlow for public security. A public web/mobile client can be inspected and the key can be copied.
- For public use, send the Firebase Auth ID token to the backend and verify it server-side with Firebase Admin before running private work.
- API calls to Render must include only the minimum fields needed.

## Render API Protection

`server.js` supports Firebase Auth verification for public deployment.

Set this Render environment variable:

```text
ROSTER_REQUIRE_FIREBASE_AUTH=true
```

Then FlutterFlow must send:

```text
Authorization: Bearer <current user's Firebase ID token>
x-api-key: <temporary API key until removed>
Content-Type: application/json
```

When this is enabled, the backend uses the verified Firebase UID from the token instead of trusting `firebaseUid` from the request body.
For public users, do not send or store per-user UIDs in GitHub Secrets. The verified token UID is used for both `owner` and `uid`.

## App Check

Enable Firebase App Check before public release:

- Web: reCAPTCHA Enterprise or reCAPTCHA v3.
- Android: Play Integrity.
- iOS: DeviceCheck or App Attest.

Start in monitoring mode, confirm legitimate requests pass, then enforce App Check for Firestore.

## Cost Controls

Firestore charges mainly by document reads, writes, deletes, storage, bandwidth, and some index reads. To avoid surprise costs:

- Set a Google Cloud budget alert at low thresholds, for example 50%, 80%, and 100%.
- Keep all FlutterFlow queries scoped by `owner` and month/date range.
- Add page limits. Do not stream thousands of documents on app start.
- Avoid realtime listeners on large collections unless needed.
- Prefer monthly subqueries such as `owner == uid AND Month == 8 AND Year == 2026`.
- Keep generated reports in Google Sheets or GitHub Actions artifacts, not public Firebase collections.
- Do not allow public unauthenticated reads.
- Enable App Check enforcement after testing to reduce automated abuse.
- Consider separating production and test Firebase projects so experiments cannot affect production billing.
- Put expensive operations such as full roster sync, Pilotlog rewrite, and report generation behind a backend endpoint or scheduled GitHub Action. Do not let every public client trigger full collection reads or writes directly.

## Secret Rotation

Because `.env` was tracked, rotate:

- PDC username/password if real values were committed.
- Render `ROSTER_API_KEY` / API key.
- Firebase service account keys if any JSON private key was ever committed.
- GitHub tokens if they appeared in committed files.

After rotation, keep values only in:

- GitHub Actions Secrets.
- Render Environment Variables / Secret Files.
- Firebase/Google Cloud Secret Manager.

## References

- Firestore Security Rules: https://firebase.google.com/docs/firestore/security/get-started
- Security Rules with Auth: https://firebase.google.com/docs/rules/rules-and-auth
- Firestore rule conditions: https://firebase.google.com/docs/firestore/security/rules-conditions
- App Check: https://firebase.google.com/docs/app-check
- Flutter App Check: https://firebase.google.com/docs/app-check/flutter/default-providers
- Avoid surprise bills: https://firebase.google.com/docs/projects/billing/avoid-surprise-bills
- Firestore pricing: https://firebase.google.com/docs/firestore/pricing
