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

// ------------------- Puppeteer 시작 -------------------
(async () => {
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const page = await browser.newPage();

  console.log("👉 로그인 페이지 접속 중...");
  await page.goto("https://pdc-web.premia.kr/CrewConnex/default.aspx", { waitUntil: "networkidle0" });

  // ------------------- 로그인 -------------------
  const username = process.env.PDC_USERNAME;
  const password = process.env.PDC_PASSWORD;

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

  // ------------------- Roster 메뉴 이동 -------------------
  const rosterLink = await page.evaluateHandle(() => {
    const links = Array.from(document.querySelectorAll("a"));
    return links.find((a) => a.textContent.includes("Roster")) || null;
  });

  if (!rosterLink) {
    console.error("❌ Roster 링크를 찾지 못했습니다.");
    await browser.close();
    return;
  }
  await Promise.all([
    rosterLink.click(),
    page.waitForNavigation({ waitUntil: "networkidle0" }),
  ]);
  console.log("✅ Roster 메뉴 클릭 완료");

  // ------------------- Roster 테이블 추출 -------------------
  await page.waitForSelector("table tr");
  const rosterRaw = await page.evaluate(() => {
    return Array.from(document.querySelectorAll("table tr")).map(tr =>
      Array.from(tr.querySelectorAll("td")).map(td => td.innerText.trim())
    );
  });

  if (rosterRaw.length < 2) {
    console.error("❌ Roster 데이터가 비어있습니다.");
    await browser.close();
    return;
  }

  // ------------------- 헤더 매핑 -------------------
  const headers = ["Date", "DC", "C/I(L)", "C/O(L)", "Activity", "F", "From", "STD(L)", "STD(Z)", "To", "STA(L)", "STA(Z)", "BLH", "AcReg", "Crew"];
  const siteHeaders = rosterRaw[0];
  const headerMap = {};
  headers.forEach(h => {
    const idx = siteHeaders.findIndex(col => col.includes(h));
    if (idx >= 0) headerMap[h] = idx;
  });

  let values = rosterRaw.slice(1).map(row => {
    return headers.map(h => {
      if (h === "AcReg") return row[18] || "";
      if (h === "Crew") return row[22] || "";
      const idx = headerMap[h];
      return idx !== undefined ? row[idx] || "" : "";
    });
  });

  // ------------------- 중복 제거 -------------------
  const seen = new Set();
  values = values.filter(row => {
    const key = row.join("||");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  values.unshift(headers);

  // ------------------- 파일 저장 -------------------
  const publicDir = path.join(process.cwd(), "public");
  if (!fs.existsSync(publicDir)) fs.mkdirSync(publicDir);

  fs.writeFileSync(path.join(publicDir, "roster.json"), JSON.stringify({ values }, null, 2), "utf-8");
  console.log("✅ roster.json 저장 완료");

  const csvContent = values.map(row => row.map(col => `"${(col || "").replace(/"/g, '""')}"`).join(",")).join("\n");
  fs.writeFileSync(path.join(publicDir, "roster.csv"), csvContent, "utf-8");
  console.log("✅ roster.csv 저장 완료");

  await browser.close();

  // ------------------- Firestore 업로드 -------------------
  console.log("🚀 Firestore 업로드 시작");
  const headerMapFirestore = { "C/I(L)": "CIL", "C/O(L)": "COL", "STD(L)": "STDL", "STD(Z)": "STDZ", "STA(L)": "STAL", "STA(Z)": "STAZ" };

  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    const docData = {};
    headers.forEach((h, idx) => { docData[headerMapFirestore[h] || h] = row[idx] || ""; });

    try {
      const querySnapshot = await db.collection("roster")
        .where("Date", "==", docData["Date"])
        .where("DC", "==", docData["DC"])
        .where("F", "==", docData["F"])
        .where("From", "==", docData["From"])
        .where("To", "==", docData["To"])
        .where("AcReg", "==", docData["AcReg"])
        .where("Crew", "==", docData["Crew"])
        .get();

      if (!querySnapshot.empty) {
        for (const doc of querySnapshot.docs) await db.collection("roster").doc(doc.id).set(docData, { merge: true });
        console.log(`🔄 ${i}행 기존 문서 업데이트 완료`);
      } else {
        await db.collection("roster").add(docData);
        console.log(`✅ ${i}행 신규 업로드 완료`);
      }
    } catch (err) {
      console.error(`❌ ${i}행 업로드 실패:`, err.message);
    }
  }
  console.log("🎉 Firestore 업로드 완료!");

  // ------------------- Google Sheets 업데이트 및 A->B 날짜 변환 -------------------
  if (!process.env.GOOGLE_SHEETS_CREDENTIALS) {
    console.error("❌ GOOGLE_SHEETS_CREDENTIALS 환경변수가 없습니다.");
    process.exit(1);
  }

  const sheetCredentials = JSON.parse(process.env.GOOGLE_SHEETS_CREDENTIALS);
  if (sheetCredentials.private_key) sheetCredentials.private_key = sheetCredentials.private_key.replace(/\\n/g, "\n");

  const authSheets = new google.auth.GoogleAuth({
    credentials: sheetCredentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });

  const sheetsApi = google.sheets({ version: "v4", auth: authSheets });
  const spreadsheetId = "1mKjEd__zIoMJaa6CLmDE-wALGhtlG-USLTAiQBZnioc";
  const sheetName = "Roster1";

  // 헬퍼: "MMM dd" → "YYYY.MM.DD"
  function parseDateString(dateStr, year) {
    const months = { Jan:1,Feb:2,Mar:3,Apr:4,May:5,Jun:6,Jul:7,Aug:8,Sep:9,Oct:10,Nov:11,Dec:12 };
    const parts = dateStr.split(" ");
    if (parts.length !== 2) return null;
    const mon = months[parts[0]];
    const day = parseInt(parts[1],10);
    if (!mon || isNaN(day)) return null;
    return `${year}.${String(mon).padStart(2,"0")}.${String(day).padStart(2,"0")}`;
  }

  try {
    // 1️⃣ A3부터 끝까지 값 읽기
    const res = await sheetsApi.spreadsheets.values.get({ spreadsheetId, range: `${sheetName}!A3:A` });
    const rows = res.data.values || [];

    if (!rows.length) { console.log("No data found in column A."); }
    else {
      // 2️⃣ 연도 가져오기 (C2 셀)
      const yearRes = await sheetsApi.spreadsheets.values.get({ spreadsheetId, range: `${sheetName}!C2` });
      const year = parseInt(yearRes.data.values?.[0][0],10);
      if (!year) console.log("Invalid year in C2.");
      else {
        // 3️⃣ 변환 후 B열 작성
        const updatedValues = rows.map(r => [parseDateString(r[0], year)]);
        await sheetsApi.spreadsheets.values.update({ spreadsheetId, range: `${sheetName}!B3`, valueInputOption:"RAW", requestBody:{ values: updatedValues }});
        console.log("✅ Google Sheet B열에 변환된 날짜 작성 완료!");
      }
    }
  } catch (err) {
    console.error("❌ Google Sheet 날짜 변환 업로드 실패:", err);
  }

})();
