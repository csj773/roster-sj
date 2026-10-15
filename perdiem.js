// ========================= perdiem.js (from PilotLog) =========================

import fs from "fs";
import path from "path";
import crypto from "crypto";
import admin from "firebase-admin";
import { hourToTimeStr } from "./flightTimeUtils.js";

// ============================================================
// 설정
// ============================================================

export const PERDIEM_RATE = {
  EWR: 3.44,
  LAX: 3.42,
  SFO: 3.42,
  LAS: 3.42,
  IAD: 3.42,
  HNL: 3.42,
  ADD: 3.44,
  JUB: 3.44,
  NRT: 2.75,
  HKG: 2.75,
  SIN: 2.75,
  CTS: 2.75,
  NGB: 2.75,
  BKK: 2.14,
  DAC: 2.14,
  SGN: 2.14,
  DAD: 2.01,
  OSL: 3.24,
  ESB: 3.00,
  AUH: 2.41,
  BEY: 2.41,
};

const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

const MONTH_NUMBER = Object.fromEntries(
  MONTH_NAMES.map((month, index) => [month.toLowerCase(), index + 1])
);

const TRANSPORT_FEE_PER_FLIGHT = 7000;
const QUICK_TURN_THRESHOLD_HOURS = 12;
const QUICK_TURN_MINIMUM_TOTAL = 33;
const FLIGHT_ACTIVITY_RE = /^YP\d+/i;

const PERDIEM_COLLECTION = "PerdiemEvents";

const PERDIEM_SHEET_HEADER = [
  "ID", "Date", "Activity", "From", "Destination",
  "RI", "RO", "StayHours", "Rate", "Total",
  "TransportFee", "Month", "Year", "Taxi", "Car", "Owner",
];

// ============================================================
// Firebase
// ============================================================

function getDb() {
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.applicationDefault(),
    });
  }

  return admin.firestore();
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

// ============================================================
// 기본 유틸리티
// ============================================================

function normalizeAirportCode(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function safeDocIdPart(value) {
  return String(value ?? "")
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "blank";
}

function monthNumber(value) {
  if (typeof value === "number") {
    return value >= 1 && value <= 12 ? value : null;
  }

  const text = String(value || "").trim();

  if (/^\d+$/.test(text)) {
    const number = Number(text);
    return number >= 1 && number <= 12 ? number : null;
  }

  return MONTH_NUMBER[text.toLowerCase()] || null;
}

function getCurrentSeoulMonthYear() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(new Date());

  const year = parts.find(part => part.type === "year")?.value;
  const month = Number(
    parts.find(part => part.type === "month")?.value
  );

  return {
    year: String(year),
    month,
    monthName: MONTH_NAMES[month - 1],
  };
}

function toValidDate(value) {
  if (!value) return null;

  let date;

  if (value instanceof Date) {
    date = value;
  } else if (typeof value.toDate === "function") {
    date = value.toDate();
  } else if (typeof value === "string" || typeof value === "number") {
    date = new Date(value);
  } else {
    return null;
  }

  return Number.isNaN(date.getTime()) ? null : date;
}

function formatDateDots(date) {
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
  ].join(".");
}

function getDateParts(dateText) {
  const match = String(dateText || "").match(
    /^(\d{4})[.-](\d{1,2})[.-](\d{1,2})/
  );

  if (!match) return null;

  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
  };
}

function getItemYearMonth(item) {
  const parts = getDateParts(item?.Date);

  if (parts) {
    return {
      year: String(parts.year),
      month: parts.month,
    };
  }

  const year = String(item?.Year || "").trim();
  const month = monthNumber(item?.Month);

  if (!year || !month) return null;

  return { year, month };
}

function isCurrentMonth(item, currentMonthInfo) {
  const itemMonth = getItemYearMonth(item);

  return Boolean(
    itemMonth &&
    itemMonth.year === currentMonthInfo.year &&
    itemMonth.month === currentMonthInfo.month
  );
}

// ============================================================
// UTC 시각 파싱
//
// 예:
//   1746-1 -> 기준 날짜의 전날 17:46 UTC
//   0645   -> 기준 날짜 06:45 UTC
//   645    -> 기준 날짜 06:45 UTC
// ============================================================

