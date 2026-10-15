// ========================= perdiem.js (from PilotLog) 2026.10.15=========================

import fs from "fs";
import path from "path";
import crypto from "crypto";
import admin from "firebase-admin";
import { hourToTimeStr } from "./flightTimeUtils.js";

// ============================================================
// 1. 설정
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

const MONTH_NAME_TO_NUMBER = Object.fromEntries(
  MONTH_NAMES.map((month, index) => [month.toLowerCase(), index + 1])
);

const TRANSPORT_FEE_PER_FLIGHT = 7000;
const QUICK_TURN_THRESHOLD_HOURS = 12;
const QUICK_TURN_MINIMUM_TOTAL = 33;
const FLIGHT_ACTIVITY_RE = /^YP\d+/i;

const PERDIEM_FLAT_MIRROR_COLLECTION = "PerdiemEvents";
const PERDIEM_COLLECTION = "Perdiem";

const PERDIEM_SHEET_HEADER = [
  "ID",
  "Date",
  "Activity",
  "From",
  "Destination",
  "RI",
  "RO",
  "StayHours",
  "Rate",
  "Total",
  "TransportFee",
  "Month",
  "Year",
  "Taxi",
  "Car",
  "Owner",
];

// ============================================================
// 2. Firebase 초기화
// ============================================================

function getDb() {
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.applicationDefault(),
    });
  }

  return admin.firestore();
}

// ============================================================
// 3. 공통 유틸리티
// ============================================================

function normalizeAirportCode(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function safeDocIdPart(value) {
  return String(value || "")
    .trim()
    .replace(/[\/\\?#\[\]*]/g, "_")
    .replace(/\s+/g, "_");
}

function sha256(value) {
  return crypto
    .createHash("sha256")
    .update(String(value))
    .digest("hex");
}

function monthNumber(value) {
  if (value === null || value === undefined || value === "") {
    return 0;
  }

  const numeric = Number(value);

  if (Number.isInteger(numeric) && numeric >= 1 && numeric <= 12) {
    return numeric;
  }

  const normalized = String(value).trim().slice(0, 3).toLowerCase();

  return MONTH_NAME_TO_NUMBER[normalized] || 0;
}

function getAirportRate(airport) {
  return Number(PERDIEM_RATE[normalizeAirportCode(airport)] || 0);
}

function getCurrentSeoulMonthYear() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "numeric",
  }).formatToParts(new Date());

  const year = Number(parts.find((part) => part.type === "year")?.value);
  const month = Number(parts.find((part) => part.type === "month")?.value);

  return { year, month };
}

function toValidDate(value) {
  if (!value) return null;

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }

  if (typeof value.toDate === "function") {
    const date = value.toDate();
    return Number.isNaN(date.getTime()) ? null : date;
  }

  if (typeof value === "number") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  if (typeof value === "string") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  return null;
}

function formatDateDots(value) {
  const date = toValidDate(value);

  if (!date) return "";

  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
  ].join(".");
}

function getDateParts(value) {
  const match = String(value || "").match(
    /^(\d{4})[./-](\d{1,2})[./-](\d{1,2})$/
  );

  if (!match) return null;

  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
  };
}

function monthYearFromRecord(record) {
  const dateParts = getDateParts(record.Date);

  const month =
    monthNumber(record.Month) ||
    dateParts?.month ||
    0;

  const year =
    Number(record.Year) ||
    dateParts?.year ||
    0;

  return { month, year };
}

function isRecordInMonth(record, targetMonthYear) {
  const recordMonthYear = monthYearFromRecord(record);

  return (
    recordMonthYear.month === targetMonthYear.month &&
    recordMonthYear.year === targetMonthYear.year
  );
}

function formatMonthName(month) {
  return MONTH_NAMES[month - 1] || "";
}

function resolvePerDiemOwner(ownerOverride) {
  const owner = String(
    ownerOverride ||
      process.env.PERDIEM_OWNER ||
      process.env.INPUT_FIREBASE_UID ||
      process.env.FIREBASE_UID ||
      process.env.PERDIEM_USER_ID ||
      process.env.FIRESTORE_ADMIN_UID ||
      ""
  ).trim();

  if (!owner) {
    throw new Error(
      "PerDiem owner를 확인할 수 없습니다. " +
      "ownerOverride 또는 PERDIEM_OWNER / INPUT_FIREBASE_UID 환경변수를 확인하세요."
    );
  }

  return owner;
}

