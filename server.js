import express from "express";
import { spawn } from "child_process";
import puppeteer from "puppeteer";
import admin from "firebase-admin";
import { google } from "googleapis";

const app = express();
app.use(express.json());

app.post("/runRoster", async (req, res) => {
  try {
    const { username, password, firebaseUid, adminFirebaseUid } = req.body;

    // env 우선 전달
    const env = {
      ...process.env,
      INPUT_PDC_USERNAME: username || "",
      INPUT_PDC_PASSWORD: password || "",
      INPUT_FIREBASE_UID: firebaseUid || "",
      INPUT_ADMIN_FIREBASE_UID: adminFirebaseUid || "",
    };

    // ------------------- Firebase 초기화 -------------------
    if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
      console.error("❌ FIREBASE_SERVICE_ACCOUNT 환경변수가 없습니다.");
      return res.status(500).json({ success: false, error: "FIREBASE_SERVICE_ACCOUNT 누락" });
    }
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    if (serviceAccount.private_key) serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, "\n");
    if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    const db = admin.firestore();

    // ------------------- Google Sheets 초기화 -------------------
    if (!process.env.GOOGLE_SHEETS_CREDENTIALS) {
      console.error("❌ GOOGLE_SHEETS_CREDENTIALS 환경변수가 없습니다.");
      return res.status(500).json({ success: false, error: "GOOGLE_SHEETS_CREDENTIALS 누락" });
    }
    const sheetsCredentials = JSON.parse(process.env.GOOGLE_SHEETS_CREDENTIALS);
    if (sheetsCredentials.private_key) sheetsCredentials.private_key = sheetsCredentials.private_key.replace(/\\n/g, "\n");
    const sheetsAuth = new google.auth.GoogleAuth({
      credentials: sheetsCredentials,
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });
    const sheetsApi = google.sheets({ version: "v4", auth: sheetsAuth });

    // ------------------- Puppeteer 실행 -------------------
    const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox", "--disable-setuid-sandbox"] });
    const page = await browser.newPage();

    const uid = firebaseUid || process.env.FLUTTERFLOW_UID;
    const adminUid = adminFirebaseUid || process.env.FIRESTORE_ADMIN_UID;
    const user = username || process.env.PDC_USERNAME;
    const pass = password || process.env.PDC_PASSWORD;

    if (!uid || !adminUid || !user || !pass) {
      return res.status(400).json({ success: false, error: "UID / Admin UID / PDC 계정 누락" });
    }

    console.log(`👉 로그인 시도 중... [uid=${uid}]`);
    await page.goto("https://pdc-web.premia.kr/CrewConnex/default.aspx", { waitUntil: "networkidle0" });
    await page.type("#ctl00_Main_userId_edit", user, { delay: 50 });
    await page.type("#ctl00_Main_password_edit", pass, { delay: 50 });
    await Promise.all([
      page.click("#ctl00_Main_login_btn"),
      page.waitForNavigation({ waitUntil: "networkidle0" }),
    ]);
    console.log("✅ 로그인 성공");

    // ------------------- Roster 메뉴 이동 -------------------
    const rosterLink = await page.evaluateHandle(() => {
      const links = Array.from(document.querySelectorAll("a"));
      return links.find(a => a.textContent.includes("Roster")) || null;
    });
    if (!rosterLink) throw new Error("Roster 링크를 찾지 못했습니다.");
    await Promise.all([rosterLink.click(), page.waitForNavigation({ waitUntil: "networkidle0" })]);
    console.log("✅ Roster 메뉴 클릭 완료");

    // ------------------- 테이블 추출 -------------------
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
    await browser.close();

    // ------------------- Firestore 업로드 -------------------
    const headerMapFirestore = { "C/I(L)":"CIL","C/O(L)":"COL","STD(L)":"STDL","STD(Z)":"STDZ","STA(L)":"STAL","STA(Z)":"STAZ" };
    for (let i=1; i<values.length; i++){
      const row = values[i];
      const docData = {};
      headers.forEach((h, idx)=>{ docData[headerMapFirestore[h]||h] = row[idx] || ""; });
      docData.userId = uid;
      docData.adminId = adminUid;
      docData.pdc_user_name = user;

      if (!docData.Activity || docData.Activity.trim()===""){
        const querySnapshot = await db.collection("roster").where("Date","==",docData.Date).where("userId","==",uid).get();
        for (const doc of querySnapshot.docs) await db.collection("roster").doc(doc.id).delete();
        continue;
      }

      const querySnapshot = await db.collection("roster")
        .where("Date","==",docData.Date)
        .where("DC","==",docData.DC)
        .where("F","==",docData.F)
        .where("From","==",docData.From)
        .where("To","==",docData.To)
        .where("AcReg","==",docData.AcReg)
        .where("Crew","==",docData.Crew)
        .get();

      if (!querySnapshot.empty){
        for (const doc of querySnapshot.docs){
          await db.collection("roster").doc(doc.id).set(docData,{merge:true});
        }
      } else {
        await db.collection("roster").add(docData);
      }
    }

    // ------------------- Google Sheets 업로드 -------------------
    async function updateGoogleSheet(spreadsheetId,sheetName,values,maxRetries=3){
      for(let attempt=1; attempt<=maxRetries; attempt++){
        try{
          await sheetsApi.spreadsheets.values.update({
            spreadsheetId,
            range:`${sheetName}!A1`,
            valueInputOption:"RAW",
            requestBody:{values},
          });
          break;
        }catch(err){
          if(attempt<maxRetries) await new Promise(r=>setTimeout(r,1000+Math.random()*1000));
        }
      }
    }

    const spreadsheetId = process.env.SPREADSHEET_ID || "1mKjEd__zIoMJaa6CLmDE-wALGhtlG-USLTAiQBZnioc";
    const sheetName = process.env.SHEET_NAME || "Roster1";
    await updateGoogleSheet(spreadsheetId, sheetName, values);

    res.json({ success: true });

  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.listen(3000, () => console.log("🚀 Server running on port 3000"));