function parseUTCClock(value, baseDateText) {
  const text = String(value || "").trim();
  const parts = getDateParts(baseDateText);

  if (!text || !parts) return null;

  const match = text.match(/^(\d{1,2})(\d{2})([+-]\d+)?$/);

  if (!match) return null;

  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const dayOffset = match[3] ? Number(match[3]) : 0;

  if (
    hour < 0 || hour > 23 ||
    minute < 0 || minute > 59 ||
    !Number.isInteger(dayOffset)
  ) {
    return null;
  }

  return new Date(Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day + dayOffset,
    hour,
    minute
  ));
}

function getAirportRate(airport) {
  const code = normalizeAirportCode(airport);

  if (code === "ICN") return 0;

  return PERDIEM_RATE[code] ?? 3;
}

function calculateQuickTurnTotal(rate) {
  return Math.round(
    Math.max(rate * 24 * 0.5, QUICK_TURN_MINIMUM_TOTAL) * 100
  ) / 100;
}

function calculateStayHours(ri, ro) {
  if (!(ri instanceof Date) || !(ro instanceof Date)) return null;
  if (Number.isNaN(ri.getTime()) || Number.isNaN(ro.getTime())) return null;

  const hours = (ro.getTime() - ri.getTime()) / 3600000;

  return hours > 0 ? hours : null;
}

// ============================================================
// Pilotlog 조회 및 필드 정규화
//
// 실제 Pilotlog 필드:
// Date, FLT, FROM, TO, STDz, STAz, Month, Year, owner
// ============================================================

async function loadPilotlogFromFirestore(owner) {
  const db = getDb();

  const snapshot = await db.collection("Pilotlog")
    .where("owner", "==", owner)
    .get();

  const records = [];

  for (const doc of snapshot.docs) {
    const data = doc.data();

    const timestampDate = toValidDate(data.Date);

    if (!timestampDate) {
      console.warn(`⚠️ Pilotlog Date 오류: ${doc.id}`);
      continue;
    }

    const dateText = formatDateDots(timestampDate);

    const activity = String(data.FLT || "").trim().toUpperCase();
    const from = normalizeAirportCode(data.FROM);
    const to = normalizeAirportCode(data.TO);

    // 비행편만 처리
    if (!FLIGHT_ACTIVITY_RE.test(activity)) continue;
    if (!from || !to || from === to) continue;

    const stdz = String(data.STDz || "").trim();
    const staz = String(data.STAz || "").trim();

    const departureUTC = parseUTCClock(stdz, dateText);
    const arrivalUTC = parseUTCClock(staz, dateText);

    if (!departureUTC || !arrivalUTC) {
      console.warn(
        `⚠️ Pilotlog 시각 오류: ${doc.id}, ` +
        `Date=${dateText}, STDz=${stdz}, STAz=${staz}`
      );
      continue;
    }

    records.push({
      id: doc.id,
      Date: dateText,
      Activity: activity,
      From: from,
      Destination: to,

      STDz: stdz,
      STAz: staz,

      DepartureUTC: departureUTC,
      ArrivalUTC: arrivalUTC,

      Month: data.Month || MONTH_NAMES[timestampDate.getUTCMonth()],
      Year: String(data.Year || timestampDate.getUTCFullYear()),

      owner,
    });
  }

  // 실제 출발 UTC 시각을 기준으로 정렬
  records.sort((a, b) =>
    a.DepartureUTC.getTime() - b.DepartureUTC.getTime()
  );

  console.log(
    `📥 Pilotlog 조회 완료: ${records.length}건, owner=${owner}`
  );

  return records;
}

// ============================================================
// Pilotlog → Per Diem 계산
//
// - ICN → 해외: 도착 시각을 RI로 사용
// - 해외 → ICN: 출발 시각을 RO로 사용
// - 해외 → ICN: 가장 최근의 ICN → 동일 해외 공항 기록을 연결
// - 과거 Pilotlog 기록은 체류 연결 계산에 활용
// ============================================================