// ============================================================
// 4. Pilotlog UTC 시각 처리
//
// 예시:
// Date  = 2024-07-01 (UTC 기준 날짜)
// STDz  = "1746-1" -> 2024-06-30 17:46 UTC
// STAz  = "645"    -> 2024-07-01 06:45 UTC
//
// +/- 숫자는 기준 날짜로부터의 날짜 이동으로 처리합니다.
// ============================================================

function parseUTCClock(value, baseDate) {
  const date = toValidDate(baseDate);

  if (!date || value === null || value === undefined) {
    return null;
  }

  const text = String(value).trim();

  if (!text) return null;

  const match = text.match(/^(\d{1,2})(\d{2})(?:([+-])(\d+))?$/);

  if (!match) {
    return null;
  }

  const hour = Number(match[1]);
  const minute = Number(match[2]);

  if (hour > 23 || minute > 59) {
    return null;
  }

  const sign = match[3] || "";
  const offsetDays = Number(match[4] || 0);

  const result = new Date(Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
    hour,
    minute,
    0,
    0
  ));

  if (sign === "+") {
    result.setUTCDate(result.getUTCDate() + offsetDays);
  } else if (sign === "-") {
    result.setUTCDate(result.getUTCDate() - offsetDays);
  }

  return result;
}

function calculateStayHours(startDate, endDate) {
  const start = toValidDate(startDate);
  const end = toValidDate(endDate);

  if (!start || !end || end < start) {
    return null;
  }

  return (end.getTime() - start.getTime()) / 3600000;
}

function formatISODateTime(value) {
  const date = toValidDate(value);
  return date ? date.toISOString() : "";
}

function calculateQuickTurnTotal(rate) {
  return Math.max(
    QUICK_TURN_MINIMUM_TOTAL,
    Math.round(Number(rate || 0) * 100) / 100
  );
}

// ============================================================
// 5. Firestore Pilotlog 전체 기록 조회
//
// 중요:
// - 현재 월만 조회하지 않습니다.
// - 지난달 출국편이 이번 달 귀국편과 연결될 수 있도록
//   해당 owner의 Pilotlog 전체 기록을 가져옵니다.
// ============================================================

export async function loadPilotlogFromFirestore(ownerOverride) {
  const db = getDb();
  const owner = resolvePerDiemOwner(ownerOverride);

  const snapshot = await db
    .collection("Pilotlog")
    .where("owner", "==", owner)
    .get();

  const records = [];

  for (const doc of snapshot.docs) {
    const data = doc.data();

    const from = normalizeAirportCode(data.FROM);
    const destination = normalizeAirportCode(data.TO);
    const activity = String(data.FLT || "").trim();

    if (!FLIGHT_ACTIVITY_RE.test(activity)) continue;
    if (!from || !destination || from === destination) continue;

    const dateObject = toValidDate(data.Date);

    if (!dateObject) {
      console.warn(
        `⚠️ Pilotlog Date가 유효하지 않아 제외합니다: ${doc.id}`
      );
      continue;
    }

    const departureUTC = parseUTCClock(data.STDz, dateObject);
    const arrivalUTC = parseUTCClock(data.STAz, dateObject);

    if (!departureUTC || !arrivalUTC) {
      console.warn(
        `⚠️ Pilotlog UTC 시각을 해석하지 못했습니다: ` +
        `${activity}, ${from} → ${destination}, ` +
        `STDz=${data.STDz}, STAz=${data.STAz}`
      );
      continue;
    }

    const dateText = formatDateDots(dateObject);
    const dateParts = getDateParts(dateText);

    records.push({
      pilotlogDocId: doc.id,
      Date: dateText,
      Activity: activity,
      From: from,
      Destination: destination,

      DepartureUTC: departureUTC,
      ArrivalUTC: arrivalUTC,

      STDz: String(data.STDz || ""),
      STAz: String(data.STAz || ""),

      // Pilotlog에 저장된 월/년 정보를 우선 보존합니다.
      Month:
        String(data.Month || "").trim() ||
        formatMonthName(dateParts?.month || 0),

      Year:
        String(data.Year || "").trim() ||
        String(dateParts?.year || ""),

      owner,
      uid: owner,
    });
  }

  records.sort((a, b) => {
    const timeDifference =
      a.DepartureUTC.getTime() - b.DepartureUTC.getTime();

    if (timeDifference !== 0) return timeDifference;

    return a.Activity.localeCompare(b.Activity);
  });

  console.log(
    `✈️ Pilotlog 조회 완료: owner=${owner}, ` +
    `전체 ${snapshot.size}건, 계산 대상 ${records.length}건`
  );

  return records;
}

