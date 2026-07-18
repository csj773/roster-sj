# Pilotlog Personal Information Protection and Processing Procedure

Effective date: July 18, 2026

This document defines the internal operating procedure for safely processing personal information during the public deployment and operation of the Pilotlog service. Before production release, confirm the responsible personnel, contact information, retention periods, and external service settings.

## 1. Scope

This procedure applies to the following data and systems.

- FlutterFlow app
- Firebase Authentication
- Cloud Firestore
- Firebase App Check
- Render backend API
- GitHub Actions workflows
- Google Sheets
- Google Calendar
- Gmail or SMTP email delivery system

## 2. Privacy Processing Principles

- Collect only the data necessary to provide the Service.
- Store an `owner` field on every user-owned document and match it to the Firebase Auth UID.
- Do not trust a UID supplied directly by a client.
- Do not include service account JSON, API secrets, or PDC passwords in the public app.
- Do not read entire Firestore collections from the client. Use user-specific and month/date-scoped queries.
- Do not log passwords, tokens, service account keys, or PDC account information.
- Before deployment, verify in staging that one user cannot access another user's data.

## 3. Collection and Storage Procedure

### 3.1 User Identification

1. The user signs in with Firebase Authentication.
2. When the app creates a Firestore document, it writes `owner = currentUserUid`.
3. The backend API verifies the Firebase ID token and uses the token's `uid` as the owner.
4. In a public deployment, `firebaseUid` from the request body must not be trusted.

### 3.2 Pilotlog and Roster Storage

1. Validate required fields before saving flight records.
2. When saving to Firestore, use a deduplication key such as owner, date, flight number, origin, and destination.
3. Do not modify or delete documents owned by another user.
4. When synchronizing to Google Sheets, use either a user-specific spreadsheet or an owner-based separation policy.

### 3.3 PDC Account Information

1. PDC ID and password are used only for automated login execution.
2. PDC passwords must not be stored in Firestore, Google Sheets, GitHub repositories, or logs.
3. Render logs must mask username and password values.
4. Failure logs must be checked to ensure raw input values are not printed.

## 4. Access Control

### 4.1 Firestore

1. Firestore Security Rules must follow a default-deny approach.
2. The `roster`, `Pilotlog`, `Perdiem`, and `Payments` collections must enforce `owner == request.auth.uid`.
3. Administrative operations must run through GitHub Actions or the Render server using a service account, not directly from the client.
4. The administrator service account must have Editor access only to the Google Sheets or Calendars required for the Service.

### 4.2 Google Sheets and Calendar

1. Google Sheets containing personal data must not be shared publicly by link.
2. Service accounts must be granted access only to the required spreadsheets and calendars.
3. Sharing permissions must be reviewed quarterly.
4. Accounts that no longer need access must be removed immediately.

### 4.3 GitHub and Render

1. Secrets must be stored only in GitHub Secrets or Render Secret Files.
2. `.env`, service account JSON, and generated roster files must not be committed.
3. If the repository is public, GitHub Actions artifact retention should be minimized.
4. Render dashboard access must be limited to service operators.

## 5. Firestore Security Rules Procedure

1. Edit `firestore.rules`.
2. Prepare test accounts A and B.
3. Confirm that Account A cannot read or write Account B's documents.
4. Confirm that signed-out users cannot access personal collections.
5. Confirm that normal user flows still work.
6. Deploy rules through Firebase Console or Firebase CLI.

Deployment command example:

```bash
firebase deploy --only firestore:rules
```

## 6. App Check Procedure

1. Register the app in Firebase Console > App Check.
2. For Web, configure reCAPTCHA Enterprise or reCAPTCHA v3.
3. For Android, configure Play Integrity. For iOS, configure DeviceCheck or App Attest.
4. Start in monitoring mode.
5. After confirming that legitimate requests pass, enable Firestore enforcement.
6. Monitor abnormal request spikes after deployment.

## 7. Cost Protection Procedure

### 7.1 Budget and Alerts

1. Set a monthly budget in Google Cloud Billing.
2. Configure alerts at 50%, 80%, and 100%.
3. Add at least two recipients for budget alerts.
4. Review Firebase Usage and billing regularly.

### 7.2 Query Controls

1. Do not read entire collections when the app starts.
2. Every user-data query must include `owner == currentUserUid`.
3. Roster and Pilotlog screens must also include `Year`, `Month`, or date range conditions.
4. List screens must use page size limits.
5. Avoid unnecessary realtime listeners.
6. Report generation, full rewrites, and bulk sync jobs must run through backend or scheduled workflows, not directly from public clients.

### 7.3 Abuse Response

1. Apply rate limiting to the Render API.
2. Require Firebase Auth token verification for public deployment.
3. Enable App Check enforcement.
4. If abnormal requests are detected, rotate the API key, temporarily restrict the Render endpoint, and tighten Firestore Rules.

## 8. Retention and Deletion Procedure

### 8.1 User Deletion Requests

1. Verify the identity of the requester.
2. Query Firestore documents by `owner == uid` for each collection.
3. Delete documents in `roster`, `Pilotlog`, `Perdiem`, and `Payments`.
4. Delete related personal data synchronized to Google Sheets or Google Calendar.
5. Notify the requester of the deletion result.

### 8.2 Periodic Deletion

1. Automation logs should generally be retained for no more than 90 days.
2. GitHub Actions artifact retention should be minimized.
3. Render logs should be kept only as long as necessary.
4. Temporary export files must not be committed to the repository after workflow completion.

## 9. Incident Response Procedure

If a personal information leak or suspected incident occurs, follow these steps.

1. Immediately stop the related API, workflow, or service account usage.
2. Rotate any exposed secrets.
3. Temporarily strengthen Firestore Rules to default deny.
4. Review access logs, GitHub Actions logs, and Render logs.
5. Assess the scope and categories of exposed information.
6. Review whether notification to users or reporting to authorities is legally required.
7. Document corrective and preventive measures.

## 10. Pre-Deployment Checklist

- [ ] `.env` is not in the repository.
- [ ] Service account JSON is not in the repository.
- [ ] `public/roster.json`, `public/roster.csv`, and `public/perdiem.csv` are not in the repository.
- [ ] Firestore Rules are deployed with owner-based access control.
- [ ] Every FlutterFlow query includes `owner == currentUserUid`.
- [ ] Render has `ROSTER_REQUIRE_FIREBASE_AUTH=true`.
- [ ] FlutterFlow API calls include the Firebase ID token in the Authorization header.
- [ ] App Check is in monitoring or enforcement mode.
- [ ] Google Cloud budget alerts are configured.
- [ ] Google Sheets and Calendar sharing are minimized.
- [ ] PDC passwords are not stored and are not printed in logs.
- [ ] Test accounts A and B confirm that cross-user data access is blocked.

## 11. Periodic Review

| Frequency | Review Items |
| --- | --- |
| Weekly | Firestore usage, Render logs, failed workflows |
| Monthly | Google Cloud costs, GitHub Actions artifacts, App Check blocking status |
| Quarterly | Google Sheets/Calendar sharing, service account permissions, Firestore Rules |
| Upon change | Privacy policy, external processors, collected items, retention periods |

## 12. Responsible Personnel

| Role | Person | Contact |
| --- | --- | --- |
| Privacy Officer | [Enter operator name] | [Enter email address] |
| Technical Operator | [Enter name] | [Enter email address] |
| Incident Response Contact | [Enter name] | [Enter email address] |

