// roster.js
import fs from "fs";
import path from "path";
import "dotenv/config";
import admin from "firebase-admin";
import { google } from "googleapis";

import {
  calculateET,
  calculateNTFromSTDSTA,
  convertDate,
  parseCrewString,
  parseYearMonthFromEeeDd
} from "./flightTimeUtils.js";

function readConfigValue(name) {
  if (process.env[name]) return process.env[name];

  const secretPath = `/etc/secrets/${name}`;
  if (fs.existsSync(secretPath)) {
    return fs.readFileSync(secretPath, "utf8").trim();
  }

  return "";
}

function parseJsonConfig(name, value) {
  try {
    return JSON.parse(value);
  } catch (error) {
    const normalized = value
      .replace(/^\uFEFF/, "")
      .replace(/[“”]/g, "\"")
      .replace(/[‘’]/g, "'")
      .replace(/-----BEGIN PRIVATE KEY[—–-]+/g, "-----BEGIN PRIVATE KEY-----")
      .replace(/[—–-]+END PRIVATE KEY[—–-]+/g, "-----END PRIVATE KEY-----");

    try {
      return JSON.parse(normalized);
    } catch {
      throw new Error(`${name} JSON 파싱 실패: 설정 값을 원본 JSON 형태로 확인해 주세요.`);
    }
  }
}

// ------------------- Firebase 초기화 -------------------
console.log("🚀 Firebase 초기화 시작");
const firebaseServiceAccountJson = readConfigValue("FIREBASE_SERVICE_ACCOUNT");
if (!firebaseServiceAccountJson) {
  console.error("❌ FIREBASE_SERVICE_ACCOUNT 없음");
  process.exit(1);
}
const serviceAccount = parseJsonConfig("FIREBASE_SERVICE_ACCOUNT", firebaseServiceAccountJson);
if (serviceAccount.private_key) serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, "\n");
if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();
console.log("✅ Firebase 초기화 완료");

// ------------------- Google Sheets 초기화 -------------------
console.log("🚀 Google Sheets 초기화 시작");
const googleSheetsCredentialsJson = readConfigValue("GOOGLE_SHEETS_CREDENTIALS") || firebaseServiceAccountJson;
if (!googleSheetsCredentialsJson) {
  console.error("❌ GOOGLE_SHEETS_CREDENTIALS 없음");
  process.exit(1);
}
const sheetsCredentials = parseJsonConfig("GOOGLE_SHEETS_CREDENTIALS", googleSheetsCredentialsJson);
if (sheetsCredentials.private_key) sheetsCredentials.private_key = sheetsCredentials.private_key.replace(/\\n/g, "\n");
const sheetsAuth = new google.auth.GoogleAuth({
  credentials: sheetsCredentials,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"]
});
const sheetsApi = google.sheets({ version: "v4", auth: sheetsAuth });
console.log("✅ Google Sheets 초기화 완료");

// ------------------- UID / Config -------------------
const flutterflowUid = process.env.INPUT_FIREBASE_UID || process.env.FIREBASE_UID;
const firestoreAdminUid = process.env.INPUT_ADMIN_FIREBASE_UID || process.env.ADMIN_FIREBASE_UID;
const firestoreCollection = process.env.INPUT_FIRESTORE_COLLECTION || "roster";
if (!flutterflowUid || !firestoreAdminUid) {
  console.error("❌ Firebase UID 또는 Admin UID 없음");
  process.exit(1);
}
console.log("✅ UID 및 Config 로드 완료");

const spreadsheetId = "1mKjEd__zIoMJaa6CLmDE-wALGhtlG-USLTAiQBZnioc";

function isRenderRuntime() {
  return (
    process.env.RENDER === "true" ||
    Boolean(process.env.RENDER_SERVICE_ID) ||
    Boolean(process.env.RENDER_EXTERNAL_URL) ||
    String(process.env.HOME || "").startsWith("/opt/render")
  );
}

async function buildBrowserLaunchOptions() {
  const args = ["--no-sandbox", "--disable-setuid-sandbox"];
  if (process.env.CHROME_PATH) {
    return { headless: "new", executablePath: process.env.CHROME_PATH, args };
  }

  if (isRenderRuntime()) {
    const { default: chromium } = await import("@sparticuz/chromium");
    return {
      headless: true,
      executablePath: await chromium.executablePath(),
      args: [...chromium.args, ...args],
    };
  }

  return { headless: "new", args };
}