// ============================================================
// 6. Per Diem 계산
//
// ICN -> 해외:
//   해외 도착 시각을 RI로 저장해 귀국편과 연결합니다.
//
// 해외 -> ICN:
//   해외 출발 시각을 RO로 사용합니다.
//   같은 해외공항의 이전 ICN 출발편과 연결해 체류시간을 계산합니다.
//
// 지난달 출국편도 records에 포함되어 있다면 이번 달 귀국편에
// 연결할 수 있습니다.
// ============================================================

export function calculatePerDiemList(records, ownerOverride) {
  const owner = resolvePerDiemOwner(ownerOverride);

  const results = [];
  const pendingOutboundByDestination = new Map();

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

    const from = normalizeAirportCode(From);
    const destination = normalizeAirportCode(Destination);

    let RI = "";
    let RO = "";
    let StayHours = "0:00";
    let Rate = getAirportRate(from);
    let Total = 0;

    const isOutbound = from === "ICN" && destination !== "ICN";
    const isInbound = destination === "ICN" && from !== "ICN";

    if (isOutbound) {
      // ICN 출발편의 해외 도착 시각을 귀국편 계산용으로 보관합니다.
      pendingOutboundByDestination.set(destination, {
        RI: ArrivalUTC,
        outboundDate: Date,
        outboundMonth: Month,
        outboundYear: Year,
        outboundFlight: Activity,
        outboundFrom: from,
        outboundDestination: destination,
      });

      Rate = 0;
      Total = 0;
    } else if (isInbound) {
      // 귀국편은 해외공항에서 출발한 UTC 시각을 RO로 사용합니다.
      RO = formatISODateTime(DepartureUTC);

      const outbound = pendingOutboundByDestination.get(from);

      if (outbound && outbound.RI instanceof Date) {
        RI = formatISODateTime(outbound.RI);

        const hours = calculateStayHours(
          outbound.RI,
          DepartureUTC
        );

        if (hours !== null) {
          StayHours = hourToTimeStr(hours);
          Rate = getAirportRate(from);

          if (hours < QUICK_TURN_THRESHOLD_HOURS) {
            Total = calculateQuickTurnTotal(Rate);
          } else {
            Total = Math.round(hours * Rate * 100) / 100;
          }

          console.log(
            `✈️ PerDiem 연결: ` +
            `${outbound.outboundFlight} (${outbound.outboundDate}) → ` +
            `${Activity} (${Date}), 공항=${from}, ` +
            `체류=${StayHours}, Rate=${Rate}, Total=${Total}`
          );
        } else {
          console.warn(
            `⚠️ 체류시간을 계산할 수 없습니다: ` +
            `${outbound.outboundFlight} → ${Activity}`
          );
        }

        pendingOutboundByDestination.delete(from);
      } else {
        console.warn(
          `⚠️ 연결할 ICN 출발편을 찾지 못했습니다: ` +
          `${Activity}, ${from} → ICN, Date=${Date}`
        );
      }
    } else {
      // 해외-해외 등 ICN 출발/귀국편이 아닌 구간은
      // 이 계산에서는 체류 Per Diem을 연결하지 않습니다.
      Rate = getAirportRate(from);
      Total = 0;
    }

    const dateParts = getDateParts(Date);
    const monthNum =
      monthNumber(Month) ||
      dateParts?.month ||
      1;

    const yearValue =
      String(Year || "").trim() ||
      String(dateParts?.year || "");

    results.push({
      Date,
      Activity,
      From: from,
      Destination: destination,

      RI,
      RO,
      StayHours,
      Rate,
      Total,

      TransportFee: TRANSPORT_FEE_PER_FLIGHT,
      Month: formatMonthName(monthNum),
      Year: yearValue,

      Taxi: "",
      Car: "",

      owner,
      uid: owner,
    });
  }

  for (const [airport, outbound] of pendingOutboundByDestination) {
    console.log(
      `ℹ️ 아직 연결할 귀국편이 없는 출국편: ` +
      `${airport}, ${outbound.outboundFlight}, ${outbound.outboundDate}`
    );
  }

  return results;
}

