import fs from "fs";
import path from "path";
import crypto from "crypto";
import { google } from "googleapis";
import admin from "firebase-admin";

const SPREADSHEET_ID =
  process.env.GOOGLE_SHEETS_SPREADSHEET_ID ||
  "1mKjEd__zIoMJaa6CLmDE-wALGhtlG-USLTAiQBZnioc";

const SHEET_NAME = process.env.PERDIEM_SHEET_NAME || "Perdiem";
const OUTPUT_DIR = process.env.PERDIEM_REPORT_DIR || "outputs";

const PERDIEM_EVENTS_COLLECTION =
  process.env.PERDIEM_EVENTS_COLLECTION || "PerdiemEvents";

const MONTH_NAMES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

const SHEET_HEADER = [
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

function requiredJsonEnv(name) {
  const raw = String(process.env[name] || "")
    .trim()
    .replace(/^\uFEFF/, "")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'");

  if (!raw) {
    throw new Error(`${name} is required`);
  }

  let parsed;

  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `${name} contains invalid JSON: ${error.message}`,
    );
  }

  if (parsed.private_key) {
    parsed.private_key = parsed.private_key.replace(/\\n/g, "\n");
  }

  return parsed;
}

function optionalEnv(name) {
  return String(process.env[name] || "").trim();
}

function kstNow() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000);
}

function defaultTargetMonthYear() {
  const now = kstNow();

  let year = now.getUTCFullYear();
  let month = now.getUTCMonth() + 1;

  // 매월 1일에는 직전 달 보고서 생성
  if (now.getUTCDate() === 1) {
    month -= 1;

    if (month === 0) {
      month = 12;
      year -= 1;
    }
  }

  return { year, month };
}

function isKstMonthCloseRun() {
  return kstNow().getUTCDate() === 1;
}

function monthToNumber(value) {
  const normalized = String(value ?? "").trim();

  if (!normalized) return null;

  const numeric = Number(normalized);

  if (
    Number.isFinite(numeric) &&
    numeric >= 1 &&
    numeric <= 12
  ) {
    return numeric;
  }

  const index = MONTH_NAMES.findIndex(
    (name) =>
      name.toLowerCase() === normalized.toLowerCase(),
  );

  return index >= 0 ? index + 1 : null;
}

function parseMoney(value) {
  const normalized = String(value ?? "")
    .replace(/,/g, "")
    .replace(/[^0-9.+-]/g, "")
    .trim();

  const parsed = Number(normalized);

  return Number.isFinite(parsed) ? parsed : 0;
}

function csvEscape(value) {
  const text = String(value ?? "");

  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }

  return text;
}

function toCsv(rows) {
  return rows
    .map((row) =>
      row.map(csvEscape).join(","),
    )
    .join("\n");
}

function normalizeIdentity(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase();
}

function sanitizeFilePart(
  value,
  fallback = "user",
) {
  const normalized = String(value || fallback)
    .normalize("NFKD")
    .replace(
      /[^a-zA-Z0-9가-힣._-]+/g,
      "_",
    )
    .replace(/^_+|_+$/g, "");

  return normalized || fallback;
}

function ownerReportKey(owner) {
  const visible =
    owner.displayName ||
    owner.email ||
    owner.owner ||
    owner.uid ||
    owner.userId;

  if (visible) {
    return sanitizeFilePart(visible);
  }

  const hash = crypto
    .createHash("sha256")
    .update(JSON.stringify(owner))
    .digest("hex")
    .slice(0, 10);

  return `user_${hash}`;
}

function reportOwner() {
  return {
    owner:
      optionalEnv("PERDIEM_OWNER") ||
      optionalEnv("REPORT_OWNER_UID") ||
      optionalEnv("FIREBASE_UID"),

    uid:
      optionalEnv("PERDIEM_UID") ||
      optionalEnv("REPORT_OWNER_UID") ||
      optionalEnv("FIREBASE_UID"),

    userId:
      optionalEnv("PERDIEM_USER_ID") ||
      optionalEnv("REPORT_OWNER_UID") ||
      optionalEnv("FIREBASE_UID") ||
      optionalEnv("USER_ID"),

    email:
      optionalEnv("PERDIEM_USER_EMAIL") ||
      optionalEnv("USER_EMAIL") ||
      (/^[^@\s]+@[^@\s]+$/.test(
        optionalEnv("USER_ID"),
      )
        ? optionalEnv("USER_ID")
        : ""),

    displayName:
      optionalEnv("PDC_USER_NAME") ||
      optionalEnv("USER_NAME") ||
      optionalEnv("PERDIEM_USER_NAME"),
  };
}

function hasRequestedIdentity(owner) {
  return Boolean(
    owner.owner ||
      owner.uid ||
      owner.userId ||
      owner.email,
  );
}

