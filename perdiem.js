// ========================= perdiem.js (패치 통합본: Month = "Oct" 형식) =========================
import fs from "fs";
import path from "path";
import crypto from "crypto";
import admin from "firebase-admin";
import { hourToTimeStr } from "./flightTimeUtils.js";

// ------------------- 공항별 PER DIEM -------------------
export const PERDIEM_RATE = {
  EWR: 3.44,
  LAX: 3.42, SFO: 3.42, LAS: 3.42, IAD: 3.42, HNL: 3.42,
  ADD: 3.44, JUB: 3.44,
  NRT: 2.75, HKG: 2.75, SIN: 2.75,
  BKK: 2.14, DAC: 2.14,
  DAD: 2.01,
  OSL: 3.24,
  ESB: 3.00,
  AUH: 2.41, BEY: 2.41,
};

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTH_NAME_TO_NUMBER = Object.fromEntries(MONTH_NAMES.map((name, index) => [name.toLowerCase(), index + 1]));
const WEEKDAY_INDEX = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const TRANSPORT_FEE_PER_FLIGHT = 7000;
const QUICK_TURN_THRESHOLD_HOURS = 12;
const QUICK_TURN_MINIMUM_TOTAL = 33;
const FLIGHT_ACTIVITY_RE = /^YP\d+/i;
const PERDIEM_SHEET_HEADER = ["ID", "Date", "Activity", "From", "Destination", "RI", "RO", "StayHours", "Rate", "Total", "TransportFee", "Month", "Year", "Taxi", "Car", "Owner"];

function normalizeAirportCode(value) {
  return String(value || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

// ------------------- Date 변환 -------------------
export function convertDate(input) {
  if (!input || typeof input !== "string") return input;
  const parts = input.trim().split(/\s+/);
  if (parts.length < 2) return input;

  const now = new Date();
  const year = now.getUTCFullYear();

  const monthMap = {
    Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06",
    Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12"
  };

  let month, dayStr;
  if (monthMap[parts[0]]) {
    month = monthMap[parts[0]];
    dayStr = parts[1].padStart(2, "0");
  } else {
    month = String(now.getUTCMonth() + 1).padStart(2, "0");
    dayStr = parts[1].padStart(2, "0");
  }

  return `${year}.${month}.${dayStr}`;
}

// ------------------- HHMM±Offset → Date 변환 -------------------
function parseHHMMOffset(str, baseDateStr) {
  if (!str) return null;
  const match = str.match(/^(\d{2})(\d{2})([+-]\d+)?$/);
  if (!match) return null;
  const [, hh, mm, offset] = match;
  const baseDateParts = baseDateStr.split(".");
  const dayOffset = offset ? Number(offset) : 0;
  return new Date(Date.UTC(
    Number(baseDateParts[0]),
    Number(baseDateParts[1]) - 1,
    Number(baseDateParts[2]) + dayOffset,
    Number(hh),
    Number(mm)
  ));
}

function formatDateDots(year, month, day) {
  return `${year}.${String(month).padStart(2, "0")}.${String(day).padStart(2, "0")}`;
}

function incrementMonth(year, month) {
  return month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 };
}

function addMonths(year, month, delta) {
  const date = new Date(Date.UTC(year, month - 1 + delta, 1));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1 };
}

function findMonthMatchingWeekday(year, month, day, weekdayToken) {
  const expected = WEEKDAY_INDEX[weekdayToken];
  if (expected === undefined) return null;

  for (const delta of [0, 1, 2, -1]) {
    const candidate = addMonths(year, month, delta);
    const actual = new Date(Date.UTC(candidate.year, candidate.month - 1, day)).getUTCDay();
    if (actual === expected) return candidate;
  }
  return null;
}

function parseRosterDateText(input) {
  if (!input || typeof input !== "string") return null;
  const dayMatch = input.match(/\d{1,2}/);
  if (!dayMatch) return null;

  let explicitMonth = null;
  let weekday = null;
  const tokens = input.match(/\b([A-Za-z]{3,9})\b/g) || [];
  for (const token of tokens) {
    const key = token.toLowerCase();
    if (MONTH_NAME_TO_NUMBER[key]) {
      explicitMonth = MONTH_NAME_TO_NUMBER[key];
      break;
    }
    if (WEEKDAY_INDEX[key] !== undefined) weekday = key;
  }

  return { day: Number(dayMatch[0]), explicitMonth, weekday };
}