// ============================================================
// 7. 기존 roster.js와의 호환 함수
//
// 기존 호출:
// generatePerDiemList(path.join(publicDir, "roster.json"), uid)
//
// 첫 번째 인자는 더 이상 사용하지 않습니다.
// ============================================================

export async function generatePerDiemList(
  _unusedRosterJsonPath,
  ownerOverride
) {
  const owner = resolvePerDiemOwner(ownerOverride);

  const pilotlogRecords = await loadPilotlogFromFirestore(owner);

  const perdiemList = calculatePerDiemList(
    pilotlogRecords,
    owner
  );

  console.log(
    `✅ Pilotlog 기반 PerDiem 계산 완료: ${perdiemList.length}건`
  );

  return perdiemList;
}

// ============================================================
// 8. CSV 저장
// ============================================================

function escapeCsvValue(value) {
  if (value === null || value === undefined) return "";

  const text = String(value);

  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }

  return text;
}

export function savePerDiemCSV(perdiemList, outputPath) {
  const header = [
    "Date",
    "Activity",
    "From",
    "Destination",
    "RI",
    "RO",
    "StayHours",
    "Rate",
    "Total",
    "TransportFee",
    "Month",
    "Year",
    "Taxi",
    "Car",
    "Owner",
  ];

  const rows = (perdiemList || []).map((item) => [
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
    item.Taxi,
    item.Car,
    item.owner || item.uid,
  ]);

  const csv = [header, ...rows]
    .map((row) => row.map(escapeCsvValue).join(","))
    .join("\r\n");

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `\uFEFF${csv}\r\n`, "utf-8");

  console.log(`✅ PerDiem CSV 저장: ${outputPath}`);

  return outputPath;
}

// ============================================================
// 9. Firestore 쓰기 보조 함수
// ============================================================

function buildPerDiemDocId(item) {
  return sha256([
    item.owner || item.uid || "",
    item.Date || "",
    item.Activity || "",
    item.From || "",
    item.Destination || "",
  ].join("|")).slice(0, 40);
}

