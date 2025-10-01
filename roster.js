// ==================== roster.js (Quick Turn 패치본, 단계별 주석 포함) ====================

// ------------------- 외부 라이브러리 / 유틸 임포트 -------------------
// Puppeteer로 웹 스크래핑, fs/path로 파일 입출력, dotenv로 환경변수 로드
import puppeteer from "puppeteer";
import fs from "fs";
import path from "path";
import "dotenv/config";
import admin from "firebase-admin";
import { google } from "googleapis";

// 내부 유틸 함수들 (시간 변환, NT/ET 계산, Date 변환 등)
import {
  blhStrToHour,
  hourToTimeStr,
  parseUTCDate,
  calculateET,
  calculateNTFromSTDSTA,
  convertDate,
  parseCrewString,
  parseYearMonthFromEeeDd
} from "./flightTimeUtils.js";

// PerDiem 관련 기능(분리 모듈)
import { generatePerDiemList, savePerDiemCSV, uploadPerDiemFirestore } from "./perdiem.js";

// ------------------- Firebase 초기화 -------------------
console.log("🚀 Firebase 초기화 시작");
// 서비스 계정 환경변수 확인 — 없으면 프로세스 종료
if (!process.env.FIREBASE_SERVICE_ACCOUNT) { console.error("❌ FIREBASE_SERVICE_ACCOUNT 없음"); process.exit(1); }

// 서비스 계정 JSON 파싱 및 private_key newline 처리
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
if (serviceAccount.private_key) serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, "\n");

// Firebase 앱 초기화 (중복 초기화 방지)
if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();
console.log("✅ Firebase 초기화 완료");

// ------------------- Google Sheets 초기화 -------------------
// Google Sheets API 인증 준비
console.log("🚀 Google Sheets 초기화 시작");
if (!process.env.GOOGLE_SHEETS_CREDENTIALS) { console.error("❌ GOOGLE_SHEETS_CREDENTIALS 없음"); process.exit(1); }
const sheetsCredentials = JSON.parse(process.env.GOOGLE_SHEETS_CREDENTIALS);
if (sheetsCredentials.private_key) sheetsCredentials.private_key = sheetsCredentials.private_key.replace(/\\n/g, "\n");

const sheetsAuth = new google.auth.GoogleAuth({
  credentials: sheetsCredentials,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"]
});
const sheetsApi = google.sheets({ version: "v4", auth: sheetsAuth });
console.log("✅ Google Sheets 초기화 완료");

// ------------------- UID / Config 로드 -------------------
// 업로드할 때 쓸 Firebase UID 및 컬렉션 이름 가져오기
const flutterflowUid = process.env.INPUT_FIREBASE_UID || process.env.FIREBASE_UID;
const firestoreAdminUid = process.env.INPUT_ADMIN_FIREBASE_UID || process.env.ADMIN_FIREBASE_UID;
const firestoreCollection = process.env.INPUT_FIRESTORE_COLLECTION || "roster";

if (!flutterflowUid || !firestoreAdminUid) { console.error("❌ Firebase UID 또는 Admin UID 없음"); process.exit(1); }
console.log("✅ UID 및 Config 로드 완료");