function resolveRosterDateSequence(rows, dateIndex = 0) {
  const resolved = new WeakMap();
  const now = new Date();
  let year = now.getUTCFullYear();
  let month = now.getUTCMonth() + 1;
  let lastDay = null;
  let currentDate = null;

  for (const row of rows) {
    const parsed = parseRosterDateText(row[dateIndex]);

    if (parsed) {
      if (parsed.explicitMonth) {
        if (parsed.explicitMonth < month && month - parsed.explicitMonth > 6) year += 1;
        month = parsed.explicitMonth;
      } else if (lastDay !== null && parsed.weekday && parsed.day < lastDay) {
        ({ year, month } = incrementMonth(year, month));
      } else if (parsed.weekday) {
        const matched = findMonthMatchingWeekday(year, month, parsed.day, parsed.weekday);
        if (matched) ({ year, month } = matched);
      }

      currentDate = formatDateDots(year, month, parsed.day);
      lastDay = parsed.day;
    }

    if (currentDate) resolved.set(row, currentDate);
  }

  return resolved;
}

function monthYearFromRosterDate(fallbackDateFormatted) {
  const dfParts = String(fallbackDateFormatted || "").split(".");
  const monthIndex = Number(dfParts[1] || "1") - 1;
  return {
    Year: dfParts[0] || String(new Date().getUTCFullYear()),
    Month: MONTH_NAMES[monthIndex] || "Unknown",
  };
}

function monthYearFromLocalTime(localTimeText, baseDateFormatted) {
  const localDate = parseHHMMOffset(localTimeText, baseDateFormatted);
  if (!localDate || isNaN(localDate)) return monthYearFromRosterDate(baseDateFormatted);

  return {
    Year: String(localDate.getUTCFullYear()),
    Month: MONTH_NAMES[localDate.getUTCMonth()] || "Unknown",
  };
}

function monthForSheet(month) {
  if (typeof month === "number") return month;
  const monthNum = MONTH_NAME_TO_NUMBER[String(month || "").toLowerCase()];
  return monthNum || month || "";
}

function resolvePerDiemOwner(ownerOverride = "") {
  return String(
    ownerOverride ||
    process.env.PERDIEM_OWNER ||
    process.env.INPUT_FIREBASE_UID ||
    process.env.FIREBASE_UID ||
    process.env.PERDIEM_USER_ID ||
    process.env.INPUT_ADMIN_FIREBASE_UID ||
    process.env.FIRESTORE_ADMIN_UID ||
    process.env.firestoreAdminUid ||
    ""
  ).trim();
}

// ------------------- PerDiem 계산 -------------------
function calculatePerDiem(riDate, roDate, rate) {
  if (!riDate || !roDate || riDate >= roDate) return { StayHours: "0:00", Total: 0 };
  const diffHours = (roDate - riDate) / 1000 / 3600;
  const total = Math.round(diffHours * rate * 100) / 100;
  return { StayHours: hourToTimeStr(diffHours), Total: total, Hours: diffHours };
}

function calculateQuickTurnTotal(rate) {
  return Math.round(Math.max(rate * 24 * 0.5, QUICK_TURN_MINIMUM_TOTAL) * 100) / 100;
}

function rateForAirport(airportCode) {
  const normalized = normalizeAirportCode(airportCode);
  if (normalized === "ICN") return 0;
  return PERDIEM_RATE[normalized] || 3;
}

function hoursFromTimeString(value) {
  const match = String(value || "").trim().match(/^(\d+):(\d{1,2})$/);
  if (!match) return null;
  return Number(match[1]) + Number(match[2]) / 60;
}

function calculateTotalFromHours(hours, rate, destination) {
  if (!Number.isFinite(hours) || hours <= 0 || rate <= 0) return 0;
  if (normalizeAirportCode(destination) === "ICN" && hours < QUICK_TURN_THRESHOLD_HOURS) {
    return calculateQuickTurnTotal(rate);
  }
  return Math.round(hours * rate * 100) / 100;
}

function normalizePerDiemItem(item) {
  const From = normalizeAirportCode(item.From) || "UNKNOWN";
  const Destination = normalizeAirportCode(item.Destination) || "UNKNOWN";
  const Rate = rateForAirport(From);
  const hours = hoursFromTimeString(item.StayHours);
  const Total = From === "ICN" ? 0 : calculateTotalFromHours(hours, Rate, Destination);
  return {
    ...item,
    From,
    Destination,
    Rate,
    Total,
  };
}

