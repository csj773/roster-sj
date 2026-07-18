# Pilotlog 개인정보 보호 및 처리절차

시행일: 2026년 7월 18일

본 문서는 Pilotlog 서비스의 공개 배포 및 운영 과정에서 개인정보를 안전하게 처리하기 위한 내부 운영 절차입니다. 실제 운영 전 담당자명, 연락처, 보관기간, 외부 서비스 설정을 확정해야 합니다.

## 1. 적용 범위

본 절차는 다음 데이터와 시스템에 적용합니다.

- FlutterFlow 앱
- Firebase Authentication
- Cloud Firestore
- Firebase App Check
- Render backend API
- GitHub Actions workflows
- Google Sheets
- Google Calendar
- Gmail 또는 SMTP 발송 시스템

## 2. 개인정보 처리 원칙

- 필요한 데이터만 수집한다.
- 모든 사용자 데이터에는 `owner` 필드를 저장하고 Firebase Auth UID와 일치시킨다.
- 클라이언트에서 전달한 UID를 그대로 신뢰하지 않는다.
- 공개 앱에 서비스 계정 JSON, API secret, PDC 비밀번호를 포함하지 않는다.
- Firestore 전체 collection read를 금지하고 사용자별/월별 조건으로 조회한다.
- 로그에는 비밀번호, 토큰, 서비스 계정 키, PDC 계정 정보를 남기지 않는다.
- 배포 전 staging 환경에서 다른 사용자 데이터가 보이지 않는지 검증한다.

## 3. 수집 및 저장 절차

### 3.1 회원 식별

1. 사용자는 Firebase Authentication으로 로그인한다.
2. 앱은 Firestore 문서 생성 시 `owner = currentUserUid`를 저장한다.
3. backend API는 Firebase ID token을 검증한 후 token의 `uid`를 owner로 사용한다.
4. request body의 `firebaseUid`는 공개 배포 환경에서 신뢰하지 않는다.

### 3.2 Pilotlog 및 roster 저장

1. 비행 기록 저장 전 필수 필드를 검증한다.
2. Firestore 저장 시 owner, date, flight number, from, to 등 중복 기준을 사용한다.
3. 다른 owner의 문서는 수정하거나 삭제하지 않는다.
4. Google Sheets로 동기화하는 경우 개인별 spreadsheet 또는 owner 기준 분리 정책을 적용한다.

### 3.3 PDC 계정 정보 처리

1. PDC ID와 비밀번호는 자동 로그인 실행에만 사용한다.
2. PDC 비밀번호는 Firestore, Google Sheets, GitHub repository, 로그에 저장하지 않는다.
3. Render 로그 출력 시 username/password를 마스킹한다.
4. 실패 로그에도 입력값 원문이 포함되지 않도록 점검한다.

## 4. 접근 권한 관리

### 4.1 Firestore

1. Firestore Security Rules는 기본 차단 원칙을 사용한다.
2. `roster`, `Pilotlog`, `Perdiem`, `Payments` collection은 `owner == request.auth.uid` 조건을 적용한다.
3. 관리자 작업은 클라이언트가 아닌 GitHub Actions 또는 Render 서버에서 service account로만 수행한다.
4. 관리자 service account는 필요한 Google Sheets/Calendar에만 Editor 권한을 부여한다.

### 4.2 Google Sheets 및 Calendar

1. 개인 데이터가 들어 있는 Google Sheets는 공개 링크 공유를 금지한다.
2. service account에는 필요한 spreadsheet/calendar에만 권한을 부여한다.
3. 공유 권한은 분기별로 검토한다.
4. 퇴사자 또는 더 이상 필요 없는 계정 권한은 즉시 제거한다.

### 4.3 GitHub 및 Render

1. 비밀값은 GitHub Secrets 또는 Render Secret Files에만 저장한다.
2. `.env`, service account JSON, generated roster files는 commit하지 않는다.
3. repository가 public인 경우 Actions artifact 보관기간을 최소화한다.
4. Render dashboard 접근 권한은 운영 담당자에게만 부여한다.

## 5. Firestore 보안 규칙 운영 절차

1. `firestore.rules`를 수정한다.
2. 테스트 계정 A/B를 준비한다.
3. Account A로 Account B의 문서 read/write가 거부되는지 확인한다.
4. signed-out 상태에서 모든 개인 collection 접근이 거부되는지 확인한다.
5. 정상 사용자 flow가 동작하는지 확인한다.
6. Firebase Console 또는 Firebase CLI로 rules를 배포한다.

배포 명령 예:

```bash
firebase deploy --only firestore:rules
```

## 6. App Check 운영 절차

