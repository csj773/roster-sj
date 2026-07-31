// roster.js
import fs from "fs";
import path from "path";
import "dotenv/config";
import crypto from "crypto";
import admin from "firebase-admin";
import { google } from "googleapis";
import { exec } from "child_process";

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

import { appendPerDiemGoogleSheet, generatePerDiemList, savePerDiemCSV, uploadPerDiemFirestore } from "./perdiem.js";

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
      throw new Error(`${name} JSON 파싱 실패: Render Secret File 값을 원본 JSON으로 다시 저장해야 합니다.`);
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
const rosterByUserCollection = process.env.INPUT_ROSTER_BY_USER_COLLECTION || "rosterByUser";
const runUserEmail = String(process.env.USER_ID || process.env.USER_EMAIL || "").trim().toLowerCase();
const googleOutputAllowedEmails = String(
  process.env.GOOGLE_OUTPUT_ALLOWED_EMAILS || "sjchoi787@gmail.com"
)
  .split(",")
  .map((email) => email.trim().toLowerCase())
  .filter(Boolean);
const canWritePersonalGoogleOutputs = googleOutputAllowedEmails.includes(runUserEmail);
if (!flutterflowUid || !firestoreAdminUid) {
  console.error("❌ Firebase UID 또는 Admin UID 없음");
  process.exit(1);
}
console.log("✅ UID 및 Config 로드 완료");
console.log(
  `🔐 Google Sheets/Calendar output ${canWritePersonalGoogleOutputs ? "enabled" : "skipped"} ` +
  `(USER_ID=${runUserEmail || "none"})`
);

const spreadsheetId="1mKjEd__zIoMJaa6CLmDE-wALGhtlG-USLTAiQBZnioc";

function isRenderRuntime() {
  return (
    process.env.RENDER === "true" ||
    Boolean(process.env.RENDER_SERVICE_ID) ||
    Boolean(process.env.RENDER_EXTERNAL_URL) ||
    String(process.env.HOME || "").startsWith("/opt/render")
  );
}

async function buildBrowserLaunchOptions() {
  const args = [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
  ];
  const commonOptions = {
    args,
    timeout: Number(process.env.PUPPETEER_LAUNCH_TIMEOUT_MS || 120000),
    protocolTimeout: Number(process.env.PUPPETEER_PROTOCOL_TIMEOUT_MS || 120000),
  };
  if (process.env.CHROME_PATH) {
    return { ...commonOptions, headless: "new", executablePath: process.env.CHROME_PATH };
  }

  if (isRenderRuntime()) {
    const { default: chromium } = await import("@sparticuz/chromium");
    return {
      ...commonOptions,
      headless: true,
      executablePath: await chromium.executablePath(),
      args: [...chromium.args, ...args],
    };
  }

  return { ...commonOptions, headless: "new" };
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
      return {
        text: target.text,
        aria: target.aria,
        title: target.title,
        href: target.href,
        onclick: target.onclick,
      };
    });

    if (clicked) {
      return clicked;
    }
  }

  return null;
}

