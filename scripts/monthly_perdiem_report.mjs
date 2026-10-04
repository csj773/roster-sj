import admin from "firebase-admin";
import fs from "node:fs/promises";
import path from "node:path";
import { google } from "googleapis";
const PERDIEM_EVENTS_COLLECTION =
  process.env.PERDIEM_EVENTS_COLLECTION || "PerdiemEvents";
const SPREADSHEET_ID =
  process.env.GOOGLE_SHEETS_SPREADSHEET_ID ||
  "1mKjEd__zIoMJaa6CLmDE-wALGhtlG-USLTAiQBZnioc";
const SHEET_NAME =
  process.env.PERDIEM_SHEET_NAME || "Perdiem";
const OUTPUT_DIR =
  process.env.PERDIEM_OUTPUT_DIR || "outputs";
const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"
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
  "Owner"
];
// ============================================================
// Environment helpers
// ============================================================
function env(name) {
  return String(process.env[name] || "").trim();
}
function requiredEnv(name) {
  const value = env(name);
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}
// ============================================================
// JSON environment variable
// ============================================================
function parseJsonEnv(name) {
  const raw = requiredEnv(name)
    .replace(/^\uFEFF/, "")
    .trim();
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `${name} contains invalid JSON: ${error.message}`
    );
  }
  if (parsed.private_key) {
    parsed.private_key = String(parsed.private_key)
      .replace(/\\n/g, "\n")
      .replace(/\r\n/g, "\n");
  }
  return parsed;
}
// ============================================================
// Month
// ============================================================
function monthToNumber(value) {
  const text = String(value ?? "").trim();
  if (!text) {
    return null;
  }
  // 1 ~ 12
  if (/^\d+$/.test(text)) {
    const number = Number(text);
    return number >= 1 && number <= 12
      ? number
      : null;
  }
  // Jan, January, Feb, February ...
  const index = MONTH_NAMES.findIndex(
    (month) =>
      month.toLowerCase() ===
      text.slice(0, 3).toLowerCase()
  );
  return index >= 0
    ? index + 1
    : null;
}
// ============================================================
// Target period
//
// PERDIEM_TARGET_MONTH / PERDIEM_TARGET_YEAR가 있으면 사용
// 없으면 서울시간 기준 "전월" 사용
// ============================================================
function targetPeriod() {
  const now = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "numeric"
  }).formatToParts(new Date());
  const currentYear = Number(
    now.find((part) => part.type === "year")?.value
  );
  const currentMonth = Number(
    now.find((part) => part.type === "month")?.value
  );
  const monthInput = env("PERDIEM_TARGET_MONTH");
  const yearInput = env("PERDIEM_TARGET_YEAR");
  // Explicit target
  if (monthInput || yearInput) {
    const month =
      monthToNumber(monthInput) || currentMonth;
    const year =
      Number(yearInput) || currentYear;
    if (
      !Number.isInteger(month) ||
      month < 1 ||
      month > 12
    ) {
      throw new Error(
        `Invalid PERDIEM_TARGET_MONTH: ${monthInput}`
      );
    }
    if (
      !Number.isInteger(year) ||
      year < 2000 ||
      year > 2200
    ) {
      throw new Error(
        `Invalid PERDIEM_TARGET_YEAR: ${yearInput}`
      );
    }
    return {
      year,
      month,
      monthName: MONTH_NAMES[month - 1]
    };
  }
  // Default = previous month
  const previous = new Date(
    Date.UTC(currentYear, currentMonth - 2, 1)
  );
  const month =
    previous.getUTCMonth() + 1;
  return {
    year: previous.getUTCFullYear(),
    month,
    monthName: MONTH_NAMES[month - 1]
  };
}
// ============================================================
// CSV
// ============================================================
function csvEscape(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text)
    ? `"${text.replaceAll('"', '""')}"`
    : text;
}
// ============================================================
// Number
// ============================================================
function numberValue(value) {
  const number = Number(
    String(value ?? "").replace(/,/g, "")
  );
  return Number.isFinite(number)
    ? number
    : 0;
}
// ============================================================
// Normalization
// ============================================================
function normalizeDate(value) {
  const text = String(value ?? "").trim();
  const match = text.match(
    /^(\d{4})[-.](\d{1,2})[-.](\d{1,2})$/
  );
  return match
    ? `${match[1]}.${match[2].padStart(2, "0")}.${match[3].padStart(2, "0")}`
    : text;
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
  const text = String(value ?? "").trim();
  if (!text) {
    return "";
  }
  const timestamp = Date.parse(text);
  return Number.isNaN(timestamp)
    ? text
    : new Date(timestamp).toISOString();
}
// ============================================================
// Dedupe
// ============================================================
function dedupeRows(rows) {
  const map = new Map();
  for (const row of rows) {
    const key = [
      normalizeDate(row.Date),
      normalizeActivity(row.Activity),
      normalizeAirport(row.From),
      normalizeAirport(
        row.Destination || row.To
      ),
      normalizedTimestamp(row.RI),
      normalizedTimestamp(row.RO)
    ].join("|");
    const existing = map.get(key);
    if (!existing) {
      map.set(key, row);
      continue;
    }
    const score = (item) =>
      [
        item.RI,
        item.RO,
        item.StayHours,
        item.Total
      ].filter(
        (value) =>
          String(value ?? "").trim() !== ""
      ).length;
    if (score(row) >= score(existing)) {
      map.set(key, row);
    }
  }
  return [...map.values()].sort(
    (a, b) =>
      `${normalizeDate(a.Date)}|${a.Activity || ""}`
        .localeCompare(
          `${normalizeDate(b.Date)}|${b.Activity || ""}`
        )
  );
}
// ============================================================
// Owner
// ============================================================
function ownerUid() {
  return (
    env("PERDIEM_OWNER") ||
    env("REPORT_OWNER_UID") ||
    env("FIREBASE_UID") ||
    env("PERDIEM_USER_ID")
  );
}
function reportUserName() {
  return (
    env("PERDIEM_USER_NAME") ||
    env("PDC_USER_NAME") ||
    env("USER_NAME")
  );
}
// ============================================================
// Safe filename
// ============================================================
function safeFilePart(value) {
  const text = String(value || "user");
  return (
    text
      .replace(/[^a-zA-Z0-9._-]+/g, "_")
      .replace(/^_+|_+$/g, "") ||
    "user"
  );
}
// ============================================================
// Slack response
// ============================================================
async function postSlackResponse(text) {
  const url = env("SLACK_RESPONSE_URL");
  if (!url) {
    return;
  }
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      response_type: "ephemeral",
      replace_original: false,
      text
    })
  });
  if (!response.ok) {
    console.warn(
      `Slack response_url failed: HTTP ${response.status}`
    );
  }
}
// ============================================================
// Slack file upload
// ============================================================
async function uploadSlackFile(
  filePath,
  title,
  comment
) {
  const token = env("SLACK_BOT_TOKEN");
  const channelId = env("SLACK_CHANNEL_ID");
  if (!token || !channelId) {
    console.log(
      "Slack file upload skipped: SLACK_BOT_TOKEN or SLACK_CHANNEL_ID is missing."
    );
    return;
  }
  const file = await fs.readFile(filePath);
  const filename = path.basename(filePath);
  // Step 1: get upload URL
  const urlResponse = await fetch(
    "https://slack.com/api/files.getUploadURLExternal",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type":
          "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({
        filename,
        length: String(file.length)
      })
    }
  );
  const urlResult = await urlResponse.json();
  if (!urlResult.ok) {
    throw new Error(
      `Slack files.getUploadURLExternal failed: ${urlResult.error}`
    );
  }
  // Step 2: upload binary
  const upload = await fetch(
    urlResult.upload_url,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream"
      },
      body: file
    }
  );
  if (!upload.ok) {
    throw new Error(
      `Slack binary upload failed: HTTP ${upload.status}`
    );
  }
  // Step 3: complete upload
  const complete = await fetch(
    "https://slack.com/api/files.completeUploadExternal",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        files: [
          {
            id: urlResult.file_id,
            title
          }
        ],
        channel_id: channelId,
        initial_comment: comment
      })
    }
  );
  const result = await complete.json();
  if (!result.ok) {
    throw new Error(
      `Slack files.completeUploadExternal failed: ${result.error}`
    );
  }
}
// ============================================================
// Firestore → PerdiemEvents
// ============================================================
async function getFirestoreRows(
  db,
  uid,
  period
) {
  let query =
    db.collection(PERDIEM_EVENTS_COLLECTION);
  if (uid) {
    query = query.where(
      "owner",
      "==",
      uid
    );
  }
  const snapshot = await query.get();
  return snapshot.docs
    .map((doc) => ({
      id: doc.id,
      ...doc.data()
    }))
    .filter((row) => {
      const rowYear = Number(row.Year);
      const rowMonth = monthToNumber(row.Month);
      return (
        rowYear === period.year &&
        rowMonth === period.month &&
        (
          !uid ||
          String(
            row.owner ||
            row.uid ||
            ""
          ).trim() === uid
        )
      );
    });
}
// ============================================================
// Firestore → Google Sheets
// ============================================================
async function writeMonthToSheet(
  sheets,
  rows
) {
  const values = rows.map((row) => [
    row.id || "",
    row.Date || "",
    row.Activity || "",
    row.From || "",
    row.Destination || row.To || "",
    row.RI || "",
    row.RO || "",
    row.StayHours || "",
    row.Rate ?? "",
    row.Total ?? "",
    row.TransportFee ?? "",
    monthToNumber(row.Month) ||
      row.Month ||
      "",
    row.Year || "",
    row.Taxi ?? "",
    row.Car ?? "",
    row.owner ||
      row.uid ||
      ""
  ]);
  // 기존 Perdiem Sheet 삭제
  await sheets.spreadsheets.values.clear({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A:P`
  });
  // 선택된 월만 다시 기록
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A1`,
    valueInputOption: "RAW",
    requestBody: {
      values: [
        SHEET_HEADER,
        ...values
      ]
    }
  });
  return values.length;
}
// ============================================================
// Google Sheets → Report
// ============================================================
async function readMonthBackFromSheet(
  sheets,
  period,
  uid
) {
  const response =
    await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!A:P`
    });
  const values =
    response.data.values || [];
  if (!values.length) {
    return [];
  }
  const rows = values
    .slice(1)
    .map((row) => ({
      id: row[0] || "",
      Date: row[1] || "",
      Activity: row[2] || "",
      From: row[3] || "",
      Destination: row[4] || "",
      RI: row[5] || "",
      RO: row[6] || "",
      StayHours: row[7] || "",
      Rate: row[8] || "",
      Total: row[9] || "",
      TransportFee: row[10] || "",
      Month: row[11] || "",
      Year: row[12] || "",
      Taxi: row[13] || "",
      Car: row[14] || "",
      owner: row[15] || ""
    }));
  return rows.filter((row) => {
    return (
      Number(row.Year) === period.year &&
      monthToNumber(row.Month) === period.month &&
      (
        !uid ||
        row.owner === uid
      )
    );
  });
}
// ============================================================
// MAIN
// ============================================================
async function main() {
  // ----------------------------------------------------------
  // Firebase
  // ----------------------------------------------------------
  if (!admin.apps.length) {
    admin.initializeApp({
      credential:
        admin.credential.cert(
          parseJsonEnv(
            "FIREBASE_SERVICE_ACCOUNT"
          )
        )
    });
  }
  const db = admin.firestore();
  // ----------------------------------------------------------
  // Owner
  // ----------------------------------------------------------
  const uid = ownerUid();
  if (!uid) {
    throw new Error(
      "PERDIEM_OWNER / REPORT_OWNER_UID / FIREBASE_UID / PERDIEM_USER_ID is required"
    );
  }
  // ----------------------------------------------------------
  // Period
  // ----------------------------------------------------------
  const period = targetPeriod();
  console.log(
    `Target period: ${period.monthName} ${period.year}`
  );
  console.log(
    `Owner: ${uid}`
  );
  // ----------------------------------------------------------
  // Google Sheets
  // ----------------------------------------------------------
  const credentials =
    parseJsonEnv(
      "GOOGLE_SHEETS_CREDENTIALS"
    );
  const auth =
    new google.auth.GoogleAuth({
      credentials,
      scopes: [
        "https://www.googleapis.com/auth/spreadsheets"
      ]
    });
  const sheets =
    google.sheets({
      version: "v4",
      auth
    });
  // ----------------------------------------------------------
  // 1. Firestore
  // ----------------------------------------------------------
  const sourceRows =
    await getFirestoreRows(
      db,
      uid,
      period
    );
  const dedupedSourceRows =
    dedupeRows(sourceRows);
  console.log(
    `Firestore source rows: ${sourceRows.length}`
  );
  console.log(
    `Firestore deduped rows: ${dedupedSourceRows.length}`
  );
  // ----------------------------------------------------------
  // 2. Firestore → Google Sheets
  // ----------------------------------------------------------
  const written =
    await writeMonthToSheet(
      sheets,
      dedupedSourceRows
    );
  console.log(
    `Google Sheets rows written: ${written}`
  );
  // ----------------------------------------------------------
  // 3. Google Sheets → Report
  // ----------------------------------------------------------
  const reportRows =
    await readMonthBackFromSheet(
      sheets,
      period,
      uid
    );
  const rows =
    dedupeRows(reportRows);
  console.log(
    `Report rows: ${rows.length}`
  );
  // ----------------------------------------------------------
  // 4. Totals
  // ----------------------------------------------------------
  const totalPerDiem =
    rows.reduce(
      (sum, row) =>
        sum + numberValue(row.Total),
      0
    );
  const transportFeeTotal =
    rows.reduce(
      (sum, row) =>
        sum + numberValue(
          row.TransportFee
        ),
      0
    );
  const grandTotal =
    totalPerDiem +
    transportFeeTotal;
  // ----------------------------------------------------------
  // 5. Output directory
  // ----------------------------------------------------------
  await fs.mkdir(
    OUTPUT_DIR,
    { recursive: true }
  );
  const userPart =
    safeFilePart(
      reportUserName() || uid
    );
  const baseName =
    `Perdiem_${userPart}_${period.monthName}_${period.year}`;
  const csvPath =
    path.join(
      OUTPUT_DIR,
      `${baseName}.csv`
    );
  const jsonPath =
    path.join(
      OUTPUT_DIR,
      `${baseName}.json`
    );
  // ----------------------------------------------------------
  // 6. CSV
  // ----------------------------------------------------------
  const csvData =
    rows.map((row) => [
      row.id,
      row.Date,
      row.Activity,
      row.From,
      row.Destination,
      row.RI,
      row.RO,
      row.StayHours,
      row.Rate,
      row.Total,
      row.TransportFee,
      row.Month,
      row.Year,
      row.Taxi,
      row.Car,
      row.owner
    ]);
  const duplicatesRemoved =
    sourceRows.length -
    dedupedSourceRows.length;
  const summary = [
    [],
    ["Summary"],
    ["Owner", uid],
    ["User", reportUserName()],
    ["Month", period.monthName],
    ["Year", period.year],
    ["Firestore Rows", sourceRows.length],
    ["Firestore Deduped Rows", dedupedSourceRows.length],
    ["Sheet Rows", written],
    ["Report Rows", rows.length],
    ["Duplicates Removed", duplicatesRemoved],
    ["Total Perdiem", totalPerDiem.toFixed(2)],
    ["Transport Fee Total", transportFeeTotal.toFixed(2)],
    ["Grand Total", grandTotal.toFixed(2)]
  ];
  const csvContent = [
    SHEET_HEADER,
    ...csvData,
    ...summary
  ]
    .map((row) =>
      row.map(csvEscape).join(",")
    )
    .join("\n");
  await fs.writeFile(
    csvPath,
    `\uFEFF${csvContent}\n`,
    "utf8"
  );
  // ----------------------------------------------------------
  // 7. JSON
  // ----------------------------------------------------------
  await fs.writeFile(
    jsonPath,
    JSON.stringify(
      {
        owner: uid,
        month: period.monthName,
        monthNumber: period.month,
        year: period.year,
        firestoreRows:
          sourceRows.length,
        firestoreDedupedRows:
          dedupedSourceRows.length,
        sheetRows:
          written,
        reportRows:
          rows.length,
        duplicatesRemoved,
        totalPerDiem,
        transportFeeTotal,
        grandTotal,
        csvPath
      },
      null,
      2
    ),
    "utf8"
  );
  // ----------------------------------------------------------
  // 8. Slack message
  // ----------------------------------------------------------
  const slackText = [
    `PerDiem Monthly Report: ${period.monthName} ${period.year}`,
    `User: ${reportUserName() || uid}`,
    `Firestore → Google Sheets: ${written} rows`,
    `Report rows: ${rows.length}`,
    `Total PerDiem: ${totalPerDiem.toFixed(2)}`,
    `Transport Fee: ₩${transportFeeTotal.toLocaleString("ko-KR")}`,
    `Grand Total: ${grandTotal.toFixed(2)}`
  ].join("\n");
  // ----------------------------------------------------------
  // 9. Console logs
  // ----------------------------------------------------------
  console.log(
    `PERDIEM_SOURCE=Firestore:${PERDIEM_EVENTS_COLLECTION}`
  );
  console.log(
    `PERDIEM_TARGET=${period.monthName} ${period.year}`
  );
  console.log(
    `PERDIEM_FIRESTORE_ROWS=${sourceRows.length}`
  );
  console.log(
    `PERDIEM_FIRESTORE_DEDUPED_ROWS=${dedupedSourceRows.length}`
  );
  console.log(
    `PERDIEM_SHEET_ROWS=${written}`
  );
  console.log(
    `PERDIEM_REPORT_ROWS=${rows.length}`
  );
  console.log(
    `PERDIEM_TOTAL=${totalPerDiem.toFixed(2)}`
  );
  console.log(
    `TRANSPORT_FEE_TOTAL=${transportFeeTotal.toFixed(2)}`
  );
  console.log(
    `GRAND_TOTAL=${grandTotal.toFixed(2)}`
  );
  console.log(
    `PERDIEM_REPORT_CSV=${csvPath}`
  );
  // ----------------------------------------------------------
  // 10. Slack CSV upload
  // ----------------------------------------------------------
  await uploadSlackFile(
    csvPath,
    `${period.monthName} ${period.year} PerDiem`,
    slackText
  );
  // ----------------------------------------------------------
  // 11. Slack response_url
  // ----------------------------------------------------------
  await postSlackResponse(
    slackText
  );
}
// ============================================================
// Error handler
// ============================================================
main().catch(
  async (error) => {
    console.error(
      `Monthly PerDiem report failed: ${
        error.stack || error.message
      }`
    );
    try {
      await postSlackResponse(
        `PerDiem report failed: ${error.message}`
      );
    } catch {
      // Ignore Slack response failure
    }
    process.exit(1);
  }
);