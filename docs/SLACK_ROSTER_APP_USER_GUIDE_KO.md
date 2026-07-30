# Slack Roster 앱 User Guide

이 문서는 Slack에서 Roster Share 앱을 사용하는 방법을 설명합니다.

공개 리뷰 URL:

```text
https://roster-sj-j3bu.vercel.app/slack-roster-guide/
```

사용자 초대 전이나 사용 시작 전에 위 링크를 공유하면 됩니다.

## 기본 개념

Slack Roster 앱은 Slack command로 roster를 가져오고, 공유된 crew layover를
조회하고, 월간 PerDiem report를 실행할 수 있게 해줍니다.

주요 명령어:

```text
/roster-share
/roster-update
/my-roster
/layover
/perdiem-report
/roster-help
```

## 처음 사용하는 경우

먼저 본인의 Slack user와 Firebase roster user를 연결해야 합니다.

```text
/roster-share link-me
```

연결이 되어 있지 않으면 앱이 필요한 Firestore document ID를 안내합니다.
관리자가 해당 연결을 만들거나, 기본 Firebase UID가 설정되어 있으면 자동으로
연결됩니다.

도움말은 언제든지 아래 명령으로 볼 수 있습니다.

```text
/roster-help
```

또는:

```text
/roster-share help
```

## Roster 가져오기

개인 iCal roster link를 Slack에서 직접 import할 수 있습니다.

```text
/roster-share import webcal://your-private-calendar-url
/roster-update webcal://your-private-calendar-url
```

다른 사용자의 email owner로 가져오려면 email을 같이 입력합니다.

```text
/roster-share import friend@example.com webcal://your-private-calendar-url
/roster-update friend@example.com webcal://your-private-calendar-url
```

`import` 대신 아래 단어도 사용할 수 있습니다.

```text
sync
link
ical
webcal
```

예:

```text
/roster-share sync friend@example.com webcal://your-private-calendar-url
/roster-update friend@example.com webcal://your-private-calendar-url
```

import가 성공하면 해당 사용자의 roster가 Firestore에 저장되고, 같은 Slack team의
roster 검색 대상에 등록됩니다.

## 내 Roster 조회

본인 roster를 조회합니다.

```text
/my-roster
```

특정 공항이 포함된 roster만 조회합니다.

```text
/my-roster HNL
```

날짜와 조회 기간을 지정할 수 있습니다.

```text
/my-roster HNL 2026-07-22 14
```

위 예시는 2026-07-22부터 14일 동안 HNL이 포함된 본인 roster를 조회합니다.

## 공유 Layover 조회

공유된 crew의 layover를 조회합니다.

```text
/layover HNL
```

날짜와 기간을 지정할 수 있습니다.

```text
/layover HNL 2026-07-22 14
```

`/layover`는 아래 roster를 함께 조회합니다.

- 본인 roster
- 나에게 공유된 roster
- 같은 Slack team에서 roster import로 등록된 owner
- 같은 Slack team의 Slack link에 남아있는 owner

검색 순서는 `roster` collection이 우선이고, 해당 owner의 `roster` data가 없으면
`pdc/{uid}/events` data를 사용합니다.

## Roster Share 초대

Roster Share 초대 링크를 만듭니다.

```text
/roster-share
```

email 작성 버튼이 포함된 초대 링크를 만들 수 있습니다.

```text
/roster-share friend@example.com
```

초대를 받은 사용자가 수락하면 `roster_shares`에 공유 관계가 저장됩니다.

## PerDiem Report

월간 PerDiem report를 실행합니다.

```text
/perdiem-report
```

특정 사용자의 특정 월 report를 실행합니다.

```text
/perdiem-report user@example.com jul
```

기본 report email을 저장할 수 있습니다.

```text
/perdiem-report set-email user@example.com
```

이후에는 email 없이 실행해도 저장된 email owner로 report를 실행합니다.

```text
/perdiem-report jul
```

연월 형식으로도 실행할 수 있습니다.

```text
/perdiem-report 2026-07
```

`/perdiem-report`는 `Perdiem/{uid}/events` data를 기준으로 계산합니다.
email을 지정한 경우 Firestore `pdc` 또는 `users`에서 owner를 찾습니다.
`slack_team_roster_owners`는 PerDiem report 대상자를 정할 때 직접 사용하지
않습니다.

## 자주 발생하는 상황

### Slack user가 연결되어 있지 않음

아래 명령을 먼저 실행합니다.

```text
/roster-share link-me
```

그래도 안 되면 앱이 안내하는 `slack_user_links/{teamId}_{slackUserId}` 문서를
Firestore에 만들어야 합니다.

### Roster import 후 layover에 안 보임

다음을 확인합니다.

- import가 성공했는지
- 같은 Slack team에서 실행했는지
- owner의 `roster` 또는 `pdc/{uid}/events`에 data가 있는지
- 조회 날짜 범위에 해당 flight가 포함되는지

### PerDiem report owner를 못 찾음

아래처럼 email을 지정해서 다시 실행합니다.

```text
/perdiem-report user@example.com jul
```

그래도 안 되면 해당 email owner의 pdc roster import가 먼저 필요합니다.

## 개인정보 주의

iCal roster link는 개인 roster 전체에 접근할 수 있는 private URL입니다.
Slack public channel에 그대로 남기지 않는 것이 좋습니다. 가능하면 개인 DM이나
제한된 private channel에서 import 명령을 실행하세요.

앱은 원본 calendar URL을 Firestore에 저장하지 않습니다.
