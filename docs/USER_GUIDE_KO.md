# Pilotlog 앱 사용 가이드

최종 업데이트: 2026년 7월 18일

이 문서는 Pilotlog 앱을 처음 사용하는 사용자를 위한 기본 사용 방법입니다. 실제 화면 이름은 FlutterFlow 배포 설정에 따라 약간 다를 수 있습니다.

## 1. 앱에서 할 수 있는 일

Pilotlog 앱은 다음 기능을 제공합니다.

- 개인 roster 조회 및 저장
- CrewConnex/PDC roster 자동 동기화
- Google Calendar 일정 등록
- Pilotlog 비행 기록 관리
- PerDiem 및 transport fee 계산
- Salary 리포트 확인
- Google Sheets 기반 리포트 동기화

## 2. 로그인

1. 앱을 실행합니다.
2. 로그인 화면에서 이메일 계정으로 로그인합니다.
3. 처음 사용하는 경우 회원가입 또는 제공된 로그인 방식을 완료합니다.
4. 로그인 후 본인 계정의 데이터만 조회됩니다.

주의:

- 다른 사람의 계정으로 로그인하지 마세요.
- 공용 기기에서는 사용 후 반드시 로그아웃하세요.

## 3. Roster 동기화

Roster 동기화는 CrewConnex/PDC의 개인 roster를 앱과 Firestore에 반영하는 기능입니다.

1. Roster 화면으로 이동합니다.
2. CrewConnex/PDC ID와 Password를 입력합니다.
3. Sync 또는 Update 버튼을 누릅니다.
4. 동기화가 시작되면 잠시 기다립니다.
5. 완료 후 roster 목록, Google Sheets, Google Calendar 반영 여부를 확인합니다.

처리되는 정보:

- Date
- Activity 또는 Flight number
- From / To
- STD / STA
- BLH / ET / NT
- Crew
- PerDiem 계산에 필요한 운항 정보

주의:

- PDC 비밀번호는 Firestore에 저장하지 않는 구조를 권장합니다.
- 동기화 중 앱을 닫아도 backend에서 계속 처리될 수 있습니다.
- PDC 로그인 실패 시 ID/Password를 다시 확인하세요.

## 4. Pilotlog 입력 및 확인

Pilotlog는 개인 비행 기록을 관리하는 기능입니다.

일반적으로 저장되는 항목:

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
- remark 또는 Crew

사용 방법:

1. Pilotlog 화면으로 이동합니다.
2. 월 또는 날짜 범위를 선택합니다.
3. 기존 기록을 확인합니다.
4. 필요한 경우 항목을 추가, 수정, 삭제합니다.
5. 저장 후 Google Sheets 동기화 workflow가 실행되면 `flt_log` sheet에 반영됩니다.

## 5. Google Calendar 연동

Roster 동기화 후 앱은 Google Calendar에 일정 등록을 시도할 수 있습니다.

등록되는 정보:

- Flight number 또는 activity
- 출발/도착 시간
- From / To
- Crew 정보 일부

주의:

- Calendar 권한이 없으면 등록이 실패할 수 있습니다.
- 이미 생성된 앱 일정은 중복 제거 로직에 따라 정리될 수 있습니다.
- 개인 일정은 앱이 만든 일정과 구분되어야 합니다.

## 6. PerDiem 확인

PerDiem은 roster의 inbound/outbound 운항 정보를 기준으로 계산됩니다.

확인 방법:

1. PerDiem 화면으로 이동합니다.
2. 확인할 월을 선택합니다.
3. Destination, RI, RO, StayHours, Rate, Total, TransportFee를 확인합니다.
4. Google Sheets `Perdiem` sheet에 반영된 결과와 비교할 수 있습니다.

계산 기준:

- 실제 운항 구간만 계산 대상입니다.
- Inbound 편은 stay hours와 perdiem을 계산합니다.
- Outbound 편은 transport fee만 저장될 수 있습니다.
- 월 배정은 설정된 기준에 따라 RO 기준 월로 저장될 수 있습니다.

## 7. Salary 리포트

Salary 리포트는 월별 급여 관련 데이터를 정리하는 기능입니다.

확인 방법:

1. Salary 화면으로 이동합니다.
2. 대상 월을 선택합니다.
3. BLK, NT, ET, P3, Salary 등 계산 결과를 확인합니다.
4. Monthly Salary Report workflow가 실행되면 Google Sheets `Salary` sheet에 반영되고 이메일로 발송될 수 있습니다.

## 8. 개인정보 및 보안

앱은 사용자별 데이터를 분리하기 위해 Firebase Auth UID를 사용합니다.

사용자 주의사항:

- 본인 계정으로만 로그인하세요.
- PDC Password를 다른 사람과 공유하지 마세요.
- 개인정보처리방침을 확인하세요.
- 비정상적인 데이터 노출이 보이면 즉시 운영자에게 연락하세요.

관련 문서:

- [개인정보처리방침](./PRIVACY_POLICY_KO.md)
- [개인정보 보호 및 처리절차](./PERSONAL_INFORMATION_PROCESSING_PROCEDURE_KO.md)

## 9. 데이터 삭제 요청

개인 데이터 삭제를 원할 경우 운영자에게 요청할 수 있습니다.

삭제 요청 시 포함할 정보:

- 로그인 이메일
- 삭제하려는 데이터 범위
- 전체 계정 삭제 여부

삭제 대상:

- Firestore roster
- Firestore Pilotlog
- Firestore Perdiem
- Firestore Payments
- Google Sheets/Calendar에 동기화된 개인 데이터

## 10. 문제 해결

| 문제 | 확인할 사항 |
| --- | --- |
| 로그인이 안 됨 | 이메일 인증 상태, Firebase 로그인 상태 확인 |
| Roster 동기화 실패 | PDC ID/Password, PDC 사이트 접속 가능 여부 확인 |
| Calendar에 일정이 안 보임 | Calendar 권한, Google Calendar ID 설정 확인 |
| Pilotlog가 Google Sheets에 반영되지 않음 | workflow 실행 상태, service account 권한 확인 |
| PerDiem 값이 이상함 | From/To, RI/RO, Month, Rate 설정 확인 |
| 타인 데이터가 보이는 것 같음 | 즉시 사용 중지 후 운영자에게 신고 |

## 11. 문의

| 구분 | 내용 |
| --- | --- |
| 운영자 | [운영자명 입력] |
| 이메일 | [이메일 입력] |
| 문의 채널 | [앱 내 문의 또는 이메일 입력] |