async function collectRosterDiagnostics(page) {
  const diagnostics = [];
  for (const frame of page.frames()) {
    const detail = await frame.evaluate(() => {
      const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
      const candidates = Array.from(document.querySelectorAll("a,button,input,[role='button'],[onclick]"))
        .slice(0, 80)
        .map((element) => ({
          text: normalize(element.innerText || element.textContent || element.value || "").slice(0, 80),
          aria: normalize(element.getAttribute("aria-label") || "").slice(0, 80),
          title: normalize(element.getAttribute("title") || "").slice(0, 80),
          href: normalize(element.getAttribute("href") || "").slice(0, 120),
          onclick: normalize(element.getAttribute("onclick") || "").slice(0, 120),
        }))
        .filter((item) => item.text || item.aria || item.title || item.href || item.onclick);

      return {
        url: location.href,
        title: document.title,
        body: normalize(document.body?.innerText || "").slice(0, 500),
        candidates,
      };
    });
    diagnostics.push(detail);
  }
  return diagnostics;
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
          return { element, score, text, aria, title, alt, id, name, className, src, href, onclick };
        })
        .filter(item => item.score > 0)
        .sort((a, b) => b.score - a.score);

      const target = candidates[0];
      if (!target) return null;
      target.element.scrollIntoView({ block: "center", inline: "center" });
      target.element.click();
      return {
        score: target.score,
        text: target.text,
        aria: target.aria,
        title: target.title,
        alt: target.alt,
        id: target.id,
        name: target.name,
        className: target.className,
        src: target.src,
        href: target.href,
        onclick: target.onclick,
      };
    });

    if (clicked) return clicked;
  }

  for (const frame of page.frames()) {
    const submitted = await frame.evaluate(() => {
      const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
      const pad2 = (value) => String(value).padStart(2, "0");
      const lastDayOfMonth = (year, monthIndex) => new Date(year, monthIndex + 1, 0).getDate();
      const optionRangeText = (year, monthIndex) =>
        `${year}-${pad2(monthIndex + 1)}-01|${year}-${pad2(monthIndex + 1)}-${pad2(lastDayOfMonth(year, monthIndex))}`;

      const periodSelect = document.querySelector("#ctl00_Main_periodSelect, select[name='ctl00$Main$periodSelect']");
      if (periodSelect) {
        const selected = periodSelect.value || "";
        const match = selected.match(/^(\d{4})-(\d{2})-\d{2}\|/);
        if (match) {
          const currentYear = Number(match[1]);
          const currentMonthIndex = Number(match[2]) - 1;
          const nextMonthIndex = (currentMonthIndex + 1) % 12;
          const nextYear = currentMonthIndex === 11 ? currentYear + 1 : currentYear;
          const nextValue = optionRangeText(nextYear, nextMonthIndex);
          const option = Array.from(periodSelect.options).find((item) => item.value === nextValue);
          if (option) {
            periodSelect.value = nextValue;
            periodSelect.dispatchEvent(new Event("change", { bubbles: true }));
            const periodButton = document.querySelector("#ctl00_Main_period, input[name='ctl00$Main$period']");
            if (periodButton) {
              periodButton.click();
            } else {
              (periodSelect.form || document.forms[0])?.submit();
            }
            return {
              method: "periodSelectSubmit",
              previousValue: selected,
              nextValue,
              nextLabel: option.text,
              selectId: periodSelect.id,
              selectName: periodSelect.name,
            };
          }
        }
      }

      const hidden = document.querySelector("#ctl00_Main_dateRangeHidden, input[name='ctl00$Main$dateRangeHidden']");
      if (!hidden) return null;

      const parseRange = (value) => {
        const match = String(value || "").match(/(\d{2})([A-Za-z]{3})(\d{2})\s*-\s*(\d{2})([A-Za-z]{3})(\d{2})/);
        if (!match) return null;
        const monthIndex = monthNames.findIndex((name) => name.toLowerCase() === match[2].toLowerCase());
        if (monthIndex < 0) return null;
        return { year: 2000 + Number(match[3]), monthIndex };
      };
      const current = parseRange(hidden.value);
      if (!current) return null;

      const nextMonthIndex = (current.monthIndex + 1) % 12;
      const nextYear = current.monthIndex === 11 ? current.year + 1 : current.year;
      const nextRange = `01${monthNames[nextMonthIndex]}${String(nextYear).slice(-2)} - ${pad2(lastDayOfMonth(nextYear, nextMonthIndex))}${monthNames[nextMonthIndex]}${String(nextYear).slice(-2)}`;
      hidden.value = nextRange;

      const form = hidden.form || document.forms[0];
      if (!form) return null;
      form.submit();
      return {
        method: "dateRangeHiddenSubmit",
        previousRange: current,
        nextRange,
        id: hidden.id,
        name: hidden.name,
      };
    });

    if (submitted) return submitted;
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
        console.log(`ℹ️ Roster period ${period + 1}/${periodCount}: 이전 period와 동일하여 건너뜀`);
      }
      previousSignature = signature;
    } else {
      console.log(`ℹ️ Roster period ${period + 1}/${periodCount}: 데이터 없음`);
    }

    if (period >= periodCount - 1) break;
    const clicked = await clickNextRosterPeriod(page);
    if (!clicked) {
      console.log("ℹ️ 다음 Roster period 버튼을 찾지 못해 현재까지 추출한 데이터만 사용");
      break;
    }
    console.log(`✅ 다음 Roster period 이동 클릭: ${JSON.stringify(clicked)}`);
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

