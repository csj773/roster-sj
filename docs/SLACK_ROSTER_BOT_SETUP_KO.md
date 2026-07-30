# Slack Roster Bot 설정

사용자용 가이드: [SLACK_ROSTER_APP_USER_GUIDE_KO.md](SLACK_ROSTER_APP_USER_GUIDE_KO.md)

이 문서는 Slack slash command로 roster 공유, iCal import, layover 조회,
PerDiem report 실행을 사용하는 방법을 정리합니다.

## Slack App

1. Slack API app management를 엽니다.
2. Crew workspace용 Slack app을 만듭니다.
3. Slash command를 추가합니다.
   - `/roster-share`
   - `/my-roster`
   - `/perdiem-report`
   - `/layover`
   - `/roster-help`
   - `/roster-update`
4. 각 command의 request URL을 아래로 설정합니다.

```text
https://roster-sj-j3bu.vercel.app/api/slackCommand
```

5. Slack app signing secret을 복사합니다.
6. Vercel 환경변수에 추가합니다.

```text
SLACK_SIGNING_SECRET=<Slack Signing Secret>
```

`SLACK_BOT_TOKEN`은 현재 MVP에서는 선택사항입니다. Slash command 응답은
이 값 없이도 동작합니다. 나중에 bot이 채널이나 DM에 직접 메시지를 보내야 하면
`SLACK_BOT_TOKEN=xoxb-...`를 추가합니다.

## Slack User와 Firebase User 연결

Slack command는 Slack user ID만 알 수 있으므로, Firebase/Kakao roster owner
UID와 연결이 필요합니다.

Firestore에 아래 문서를 만들 수 있습니다.

```text
collection: slack_user_links
document: <team_id>_<user_id>
```

예시 필드:

```json
{
  "firebaseUid": "kakao_1234567890",
  "slackTeamId": "T0123456789",
  "slackUserId": "U0123456789",
  "createdBy": "manual"
}
```

이 문서가 없으면 slash command는 필요한 document ID를 안내합니다.

단일 사용자 테스트에서는 Vercel 환경변수로 기본 UID를 지정할 수 있습니다.

```text
SLACK_DEFAULT_FIREBASE_UID=kakao_1234567890
```

## 명령어

도움말 보기:

```text
/roster-help
/roster-share help
```

Roster Share 초대 링크 생성:

```text
/roster-share
```

이메일 작성 버튼이 포함된 Roster Share 초대 링크 생성:

```text
/roster-share friend@example.com
```

현재 Slack user를 기본 Firebase roster user에 연결:

```text
/roster-share link-me
```

FlutterFlow를 거치지 않고 개인 iCal roster link import:

```text
/roster-share import webcal://your-private-calendar-url
/roster-update webcal://your-private-calendar-url
```

email owner로 roster import하고 현재 Slack user와 자동 연결:

```text
/roster-share import friend@example.com webcal://your-private-calendar-url
/roster-update friend@example.com webcal://your-private-calendar-url
```

아래 단어들은 모두 같은 import action으로 처리됩니다.

```text
import
sync
link
ical
webcal
```

email 없이 import할 때는 `slack_user_links/{teamId}_{slackUserId}`에
사용자별 Firestore link가 필요합니다. email을 포함하면 command가 해당 link를
자동으로 생성합니다. 이 경우 `SLACK_DEFAULT_FIREBASE_UID`를 사용하지 않고,
각 사용자의 roster는 해당 사용자 본인의 Firebase UID 또는 guest UID 아래에
저장됩니다.

Vercel에 `GITHUB_TOKEN`이 설정되어 있으면 import command는
`import-ical-roster-to-pdc.yml` GitHub Actions workflow를 실행합니다. workflow는
기존 roster upload 로직과 같은 중복 기준을 사용해 Firestore `pdc`에 저장합니다.

중복 기준:

```text
owner, Date, DC, Activity, From, To
```

저장된 event에는 `source: slack_ical`이 들어가며, 원본 calendar URL은
Firestore에 저장하지 않습니다.

사용자 지정 scope 초대 링크 생성:

```text
/roster-share layover_only
```

공유 layover crew 조회:

```text
/layover HNL
/layover HNL 2026-07-22 14
```

본인 roster만 조회:

```text
/my-roster
/my-roster HNL
/my-roster HNL 2026-07-22 14
```

월간 PerDiem report를 Slack으로 받기:

```text
/perdiem-report
/perdiem-report user@example.com jul
/perdiem-report set-email user@example.com
/perdiem-report jul
/perdiem-report 2026-07
```

## 조회 기준

`/my-roster`는 현재 Slack user에 연결된 본인 roster만 반환합니다.

`/layover`는 아래 owner들의 roster를 함께 조회합니다.

- 현재 Slack user 본인
- `roster_shares`를 통해 공유받은 owner
- 같은 Slack team의 `slack_team_roster_owners`에 등록된 owner
- 같은 Slack team의 `slack_user_links`에 남아있는 owner

Roster 검색은 `roster` collection을 먼저 사용하고, 해당 owner의 `roster`
문서가 없을 때만 `pdc/{uid}/events`로 fallback합니다.

`/perdiem-report`는 `monthly-perdiem-slack-report.yml` workflow를 실행합니다.
보고서는 Firestore `Perdiem/{uid}/events` rows를 기준으로 생성되고, 결과는
email 대신 Slack으로 반환됩니다.

email을 지정한 PerDiem report는 Firestore `pdc` 또는 `users`에서 owner를
찾습니다. `slack_team_roster_owners`는 `/perdiem-report`에서 직접 사용되지
않습니다.

## Firestore Collections

- `slack_user_links`: Slack user와 Firebase UID 연결
- `slack_team_roster_owners`: 같은 Slack team에서 roster 검색 대상이 되는 owner 목록
- `roster_share_invites`: Slack에서 생성한 초대 링크
- `roster_shares`: 수락된 roster 공유 관계
- `roster_friendships`: 친구/그룹 상태

서버는 Firebase Admin SDK로 위 collection을 처리합니다. Firestore client rules는
`slack_user_links`에 대한 client 직접 read/write를 막습니다.
