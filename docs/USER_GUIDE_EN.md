# Pilotlog App User Guide

Last updated: July 18, 2026

This guide explains the basic use of the Pilotlog app for first-time users. Actual screen names may vary depending on the FlutterFlow deployment.

## 1. What You Can Do

Pilotlog provides the following features.

- View and save personal roster data
- Automatically sync CrewConnex/PDC roster data
- Register roster events in Google Calendar
- Manage Pilotlog flight records
- Calculate PerDiem and transport fees
- Review salary reports
- Sync reports through Google Sheets

## 2. Sign In

1. Open the app.
2. Sign in with your email account.
3. If this is your first time, complete sign-up or the provided login flow.
4. After sign-in, only data for your own account should be displayed.

Important:

- Do not sign in with another person's account.
- Log out after use on a shared device.

## 3. Roster Sync

Roster sync imports your personal CrewConnex/PDC roster into the app and Firestore.

1. Go to the Roster screen.
2. Enter your CrewConnex/PDC ID and password.
3. Tap the Sync or Update button.
4. Wait while synchronization starts.
5. After completion, check the roster list, Google Sheets, and Google Calendar if enabled.

Information processed:

- Date
- Activity or flight number
- From / To
- STD / STA
- BLH / ET / NT
- Crew
- Flight data needed for PerDiem calculation

Important:

- The PDC password should not be stored in Firestore.
- If you close the app during synchronization, the backend may continue processing.
- If PDC login fails, check your ID and password.

## 4. Pilotlog Entry and Review

Pilotlog manages your personal flight records.

Commonly stored fields:

- DATE
- FLT
- FROM / TO
- REG
- DC
- RO / RI
- BLK
- NGT
- INS
- TKO / LDG
- PIC
- P3
- EX
- remark or Crew

How to use:

1. Go to the Pilotlog screen.
2. Select a month or date range.
3. Review existing records.
4. Add, edit, or delete records if needed.
5. After saving, the Google Sheets sync workflow can reflect the data in the `flt_log` sheet.

## 5. Google Calendar Integration

After roster sync, the app may register events in Google Calendar and Kakao Talk Calendar.

Information registered:

- Flight number or activity
- Departure/arrival time
- From / To
- Limited crew information

Important:

- Calendar registration may fail if permissions are missing.
- Kakao Talk Calendar requires the Kakao Developers `talk_calendar` consent item and a user access token.
- Events created by the app may be cleaned up by deduplication logic.
- Personal calendar events should remain separate from app-created events.

## 6. PerDiem

PerDiem is calculated from roster inbound/outbound flight information.

How to review:

1. Go to the PerDiem screen.
2. Select the target month.
3. Review Destination, RI, RO, StayHours, Rate, Total, and TransportFee.
4. Compare the result with the Google Sheets `Perdiem` sheet if needed.

Calculation notes:

- Only actual flight sectors are included.
- Inbound flights calculate stay hours and perdiem.
- Outbound flights may store transport fee only.
- Monthly assignment may be based on the month of RO depending on the configured rule.

## 7. Salary Report

The Salary report summarizes monthly salary-related data.

How to review:

1. Go to the Salary screen.
2. Select the target month.
3. Review BLK, NT, ET, P3, Salary, and other calculated results.
4. When the Monthly Salary Report workflow runs, results may be written to the Google Sheets `Salary` sheet and sent by email.

## 8. Privacy and Security

The app uses Firebase Auth UID to separate user data.

User precautions:

- Sign in only with your own account.
- Do not share your PDC password.
- Review the Privacy Policy.
- If you notice abnormal data exposure, contact the operator immediately.

Related documents:

- [Privacy Policy](./PRIVACY_POLICY_EN.md)
- [Personal Information Protection and Processing Procedure](./PERSONAL_INFORMATION_PROCESSING_PROCEDURE_EN.md)

## 9. Data Deletion Request

You may request deletion of your personal data from the operator.

Include the following information:

- Login email
- Data scope to delete
- Whether you want full account deletion

Deletion scope:

- Firestore roster
- Firestore Pilotlog
- Firestore Perdiem
- Firestore Payments
- Personal data synchronized to Google Sheets or Google Calendar

## 10. Troubleshooting

| Problem | What to Check |
| --- | --- |
| Cannot sign in | Email verification and Firebase login status |
| Roster sync fails | PDC ID/password and PDC website availability |
| Calendar events do not appear | Calendar permission and Google Calendar ID settings |
| Pilotlog is not reflected in Google Sheets | Workflow run status and service account permissions |
| PerDiem value looks wrong | From/To, RI/RO, Month, and Rate settings |
| Another user's data appears | Stop using the app and report it to the operator immediately |

## 11. Contact

| Item | Details |
| --- | --- |
| Operator | [Enter operator name] |
| Email | [Enter email address] |
| Inquiry Channel | [Enter in-app contact or email address] |