function eventOwnerMatches(event, owner) {
  const candidates = [
    event.owner,
    event.uid,
    event.userId,
    event.firebaseUid,
    event.email,
    event.userEmail,
  ]
    .map(normalizeIdentity)
    .filter(Boolean);

  const expected = [
    owner.owner,
    owner.uid,
    owner.userId,
    owner.email,
  ]
    .map(normalizeIdentity)
    .filter(Boolean);

  if (!candidates.length || !expected.length) {
    return false;
  }

  return expected.some((value) =>
    candidates.includes(value),
  );
}

function valueFromEvent(event, names) {
  for (const name of names) {
    if (
      event[name] !== undefined &&
      event[name] !== null &&
      String(event[name]).trim() !== ""
    ) {
      return event[name];
    }
  }

  return "";
}

function normalizeDate(value) {
  const text = String(value ?? "").trim();

  const match = text.match(
    /^(\d{4})[-.](\d{1,2})[-.](\d{1,2})$/,
  );

  if (!match) return text;

  return `${match[1]}.${match[2].padStart(
    2,
    "0",
  )}.${match[3].padStart(2, "0")}`;
}

function normalizeAirport(value) {
  return String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function normalizeActivity(value) {
  return String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "");
}

function normalizedTimestamp(value) {
  if (!value) return "";

  if (
    typeof value === "object" &&
    typeof value.toDate === "function"
  ) {
    return value.toDate().toISOString();
  }

  const text = String(value).trim();

  if (!text) return "";

  const parsed = Date.parse(text);

  return Number.isNaN(parsed)
    ? text
    : new Date(parsed).toISOString();
}

function rowCompleteness(row) {
  return row.reduce(
    (score, value) =>
      score +
      (String(value ?? "").trim() ? 1 : 0),
    0,
  );
}

function perDiemDuplicateKey(row) {
  return [
    normalizeDate(row[1]),
    normalizeActivity(row[2]),
    normalizeAirport(row[3]),
    normalizeAirport(row[4]),
    normalizedTimestamp(row[5]),
    normalizedTimestamp(row[6]),
  ].join("|");
}

function dedupePerDiemRows(rows) {
  const selected = new Map();

  for (const row of rows) {
    const key = perDiemDuplicateKey(row);

    const current = selected.get(key);

    if (
      !current ||
      rowCompleteness(row) >
        rowCompleteness(current)
    ) {
      selected.set(key, row);
    }
  }

  return [...selected.values()].sort(
    (left, right) => {
      const leftDate = normalizeDate(left[1]);
      const rightDate = normalizeDate(right[1]);

      const dateCompare =
        leftDate.localeCompare(rightDate);

      if (dateCompare !== 0) {
        return dateCompare;
      }

      return normalizeActivity(
        left[2],
      ).localeCompare(
        normalizeActivity(right[2]),
      );
    },
  );
}

function eventToSheetRow(
  event,
  documentId,
  targetMonth,
  targetYear,
) {
  const date = valueFromEvent(event, [
    "Date",
    "date",
  ]);

  const activity = valueFromEvent(event, [
    "Activity",
    "activity",
    "FLT",
    "flight",
  ]);

  const from = valueFromEvent(event, [
    "From",
    "from",
  ]);

  const destination = valueFromEvent(event, [
    "Destination",
    "destination",
    "To",
    "to",
  ]);

  const ri = valueFromEvent(event, [
    "RI",
    "ri",
  ]);

  const ro = valueFromEvent(event, [
    "RO",
    "ro",
  ]);

  const stayHours = valueFromEvent(event, [
    "StayHours",
    "stayHours",
  ]);

  const rate = valueFromEvent(event, [
    "Rate",
    "rate",
  ]);

  const total = valueFromEvent(event, [
    "Total",
    "total",
  ]);

  const transportFee =
    valueFromEvent(event, [
      "TransportFee",
      "transportFee",
      "Transport Fee",
    ]);

  const taxi = valueFromEvent(event, [
    "Taxi",
    "taxi",
  ]);

  const car = valueFromEvent(event, [
    "Car",
    "car",
  ]);

  const owner =
    valueFromEvent(event, [
      "Owner",
      "owner",
      "uid",
      "userId",
      "firebaseUid",
    ]) || "";

  return [
    documentId,
    normalizeDate(date),
    activity,
    from,
    destination,
    ri,
    ro,
    stayHours,
    rate,
    total,
    transportFee,
    MONTH_NAMES[targetMonth - 1],
    targetYear,
    taxi,
    car,
    owner,
  ];
}

async function initializeFirebase() {
  const credentials =
    requiredJsonEnv(
      "FIREBASE_SERVICE_ACCOUNT",
    );

  if (!admin.apps.length) {
    admin.initializeApp({
      credential:
        admin.credential.cert(credentials),
    });
  }

  return admin.firestore();
}

