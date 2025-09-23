import puppeteer from "puppeteer";
import fs from "fs";
import path from "path";
import "dotenv/config";
import admin from "firebase-admin";
import { google } from "googleapis";

// ------------------- Config Loader -------------------
const getConfigValue = (secretName, envName) => {
  if (process.env[secretName]) return process.env[secretName]; // ✅ Secrets 우선
  if (process.env[envName]) return process.env[envName];       // ✅ 없으면 env fallback
  return null;
};

// ------------------- Firebase 초기화 -------------------
const firebaseServiceAccount = getConfigValue("INPUT_FIREBASE_SERVICE_ACCOUNT", "FIREBASE_SERVICE_ACCOUNT");
if (!firebaseServiceAccount) {
  console.error("❌ FIREBASE_SERVICE_ACCOUNT 누락");
  process.exit(1);
}
const serviceAccount = JSON.parse(firebaseServiceAccount);
if (serviceAccount.private_key) serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, "\n");
if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

// ------------------- Google Sheets 초기화 -------------------
const googleSheetsCreds = getConfigValue("INPUT_GOOGLE_SHEETS_CREDENTIALS", "GOOGLE_SHEETS_CREDENTIALS");
if (!googleSheetsCreds) {
  console.error("❌ GOOGLE_SHEETS_CREDENTIALS 누락");
  process.exit(1);
}
const sheetsCredentials = JSON.parse(googleSheetsCreds);
if (sheetsCredentials.private_key) sheetsCredentials.private_key = sheetsCredentials.private_key.replace(/\\n/g, "\n");
const sheetsAuth = new google.auth.GoogleAuth({
  credentials: sheetsCredentials,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheetsApi = google.sheets({ version: "v4", auth: sheetsAuth });

// ------------------- UID / API Config -------------------
const flutterflowUid = getConfigValue("INPUT_FIREBASE_UID", "FIREBASE_UID");
const firestoreAdminUid = getConfigValue("INPUT_ADMIN_FIREBASE_UID", "ADMIN_FIREBASE_UID");
const apiBaseUrl = getConfigValue("INPUT_API_BASE_URL", "API_BASE_URL") || "https://roster-sj.onrender.com";
const apiKey = getConfigValue("INPUT_API_KEY", "API_KEY") || "change_me";
const firestoreCollection = getConfigValue("INPUT_FIRESTORE_COLLECTION", "FIRESTORE_COLLECTION") || "roster";

if (!flutterflowUid || !firestoreAdminUid) {
  console.error("❌ FlutterFlow UID 또는 Firestore Admin UID 누락");
  process.exit(1);
}

// ------------------- Puppeteer 시작 -------------------
(async () => {
  const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox", "--disable-setuid-sandbox"] });
  const page = await browser.newPage();

  const username = getConfigValue("INPUT_PDC_USERNAME", "PDC_USERNAME");
  const password = getConfigValue("INPUT_PDC_PASSWORD", "PDC_PASSWORD");
  if (!username || !password) {
    console.error("❌ PDC_USERNAME 또는 PDC_PASSWORD 누락");
    await browser.close();
    process.exit(1);
  }

  console.log(`👉 로그인 시도 중... [uid=${flutterflowUid}]`);
  await page.goto("https://pdc-web.premia.kr/CrewConnex/default.aspx", { waitUntil: "networkidle0" });
  await page.type("#ctl00_Main_userId_edit", username, { delay: 50 });
  await page.type("#ctl00_Main_password_edit", password, { delay: 50 });
  await Promise.all([page.click("#ctl00_Main_login_btn"), page.waitForNavigation({ waitUntil: "networkidle0" })]);
  console.log("✅ 로그인 성공");

  // ------------------- Roster 메뉴 이동 -------------------
  const rosterLink = await page.evaluateHandle(() => {
    const links = Array.from(document.querySelectorAll("a"));
    return links.find(a => a.textContent.includes("Roster")) || null;
  });
  if (!rosterLink) throw new Error("Roster 링크를 찾지 못했습니다.");
  await Promise.all([rosterLink.click(), page.waitForNavigation({ waitUntil: "networkidle0" })]);
  console.log("✅ Roster 메뉴 클릭 완료");

  // ------------------- Roster 테이블 추출 -------------------
  await page.waitForSelector("table tr");
  const rosterRaw = await page.evaluate(() =>
    Array.from(document.querySelectorAll("table tr")).map(tr =>
      Array.from(tr.querySelectorAll("td")).map(td => td.innerText.trim())
    )
  );
  if (rosterRaw.length < 2) throw new Error("Roster 데이터가 비어있습니다.");

  const headers = ["Date","DC","C/I(L)","C/O(L)","Activity","F","From","STD(L)","STD(Z)","To","STA(L)","STA(Z)","BLH","AcReg","Crew"];
  const siteHeaders = rosterRaw[0];
  const headerMap = {};
  headers.forEach(h => {
    const idx = siteHeaders.findIndex(col => col.includes(h));
    if (idx >= 0) headerMap[h] = idx;
  });

  let values = rosterRaw.slice(1).map(row =>
    headers.map(h => {
      if (h === "AcReg") return row[18] || "";
      if (h === "Crew") return row[22] || "";
      const idx = headerMap[h];
      return idx !== undefined ? row[idx] || "" : "";
    })
  );

  // 중복 제거
  const seen = new Set();
  values = values.filter(row => {
    const key = row.join("||");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  values.unshift(headers);

  // ------------------- JSON / CSV 저장 -------------------
  const publicDir = path.join(process.cwd(), "public");
  if (!fs.existsSync(publicDir)) fs.mkdirSync(publicDir);
  fs.writeFileSync(path.join(publicDir, "roster.json"), JSON.stringify({ values }, null, 2), "utf-8");
  fs.writeFileSync(
    path.join(publicDir, "roster.csv"),
    values.map(row => row.map(col => `"${(col||"").replace(/"/g,'""')}"`).join(",")).join("\n"),
    "utf-8"
  );
  console.log("✅ roster.json / roster.csv 저장 완료");
  await browser.close();

  // ------------------- Firestore 업로드 -------------------
console.log("🚀 Firestore 업로드 시작");
const headerMapFirestore = {
  "C/I(L)": "CIL",
  "C/O(L)": "COL",
  "STD(L)": "STDL",
  "STD(Z)": "STDZ",
  "STA(L)": "STAL",
  "STA(Z)": "STAZ"
};

for (let i = 1; i < values.length; i++) {
  const row = values[i];
  const docData = {};

  headers.forEach((h, idx) => {
    docData[headerMapFirestore[h] || h] = row[idx] || "";
  });

  // UID & 계정 정보
  docData.userId = flutterflowUid;
  docData.adminId = firestoreAdminUid;
  docData.pdc_user_name = username;

  // 비어있는 Activity → 자기 계정 데이터 삭제
  if (!docData.Activity || docData.Activity.trim() === "") {
    const querySnapshot = await db.collection(firestoreCollection)
      .where("Date", "==", docData.Date)
      .where("userId", "==", flutterflowUid) // 자기 계정만 삭제
      .get();

    for (const doc of querySnapshot.docs) {
      await db.collection(firestoreCollection).doc(doc.id).delete();
    }
    continue;
  }

  // 중복 체크 (userId 제외)
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
    // 같은 데이터가 있으면 → 자기 userId 데이터만 갱신
    let updated = false;
    for (const doc of querySnapshot.docs) {
      if (doc.data().userId === flutterflowUid) {
        await db.collection(firestoreCollection)
          .doc(doc.id)
          .set(docData, { merge: true });
        console.log(`🔄 ${i}행 기존 문서 업데이트 완료`);
        updated = true;
      }
    }
    if (!updated) {
      // 다른 userId만 있으면 → 새 문서 추가
      await db.collection(firestoreCollection).add(docData);
      console.log(`✅ ${i}행 신규 업로드 완료 (userId 다름)`);
    }
  } else {
    // 아예 없으면 → 새 문서 추가
    await db.collection(firestoreCollection).add(docData);
    console.log(`✅ ${i}행 신규 업로드 완료`);
  }
}
console.log("🎉 Firestore 업로드 완료!");

  // ------------------- Google Sheets 업로드 -------------------
  function convertDate(input){
    if(!input||typeof input!=="string") return input;
    const s=input.trim();
    const parts=s.split(/\s+/);
    if(parts.length!==2) return input;
    const token=parts[0];
    const dayStr=parts[1].replace(/^0+/,"")||"0";
    if(!/^\d+$/.test(dayStr)) return input;
    const day=parseInt(dayStr,10);
    const now=new Date();
    const year=now.getFullYear();
    const months={jan:"01",feb:"02",mar:"03",apr:"04",may:"05",jun:"06",jul:"07",aug:"08",sep:"09",oct:"10",nov:"11",dec:"12"};
    const tokenLower=token.toLowerCase();
    if(months[tokenLower]) return `${year}.${months[tokenLower]}.${String(day).padStart(2,"0")}`;
    const weekdays=["mon","tue","wed","thu","fri","sat","sun"];
    if(weekdays.includes(tokenLower)){
      const month=String(now.getMonth()+1).padStart(2,"0");
      return `${year}.${month}.${String(day).padStart(2,"0")}`;
    }
    return input;
  }

  async function updateGoogleSheet(spreadsheetId,sheetName,values,maxRetries=3){
    for(let attempt=1;attempt<=maxRetries;attempt++){
      try{
        await sheetsApi.spreadsheets.values.update({
          spreadsheetId,
          range:`${sheetName}!A1`,
          valueInputOption:"RAW",
          requestBody:{values},
        });
        console.log(`✅ Google Sheets A1부터 덮어쓰기 완료 (시도 ${attempt})`);
        break;
      }catch(err){
        console.error(`❌ Google Sheets 업로드 실패 (시도 ${attempt}):`,err.message);
        if(attempt<maxRetries){
          const delay=1000+Math.random()*1000;
          console.log(`⏳ ${delay.toFixed(0)}ms 후 재시도...`);
          await new Promise(res=>setTimeout(res,delay));
        }else console.error("❌ 최대 재시도 횟수 도달, 업로드 실패");
      }
    }
  }

  console.log("🚀 Google Sheets A1부터 덮어쓰기 시작...");
  const spreadsheetId="1mKjEd__zIoMJaa6CLmDE-wALGhtlG-USLTAiQBZnioc";
  const sheetName="Roster1";
  const sheetValues=values.map((row,idx)=> idx===0?row:[...row.slice(0,1).map(cell=>convertDate(cell)).concat(row.slice(1))]);

  await updateGoogleSheet(spreadsheetId,sheetName,sheetValues);

})();