// ------------------- 브라우저 시작 / PDC 로그인 / Roster 페이지 수집 -------------------
(async () => {
  console.log("🚀 Puppeteer 브라우저 시작");
  // headless 브라우저 실행 (CI 환경 고려한 옵션)
  const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox","--disable-setuid-sandbox"] });
  const page = await browser.newPage();

  // 로그인 자격 확인
  const username = process.env.INPUT_PDC_USERNAME || process.env.PDC_USERNAME;
  const password = process.env.INPUT_PDC_PASSWORD || process.env.PDC_PASSWORD;
  if (!username || !password) { console.error("❌ PDC_USERNAME/PASSWORD 없음"); await browser.close(); process.exit(1); }

  // PDC 로그인 시도 (폼 입력 및 네비게이션 대기)
  console.log("🚀 PDC 로그인 시도");
  await page.goto("https://pdc-web.premia.kr/CrewConnex/default.aspx", { waitUntil: "networkidle0" });
  await page.type("#ctl00_Main_userId_edit", username, { delay: 50 });
  await page.type("#ctl00_Main_password_edit", password, { delay: 50 });
  await Promise.all([page.click("#ctl00_Main_login_btn"), page.waitForNavigation({ waitUntil: "networkidle0" })]);
  console.log("✅ 로그인 성공");

  // Roster 메뉴 클릭 후 페이지 로드 대기
  console.log("🚀 Roster 메뉴 이동");
  const rosterLink = await page.evaluateHandle(() => Array.from(document.querySelectorAll("a")).find(a => a.textContent.includes("Roster")) || null);
  if (!rosterLink) { console.error("❌ Roster 링크 없음"); await browser.close(); return; }
  await Promise.all([rosterLink.click(), page.waitForNavigation({ waitUntil: "networkidle0" })]);
  console.log("✅ Roster 메뉴 진입 성공");

  // 테이블 행을 전부 가져와서 td 텍스트를 배열화
  console.log("🚀 Roster 데이터 추출");
  await page.waitForSelector("table tr");
  const rosterRaw = await page.evaluate(() =>
    Array.from(document.querySelectorAll("table tr"))
      .map(tr => Array.from(tr.querySelectorAll("td")).map(td => td.innerText.trim()))
  );

  // 최소 한 행 이상인지 확인
  if (rosterRaw.length < 2) { console.error("❌ Roster 데이터 비어 있음"); await browser.close(); return; }
  console.log(`✅ Roster 데이터 ${rosterRaw.length - 1}행 추출 완료`);

  // ------------------- 헤더 매핑 -------------------
  // 우리가 사용할 컬럼 이름 목록을 정의하고 사이트에서의 인덱스를 찾아 headerMap에 저장
  const headers = ["Date","DC","C/I(L)","C/O(L)","Activity","F","From","STD(L)","STD(Z)","To","STA(L)","STA(Z)","BLH","AcReg","Crew"];
  const siteHeaders = rosterRaw[0];
  const headerMap = {};
  headers.forEach(h => { const idx = siteHeaders.findIndex(col => col.includes(h)); if(idx>=0) headerMap[h]=idx; });
  console.log("✅ 헤더 매핑 완료");

  // ------------------- 행 데이터 정리 (values 배열 생성) -------------------
  // site에서 가져온 row를 우리가 정한 headers 순서대로 재구성
  // 주의: 화면 레이아웃 때문에 AcReg, Crew 컬럼이 고정 인덱스(18,22)를 쓰도록 되어 있음(원본과 동일)
  let values = rosterRaw.slice(1).map(row => headers.map(h => {
    if(h==="AcReg") return row[18]||"";     // 화면 레이아웃에 따라 고정 열 사용
    if(h==="Crew") return row[22]||"";      // 화면 레이아웃에 따라 고정 열 사용
    const idx = headerMap[h];
    return idx!==undefined ? row[idx]||"" : "";
  }));

  // ------------------- 중복 제거 -------------------
  // 동일한 행(모든 컬럼값이 동일한 경우)을 제거하여 중복 업로드 방지
  console.log("🚀 중복 제거");
  const seen = new Set();
  values = values.filter(row => {
    const key = row.join("||");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  // 헤더 행을 맨 앞에 넣어 roster.json 포맷 유지
  values.unshift(headers);
  console.log("✅ 중복 제거 완료. 최종 행 수:", values.length - 1);

  await browser.close();

  // ------------------- JSON/CSV 파일로 저장 -------------------
  // public 디렉토리에 roster.json, roster.csv를 저장
  console.log("🚀 JSON/CSV 저장");
  const publicDir = path.join(process.cwd(),"public");
  if(!fs.existsSync(publicDir)) fs.mkdirSync(publicDir);
  fs.writeFileSync(path.join(publicDir,"roster.json"), JSON.stringify({values}, null, 2), "utf-8");
  fs.writeFileSync(path.join(publicDir,"roster.csv"), values.map(row=>row.map(col=>`"${(col||"").replace(/"/g,'""')}"`).join(",")).join("\n"), "utf-8");
  console.log("✅ JSON/CSV 저장 완료");

  // ------------------- PerDiem 처리 -------------------
  // generatePerDiemList에서 roster.json을 읽어 PerDiem 리스트 생성 (perdiem.js 내부 로직 실행)
  console.log("🚀 PerDiem 처리 시작");
  const perdiemList = await generatePerDiemList(path.join(publicDir, "roster.json"), flutterflowUid);
  // PerDiem 중 Flight 전용(From != To, RI/RO 존재)만 CSV/Firestore에 업로드
  const flightPerDiemList = perdiemList.filter(p => p.Destination && p.RI && p.RO);
  savePerDiemCSV(flightPerDiemList, path.join(publicDir, "perdiem.csv"));
  await uploadPerDiemFirestore(flightPerDiemList, flutterflowUid);
  console.log("✅ PerDiem 처리 완료");

  // ------------------- Roster Firestore 업로드 (메인 루프) -------------------
  console.log("🚀 Roster Firestore 업로드 시작");
  const headerMapFirestore = { "C/I(L)":"CIL", "C/O(L)":"COL", "STD(L)":"STDL", "STD(Z)":"STDZ", "STA(L)":"STAL", "STA(Z)":"STAZ" };
  const QUICK_DESTS = ["NRT","HKG","DAC"]; // Quick Turn 대상 공항

  // values 배열의 각 행(헤더 제외)을 Firestore에 업로드
  for (let i=1; i<values.length; i++) {
    const row = values[i];

    // docData 객체에 우리가 쓸 모든 필드 값을 채움 (원본 + 매핑된 헤더들)
    const docData = {};
    headers.forEach((h, idx) => {
      docData[h] = row[idx] || "";
      docData[headerMapFirestore[h] || h] = row[idx] || "";
    });

    // ------------------- 패치 적용: DateRaw 자동 보정 (Quick Turn 포함) -------------------
    // 원본 Date 컬럼(docData.Date)이 비어있다면 자동으로 보정
    // Quick Turn: 도착편이 NRT/HKG/DAC 등인 경우 이전 ICN 출발편의 날짜를 사용
    if (!docData.Date || !docData.Date.trim()) {
      const prevRow = i > 1 ? values[i-1] : null;

      // Quick Turn 조건: 현재 행의 From이 Quick 목적지이고, 이전 행(prevRow)이 ICN -> same dest 편이라면
      // (예: prevRow: ICN -> NRT, 현재 행: NRT -> ICN) 이면 prevRow의 Date를 DateRaw로 사용
      if (prevRow && QUICK_DESTS.includes(docData.From) && prevRow[9] == docData.From && prevRow[6] == "ICN") {
        docData.DateRaw = prevRow[0];
      } else {
        // Quick Turn이 아닌 경우에는 이전 날짜 우선, 없으면 다음 날짜 참조
        const prevDate = prevRow ? prevRow[0] : "";
        const nextDate = i < values.length - 1 ? values[i+1][0] : "";
        docData.DateRaw = prevDate || nextDate || "";
      }
    } else {
      // Date가 존재하면 그 값을 DateRaw로 보관
      docData.DateRaw = docData.Date;
    }
    // convertDate로 DateRaw -> Date(YYYY.MM.DD) 포맷으로 변환
    docData.Date = convertDate(docData.DateRaw);
    // ---------------------------------------------------------------------------

    // 사용자/관리자/사용자명 메타 필드 추가
    docData.userId = flutterflowUid || "";
    docData.adminId = firestoreAdminUid || "";
    docData.pdc_user_name = username || "";

    // Activity가 비어있으면 업로드하지 않음 (의미 없는 행 건너뜀)
    if (!docData.Activity || docData.Activity.trim() === "") continue;

    // ------------------- ET 계산 -------------------
    // BLH(비행시간 등)로 ET(예: 비행시간 환산값)를 계산해서 저장
    docData.ET = calculateET(docData.BLH);

    // ------------------- NT 계산 -------------------
    // 출발지와 목적지가 다를 때만 NT 계산 (같은 공항이면 "00:00")
    if (docData.From !== docData.To) {
      const flightDate = new Date(docData.Date);
      docData.NT = calculateNTFromSTDSTA(docData.STDZ, docData.STAZ, flightDate);
    } else {
      docData.NT = "00:00";
    }

    // ------------------- Crew 파싱 ----------------    ---
    // Crew 문자열을 파싱해서 배열로 저장 (parseCrewString 유틸 사용)
    docData.CrewArray = parseCrewString(docData.Crew);

    // ------------------- Year/Month 추출 -------------------
    // DateRaw(EEE dd 형태)로부터 Year/Month 파싱(유틸 함수)
    const { Year, Month } = parseYearMonthFromEeeDd(docData.DateRaw);
    docData.Year = Year;
    docData.Month = Month;

    // ------------------- undefined 값 제거 -------------------
    // Firestore에 undefined 값이 올라가지 않도록 정리
    Object.keys(docData).forEach(k => { if (docData[k] === undefined) delete docData[k]; });

    // ------------------- 중복 문서 제거 로직 -------------------
    // 동일한 (Date, DC, F, From, To, AcReg, Crew) 조합이 이미 존재하면 삭제 후 다시 업로드
    const querySnapshot = await db.collection(firestoreCollection)
      .where("Date", "==", docData.Date)
      .where("DC", "==", docData.DC)
      .where("F", "==", docData.F)
      .where("From", "==", docData.From)
      .where("To", "==", docData.To)
      .where("AcReg", "==", docData.AcReg)
      .where("Crew", "==", docData.Crew)
      .get();

    if (!querySnapshot.empty) {
      for (const d of querySnapshot.docs) await db.collection(firestoreCollection).doc(d.id).delete();
    }

    // ------------------- Firestore 신규 추가 -------------------
    const newDocRef = await db.collection(firestoreCollection).add(docData);
    console.log(`✅ ${i}행 업로드 완료: ${newDocRef.id}, NT=${docData.NT}, ET=${docData.ET}, CrewCount=${docData.CrewArray.length}, Year=${docData.Year}, Month=${docData.Month}`);
  }

  // ------------------- Google Sheets 업로드 (Crew 정보까지만) -------------------
  // Google Sheets에는 첫 15컬럼(대부분의 주요 필드)만 업로드 — Date를 convertDate로 변환해서 저장
  console.log("🚀 Google Sheets 업로드 (Crew까지만)");
  const spreadsheetId = "1mKjEd__zIoMJaa6CLmDE-wALGhtlG-USLTAiQBZnioc";
  const sheetName = "Roster1";
  const sheetValues = values.map((row, idx) => {
    if (idx === 0) return row.slice(0, 15);
    const newRow = [...row.slice(0, 15)];
    // 화면에 보이는 Date(원본)를 convertDate로 변환해서 시트에 넣음
    newRow[0] = convertDate(row[0]);
    return newRow;
  });

  try {
    await sheetsApi.spreadsheets.values.update({
      spreadsheetId,
      range: `${sheetName}!A1`,
      valueInputOption: "RAW",
      requestBody: { values: sheetValues }
    });
    console.log("✅ Google Sheets 업로드 완료");
  } catch (err) {
    console.error("❌ Google Sheets 업로드 실패:", err);
  }

})(); // (async) IIFE 끝