function calculatePerDiemList(records, owner) {
  const results = [];

  // 각 해외 공항에 도착한 가장 최근 출국편을 보관한다.
  const latestOutboundByDestination = new Map();

  for (const flight of records) {
    const {
      Date,
      Activity,
      From,
      Destination,
      DepartureUTC,
      ArrivalUTC,
      Month,
      Year,
    } = flight;

    let RI = "";
    let RO = "";
    let StayHours = "0:00";
    let Rate = getAirportRate(From);
    let Total = 0;

    // 출국편: ICN → 해외
    if (From === "ICN" && Destination !== "ICN") {
      // 해외 도착 시각부터 체류 시작
      RI = ArrivalUTC.toISOString();

      latestOutboundByDestination.set(Destination, {
        RI: ArrivalUTC,
        outboundDeparture: DepartureUTC,
        outboundDate: Date,
      });

      Rate = 0;
      Total = 0;
    }

    // 귀국편: 해외 → ICN
    else if (Destination === "ICN" && From !== "ICN") {
      RO = DepartureUTC.toISOString();

      const outbound = latestOutboundByDestination.get(From);

      if (outbound) {
        RI = outbound.RI.toISOString();

        const hours = calculateStayHours(outbound.RI, DepartureUTC);

        if (hours !== null) {
          StayHours = hourToTimeStr(hours);

          Rate = getAirportRate(From);

          if (hours < QUICK_TURN_THRESHOLD_HOURS) {
            Total = calculateQuickTurnTotal(Rate);
          } else {
            Total = Math.round(hours * Rate * 100) / 100;
          }
        }
      } else {
        console.warn(
          `⚠️ 연결할 출국편 없음: ${Activity}, ${From} → ICN, ${Date}`
        );
      }
    }

    // 해외 → 해외: 이 버전에서는 별도 체류 연결을 하지 않는다.
    // 해외 경유 구간의 정확한 정산 규칙이 필요하면 별도 규칙을 추가한다.

    const dateParts = getDateParts(Date);
    const monthNumberValue = dateParts?.month || monthNumber(Month) || 1;
    const yearValue = String(dateParts?.year || Year);

    results.push({
      Date,
      Activity,
      From,
      Destination,

      RI,
      RO,
      StayHours,
      Rate,
      Total,

      TransportFee: TRANSPORT_FEE_PER_FLIGHT,

      Month: MONTH_NAMES[monthNumberValue - 1] || Month,
      Year: yearValue,

      Taxi: "",
      Car: "",

      owner,
      uid: owner,
    });
  }

  return results;
}

// ============================================================
// 기존 함수 이름 유지
//
// roster.js에서 generatePerDiemList(path, owner)를 호출하더라도
// 첫 번째 인자는 더 이상 사용하지 않고 Pilotlog에서 조회한다.
// ============================================================

export async function generatePerDiemList(_unusedRosterJsonPath, ownerOverride = "") {
  const owner = resolvePerDiemOwner(ownerOverride);

  if (!owner) {
    throw new Error(
      "PerDiem 실행 중단: 사용자 UID를 확인할 수 없습니다."
    );
  }

  const records = await loadPilotlogFromFirestore(owner);

  return calculatePerDiemList(records, owner);
}

// ============================================================
// CSV 저장
// ============================================================

function csvEscape(value) {
  const text = String(value ?? "");

  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }

  return text;
}

export function savePerDiemCSV(perdiemList, outputPath = "public/perdiem.csv") {
  if (!Array.isArray(perdiemList)) return;

  const header = [
    "Date", "Activity", "From", "Destination", "RI", "RO",
    "StayHours", "Rate", "Total", "TransportFee",
    "Month", "Year", "Owner",
  ];

  const rows = perdiemList.map(item => [
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
    item.Month,
    item.Year,
    item.owner || item.Owner || "",
  ]);

  const csv = [
    header.map(csvEscape).join(","),
    ...rows.map(row => row.map(csvEscape).join(",")),
  ].join("\n");

  const fullPath = path.join(process.cwd(), outputPath);

  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, csv, "utf8");

  console.log(`✅ PerDiem CSV 저장: ${fullPath}`);
}

