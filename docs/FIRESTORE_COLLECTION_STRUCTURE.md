# Firestore Collection Structure

This document summarizes the main Firestore collections used by the app.

## Core Pattern

Most personal data uses two layers:

```text
Top-level collection              = FlutterFlow screen/query mirror
{Collection}ByUser/{uid}/events   = User-owned source/backup structure
```

FlutterFlow screens should usually query the top-level collection with this filter:

```text
owner == Authenticated User UID
```

## Roster

```text
roster
```

Purpose:
- FlutterFlow screen mirror for CrewConnex roster data.
- Existing FlutterFlow pages can keep querying this collection.

FlutterFlow query:

```text
Collection: roster
Filter: owner == Authenticated User UID
```

User-owned structure:

```text
rosterByUser/{uid}/events/{eventId}
```

Purpose:
- User-owned source/backup for CrewConnex roster data.
- Rewritten per owner when `Update Roster & Google Calendar` runs.

## PDC / Slack iCal Roster

```text
pdc/{uid}/events/{eventId}
```

Purpose:
- User-owned source for Slack/iCal roster import.
- Rewritten per owner by `Import iCal Roster to PDC`.

FlutterFlow mirror:

```text
PdcEvents/{eventId}
```

FlutterFlow query:

```text
Collection: PdcEvents
Filter: owner == Authenticated User UID
```

## Perdiem

```text
Perdiem/{uid}/events/{eventId}
```

Purpose:
- User-owned source for perdiem calculation results.
- Rewritten per owner from roster/PDC imports.

FlutterFlow mirror:

```text
PerdiemEvents/{eventId}
```

FlutterFlow query:

```text
Collection: PerdiemEvents
Filter: owner == Authenticated User UID
```

## Pilotlog

```text
Pilotlog
```

Purpose:
- FlutterFlow screen mirror for pilot logbook data.

FlutterFlow query:

```text
Collection: Pilotlog
Filter: owner == Authenticated User UID
```

User-owned structure:

```text
PilotlogByUser/{uid}/events/{docId}
```

Purpose:
- User-owned source/backup for Pilotlog data.
- Updated together by `Sync PILOTLOG flt_log to Firestore`.

## Payments

```text
Payments
```

Purpose:
- FlutterFlow screen mirror for salary/payment data.

FlutterFlow query:

```text
Collection: Payments
Filter: owner == Authenticated User UID
```

User-owned structure:

```text
PaymentsByUser/{uid}/events/{docId}
```

Purpose:
- User-owned source/backup for payment data.

## Limits

```text
Limits
```

Purpose:
- FlutterFlow screen mirror for limit data.

FlutterFlow query:

```text
Collection: Limits
Filter: owner == Authenticated User UID
```

User-owned structure:

```text
LimitsByUser/{uid}/events/{docId}
```

Purpose:
- User-owned source/backup for limit data.

## Other User Data

These collections follow the same mirror plus user-owned backup pattern:

```text
CrewRest
CrewRestByUser/{uid}/events/{docId}

DutyPeriod
DutyPeriodByUser/{uid}/events/{docId}

DutyPeroid
DutyPeroidByUser/{uid}/events/{docId}

UploadUrl
UploadUrlByUser/{uid}/events/{docId}

UploadFile
UploadFileByUser/{uid}/events/{docId}
```

FlutterFlow query for the top-level collections:

```text
owner == Authenticated User UID
```

## Sharing Collections

These are relationship/permission collections, not roster event data:

```text
roster_share_invites
roster_shares
roster_friendships
```

Purpose:
- Store invite and sharing relationships.
- Not rewritten like roster/PDC.
- Written only by API/Admin logic.

## Important Rule

For public multi-user use, every FlutterFlow query that reads a top-level mirror collection must include:

```text
owner == Authenticated User UID
```

Do not show all documents from these collections without an owner filter.