// ------------------- Roster.json → PerDiem 리스트 -------------------
export async function generatePerDiemList(rosterJsonPath, owner) {
  const raw = JSON.parse(fs.readFileSync(rosterJsonPath, "utf-8"));
  const rows = raw.values.slice(1);
  const resolvedDates = resolveRosterDateSequence(rows);
  const resolvedDateForRow = (row) => resolvedDates.get(row) || convertDate(row[0]);

  const perdiemList = [];
  const now = new Date();

  if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.applicationDefault() });
  }
  const db = admin.firestore();

  // ===== flightRows 필터링 =====
  const flightRows = rows.filter(r => {
    const activity = (r[4] || "").trim().toUpperCase();
    const from = (r[6] || "").trim();
    const to = (r[9] || "").trim();
    return FLIGHT_ACTIVITY_RE.test(activity) && from && to && from !== to;
  });

  for (let i = 0; i < flightRows.length; i++) {
    const row = flightRows[i];
    const [DateStr,, , , Activity,, FromRaw, STDL, STDZ, ToRaw,, STAZ] = row;

    const From = normalizeAirportCode(FromRaw) || "UNKNOWN";
    const To = normalizeAirportCode(ToRaw) || "UNKNOWN";

    let LocalDateFormatted = resolvedDateForRow(row);
    let DateFormatted = LocalDateFormatted;
    if (!DateFormatted || !DateFormatted.includes(".")) {
      DateFormatted = i > 0 ? resolvedDateForRow(flightRows[i - 1])
        : `${now.getUTCFullYear()}.${String(now.getUTCMonth() + 1).padStart(2, "0")}.${String(now.getUTCDate()).padStart(2, "0")}`;
      LocalDateFormatted = DateFormatted;
    }

    const dfParts = DateFormatted.split(".");
    const Year = dfParts[0] || String(now.getUTCFullYear());
    const monthNum = (dfParts[1] || "01").padStart(2, "0");

    let Rate = rateForAirport(From);
    let riDate = null, roDate = null;

    // ===== 귀국편 =====
    if (To === "ICN" && From !== "ICN") {
      roDate = parseHHMMOffset(STDZ, DateFormatted);

      if (i === 0) {
        const curMonthNum = Number(monthNum);
        const prevMonthNum = curMonthNum - 1 >= 1 ? curMonthNum - 1 : 12;
        const prevMonthName = MONTH_NAMES[prevMonthNum - 1] || "Unknown";
        const prevYear = prevMonthNum === 12 ? String(Number(Year) - 1) : Year;

        const eventsRef = db.collection("Perdiem").doc(owner).collection("events");

        let prevSnapshot = await eventsRef
          .where("Month", "==", prevMonthName)
          .where("Year", "==", prevYear)
          .where("Destination", "==", From)
          .orderBy("Date", "desc")
          .limit(1)
          .get();

        if (prevSnapshot.empty) {
          prevSnapshot = await eventsRef
            .where("Month", "==", prevMonthNum)
            .where("Year", "==", prevYear)
            .where("Destination", "==", From)
            .orderBy("Date", "desc")
            .limit(1)
            .get();
        }

        if (!prevSnapshot.empty) {
          const prevDoc = prevSnapshot.docs[0].data();
          if (prevDoc.RO) riDate = new Date(prevDoc.RO);
        }
      } else {
        const prevRow = flightRows[i - 1];
        riDate = parseHHMMOffset(prevRow[11], resolvedDateForRow(prevRow));
      }
    }
    // ===== 출발편 (ICN → 해외) =====
    else if (From === "ICN") {
      riDate = parseHHMMOffset(STAZ, DateFormatted);
    }
    // ===== 해외 → 해외 =====
    else {
      riDate = parseHHMMOffset(STAZ, DateFormatted);
      roDate = parseHHMMOffset(STDZ, DateFormatted);
    }

    // ===== Quick Turn 귀국편 =====
    if (To === "ICN" && From !== "ICN" && i > 0) {
      const prevRow = flightRows[i - 1];
      if (normalizeAirportCode(prevRow[6]) === "ICN" && normalizeAirportCode(prevRow[9]) === From) {
        const prevRI = parseHHMMOffset(prevRow[11], resolvedDateForRow(prevRow));
        if (prevRI instanceof Date && !isNaN(prevRI)) {
          riDate = prevRI;
          if (!DateStr || !DateStr.trim()) DateFormatted = resolvedDateForRow(prevRow);
        }
      }
    }

    // ===== Per Diem 계산 =====
    const riValid = riDate instanceof Date && !isNaN(riDate) ? riDate : null;
    const roValid = roDate instanceof Date && !isNaN(roDate) ? roDate : null;

    let { StayHours, Total, Hours } = calculatePerDiem(riValid, roValid, Rate);

    if (From === "ICN") {
      StayHours = "0:00";
      Rate = 0;
      Total = 0;
    }
    if (To === "ICN" && From !== "ICN" && Hours > 0 && Hours < QUICK_TURN_THRESHOLD_HOURS) {
      Total = calculateQuickTurnTotal(Rate);
    }

    const assigned = monthYearFromLocalTime(STDL, LocalDateFormatted);

    // ===== 교통비 =====
    const TransportFee = TRANSPORT_FEE_PER_FLIGHT;

    perdiemList.push(normalizePerDiemItem({
      Date: DateFormatted,
      Activity,
      From,
      Destination: To,
      RI: riValid ? riValid.toISOString() : "",
      RO: roValid ? roValid.toISOString() : "",
      StayHours,
      Rate,
      Total,
      TransportFee,
      Month: assigned.Month,
      Year: assigned.Year,
      owner: resolvePerDiemOwner(owner),
      uid: resolvePerDiemOwner(owner)
    }));
  }

  return perdiemList;
}