async function clickRosterNavigation(page) {
  for (const frame of page.frames()) {
    const clicked = await frame.evaluate(() => {
      const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
      const candidates = Array.from(document.querySelectorAll("a,button,input,[role='button'],[onclick]"));
      const rosterWords = ["roster", "crew roster", "my roster", "로스터", "스케줄", "schedule"];

      const matches = candidates
        .map((element) => {
          const text = normalize(element.innerText || element.textContent || element.value || "");
          const aria = normalize(element.getAttribute("aria-label") || "");
          const title = normalize(element.getAttribute("title") || "");
          const href = normalize(element.getAttribute("href") || "");
          const onclick = normalize(element.getAttribute("onclick") || "");
          const combined = `${text} ${aria} ${title} ${href} ${onclick}`.toLowerCase();
          return { element, text, aria, title, href, onclick, combined };
        })
        .filter((item) => rosterWords.some((word) => item.combined.includes(word)))
        .filter((item) => !item.combined.includes("preference"));

      const target = matches[0];
      if (!target) return null;

      target.element.scrollIntoView({ block: "center", inline: "center" });
      target.element.click();
      return { text: target.text, aria: target.aria, title: target.title, href: target.href, onclick: target.onclick };
    });

    if (clicked) return clicked;
  }
  return null;
}

async function extractRosterRaw(page) {
  const frames = page.frames();
  let fallback = [];

  for (const frame of frames) {
    const result = await frame.evaluate(() => {
      const normalize = (value) => value.replace(/\s+/g, " ").trim();
      const tables = Array.from(document.querySelectorAll("table"));
      const tableRows = tables
        .map(table =>
          Array.from(table.querySelectorAll("tr"))
            .map(tr => Array.from(tr.querySelectorAll("th,td")).map(td => normalize(td.innerText)))
        )
        .filter(rows => rows.length > 1);

      const rosterTable = tableRows.find(rows => {
        const firstRows = rows.slice(0, 5).flat();
        return ["Date", "Activity", "From", "To"].every(header =>
          firstRows.some(cell => cell === header || cell.includes(header))
        );
      });

      return {
        rosterTable: rosterTable || null,
        fallbackTable: tableRows.sort((a, b) => b.length - a.length)[0] || [],
      };
    });

    if (result.rosterTable) return result.rosterTable;
    if (result.fallbackTable.length > fallback.length) fallback = result.fallbackTable;
  }

  return fallback;
}

function looksLikeRosterHeader(row) {
  return ["Date", "Activity", "From", "To"].every(header =>
    row.some(cell => cell === header || cell.includes(header))
  );
}

function rosterRowsFromRaw(rawRows) {
  const rosterHeaderIndex = rawRows.findIndex(looksLikeRosterHeader);
  return rosterHeaderIndex >= 0 ? rawRows.slice(rosterHeaderIndex) : rawRows;
}

function rosterRowsSignature(rows) {
  return rows
    .slice(0, 12)
    .map(row => row.map(cell => String(cell || "").trim()).join("|"))
    .join("\n");
}

async function clickNextRosterPeriod(page) {
  for (const frame of page.frames()) {
    const clicked = await frame.evaluate(() => {
      const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
      const isVisible = (element) => {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      };
      const candidates = Array.from(document.querySelectorAll("a,button,input,[role='button'],[onclick],img"))
        .filter(isVisible)
        .map((element) => {
          const text = normalize(element.innerText || element.textContent || element.value || "");
          const aria = normalize(element.getAttribute("aria-label") || "");
          const title = normalize(element.getAttribute("title") || "");
          const alt = normalize(element.getAttribute("alt") || "");
          const id = normalize(element.getAttribute("id") || "");
          const name = normalize(element.getAttribute("name") || "");
          const className = normalize(element.getAttribute("class") || "");
          const src = normalize(element.getAttribute("src") || "");
          const href = normalize(element.getAttribute("href") || "");
          const onclick = normalize(element.getAttribute("onclick") || "");
          const combined = `${text} ${aria} ${title} ${alt} ${id} ${name} ${className} ${src} ${href} ${onclick}`.toLowerCase();
          const label = `${text} ${aria} ${title} ${alt}`.trim();
          let score = 0;
          if (/^(>|›|»|next|next month|다음|익월)$/i.test(label)) score += 50;
          if (/(next|nxt|nextmonth|monthnext|forward|right|arrowright|arr_right|btnright|movenext)/i.test(combined)) score += 35;
          if (/다음|익월|이후월|다음달/.test(combined)) score += 35;
          if (/(^|\s)(>|›|»)(\s|$)/.test(label)) score += 20;
          if (/prev|previous|back|before|left|arrowleft|arr_left|btnleft|이전|전월|logout|home|today/.test(combined)) score -= 100;
          return { element, score };
        })
        .filter(item => item.score > 0)
        .sort((a, b) => b.score - a.score);

      const target = candidates[0];
      if (!target) return null;
      target.element.scrollIntoView({ block: "center", inline: "center" });
      target.element.click();
      return true;
    });

    if (clicked) return clicked;
  }
  return null;
}