async function readPerdiemEvents({
  db,
  owner,
  targetMonth,
  targetYear,
}) {
  const collection =
    db.collection(
      PERDIEM_EVENTS_COLLECTION,
    );

  const snapshot = await collection.get();

  const rows = [];

  for (const doc of snapshot.docs) {
    const data = doc.data() || {};

    if (!eventOwnerMatches(data, owner)) {
      continue;
    }

    const monthValue = valueFromEvent(
      data,
      ["Month", "month"],
    );

    const yearValue = valueFromEvent(
      data,
      ["Year", "year"],
    );

    let eventMonth =
      monthToNumber(monthValue);

    let eventYear =
      Number(yearValue);

    /*
     * Month / Year 필드가 없는 오래된 문서에 대해서는
     * Date에서 자동으로 계산한다.
     */
    if (
      !eventMonth ||
      !Number.isInteger(eventYear)
    ) {
      const dateValue = valueFromEvent(
        data,
        ["Date", "date"],
      );

      const match = String(
        dateValue || "",
      ).match(
        /^(\d{4})[-.](\d{1,2})[-.](\d{1,2})/,
      );

      if (match) {
        eventYear = Number(match[1]);
        eventMonth = Number(match[2]);
      }
    }

    if (
      eventMonth !== targetMonth ||
      eventYear !== targetYear
    ) {
      continue;
    }

    rows.push(
      eventToSheetRow(
        data,
        doc.id,
        targetMonth,
        targetYear,
      ),
    );
  }

  return rows;
}

async function replacePerdiemSheet({
  sheets,
  sourceRows,
}) {
  /*
   * Google Sheets는 보고서 표시용으로만 사용.
   * Firestore PerdiemEvents가 원본(Source of Truth)이다.
   */
  await sheets.spreadsheets.values.clear({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A:P`,
  });

  const rows = [
    SHEET_HEADER,
    ...sourceRows,
  ];

  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A1:P${rows.length}`,
    valueInputOption: "RAW",
    requestBody: {
      values: rows,
    },
  });

  console.log(
    `PERDIEM_SHEET_WRITTEN_ROWS=${sourceRows.length}`,
  );

  return sourceRows.length;
}