// ============================================================
// PerdiemEvents 저장
//
// - owner의 현재 서울 월 데이터만 삭제 후 재작성
// - 이전 월 데이터는 삭제하거나 다시 쓰지 않음
// - 다른 owner의 데이터는 건드리지 않음
// ============================================================

function buildPerDiemDocId(item) {
  return [
    item.owner,
    item.Date,
    item.Activity,
    item.From,
    item.Destination,
  ].map(safeDocIdPart).join("_");
}

function buildPerDiemKey(item) {
  return [
    String(item.Date || "").trim(),
    String(item.Activity || "").trim().toUpperCase(),
    normalizeAirportCode(item.From),
    normalizeAirportCode(item.Destination),
  ].join("|");
}

async function commitDeleteRefs(db, refs) {
  let deleted = 0;

  for (let index = 0; index < refs.length; index += 400) {
    const batch = db.batch();
    const chunk = refs.slice(index, index + 400);

    for (const ref of chunk) {
      batch.delete(ref);
    }

    await batch.commit();
    deleted += chunk.length;
  }

  return deleted;
}

export async function uploadPerDiemFirestore(perdiemList, ownerOverride = "") {
  const owner = resolvePerDiemOwner(ownerOverride);

  if (!owner) {
    throw new Error(
      "PerdiemEvents 저장 중단: 사용자 UID가 없습니다."
    );
  }

  if (!Array.isArray(perdiemList)) {
    throw new Error("PerdiemEvents 저장 중단: 입력 데이터가 배열이 아닙니다.");
  }

  const db = getDb();
  const currentMonthInfo = getCurrentSeoulMonthYear();

  console.log(
    `📅 PerdiemEvents 갱신 월: ${currentMonthInfo.year}-` +
    `${String(currentMonthInfo.month).padStart(2, "0")}`
  );

  // 이번 달에 속하는 데이터만 저장 대상으로 선택
  const currentItems = perdiemList.filter(item =>
    isCurrentMonth(item, currentMonthInfo)
  );

  // 입력 목록 중복 제거
  const uniqueItems = new Map();

  for (const item of currentItems) {
    const normalized = {
      ...item,
      owner,
      uid: owner,
    };

    const key = buildPerDiemKey(normalized);

    if (!uniqueItems.has(key)) {
      uniqueItems.set(key, normalized);
    }
  }

  const uniqueCurrentItems = [...uniqueItems.values()];

  const collectionRef = db.collection(PERDIEM_COLLECTION);

  // 소유자 문서만 조회
  const existingSnapshot = await collectionRef
    .where("owner", "==", owner)
    .get();

  // 기존 데이터 중 현재 월인 문서만 삭제
  const refsToDelete = existingSnapshot.docs
    .filter(doc => isCurrentMonth(doc.data(), currentMonthInfo))
    .map(doc => doc.ref);

  const deleted = await commitDeleteRefs(db, refsToDelete);

  // 현재 월 데이터만 작성
  let written = 0;

  for (let index = 0; index < uniqueCurrentItems.length; index += 400) {
    const batch = db.batch();
    const chunk = uniqueCurrentItems.slice(index, index + 400);

    for (const item of chunk) {
      const id = buildPerDiemDocId(item);

      batch.set(collectionRef.doc(id), {
        ...item,
        owner,
        uid: owner,
        source: "Pilotlog",
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: false });
    }

    await batch.commit();
    written += chunk.length;
  }

  console.log(
    `✅ PerdiemEvents 저장 완료: ` +
    `입력 ${perdiemList.length}건, ` +
    `이번 달 대상 ${currentItems.length}건, ` +
    `중복 제거 후 ${uniqueCurrentItems.length}건, ` +
    `기존 이번 달 삭제 ${deleted}건, ` +
    `저장 ${written}건`
  );

  return {
    owner,
    year: currentMonthInfo.year,
    month: currentMonthInfo.monthName,
    inputRows: perdiemList.length,
    currentMonthRows: currentItems.length,
    uniqueRows: uniqueCurrentItems.length,
    deleted,
    written,
  };
}