function isCurrentMonthFirestoreDoc(data, targetMonthYear) {
  return isRecordInMonth(data, targetMonthYear);
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

async function commitPerDiemRewrite(db, collectionName, writes) {
  let written = 0;

  for (let index = 0; index < writes.length; index += 400) {
    const batch = db.batch();
    const chunk = writes.slice(index, index + 400);

    for (const item of chunk) {
      batch.set(
        db.collection(collectionName).doc(item.id),
        item.data,
        { merge: false }
      );
    }

    await batch.commit();
    written += chunk.length;
  }

  return written;
}

// ============================================================
// 10. PerdiemEvents 및 Perdiem/{owner}/events 저장
//
// 정책:
// - 현재 서울 기준 월의 데이터만 삭제 후 다시 작성합니다.
// - 이전 달 데이터는 삭제하지 않습니다.
// - 이전 달 출국편은 계산에만 사용하며, 현재 월의 귀국편
//   결과에 반영됩니다.
// ============================================================

export async function uploadPerDiemFirestore(
  perdiemList,
  ownerOverride
) {
  const db = getDb();
  const owner = resolvePerDiemOwner(ownerOverride);
  const now = admin.firestore.FieldValue.serverTimestamp();

  const currentMonthInfo = getCurrentSeoulMonthYear();

  const currentMonthItems = (perdiemList || [])
    .filter((item) => {
      const itemOwner = String(item.owner || item.uid || "").trim();

      return (
        itemOwner === owner &&
        isCurrentMonthFirestoreDoc(item, currentMonthInfo)
      );
    });

  // 같은 ID의 중복 입력을 제거합니다.
  const uniqueById = new Map();

  for (const item of currentMonthItems) {
    const id = buildPerDiemDocId({ ...item, owner });
    uniqueById.set(id, { ...item, owner, uid: owner });
  }

  const uniqueCurrentMonthItems = [...uniqueById.values()];

  const nestedEventsRef = db
    .collection(PERDIEM_COLLECTION)
    .doc(owner)
    .collection("events");

  const nestedSnapshot = await nestedEventsRef.get();

  const nestedRefsToDelete = nestedSnapshot.docs
    .filter((doc) =>
      isCurrentMonthFirestoreDoc(doc.data(), currentMonthInfo)
    )
    .map((doc) => doc.ref);

  const mirrorCollectionRef = db.collection(
    PERDIEM_FLAT_MIRROR_COLLECTION
  );

  const mirrorSnapshot = await mirrorCollectionRef
    .where("owner", "==", owner)
    .get();

  const mirrorRefsToDelete = mirrorSnapshot.docs
    .filter((doc) =>
      isCurrentMonthFirestoreDoc(doc.data(), currentMonthInfo)
    )
    .map((doc) => doc.ref);

  const nestedWrites = uniqueCurrentMonthItems.map((item) => {
    const id = buildPerDiemDocId(item);

    return {
      id,
      data: {
        ...item,
        owner,
        uid: owner,
        updatedAt: now,
        importedAt: now,
      },
    };
  });

  const mirrorWrites = nestedWrites.map((item) => ({
    id: `${safeDocIdPart(owner)}_${item.id}`,
    data: {
      ...item.data,
      owner,
      uid: owner,
      updatedAt: now,
      importedAt: now,
    },
  }));

  const deletedNested = await commitDeleteRefs(
    db,
    nestedRefsToDelete
  );

  const deletedMirror = await commitDeleteRefs(
    db,
    mirrorRefsToDelete
  );

  const savedNested = await commitPerDiemRewrite(
    db,
    `Perdiem/${owner}/events`,
    nestedWrites
  );

  const savedMirror = await commitPerDiemRewrite(
    db,
    PERDIEM_FLAT_MIRROR_COLLECTION,
    mirrorWrites
  );

  // 소유자별 메타데이터는 병합하여 보관합니다.
  await db
    .collection(PERDIEM_COLLECTION)
    .doc(owner)
    .set({
      owner,
      uid: owner,
      source: "Pilotlog",

      currentMonth: formatMonthName(currentMonthInfo.month),
      currentMonthNumber: currentMonthInfo.month,
      currentMonthYear: currentMonthInfo.year,

      currentMonthInputRows: currentMonthItems.length,
      currentMonthSavedRows: savedNested,
      currentMonthMirrorRows: savedMirror,

      currentMonthRewrittenAt: now,
      storagePath: `Perdiem/${owner}/events`,
      flatMirror: PERDIEM_FLAT_MIRROR_COLLECTION,

      updatedAt: now,
    }, { merge: true });

  console.log(
    `✅ Firestore PerDiem 저장 완료: ` +
    `${currentMonthInfo.year}-${String(currentMonthInfo.month).padStart(2, "0")}, ` +
    `입력=${currentMonthItems.length}, ` +
    `고유=${uniqueCurrentMonthItems.length}, ` +
    `events 삭제=${deletedNested}, ` +
    `events 저장=${savedNested}, ` +
    `PerdiemEvents 삭제=${deletedMirror}, ` +
    `PerdiemEvents 저장=${savedMirror}`
  );

  return {
    owner,
    month: currentMonthInfo.month,
    year: currentMonthInfo.year,
    inputRows: currentMonthItems.length,
    uniqueRows: uniqueCurrentMonthItems.length,
    deletedNested,
    savedNested,
    deletedMirror,
    savedMirror,
  };
}

// ============================================================
// 11. Google Sheets 업데이트
//
// - 기존 행을 먼저 읽습니다.
// - 해당 owner의 현재 월 행만 교체합니다.
// - 다른 owner 및 과거 월의 행은 보존합니다.
// ============================================================

function normalizeSheetCell(value) {
  return String(value ?? "").trim();
}

function rowToPerDiemObject(row, headerIndex) {
  const get = (name) => {
    const index = headerIndex[name];

    return index === undefined || index < 0
      ? ""
      : row[index] ?? "";
  };

  return {
    ID: get("ID"),
    Date: get("Date"),
    Activity: get("Activity"),
    From: get("From"),
    Destination: get("Destination"),
    RI: get("RI"),
    RO: get("RO"),
    StayHours: get("StayHours"),
    Rate: get("Rate"),
    Total: get("Total"),
    TransportFee: get("TransportFee"),
    Month: get("Month"),
    Year: get("Year"),
    Taxi: get("Taxi"),
    Car: get("Car"),
    Owner: get("Owner"),
  };
}

function sheetRowMatchesOwner(row, headerIndex, owner) {
  const ownerColumn =
    headerIndex.Owner ??
    headerIndex.owner ??
    -1;

  if (ownerColumn < 0) return false;

  return normalizeSheetCell(row[ownerColumn]) === owner;
}

function itemToSheetRow(item, owner) {
  return [
    buildPerDiemDocId({ ...item, owner }),
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
    item.Month || "",
    item.Year || "",
    item.Taxi || "",
    item.Car || "",
    owner,
  ];
}

export async function appendPerDiemGoogleSheet(
  perdiemList,
  sheetsApi,
  spreadsheetId,
  sheetName = "Perdiem",
  ownerOverride
) {
  if (!sheetsApi || !spreadsheetId) {
    console.warn(
      "⚠️ Google Sheets API 또는 spreadsheetId가 없어 Sheet 업데이트를 건너뜁니다."
    );
    return;
  }

  const owner = resolvePerDiemOwner(ownerOverride);
  const currentMonthInfo = getCurrentSeoulMonthYear();

  const range = `${sheetName}!A:P`;

  const response = await sheetsApi.spreadsheets.values.get({
    spreadsheetId,
    range,
  });

  const existingValues = response.data.values || [];
  const existingHeader = existingValues[0] || [];

  const header = PERDIEM_SHEET_HEADER;

  const headerIndex = {};

  existingHeader.forEach((name, index) => {
    headerIndex[String(name).trim()] = index;
  });

  const hasCompatibleHeader =
    existingHeader.length > 0 &&
    existingHeader.includes("Date") &&
    existingHeader.includes("Activity") &&
    (
      existingHeader.includes("Owner") ||
      existingHeader.includes("owner")
    );

  if (existingValues.length > 0 && !hasCompatibleHeader) {
    throw new Error(
      `Google Sheet ${sheetName}의 헤더가 예상 형식과 다릅니다. ` +
      "기존 데이터를 덮어쓰지 않도록 업데이트를 중단했습니다."
    );
  }

  const existingRows = existingValues.slice(1);

  const rowsToPreserve = existingRows.filter((row) => {
    const belongsToOwner = sheetRowMatchesOwner(
      row,
      headerIndex,
      owner
    );

    if (!belongsToOwner) return true;

    const existingObject = rowToPerDiemObject(row, headerIndex);

    // 같은 owner의 현재 월 행만 교체합니다.
    return !isCurrentMonthFirestoreDoc(
      existingObject,
      currentMonthInfo
    );
  });

  const currentMonthItems = (perdiemList || []).filter((item) => {
    const itemOwner = String(item.owner || item.uid || "").trim();

    return (
      itemOwner === owner &&
      isCurrentMonthFirestoreDoc(item, currentMonthInfo)
    );
  });

  const uniqueItems = new Map();

  for (const item of currentMonthItems) {
    const id = buildPerDiemDocId({ ...item, owner });
    uniqueItems.set(id, item);
  }

  const currentMonthRows = [...uniqueItems.values()].map(
    (item) => itemToSheetRow(item, owner)
  );

  const outputValues = [
    header,
    ...rowsToPreserve,
    ...currentMonthRows,
  ];

  await sheetsApi.spreadsheets.values.update({
    spreadsheetId,
    range: `${sheetName}!A1`,
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: outputValues,
    },
  });

  // 이전 출력보다 기존 데이터가 길었다면 남은 셀을 비웁니다.
  const previousRowCount = existingValues.length;
  const newRowCount = outputValues.length;

  if (previousRowCount > newRowCount) {
    await sheetsApi.spreadsheets.values.clear({
      spreadsheetId,
      range: `${sheetName}!A${newRowCount + 1}:P${previousRowCount}`,
    });
  }

  console.log(
    `✅ Google Sheet ${sheetName} 업데이트 완료: ` +
    `owner=${owner}, 이번 달 입력=${currentMonthItems.length}, ` +
    `이번 달 저장=${currentMonthRows.length}, ` +
    `보존 행=${rowsToPreserve.length}`
  );
}
