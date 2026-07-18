# Pilotlog Privacy Policy

Effective date: July 18, 2026

Pilotlog (the "Service") respects user privacy and is committed to processing personal information safely and transparently in accordance with applicable privacy laws and regulations.

Before public release, the operator name, contact address, actual third-party services, retention periods, and regional requirements should be reviewed and finalized.

## 1. Purposes of Processing Personal Information

The Service processes personal information for the following purposes.

| Purpose | Description |
| --- | --- |
| Account identification and login | Identifying users and managing accounts through Firebase Authentication |
| Flight record management | Storing and displaying Pilotlog, roster, flight log, block time, night time, takeoff/landing, and related records |
| Allowance and report management | Calculating and storing PerDiem, salary, transport fee, and report results |
| External integrations | Synchronizing data through Google Sheets, Google Calendar, GitHub Actions, and the Render API |
| Security and troubleshooting | Detecting abnormal access, reviewing errors, checking logs, and improving service stability |

## 2. Personal Information Processed

The Service processes only the information necessary to provide its features.

| Category | Items |
| --- | --- |
| Account information | Firebase Auth UID, email address |
| Flight and schedule information | Date, flight number, origin, destination, aircraft registration, flight time, night time, takeoff/landing count, crew/remark, and other flight-related information entered or synchronized by the user |
| Settlement information | PerDiem, salary, transport fee, rate, month, year, and related calculated results |
| Automation information | Synchronization time, processing result, error logs |
| Security information | IP address, limited request headers, authentication token verification result, API request logs |

PDC or CrewConnex ID and password may be transmitted for automated login execution. As a rule, the password must not be stored in Firestore. It should be used temporarily during execution only, and logs should mask sensitive values.

## 3. Retention Period

The Service retains personal information only for as long as necessary to fulfill the purposes described above.

| Information Type | Retention Period |
| --- | --- |
| Account information | Until account deletion or withdrawal request |
| Flight and settlement records | Until the user deletes the data or requests account deletion |
| Automation logs | For troubleshooting and audit purposes. A default retention period of up to 90 days is recommended |
| Backup data | According to the backup policy. A retention period of up to 30 days is recommended |

Where retention is required by law or reasonably necessary for dispute response, the Service may retain relevant information for the required period.

## 4. Disclosure to Third Parties

The Service does not disclose personal information to third parties except in the following cases.

- The user has provided prior consent.
- Disclosure is required by applicable law.
- Disclosure is urgently necessary to protect life, body, or property.

## 5. Processors and External Services

The Service may use the following external services for operation.

| Processor or Service | Purpose | Information Processed |
| --- | --- | --- |
| Google Firebase | Authentication, Firestore data storage, App Check | UID, email, service data, security logs |
| Google Sheets | Storing flight records, allowances, and reports | Flight records, settlement results |
| Google Calendar | Registering roster events | Date, time, flight number, origin, destination |
| Render | Running backend APIs | API request information, temporary login execution information |
| GitHub Actions | Scheduled synchronization and report generation | Automation logs, report artifacts |
| Gmail or SMTP service | Sending report emails | Recipient email address, attached reports |

Each external service processes information according to its own privacy policy.

## 6. International Transfers

Because the Service may use cloud services such as Firebase, Google Sheets, Google Calendar, Render, and GitHub Actions, personal information may be stored or processed in countries outside the user's location.

| Recipient | Country or Region | Transferred Items | Purpose | Retention and Use Period |
| --- | --- | --- | --- | --- |
| Google | United States and other Google infrastructure regions | Account information, flight records, settlement information | Authentication, data storage, document/calendar integration | During service use or until deletion request |
| Render | United States and other Render infrastructure regions | API request information, automation execution information | Backend API execution | Within the log retention period |
| GitHub | United States and other GitHub infrastructure regions | Automation logs, report artifacts | GitHub Actions automation | Within artifact and log retention periods |

Before public release, verify the actual service regions and update this table accordingly.

## 7. Deletion Procedure and Method

When the retention period expires or the processing purpose is fulfilled, the Service deletes personal information without undue delay.

- Electronic files: Deleted or access-restricted in a way that makes recovery difficult.
- Firestore documents: Deleted based on the user's Firebase UID.
- Google Sheets/Calendar data: Related rows and events are deleted upon user request or account deletion.
- Backups and logs: Deleted after the defined retention period.

## 8. User Rights and How to Exercise Them

Users may exercise the following rights at any time.

- Request access to personal information
- Request correction of personal information
- Request deletion of personal information
- Request suspension of processing
- Withdraw consent and request account deletion

Requests may be submitted through the in-app contact feature or to the privacy contact listed below. The Service will verify the requester and process the request in accordance with applicable law.

## 9. Security Measures

The Service applies the following measures to protect personal information.

- User authentication through Firebase Authentication
- User-specific data access restrictions through Firestore Security Rules
- Abuse prevention through Firebase App Check
- Server-side storage of service account keys and API keys
- Secret management through Render and GitHub Secrets
- HTTPS communication
- Masking passwords and sensitive values in logs
- Least-privilege sharing for Google Sheets and Google Calendar
- Budget alerts and usage monitoring to reduce the risk of excessive costs

## 10. Cookies and Similar Technologies

The Service may use cookies or similar technologies from Firebase, FlutterFlow, and Google services for authentication, security checks, and service quality improvement. Users may restrict cookies through browser settings, but some features may not work properly.

## 11. Children's Privacy

The Service is not intended for children under the age of 14. If the Service becomes aware that it has collected personal information from a child under 14, it will delete that information without undue delay.

## 12. Privacy Contact

| Role | Details |
| --- | --- |
| Privacy Officer | [Enter operator name] |
| Contact | [Enter email address] |
| Inquiry Channel | [Enter in-app contact or email address] |

## 13. Remedies and Inquiries

For privacy-related consultation or complaints, users may contact the following organizations.

- Korea Internet & Security Agency Privacy Infringement Report Center: https://privacy.kisa.or.kr
- Personal Information Dispute Mediation Committee: https://www.kopico.go.kr
- Personal Information Portal: https://www.privacy.go.kr

## 14. Changes to This Privacy Policy

This Privacy Policy applies from the effective date above. If the policy changes, the Service will notify users of the changes and effective date through the app or website notice area.