// ------------------- Puppeteer 브라우저 시작 -------------------
(async () => {
  console.log("🚀 Puppeteer 브라우저 시작");
  const { default: puppeteer } = await import("puppeteer");
  const browser = await puppeteer.launch(await buildBrowserLaunchOptions());
  const page = await browser.newPage();

  // ------------------- PDC 로그인 -------------------
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
  const hasAspNetRequestValidationRisk = (value) => /<|>|&#|&lt;|&gt;|%3c|%3e/i.test(String(value || ""));
  if (!username || !password) {
    console.error("❌ PDC_USERNAME/PASSWORD 없음");
    await browser.close();
    process.exit(1);
  }
  if (hasAspNetRequestValidationRisk(username)) {
    console.error("❌ PDC_USERNAME에 CrewConnex가 거부하는 문자가 있습니다. <, >, HTML/XML 형태 문자를 제거하세요.");
    await browser.close();
    process.exit(1);
  }
  if (hasAspNetRequestValidationRisk(password)) {
    console.error("❌ PDC_PASSWORD에 CrewConnex가 거부하는 문자가 있습니다. 비밀번호에서 <, >, HTML/XML 형태 문자를 제거하거나 CrewConnex 비밀번호를 변경하세요.");
    await browser.close();
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

  const loginFailure = await page.evaluate(() => {
    const text = String(document.body?.innerText || "").replace(/\s+/g, " ");
    const title = String(document.title || "");
    return {
      failed: /not recognized|invalid|login failed|incorrect|server error|potentially dangerous request\.form|request validation/i.test(text) ||
        /Login|Server Error|potentially dangerous/i.test(title),
      title,
      message: text.slice(0, 300),
    };
  });
  if (loginFailure.failed) {
    console.error(`❌ PDC 로그인 실패: ${loginFailure.message}`);
    await browser.close();
    process.exit(1);
  }
  console.log("✅ 로그인 성공");

  // ------------------- Roster 메뉴 이동 -------------------
  console.log("🚀 Roster 메뉴 이동");
  const navigationPromise = page.waitForNavigation({ waitUntil: "networkidle0", timeout: 15000 }).catch(() => null);
  const rosterClick = await clickRosterNavigation(page);
  if (!rosterClick) {
    const diagnostics = await collectRosterDiagnostics(page);
    console.error("❌ Roster 링크 없음");
    console.error(`현재 URL: ${page.url()}`);
    console.error(`화면 후보: ${JSON.stringify(diagnostics).slice(0, 3000)}`);
    await browser.close();
    return;
  }
  console.log(`✅ Roster 메뉴 클릭: ${JSON.stringify(rosterClick)}`);
  await navigationPromise;
  console.log("✅ Roster 메뉴 진입 성공");

  // ------------------- Roster 데이터 추출 -------------------
  console.log("🚀 Roster 데이터 추출");
  const rosterPeriodCount = Number.parseInt(process.env.ROSTER_PERIODS_TO_EXTRACT || "2", 10);
  const rosterRows = await extractRosterAcrossPeriods(page, Number.isFinite(rosterPeriodCount) ? rosterPeriodCount : 2);
  if (rosterRows.length < 2) { console.error("❌ Roster 데이터 비어 있음"); await browser.close(); return; }
  console.log(`✅ Roster 데이터 ${rosterRows.length - 1}행 추출 완료`);

  // ------------------- 헤더 매핑 -------------------
  const headers = ["Date","DC","C/I(L)","C/O(L)","Activity","F","From","STD(L)","STD(Z)","To","STA(L)","STA(Z)","BLH","AcReg","Crew"];
  const siteHeaders = rosterRows[0];
  const headerMap = {};
  const normalizeHeader = (value) => String(value || "").replace(/\s+/g, "").toUpperCase();
  const headerAliases = {
    Date: ["DATE"],
    DC: ["DC"],
    "C/I(L)": ["C/I(L)", "CI(L)", "CIL"],
    "C/O(L)": ["C/O(L)", "CO(L)", "COL"],
    Activity: ["ACTIVITY"],
    F: ["F", "FLT", "FLIGHT", "FLIGHTNO", "FLIGHTNUMBER"],
    From: ["FROM"],
    "STD(L)": ["STD(L)", "STDL"],
    "STD(Z)": ["STD(Z)", "STDZ"],
    To: ["TO"],
    "STA(L)": ["STA(L)", "STAL"],
    "STA(Z)": ["STA(Z)", "STAZ"],
    BLH: ["BLH", "BH"],
    AcReg: ["ACREG", "ACREGISTRATION", "A/CID", "REG"],
    Crew: ["CREW", "CC"],
  };

  headers.forEach(h => {
    const aliases = headerAliases[h] || [h];
    const idx = siteHeaders.findIndex(col => aliases.includes(normalizeHeader(col)));
    if(idx >= 0) headerMap[h] = idx;
  });
  console.log("✅ 헤더 매핑 완료");

  const dateIdx = headers.indexOf("Date");
  const dcIdx = headers.indexOf("DC");
  const activityIdx = headers.indexOf("Activity");
  const flightIdx = headers.indexOf("F");
  const fromIdx = headers.indexOf("From");
  const toIdx = headers.indexOf("To");

  // ------------------- 행 데이터 정리 -------------------
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

  // ------------------- CSV/JSON 저장 전 중복 제거 (기존 Map 로직 유지) -------------------
  console.log("🚀 CSV/JSON 저장 전 중복 제거");
  const normalizeDate = (row) => resolvedDateForRow(row) || (row[dateIdx] || "").replace(/[.\s]/g, "");

  const mapByKey = new Map();
  for (let i = 0; i < values.length; i++) {
    const row = values[i];
    const key = `${normalizeDate(row)}||${row[dcIdx]}||${row[flightIdx]}||${row[fromIdx]}||${row[toIdx]}`;
    mapByKey.set(key, row); // 나중 항목 덮어쓰기 -> 최신 유지
  }
  const dedupedRows = Array.from(mapByKey.values());
  values = [headers, ...dedupedRows];
  console.log("✅ CSV/JSON 저장 전 중복 제거 완료. 최종 행 수:", values.length - 1);
  const monthSummary = values.slice(1).reduce((summary, row) => {
    const { Year, Month } = resolvedYearMonth(resolvedDateForRow(row));
    const key = `${Year || "Unknown"}-${Month || "Unknown"}`;
    summary[key] = (summary[key] || 0) + 1;
    return summary;
  }, {});
  console.log(`📆 Roster 월별 추출 요약: ${JSON.stringify(monthSummary)}`);

  await browser.close();

  // ------------------- JSON/CSV 파일 저장 -------------------
  console.log("🚀 JSON/CSV 저장");
  const publicDir = path.join(process.cwd(),"public");
  if(!fs.existsSync(publicDir)) fs.mkdirSync(publicDir);
  fs.writeFileSync(path.join(publicDir,"roster.json"), JSON.stringify({values}, null, 2), "utf-8");
  fs.writeFileSync(
    path.join(publicDir,"roster.csv"),
    values.map(row => row.map(col => `"${(col||"").replace(/"/g,'""')}"`).join(",")).join("\n"),
    "utf-8"
  );
  console.log("✅ JSON/CSV 저장 완료");

  if (process.env.ROSTER_JSON_ONLY === "1") {
    console.log("✅ ROSTER_JSON_ONLY=1: 외부 업로드 없이 roster JSON/CSV 생성 후 종료");
    return;
  }

  // ------------------- PerDiem 처리 -------------------
  console.log("🚀 PerDiem 처리 시작");
  const perdiemList = await generatePerDiemList(path.join(publicDir,"roster.json"), flutterflowUid);
  const flightPerDiemList = perdiemList.filter(p => p.Destination && (p.RI || p.RO || p.TransportFee));
  savePerDiemCSV(flightPerDiemList, path.join(publicDir,"perdiem.csv"));
  await uploadPerDiemFirestore(flightPerDiemList, flutterflowUid);
  await appendPerDiemGoogleSheet(flightPerDiemList, sheetsApi, spreadsheetId, "Perdiem", flutterflowUid);
  console.log("✅ PerDiem 처리 완료");

  // ------------------- Roster Firestore 업로드 -------------------
  console.log("🚀 Roster Firestore 업로드 시작");

  const headerMapFirestore = { "C/I(L)":"CIL", "C/O(L)":"COL", "STD(L)":"STDL", "STD(Z)":"STDZ", "STA(L)":"STAL", "STA(Z)":"STAZ" };
  const QUICK_DESTS = ["NRT","HKG","DAC"];

  function resolveDateRaw(i, values, docData) {
    if (docData.Date && docData.Date.trim()) return docData.Date;
    const prevRow = i > 1 ? values[i - 1] : null;
    if (prevRow && QUICK_DESTS.includes(docData.From) && prevRow[9] == docData.From && prevRow[6] == "ICN")
      return prevRow[0];
    const prevDate = prevRow ? prevRow[0] : "";
    const nextDate = i < values.length - 1 ? values[i + 1][0] : "";
    return prevDate || nextDate || "";
  }

  function buildDocData(row, headers, i, values) {
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
    if (!docData.Activity || docData.Activity.trim() === "") return null;
    docData.ET = calculateET(docData.BLH);
    docData.NT = docData.From !== docData.To
      ? calculateNTFromSTDSTA(docData.STDZ, docData.STAZ, new Date(docData.Date))
      : "00:00";
    docData.CrewArray = parseCrewString(docData.Crew);
    const { Year, Month } = resolvedYearMonth(docData.Date);
    docData.Year = Year;
    docData.Month = Month;
    Object.keys(docData).forEach(k => {
      if (docData[k] === undefined) delete docData[k];
    });
    return docData;
  }

  function rosterDocId(docData) {
    return crypto.createHash("sha256").update([
      docData.owner,
      docData.Date,
      docData.DC,
      docData.Activity,
      docData.From,
      docData.To,
    ].join("|")).digest("hex");
  }

  function rosterDedupeKey(docData) {
    return [
      docData.owner,
      docData.Date,
      docData.DC,
      docData.Activity,
      docData.From,
      docData.To,
    ].map(value => String(value || "").trim().toUpperCase()).join("|");
  }

  const ROSTER_HASH_SKIP_FIELDS = new Set([
    "createdAt",
    "importedAt",
    "rewrittenAt",
    "updatedAt",
    "sourceHash",
    "sourceHashUpdatedAt",
  ]);

  function stableHashValue(value) {
    if (value == null) return null;
    if (value instanceof Date) return value.toISOString();
    if (Array.isArray(value)) return value.map(stableHashValue);
    if (typeof value === "object") {
      return Object.fromEntries(Object.keys(value)
        .filter((key) => !ROSTER_HASH_SKIP_FIELDS.has(key))
        .sort()
        .map((key) => [key, stableHashValue(value[key])]));
    }
    return value;
  }

  function sourceHashForDocEntries(entries) {
    const stableEntries = entries
      .map(({ id, data }) => ({ id, data: stableHashValue(data) }))
      .sort((a, b) => a.id.localeCompare(b.id));
    return crypto.createHash("sha256").update(JSON.stringify(stableEntries)).digest("hex");
  }

  async function commitBatchOperations(db, operations, chunkSize = 400) {
    for (let index = 0; index < operations.length; index += chunkSize) {
      const batch = db.batch();
      for (const operation of operations.slice(index, index + chunkSize)) operation(batch);
      await batch.commit();
    }
  }

  async function rewriteRosterCollection(db, collectionName, docs) {
    if (!docs.length) throw new Error("Roster rewrite aborted: no roster docs parsed");
    const owner = docs[0]?.owner || firestoreAdminUid || "";
    if (!owner) throw new Error("Roster rewrite requires owner uid");

    const uniqueDocs = new Map();
    for (const docData of docs) uniqueDocs.set(rosterDedupeKey(docData), docData);

    const ownerRef = db.collection(rosterByUserCollection).doc(owner);
    const ownerEventsRef = ownerRef.collection("events");
    const docEntries = [...uniqueDocs.values()].map((docData) => ({
      id: rosterDocId(docData),
      data: docData,
    }));
    const sourceHash = sourceHashForDocEntries(docEntries);
    const ownerSnapshot = await ownerRef.get();
    if (ownerSnapshot.exists && ownerSnapshot.get("sourceHash") === sourceHash) {
      console.log(
        `✅ Roster Firestore rewrite skip ` +
        `(owner=${owner}, 입력 ${docs.length}건, 고유 ${uniqueDocs.size}건, sourceHash 동일)`
      );
      console.log(`ROSTER_BY_USER_STORAGE_PATH=${rosterByUserCollection}/${owner}/events`);
      return;
    }

    const existingSnapshot = await db.collection(collectionName)
      .where("owner", "==", owner)
      .get();
    const existingOwnerEventsSnapshot = await ownerEventsRef.get();
    await commitBatchOperations(
      db,
      [
        ...existingSnapshot.docs.map(doc => batch => batch.delete(doc.ref)),
        ...existingOwnerEventsSnapshot.docs.map(doc => batch => batch.delete(doc.ref)),
      ]
    );

    const writes = [
      batch => batch.set(ownerRef, {
        owner,
        uid: owner,
        source: "roster_js",
        eventCount: uniqueDocs.size,
        sourceHash,
        sourceHashUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
        rewrittenAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true }),
    ];
    for (const { id, data } of docEntries) {
      writes.push(batch => batch.set(db.collection(collectionName).doc(id), data, { merge: false }));
      writes.push(batch => batch.set(ownerEventsRef.doc(id), data, { merge: false }));
    }
    await commitBatchOperations(db, writes);

    console.log(
      `✅ Roster Firestore rewrite 완료 ` +
      `(owner=${owner}, 기존 roster 삭제 ${existingSnapshot.size}건, 기존 ${rosterByUserCollection}/events 삭제 ${existingOwnerEventsSnapshot.size}건, 입력 ${docs.length}건, 고유 저장 ${uniqueDocs.size}건, 중복 제외 ${docs.length - uniqueDocs.size}건)`
    );
    console.log(`ROSTER_BY_USER_STORAGE_PATH=${rosterByUserCollection}/${owner}/events`);
  }

  const rosterDocs = [];
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    const docData = buildDocData(row, headers, i, values);
    if (!docData) continue;
    rosterDocs.push(docData);
  }
  await rewriteRosterCollection(db, firestoreCollection, rosterDocs);

  console.log("✅ Roster Firestore 업로드 완료");

  if (canWritePersonalGoogleOutputs) {
    // ------------------- Google Sheets 업로드 -------------------
    console.log("🚀 Google Sheets 업로드 시작");
    const sheetName="Roster1";
    const sheetValues = values.map((row,idx)=>{
      if(idx===0) return row.slice(0,15); 
      const newRow=[...row.slice(0,15)];
      newRow[0] = resolvedDateForRow(row) || convertDate(row[0]);
      return newRow;
    });

    try {
      await sheetsApi.spreadsheets.values.update({
        spreadsheetId,
        range:`${sheetName}!A1`,
        valueInputOption:"RAW",
        requestBody:{values:sheetValues}
      });
      console.log("✅ Google Sheets 업로드 완료");
    } catch(err) {
      console.error("❌ Google Sheets 업로드 실패:",err);
    }

    // ------------------- Google Calendar 업로드 -------------------
    console.log("🚀 Google Calendar 업로드 시작 (gcal.js)");
    const gcalPath = path.join(process.cwd(),"gcal.js");
    exec(`node "${gcalPath}"`, (error, stdout, stderr) => {
      if(error){
        console.error("❌ gcal.js 실행 실패:", error.message);
        return;
      }
      if(stderr) console.error("stderr:", stderr);
      console.log(stdout);
      console.log("✅ Google Calendar 처리 완료");
    });
  } else {
    console.log("⏭ Google Sheets Roster1 / Google Calendar 업로드 건너뜀");
  }

})();
