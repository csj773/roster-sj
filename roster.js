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

// ------------------- Puppeteer 시작 -------------------
(async () => {
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const page = await browser.newPage();

  console.log("👉 로그인 페이지 접속 중...");
  await page.goto("https://pdc-web.premia.kr/CrewConnex/default.aspx", {
    waitUntil: "networkidle0",
  });

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
  console.log("✅ roster.json 저장 완료");

  fs.writeFileSync(path.join(publicDir, "roster.csv"), values.map(row => row.map(col => `"${(col||"").replace(/"/g,'""')}"`).join(",")).join("\n"), "utf-8");
  console.log("✅ roster.csv 저장 완료");

  await browser.close();

  // Firestore 업로드
  console.log("🚀 Firestore 업로드 시작");
  const headerMapFirestore = { "C/I(L)": "CIL", "C/O(L)": "COL", "STD(L)": "STDL", "STD(Z)": "STDZ", "STA(L)": "STAL", "STA(Z)": "STAZ" };

  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    const docData = {};
    headers.forEach((h, idx) => {
      docData[headerMapFirestore[h] || h] = row[idx] || "";
    });

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
        for (const doc of querySnapshot.docs) {
          await db.collection("roster").doc(doc.id).set(docData, { merge: true });
        }
      } else {
        await db.collection("roster").add(docData);
      }
    } catch (err) {
      console.error(`❌ ${i}행 Firestore 업로드 실패:`, err.message);
    }
  }
  console.log("🎉 Firestore 업로드 완료!");


// 🔹 Google Sheets에 업로드할 values 복사 & 변환
  const sheetValues = values.map((row, idx) => {
    if (idx === 0) return row; // 헤더는 그대로
    const newRow = [...row];
    newRow[0] = convertDate(row[0]); // Date 컬럼 변환 (A열)
    return newRow;
  });

  try {
    await sheetsApi.spreadsheets.values.update({
      spreadsheetId,
      range: `${sheetName}!A3`,
      valueInputOption: "RAW",
      requestBody: { values: sheetValues },
    });
    console.log("✅ Google Sheets A3부터 덮어쓰기 완료!");
  } catch (err) {
    console.error("❌ Google Sheets 업로드 실패:", err);
  }

})();