// ------------------- CSV 저장 -------------------
export function savePerDiemCSV(perdiemList, outputPath = "public/perdiem.csv") {
  if (!Array.isArray(perdiemList)) return;

  const header = "Date,Activity,From,Destination,RI,RO,StayHours,Rate,Total,TransportFee,Month,Year,Owner\n";
  const rows = perdiemList.map(item => normalizePerDiemItem(item)).map(e =>
    `${e.Date},${e.Activity},${e.From},${e.Destination},${e.RI},${e.RO},${e.StayHours},${e.Rate},${e.Total},${e.TransportFee},${e.Month},${e.Year},${e.owner || e.Owner || ""}`
  );

  try {
    const fullPath = path.join(process.cwd(), outputPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, header + rows.join("\n"), "utf-8");
    console.log(`✅ CSV 저장 완료: ${fullPath}`);
  } catch (err) {
    console.error("❌ CSV 저장 실패:", err);
  }
}

function buildPerDiemSheetKey(item) {
  return [
    item.Date,
    item.Activity,
    item.From,
    item.Destination,
    item.RI,
    item.RO,
  ].join("||");
}

function randomSheetId() {
  return crypto.randomBytes(4).toString("hex");
}

function uniqueSheetId(usedIds) {
  let id = randomSheetId();
  while (usedIds.has(id)) id = randomSheetId();
  usedIds.add(id);
  return id;
}

function safeDocIdPart(value) {
  return String(value ?? "")
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "blank";
}

function buildPerDiemDocId(item) {
  return [
    item.Year,
    item.Month,
    item.Date,
    item.Activity,
    item.From,
    item.Destination,
  ].map(safeDocIdPart).join("_");
}

function buildPerDiemDedupeKey(item) {
  return [
    String(item.Date || "").trim(),
    String(item.Activity || "").trim().toUpperCase(),
    normalizeAirportCode(item.From),
    normalizeAirportCode(item.Destination || item.To),
  ].join("|");
}

function buildPerDiemSheetRow(item, id, ownerOverride = "") {
  const owner = resolvePerDiemOwner(
    item.Owner ||
    item.owner ||
    item.uid ||
    ownerOverride
  );

  return [
    id,
    item.Date,
    item.Activity,
    item.From,
    item.Destination,
    item.RI,
    item.RO,
    item.StayHours,
    item.Rate,
    item.Total,
    item.TransportFee,
    monthForSheet(item.Month),
    item.Year,
    item.Taxi ?? "",
    item.Car ?? "",
    owner,
  ];
}