async function main() {
  const force =
    process.env.FORCE_PERDIEM_REPORT ===
      "true" ||
    process.env.GITHUB_EVENT_NAME ===
      "workflow_dispatch";

  if (
    !force &&
    !isKstMonthCloseRun()
  ) {
    console.log(
      "Not KST month-close day; skipping report.",
    );
    return;
  }

  const target =
    defaultTargetMonthYear();

  const targetYear = Number(
    process.env.PERDIEM_TARGET_YEAR ||
      target.year,
  );

  const targetMonth = monthToNumber(
    process.env.PERDIEM_TARGET_MONTH ||
      target.month,
  );

  const monthName =
    MONTH_NAMES[targetMonth - 1];

  if (
    !monthName ||
    !Number.isInteger(targetYear) ||
    targetYear < 2000
  ) {
    throw new Error(
      `Invalid target month/year: ${targetMonth}/${targetYear}`,
    );
  }

  const owner = reportOwner();

  if (!hasRequestedIdentity(owner)) {
    throw new Error(
      "User identity is required. Set PERDIEM_OWNER, REPORT_OWNER_UID, FIREBASE_UID, PERDIEM_USER_ID, or PERDIEM_USER_EMAIL.",
    );
  }

  console.log(
    `PERDIEM_TARGET=${targetYear}-${String(
      targetMonth,
    ).padStart(2, "0")}`,
  );

  console.log(
    `PERDIEM_OWNER=${
      owner.owner ||
      owner.uid ||
      owner.userId ||
      owner.email
    }`,
  );

  /*
   * ---------------------------------------------------------
   * 1. Firestore 초기화
   * ---------------------------------------------------------
   */

  const db =
    await initializeFirebase();

  /*
   * ---------------------------------------------------------
   * 2. PerdiemEvents에서 해당 사용자 + 월 데이터 조회
   * ---------------------------------------------------------
   */

  const firestoreRows =
    await readPerdiemEvents({
      db,
      owner,
      targetMonth,
      targetYear,
    });

  console.log(
    `PERDIEM_FIRESTORE_ROWS=${firestoreRows.length}`,
  );

  /*
   * ---------------------------------------------------------
   * 3. 중복 제거
   * ---------------------------------------------------------
   */

  const filteredRows =
    dedupePerDiemRows(
      firestoreRows,
    );

  const duplicatesRemoved =
    firestoreRows.length -
    filteredRows.length;

  console.log(
    `PERDIEM_DUPLICATES_REMOVED=${duplicatesRemoved}`,
  );

  /*
   * ---------------------------------------------------------
   * 4. Google Sheets 인증
   * ---------------------------------------------------------
   */

  const googleCredentials =
    requiredJsonEnv(
      "GOOGLE_SHEETS_CREDENTIALS",
    );

  const auth =
    new google.auth.GoogleAuth({
      credentials: googleCredentials,
      scopes: [
        "https://www.googleapis.com/auth/spreadsheets",
      ],
    });

  const sheets =
    google.sheets({
      version: "v4",
      auth,
    });

  /*
   * ---------------------------------------------------------
   * 5. Firestore → Google Sheets
   * ---------------------------------------------------------
   */

  await replacePerdiemSheet({
    sheets,
    sourceRows: filteredRows,
  });

  /*
   * ---------------------------------------------------------
   * 6. 금액 계산
   * ---------------------------------------------------------
   */

  const totalPerdiem =
    filteredRows.reduce(
      (sum, row) =>
        sum + parseMoney(row[9]),
      0,
    );

  const totalTransportFee =
    filteredRows.reduce(
      (sum, row) =>
        sum + parseMoney(row[10]),
      0,
    );

  const grandTotal =
    totalPerdiem +
    totalTransportFee;

  /*
   * ---------------------------------------------------------
   * 7. CSV / JSON 생성
   * ---------------------------------------------------------
   */

  fs.mkdirSync(
    OUTPUT_DIR,
    { recursive: true },
  );

  const userKey =
    ownerReportKey(owner);

  const baseName =
    `Perdiem_${userKey}_${monthName}_${targetYear}`;

  const csvPath =
    path.join(
      OUTPUT_DIR,
      `${baseName}.csv`,
    );

  const summaryPath =
    path.join(
      OUTPUT_DIR,
      `${baseName}.json`,
    );

  const summaryRows = [
    [],
    ["Summary"],
    [
      "User",
      owner.displayName ||
        owner.email ||
        owner.owner ||
        owner.uid ||
        owner.userId,
    ],
    ["Month", monthName],
    ["Year", targetYear],
    [
      "Firestore Rows",
      firestoreRows.length,
    ],
    ["Rows", filteredRows.length],
    [
      "Duplicates Removed",
      duplicatesRemoved,
    ],
    [
      "Total Perdiem",
      totalPerdiem.toFixed(2),
    ],
    [
      "Transport Fee Total",
      totalTransportFee.toFixed(2),
    ],
    [
      "Grand Total",
      grandTotal.toFixed(2),
    ],
  ];

  fs.writeFileSync(
    csvPath,
    `${toCsv([
      SHEET_HEADER,
      ...filteredRows,
      ...summaryRows,
    ])}\n`,
    "utf-8",
  );

  fs.writeFileSync(
    summaryPath,
    JSON.stringify(
      {
        source:
          PERDIEM_EVENTS_COLLECTION,

        sourceOfTruth:
          "Firestore",

        owner: {
          owner: owner.owner,
          uid: owner.uid,
          userId: owner.userId,
          email: owner.email,
          displayName:
            owner.displayName,
        },

        month: monthName,
        monthNumber: targetMonth,
        year: targetYear,

        firestoreRows:
          firestoreRows.length,

        rows:
          filteredRows.length,

        duplicatesRemoved,

        totalPerdiem,
        totalTransportFee,
        grandTotal,

        csvPath,
        fileBaseName: baseName,
      },
      null,
      2,
    ),
    "utf-8",
  );

  /*
   * ---------------------------------------------------------
   * 8. GitHub Actions 로그
   * ---------------------------------------------------------
   */

  console.log(
    `PERDIEM_REPORT_CSV=${csvPath}`,
  );

  console.log(
    `PERDIEM_REPORT_SUMMARY=${summaryPath}`,
  );

  console.log(
    `PERDIEM_REPORT_FILE_BASE=${baseName}`,
  );

  console.log(
    `PERDIEM_REPORT_OWNER=${
      owner.owner ||
      owner.uid ||
      owner.userId ||
      owner.email
    }`,
  );

  console.log(
    `PERDIEM_REPORT_FIRESTORE_ROWS=${firestoreRows.length}`,
  );

  console.log(
    `PERDIEM_REPORT_ROWS=${filteredRows.length}`,
  );

  console.log(
    `PERDIEM_DUPLICATES_REMOVED=${duplicatesRemoved}`,
  );

  console.log(
    `PERDIEM_TOTAL=${totalPerdiem.toFixed(2)}`,
  );

  console.log(
    `TRANSPORT_FEE_TOTAL=${totalTransportFee.toFixed(2)}`,
  );

  console.log(
    `GRAND_TOTAL=${grandTotal.toFixed(2)}`,
  );
}

main().catch((error) => {
  console.error(
    "Monthly PerDiem report failed:",
    error,
  );

  process.exit(1);
});