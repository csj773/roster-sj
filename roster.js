import puppeteer from "puppeteer";
import fs from "fs";
import path from "path";
import "dotenv/config";
import admin from "firebase-admin";
import { google } from "googleapis";

// ------------------- Firebase 초기화 -------------------
if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
  console.error("❌ FIREBASE_SERVICE_ACCOUNT 환경변수가 없습니다.");
  process.exit(1);
}

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
if (serviceAccount.private_key) {
  serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, "\n");
}

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}
const db = admin.firestore();

// ------------------- Google Sheets 초기화 -------------------
if (!process.env.GOOGLE_SHEETS_CREDENTIALS) {
  console.error("❌ GOOGLE_SHEETS_CREDENTIALS 환경변수가 없습니다.");
  process.exit(1);
}

const sheetsCredentials = JSON.parse(process.env.GOOGLE_SHEETS_CREDENTIALS);
if (sheetsCredentials.private_key) {
  sheetsCredentials.private_key = sheetsCredentials.private_key.replace(/\\n/g, "\n");
}

const sheetsAuth = new google.auth.GoogleAuth({
  credentials: sheetsCredentials,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheetsApi = google.sheets({ version: "v4", auth: sheetsAuth });

// ------------------- UID / Config -------------------
const flutterflowUid = process.env.INPUT_FIREBASE_UID || process.env.FIREBASE_UID;
const firestoreAdminUid = process.env.INPUT_ADMIN_FIREBASE_UID || process.env.ADMIN_FIREBASE_UID;
const firestoreCollection = process.env.INPUT_FIRESTORE_COLLECTION || "roster";

if (!flutterflowUid || !firestoreAdminUid) {
  console.error("❌ Firebase UID 또는 Admin UID가 설정되지 않았습니다.");
  process.exit(1);
}

// ------------------- Puppeteer 시작 -------------------
(async () => {
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const page = await browser.newPage();

  console.log("👉 로그인 페이지 접속 중...");
  await page.goto("https://pdc-web.premia.kr/CrewConnex/default.aspx", { waitUntil: "networkidle0" });

  const username = process.env.INPUT_PDC_USERNAME || process.env.PDC_USERNAME;
  const password = process.env.INPUT_PDC_PASSWORD || process.env.PDC_PASSWORD;

  if (!username || !password) {
    console.error("❌ PDC_USERNAME 또는 PDC_PASSWORD 환경변수가 없습니다.");
    await browser.close();
    process.exit(1);
  }

  console.log("👉 로그인 시도 중...");
  await page.type("#ctl00_Main_userId_edit", username, { delay: 50 });
  await page.type("#ctl00_Main_password_edit", password, { delay: 50 });
  await Promise.all([
    page.click("#ctl00_Main_login_btn"),
    page.waitForNavigation({ waitUntil: "networkidle0" }),
  ]);
  console.log("✅ 로그인 성공");

  // Roster 메뉴 이동
  const rosterLink = await page.evaluateHandle(() => {
    const links = Array.from(document.querySelectorAll("a"));
    return links.find(a => a.textContent.includes("Roster")) || null;
  });

  if (rosterLink) {
    await Promise.all([
      rosterLink.click(),
      page.waitForNavigation({ waitUntil: "networkidle0" }),
    ]);
    console.log("✅ Roster 메뉴 클릭 완료");
  } else {
    console.error("❌ Roster 링크를 찾지 못했습니다.");
    await browser.close();
    return;
  }

  // Roster 테이블 추출
  await page.waitForSelector("table tr");
  const rosterRaw = await page.evaluate(() =>
    Array.from(document.querySelectorAll("table tr")).map(tr =>
      Array.from(tr.querySelectorAll("td")).map(td => td.innerText.trim())
    )
  );

  if (rosterRaw.length < 2) {
    console.error("❌ Roster 데이터가 비어있습니다.");
    await browser.close();
    return;
  }

  const headers = ["Date", "DC", "C/I(L)", "C/O(L)", "Activity", "F", "From", "STD(L)", "STD(Z)", "To", "STA(L)", "STA(Z)", "BLH", "AcReg", "Crew"];
  const siteHeaders = rosterRaw[0];
  const headerMap = {};
  headers.forEach(h => {
    const idx = siteHeaders.findIndex(col => col.includes(h));
    if (idx >= 0) headerMap[h] = idx;
  });

  let values = rosterRaw.slice(1).map(row => headers.map(h => {
    if (h === "AcReg") return row[18] || "";
    if (h === "Crew") return row[22] || "";
    const idx = headerMap[h];
    return idx !== undefined ? row[idx] || "" : "";
  }));

  // 중복 제거
  const seen = new Set();
  values = values.filter(row => {
    const key = row.join("||");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  values.unshift(headers);

  // 파일 저장
  const publicDir = path.join(process.cwd(), "public");
  if (!fs.existsSync(publicDir)) fs.mkdirSync(publicDir);

  fs.writeFileSync(path.join(publicDir, "roster.json"), JSON.stringify({ values }, null, 2), "utf-8");
  fs.writeFileSync(path.join(publicDir, "roster.csv"), values.map(row => row.map(col => `"${(col||"").replace(/"/g,'""')}"`).join(",")).join("\n"), "utf-8");
  console.log("✅ roster.json / roster.csv 저장 완료");

  await browser.close();

// ------------------- Firestore 업로드 -------------------
console.log("🚀 Firestore 업로드 시작");
const headerMapFirestore = { "C/I(L)":"CIL","C/O(L)":"COL","STD(L)":"STDL","STD(Z)":"STDZ","STA(L)":"STAL","STA(Z)":"STAZ" };

// BLH 문자열 "HHMM" 또는 "HH:MM" -> decimal hour
function blhStrToHour(str) {
  if (!str) return 0;
  if (str.includes(":")) {
    const [h,m] = str.split(":").map(Number);
    return h + m/60;
  } else if (str.length === 4) {
    const h = Number(str.slice(0,2));
    const m = Number(str.slice(2,4));
    return h + m/60;
  }
  return 0;
}

// decimal hour -> "HH:MM"
function hourToTimeStr(hour) {
  const h = Math.floor(hour);
  let m = Math.round((hour - h) * 60);
  if (m === 60) return hourToTimeStr(h+1);
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
}

// UTC 문자열 "HHMM" 또는 "HH:MM" -> Date 객체
function parseUTCDate(dateStr, baseDate, nextDay=false) {
  let h=0, m=0;
  if (dateStr.includes(":")) {
    [h,m] = dateStr.split(":").map(Number);
  } else if (dateStr.length === 4) {
    h = Number(dateStr.slice(0,2));
    m = Number(dateStr.slice(2,4));
  }
  const d = new Date(baseDate);
  d.setUTCHours(h, m, 0, 0);
  if (nextDay) d.setUTCDate(d.getUTCDate()+1);
  return d;
}

for (let i=1; i<values.length; i++){
  const row = values[i];
  const docData = {};
  headers.forEach((h, idx) => { docData[headerMapFirestore[h]||h] = row[idx]||""; });

  // ✅ UID / Admin 적용
  docData.userId = flutterflowUid;
  docData.adminId = firestoreAdminUid;
  docData.pdc_user_name = username;

  if (!docData.Activity || docData.Activity.trim() === "") continue;

  // ------------------- ET, NT 계산 조건 -------------------
  if (docData.From !== docData.To) {
    // ET 계산
    const blhHour = blhStrToHour(docData.BLH || "0000"); // BLH string 그대로 사용
    docData.ET = blhHour > 8 ? hourToTimeStr(blhHour - 8) : "00:00";

    // NT 계산
    const flightDate = new Date(docData.Date); // YYYY-MM-DD 형식 가정
    const stdStr = docData.STDZ || "0000";
    const staStr = docData.STAZ || "0000";

    const stdDate = parseUTCDate(stdStr, flightDate);
    let nextDay = staStr.includes("+1");
    const staDate = parseUTCDate(staStr.replace("+1",""), flightDate, nextDay);

    const ntStart = new Date(flightDate); ntStart.setUTCHours(13,0,0,0);
    const ntEnd = new Date(flightDate); ntEnd.setUTCHours(21,0,0,0);

    const overlapStart = stdDate > ntStart ? stdDate : ntStart;
    const overlapEnd = staDate < ntEnd ? staDate : ntEnd;
    let ntMs = overlapEnd - overlapStart;
    if (ntMs < 0) ntMs = 0;
    const ntHours = ntMs / (1000*60*60);
    docData.NT = hourToTimeStr(ntHours);
  } else {
    // 동일 From/To인 경우 ET, NT는 0
    docData.ET = "00:00";
    docData.NT = "00:00";
  }

  // ------------------- Firestore 기존 문서 조회 -------------------
  const querySnapshot = await db.collection(firestoreCollection)
    .where("Date","==",docData.Date)
    .where("DC","==",docData.DC)
    .where("F","==",docData.F)
    .where("From","==",docData.From)
    .where("To","==",docData.To)
    .where("AcReg","==",docData.AcReg)
    .where("Crew","==",docData.Crew)
    .get();

  if (!querySnapshot.empty) {
    let updated = false;
    for (const doc of querySnapshot.docs) {
      if (doc.data().userId === flutterflowUid) {
        await db.collection(firestoreCollection).doc(doc.id).set(docData, { merge: true });
        console.log(`🔄 ${i}행 기존 문서 업데이트 완료`);
        updated = true;
      }
    }
    if (!updated) {
      await db.collection(firestoreCollection).add(docData);
      console.log(`✅ ${i}행 신규 업로드 완료 (userId가 다름)`);
    }
  } else {
    await db.collection(firestoreCollection).add(docData);
    console.log(`✅ ${i}행 신규 업로드 완료`);
  }
}
console.log("🎉 Firestore 업로드 완료!");
  
 
  // ------------------- Date 변환 함수 -------------------
  function convertDate(input) {
    if (!input || typeof input !== "string") return input;
    const s = input.trim();
    const parts = s.split(/\s+/);
    if (parts.length !== 2) return input;
    const token = parts[0];
    const dayStr = parts[1].replace(/^0+/, "") || "0";
    if (!/^\d+$/.test(dayStr)) return input;
    const day = parseInt(dayStr, 10);
    if (day < 1 || day > 31) return input;
    const now = new Date();
    const year = now.getFullYear();
    const months = { jan:"01", feb:"02", mar:"03", apr:"04", may:"05", jun:"06", jul:"07", aug:"08", sep:"09", oct:"10", nov:"11", dec:"12" };
    const tokenLower = token.toLowerCase();
    if (months[tokenLower]) return `${year}.${months[tokenLower]}.${String(day).padStart(2,"0")}`;
    const weekdays = ["mon","tue","wed","thu","fri","sat","sun"];
    if (weekdays.includes(tokenLower)) {
      const month = String(now.getMonth()+1).padStart(2,"0");
      return `${year}.${month}.${String(day).padStart(2,"0")}`;
    }
    return input;
  }

 // ------------------- Google Sheets 업로드 -------------------
console.log("🚀 Google Sheets A1부터 덮어쓰기 시작...");
const spreadsheetId = "1mKjEd__zIoMJaa6CLmDE-wALGhtlG-USLTAiQBZnioc";
const sheetName = "Roster1";

// Crew 열까지 추출
// headers 배열에서 Crew 열의 index 확인
const crewIndex = headers.findIndex(h => h === "Crew");

const sheetValues = values.map((row, idx) => {
  // 헤더는 그대로
  if (idx === 0) return row.slice(0, crewIndex + 1);

  // 날짜 변환 후 Crew까지만 포함
  const newRow = [...row];
  newRow[0] = convertDate(row[0]);
  return newRow.slice(0, crewIndex + 1);
});

try {
  await sheetsApi.spreadsheets.values.update({
    spreadsheetId,
    range: `${sheetName}!A1`,
    valueInputOption: "RAW",
    requestBody: { values: sheetValues },
  });
  console.log("✅ Google Sheets A1부터 덮어쓰기 완료!");
} catch (err) {
  console.error("❌ Google Sheets 업로드 실패:", err);
} 
})();