async function extractRosterAcrossPeriods(page, periodCount = 2) {
  const allRows = [];
  let header = null;
  let previousSignature = "";

  for (let period = 0; period < periodCount; period += 1) {
    await sleep(3000);
    const raw = await extractRosterRaw(page);
    const rows = rosterRowsFromRaw(raw);
    if (rows.length >= 2) {
      const signature = rosterRowsSignature(rows);
      if (period === 0 || signature !== previousSignature) {
        if (!header) {
          header = rows[0];
          allRows.push(rows[0]);
        }
        allRows.push(...rows.slice(1));
        console.log(`✅ Roster period ${period + 1}/${periodCount}: ${rows.length - 1}행 추출`);
      } else {
        console.log(`ℹ️ Roster period ${period + 1}/${periodCount}: 이전 period와 동일함`);
      }
      previousSignature = signature;
    }

    if (period >= periodCount - 1) break;
    const clicked = await clickNextRosterPeriod(page);
    if (!clicked) break;
    await Promise.race([
      page.waitForNavigation({ waitUntil: "networkidle0", timeout: 12000 }).catch(() => null),
      sleep(5000),
    ]);
  }

  return allRows;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ------------------- 메인 실행 로직 -------------------
(async () => {
  console.log("🚀 Puppeteer 브라우저 시작");
  const { default: puppeteer } = await import("puppeteer");
  const browser = await puppeteer.launch(await buildBrowserLaunchOptions());

  try {
    const page = await browser.newPage();

    const normalizeCredential = (value) => {
      let normalized = String(value || "").trim();
      for (let i = 0; i < 3; i++) {
        const quoted = (normalized.startsWith("\"") && normalized.endsWith("\"")) ||
          (normalized.startsWith("'") && normalized.endsWith("'"));
        if (!quoted) break;
        normalized = normalized.slice(1, -1).trim();
      }
      return normalized;
    };

    const username = normalizeCredential(process.env.INPUT_PDC_USERNAME || process.env.PDC_USERNAME);
    const password = normalizeCredential(process.env.INPUT_PDC_PASSWORD || process.env.PDC_PASSWORD);

    if (!username || !password) {
      console.error("❌ PDC_USERNAME/PASSWORD 없음");
      process.exit(1);
    }

    console.log("🚀 PDC 로그인 시도");
    await page.goto("https://pdc-web.premia.kr/CrewConnex/default.aspx", { waitUntil: "networkidle0" });
    await page.type("#ctl00_Main_userId_edit", username, { delay: 50 });
    await page.type("#ctl00_Main_password_edit", password, { delay: 50 });
    await Promise.all([
      page.click("#ctl00_Main_login_btn"),
      page.waitForNavigation({ waitUntil: "networkidle0" })
    ]);

    console.log("✅ 로그인 성공");

    console.log("🚀 Roster 메뉴 이동");
    const navigationPromise = page.waitForNavigation({ waitUntil: "networkidle0", timeout: 15000 }).catch(() => null);
    await clickRosterNavigation(page);
    await navigationPromise;
    console.log("✅ Roster 메뉴 진입 성공");

    console.log("🚀 Roster 데이터 추출");
    const rosterPeriodCount = Number.parseInt(process.env.ROSTER_PERIODS_TO_EXTRACT || "2", 10);
    const rosterRows = await extractRosterAcrossPeriods(page, Number.isFinite(rosterPeriodCount) ? rosterPeriodCount : 2);
    if (rosterRows.length < 2) { 
      console.error("❌ Roster 데이터 비어 있음"); 
      return; 
    }
    console.log(`✅ Roster 데이터 ${rosterRows.length - 1}행 추출 완료`);

    // 헤더 정의 및 매핑
    const headers = ["Date","DC","C/I(L)","C/O(L)","Activity","F","From","STD(L)","STD(Z)","To","STA(L)","STA(Z)","BLH","AcReg","Crew"];
    const siteHeaders = rosterRows[0];
    const headerMap = {};
    const normalizeHeader = (value) => String(value || "").replace(/\s+/g, "").toUpperCase();
    const headerAliases = {
      Date: ["DATE"], DC: ["DC"], "C/I(L)": ["C/I(L)", "CI(L)", "CIL"], "C/O(L)": ["C/O(L)", "CO(L)", "COL"],
      Activity: ["ACTIVITY"], F: ["F", "FLT", "FLIGHT", "FLIGHTNO", "FLIGHTNUMBER"], From: ["FROM"],
      "STD(L)": ["STD(L)", "STDL"], "STD(Z)": ["STD(Z)", "STDZ"], To: ["TO"],
      "STA(L)": ["STA(L)", "STAL"], "STA(Z)": ["STA(Z)", "STAZ"], BLH: ["BLH", "BH"],
      AcReg: ["ACREG", "ACREGISTRATION", "A/CID", "REG"], Crew: ["CREW", "CC"],
    };

    headers.forEach(h => {
      const aliases = headerAliases[h] || [h];
      const idx = siteHeaders.findIndex(col => aliases.includes(normalizeHeader(col)));
      if(idx >= 0) headerMap[h] = idx;
    });

    const dateIdx = headers.indexOf("Date");
    const dcIdx = headers.indexOf("DC");
    const activityIdx = headers.indexOf("Activity");
    const flightIdx = headers.indexOf("F");
    const fromIdx = headers.indexOf("From");
    const toIdx = headers.indexOf("To");

    const isFlightNumber = (value) => /^YP\d+/i.test(String(value || "").trim());
    const isRosterDataRow = (row) => {
      const normalized = row.map(cell => String(cell || "").trim());
      if (normalized.every(cell => !cell)) return false;
      if (normalizeHeader(normalized[dateIdx]) === "DATE") return false;
      if (normalizeHeader(normalized[activityIdx]) === "ACTIVITY") return false;
      return Boolean(normalized[activityIdx] && (normalized[fromIdx] || normalized[toIdx]));
    };

    let values = rosterRows.slice(1)
      .map(row => headers.map(h => {
        if(h==="AcReg") return (headerMap[h] !== undefined ? row[headerMap[h]] : row[18]) || "";
        if(h==="Crew") return (headerMap[h] !== undefined ? row[headerMap[h]] : row[22]) || "";
        const idx = headerMap[h]; 
        return idx!==undefined ? row[idx]||"" : "";
      }))
      .map(row => {
        if (!row[flightIdx] && isFlightNumber(row[activityIdx])) row[flightIdx] = row[activityIdx];
        return row;
      })
      .filter(isRosterDataRow);

    const monthNames = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    const monthTokenToNumber = Object.fromEntries(monthNames.map((name, index) => [name.toLowerCase(), index + 1]));
    const weekdays = new Set(["mon","tue","wed","thu","fri","sat","sun"]);

    function incrementMonth(year, month) {
      return month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 };
    }

    function resolveRosterDateSequence(rows) {
      const resolved = new WeakMap();
      const now = new Date();
      let currentYear = now.getFullYear();
      let currentMonth = now.getMonth() + 1;
      let lastDay = null;
      let currentDate = "";

      for (const row of rows) {
        const raw = String(row[dateIdx] || "").trim();
        const parts = raw.split(/\s+/);

        if (parts.length === 2) {
          const token = parts[0].toLowerCase();
          const day = Number.parseInt(parts[1].replace(/^0+/, "") || "0", 10);
          if (Number.isInteger(day) && day >= 1 && day <= 31) {
            if (monthTokenToNumber[token]) {
              currentMonth = monthTokenToNumber[token];
            } else if (weekdays.has(token) && lastDay != null && day < lastDay) {
              ({ year: currentYear, month: currentMonth } = incrementMonth(currentYear, currentMonth));
            }
            currentDate = `${currentYear}.${String(currentMonth).padStart(2, "0")}.${String(day).padStart(2, "0")}`;
            lastDay = day;
          }
        }
        if (currentDate) resolved.set(row, currentDate);
      }
      return resolved;
    }

    const resolvedDateByRow = resolveRosterDateSequence(values);
    const resolvedDateForRow = (row) => resolvedDateByRow.get(row) || convertDate(row[dateIdx]);
    const resolvedYearMonth = (dateValue) => {
      const match = String(dateValue || "").match(/^(\d{4})\.(\d{1,2})\.(\d{1,2})$/);
      if (!match) return parseYearMonthFromEeeDd(dateValue);
      return { Year: match[1], Month: monthNames[Number(match[2]) - 1] || "" };
    };

    // 중복 데이터 정리
    const normalizeDate = (row) => resolvedDateForRow(row) || (row[dateIdx] || "").replace(/[.\s]/g, "");
    const mapByKey = new Map();
    for (let i = 0; i < values.length; i++) {
      const row = values[i];
      const key = `${normalizeDate(row)}||${row[dcIdx]}||${row[flightIdx]}||${row[fromIdx]}||${row[toIdx]}`;
      mapByKey.set(key, row);
    }
    const dedupedRows = Array.from(mapByKey.values());
    values = [headers, ...dedupedRows];

    // local roster.json/roster.csv 저장 (GitHub Actions Step 6용)
    const publicDir = path.join(process.cwd(), "public");
    if (!fs.existsSync(publicDir)) fs.mkdirSync(publicDir, { recursive: true });
    fs.writeFileSync(path.join(publicDir, "roster.json"), JSON.stringify({ values }, null, 2), "utf-8");
    fs.writeFileSync(
      path.join(publicDir, "roster.csv"),
      values.map(row => row.map(col => `"${(col || "").replace(/"/g, '""')}"`).join(",")).join("\n"),
      "utf-8"
    );
    console.log("✅ JSON 및 CSV 로컬 저장 완료");

    // ------------------- Firestore 업로드 -------------------
    console.log("🚀 Roster Firestore 업로드 시작");
    const headerMapFirestore = { "C/I(L)": "CIL", "C/O(L)": "COL", "STD(L)": "STDL", "STD(Z)": "STDZ", "STA(L)": "STAL", "STA(Z)": "STAZ" };
    const QUICK_DESTS = ["NRT", "HKG", "DAC"];

    function resolveDateRaw(i, values, docData) {
      if (docData.Date && docData.Date.trim()) return docData.Date;
      const prevRow = i > 1 ? values[i - 1] : null;
      if (prevRow && QUICK_DESTS.includes(docData.From) && prevRow[9] == docData.From && prevRow[6] == "ICN")
        return prevRow[0];
      const prevDate = prevRow ? prevRow[0] : "";
      const nextDate = i < values.length - 1 ? values[i + 1][0] : "";
      return prevDate || nextDate || "";
    }

    for (let i = 1; i < values.length; i++) {
      const row = values[i];
      const docData = {};
      headers.forEach((h, idx) => {
        docData[h] = row[idx] || "";
        docData[headerMapFirestore[h] || h] = row[idx] || "";
      });
      docData.DateRaw = resolveDateRaw(i, values, docData);
      docData.Date = resolvedDateForRow(row) || convertDate(docData.DateRaw);
      docData.owner = firestoreAdminUid || "";
      docData.uid = firestoreAdminUid || "";
      docData.pdc_user_name = username || "";
      docData.email = process.env.USER_ID || "";
      if (!docData.Activity || docData.Activity.trim() === "") continue;
      docData.ET = calculateET(docData.BLH);
      docData.NT = docData.From !== docData.To
        ? calculateNTFromSTDSTA(docData.STDZ, docData.STAZ, new Date(docData.Date))
        : "00:00";
      docData.CrewArray = parseCrewString(docData.Crew);
      const { Year, Month } = resolvedYearMonth(docData.Date);
      docData.Year = Year;
      docData.Month = Month;

      const querySnapshot = await db.collection(firestoreCollection)
        .where("owner", "==", docData.owner)
        .where("Date", "==", docData.Date)
        .where("DC", "==", docData.DC)
        .where("Activity", "==", docData.Activity)
        .where("From", "==", docData.From)
        .where("To", "==", docData.To)
        .get();

      if (!querySnapshot.empty) {
        for (const d of querySnapshot.docs) {
          await db.collection(firestoreCollection).doc(d.id).delete();
        }
      }
      await db.collection(firestoreCollection).add(docData);
    }
    console.log("✅ Roster Firestore 업로드 완료");

    // ------------------- Google Sheets 업로드 -------------------
    console.log("🚀 Google Sheets 업로드 시작");
    const sheetName = "Roster1";
    const sheetValues = values.map((row, idx) => {
      if (idx === 0) return row.slice(0, 15);
      const newRow = [...row.slice(0, 15)];
      newRow[0] = resolvedDateForRow(row) || convertDate(row[0]);
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
      console.error("❌ Google Sheets 업로드 실패:", err.message);
    }

  } catch (err) {
    console.error("❌ 처리 중 예외 발생:", err);
    process.exit(1);
  } finally {
    await browser.close();
    console.log("🏁 브라우저 세션 안전하게 종료");
  }
})();