1. Firebase Console > App Check에서 앱을 등록한다.
2. Web은 reCAPTCHA Enterprise 또는 reCAPTCHA v3를 설정한다.
3. Android는 Play Integrity, iOS는 DeviceCheck 또는 App Attest를 설정한다.
4. 처음에는 모니터링 모드로 운영한다.
5. 정상 요청 통과율을 확인한 뒤 Firestore enforcement를 활성화한다.
6. 배포 후 비정상 요청 급증 여부를 모니터링한다.

## 7. 비용 보호 절차

### 7.1 예산 및 알림

1. Google Cloud Billing에서 월 예산을 설정한다.
2. 50%, 80%, 100% 알림을 설정한다.
3. 예산 초과 알림 수신자는 최소 2명 이상으로 설정한다.
4. Firebase Usage and billing 화면을 주기적으로 확인한다.

### 7.2 쿼리 제한

1. 앱 시작 시 전체 collection을 읽지 않는다.
2. 모든 사용자 데이터 쿼리는 `owner == currentUserUid`를 포함한다.
3. roster/Pilotlog 화면은 `Year`, `Month`, 날짜 범위 조건을 함께 사용한다.
4. 목록 화면에는 page size 또는 limit을 설정한다.
5. 불필요한 realtime listener를 사용하지 않는다.
6. 리포트 생성, 전체 rewrite, 대량 sync는 클라이언트에서 직접 실행하지 않고 backend 또는 schedule workflow에서 수행한다.

### 7.3 남용 대응

1. Render API에 rate limit을 적용한다.
2. 공개 배포에서는 Firebase Auth token 검증을 필수화한다.
3. App Check enforcement를 활성화한다.
4. 비정상 요청이 감지되면 API key 회전, Render endpoint 임시 차단, Firestore Rules 강화 순서로 대응한다.

## 8. 보관 및 삭제 절차

### 8.1 사용자 요청 삭제

1. 요청자 본인 확인을 한다.
2. Firestore에서 `owner == uid` 문서를 collection별로 조회한다.
3. `roster`, `Pilotlog`, `Perdiem`, `Payments` 문서를 삭제한다.
4. Google Sheets/Calendar에 동기화된 개인 데이터가 있으면 삭제한다.
5. 삭제 결과를 요청자에게 통지한다.

### 8.2 정기 삭제

1. 자동화 로그는 기본 90일 이내 보관을 권장한다.
2. GitHub Actions artifact는 최소 기간으로 설정한다.
3. Render logs는 필요한 기간만 보관한다.
4. 임시 export 파일은 workflow 종료 후 repository에 commit하지 않는다.

## 9. 사고 대응 절차

개인정보 유출 또는 의심 정황이 발생하면 다음 순서로 대응한다.

1. 관련 API, workflow, service account 사용을 즉시 중지한다.
2. 노출된 secret을 회전한다.
3. Firestore Rules를 기본 차단으로 임시 강화한다.
4. 접근 로그, GitHub Actions logs, Render logs를 확인한다.
5. 영향 범위와 노출 항목을 산정한다.
6. 관련 법령상 신고 및 이용자 통지 필요 여부를 검토한다.
7. 재발 방지 조치를 문서화한다.

## 10. 배포 전 점검표

- [ ] `.env`가 repository에 없다.
- [ ] service account JSON이 repository에 없다.
- [ ] `public/roster.json`, `public/roster.csv`, `public/perdiem.csv`가 repository에 없다.
- [ ] Firestore Rules가 owner 기반으로 배포되어 있다.
- [ ] FlutterFlow 모든 query에 `owner == currentUserUid` 조건이 있다.
- [ ] Render에 `ROSTER_REQUIRE_FIREBASE_AUTH=true`가 설정되어 있다.
- [ ] FlutterFlow API Call에 Firebase ID token Authorization header가 포함되어 있다.
- [ ] App Check가 모니터링 또는 enforcement 상태다.
- [ ] Google Cloud budget alert가 설정되어 있다.
- [ ] Google Sheets/Calendar 공유 대상이 최소화되어 있다.
- [ ] PDC password가 저장되지 않고 로그에 출력되지 않는다.
- [ ] 테스트 계정 A/B로 타인 데이터 접근 차단을 검증했다.

## 11. 정기 점검

| 주기 | 점검 항목 |
| --- | --- |
| 매주 | Firestore 사용량, Render logs, 실패 workflow |
| 매월 | Google Cloud 비용, GitHub Actions artifact, App Check 차단 현황 |
| 분기 | Google Sheets/Calendar 공유 권한, service account 권한, Firestore Rules |
| 변경 시 | 개인정보처리방침, 외부 위탁 서비스, 수집 항목, 보유기간 |

## 12. 담당자

| 역할 | 담당자 | 연락처 |
| --- | --- | --- |
| 개인정보 보호책임자 | [운영자명 입력] | [이메일 입력] |
| 기술 운영 담당자 | [담당자명 입력] | [이메일 입력] |
| 사고 대응 담당자 | [담당자명 입력] | [이메일 입력] |