// ============================================================
// Google Sheets 동기화
//
// 이전 달 기록과 다른 owner의 기록은 유지한다.
// 현재 owner의 현재 월 행만 교체한다.
// ============================================================

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

  while (usedIds.has(id)) {
    id = randomSheetId();
  }

  usedIds.add(id);
  return id;
}

function buildPerDiemSheetRow(item, id, owner) {
  return [
    id,
    item.Date || "",
    item.Activity || "",
    item.From || "",
    item.Destination || "",
    item.RI || "",
    item.RO || "",
    item.StayHours || "0:00",
    item.Rate ?? 0,
    item.Total ?? 0,
    item.TransportFee ?? 0,
    monthNumber(item.Month) || item.Month || "",
    item.Year || "",
    item.Taxi ?? "",
    item.Car ?? "",
    owner,
  ];
}

export async function appendPerDiemGoogleSheet(
  perdiemList,
  sheetsApi,
  spreadsheetId,
  sheetName = "Perdiem",
  ownerOverride = ""
) {
  if (!Array.isArray(perdiemList) || !sheetsApi || !spreadsheetId) return;

  const owner = resolvePerDiemOwner(ownerOverride);

  if (!owner) {
    throw new Error("Google Sheets 저장 중단: owner UID가 없습니다.");
  }

  const currentMonthInfo = getCurrentSeoulMonthYear();

  const response = await sheetsApi.spreadsheets.values.get({
    spreadsheetId,
    range: `${sheetName}!A:P`,
  });

  const existingRows = response.data.values || [];
  const hasHeader = existingRows[0]?.[0] === "ID";
  const dataRows = hasHeader ? existingRows.slice(1) : existingRows;

  const usedIds = new Set(
    dataRows.map(row => String(row[0] || "").trim()).filter(Boolean)
  );

  const existingIdByKey = new Map();

  for (const row of dataRows) {
    if (String(row[15] || "").trim() !== owner) continue;

    const existingItem = {
      Date: row[1] || "",
      Month: row[11] || "",
      Year: row[12] || "",
    };

    if (!isCurrentMonth(existingItem, currentMonthInfo)) continue;

    const key = buildPerDiemSheetKey({
      Date: row[1] || "",
      Activity: row[2] || "",
      From: row[3] || "",
      Destination: row[4] || "",
      RI: row[5] || "",
      RO: row[6] || "",
    });

    if (!existingIdByKey.has(key) && row[0]) {
      existingIdByKey.set(key, row[0]);
    }
  }

  // 이번 달 대상이 아닌 기존 행은 보존한다.
  const preservedRows = dataRows.filter(row => {
    if (String(row[15] || "").trim() !== owner) return true;

    return !isCurrentMonth({
      Date: row[1] || "",
      Month: row[11] || "",
      Year: row[12] || "",
    }, currentMonthInfo);
  });

  const seenKeys = new Set();
  const syncedRows = [];

  for (const item of perdiemList) {
    if (!isCurrentMonth(item, currentMonthInfo)) continue;

    const key = buildPerDiemSheetKey(item);

    if (seenKeys.has(key)) continue;
    seenKeys.add(key);

    const id = existingIdByKey.get(key) || uniqueSheetId(usedIds);

    syncedRows.push(buildPerDiemSheetRow(item, id, owner));
  }

  const outputRows = [
    PERDIEM_SHEET_HEADER,
    ...preservedRows,
    ...syncedRows,
  ];

  await sheetsApi.spreadsheets.values.update({
    spreadsheetId,
    range: `${sheetName}!A1`,
    valueInputOption: "RAW",
    requestBody: { values: outputRows },
  });

  // 이전 결과보다 짧아진 경우 남은 꼬리 행만 정리
  if (existingRows.length > outputRows.length) {
    await sheetsApi.spreadsheets.values.clear({
      spreadsheetId,
      range: `${sheetName}!A${outputRows.length + 1}:P${existingRows.length}`,
    });
  }

  console.log(
    `✅ Google Sheets ${sheetName}: ` +
    `보존 ${preservedRows.length}건, 이번 달 반영 ${syncedRows.length}건`
  );
}