// ------------------- Google Sheets sync -------------------
export async function appendPerDiemGoogleSheet(perdiemList, sheetsApi, spreadsheetId, sheetName = "Perdiem", ownerOverride = "") {
  if (!Array.isArray(perdiemList) || !sheetsApi || !spreadsheetId) return;

  const existing = await sheetsApi.spreadsheets.values.get({
    spreadsheetId,
    range: `${sheetName}!A:P`,
  }).catch(err => {
    if (err.code === 400) console.warn(`⚠️ Google Sheets ${sheetName} 읽기 실패, append만 시도:`, err.message);
    else throw err;
    return { data: { values: [] } };
  });

  const existingRows = existing.data.values || [];
  const hasHeader = existingRows[0]?.[0] === "ID";
  const dataRows = hasHeader ? existingRows.slice(1) : existingRows;
  const usedIds = new Set(dataRows.map(row => row[0]).filter(Boolean));
  const existingIdByKey = new Map();
  for (const row of dataRows) {
    const key = buildPerDiemSheetKey({
      Date: row[1] || "",
      Activity: row[2] || "",
      From: row[3] || "",
      Destination: row[4] || "",
      RI: row[5] || "",
      RO: row[6] || "",
    });
    if (!existingIdByKey.has(key) && row[0]) existingIdByKey.set(key, row[0]);
  }

  const syncedRows = [];
  const seenKeys = new Set();
  for (const rawItem of perdiemList) {
    const item = normalizePerDiemItem(rawItem);
    const key = buildPerDiemSheetKey(item);
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    syncedRows.push(buildPerDiemSheetRow(item, existingIdByKey.get(key) || uniqueSheetId(usedIds), ownerOverride));
  }

  await sheetsApi.spreadsheets.values.clear({
    spreadsheetId,
    range: `${sheetName}!A:P`,
  });

  await sheetsApi.spreadsheets.values.update({
    spreadsheetId,
    range: `${sheetName}!A1`,
    valueInputOption: "RAW",
    requestBody: { values: [PERDIEM_SHEET_HEADER, ...syncedRows] },
  });
  console.log(`✅ Google Sheets ${sheetName} PerDiem sync 완료 (${syncedRows.length}건, 중복/삭제 정리 포함)`);
}

// ------------------- Firestore 업로드 -------------------
// rewrite 없이 기존 events를 유지하고, 동일 운항 키만 갱신/중복 제거한다.
export async function uploadPerDiemFirestore(perdiemList, ownerOverride = "") {
  const owner = resolvePerDiemOwner(ownerOverride);
  if (!Array.isArray(perdiemList) || !owner) return;

  if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.applicationDefault() });
  }

  const db = admin.firestore();
  const ownerRef = db.collection("Perdiem").doc(owner);
  const eventsRef = ownerRef.collection("events");

  await ownerRef.set({
    owner,
    uid: owner,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });

  // 입력 목록 자체의 중복을 먼저 제거한다.
  const uniqueItems = new Map();
  for (const rawItem of perdiemList) {
    const item = normalizePerDiemItem(rawItem);
    const normalized = {
      ...item,
      To: item.To || item.Destination,
      owner,
      uid: owner,
    };
    uniqueItems.set(buildPerDiemDedupeKey(normalized), normalized);
  }

  let saved = 0;
  let duplicatesDeleted = 0;

  for (const item of uniqueItems.values()) {
    const docId = buildPerDiemDocId(item);

    // 동일 Date + Activity + From + Destination 문서를 조회한다.
    const duplicateSnapshot = await eventsRef
      .where("Date", "==", item.Date)
      .where("Activity", "==", item.Activity)
      .where("From", "==", item.From)
      .where("Destination", "==", item.Destination)
      .get();

    const batch = db.batch();

    // 정규 docId 이외의 동일 문서는 삭제한다.
    for (const duplicateDoc of duplicateSnapshot.docs) {
      if (duplicateDoc.id !== docId) {
        batch.delete(duplicateDoc.ref);
        duplicatesDeleted += 1;
      }
    }

    // 정규 문서는 merge upsert한다. 다른 날짜/운항 문서는 건드리지 않는다.
    batch.set(eventsRef.doc(docId), {
      ...item,
      owner,
      uid: owner,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    await batch.commit();
    saved += 1;
  }

  console.log(
    `✅ Firestore PerDiem upsert 완료 ` +
    `(입력 ${perdiemList.length}건, 고유 ${uniqueItems.size}건, 저장 ${saved}건, 중복 삭제 ${duplicatesDeleted}건)`
  );
  console.log(`PERDIEM_STORAGE_PATH=Perdiem/${owner}/events`);
}
