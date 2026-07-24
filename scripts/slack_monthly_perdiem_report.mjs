import fs from "fs";
import path from "path";
import crypto from "crypto";
import { google } from "googleapis";

//const SPREADSHEET_ID =
  process.env.GOOGLE_SHEETS_SPREADSHEET_ID ||
  "1mKjEd__zIoMJaa6CLmDE-wALGhtlG-USLTAiQBZnioc";
const SHEET_NAME = process.env.PERDIEM_SHEET_NAME || "Perdiem";
const OUTPUT_DIR = process.env.PERDIEM_REPORT_DIR || "outputs";
const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function requiredJsonEnv(name) {
  const raw = String(process.env[name] || "")
    .trim()
    .replace(/^\uFEFF/, "")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/-----BEGIN PRIVATE KEY[—–-]+/g, "-----BEGIN PRIVATE KEY-----")
    .replace(/[—–-]+END PRIVATE KEY[—–-]+/g, "-----END PRIVATE KEY-----");

  if (!raw) throw new Error(`${name} is required`);

  const parsed = JSON.parse(raw);
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

  // 매월 1일 자동 실행 시 직전 달 보고서를 작성한다.
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
  if (Number.isFinite(numeric) && numeric >= 1 && numeric <= 12) {
    return numeric;
  }

  const index = MONTH_NAMES.findIndex(
    (name) => name.toLowerCase() === normalized.toLowerCase(),
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
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function toCsv(rows) {
  return rows.map((row) => row.map(csvEscape).join(",")).join("\n");
}

function getColumn(row, index) {
  return Number.isInteger(index) && index >= 0 ? row[index] ?? "" : "";
}

function normalizeHeader(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s_()\-/.]/g, "");
}

function buildHeaderIndex(header) {
  const index = {};
  header.forEach((name, i) => {
    index[normalizeHeader(name)] = i;
  });
  return index;
}

function findColumn(index, aliases) {
  for (const alias of aliases) {
    const found = index[normalizeHeader(alias)];
    if (found !== undefined) return found;
  }
  return -1;
}

function normalizeIdentity(value) {
  return String(value ?? "").trim().toLowerCase();
}

function reportOwner() {
  return {
    owner: optionalEnv("PERDIEM_OWNER") || optionalEnv("FIREBASE_UID"),
    uid: optionalEnv("PERDIEM_UID") || optionalEnv("FIREBASE_UID"),
    userId:
      optionalEnv("PERDIEM_USER_ID") ||
      optionalEnv("FIREBASE_UID") ||
      optionalEnv("USER_ID"),
    email:
      optionalEnv("PERDIEM_USER_EMAIL") ||
      optionalEnv("USER_EMAIL") ||
      (/^[^@\s]+@[^@\s]+$/.test(optionalEnv("USER_ID"))
        ? optionalEnv("USER_ID")
        : ""),
    displayName:
      optionalEnv("PDC_USER_NAME") ||
      optionalEnv("USER_NAME") ||
      optionalEnv("PERDIEM_USER_NAME"),
  };
}

function hasRequestedIdentity(owner) {
  return Boolean(owner.owner || owner.uid || owner.userId || owner.email);
}

function rowMatchesOwner(row, columns, owner) {
  const comparisons = [
    [columns.owner, owner.owner],
    [columns.uid, owner.uid],
    [columns.userId, owner.userId],
    [columns.email, owner.email],
  ].filter(([columnIndex, expected]) => columnIndex >= 0 && expected);

  if (!comparisons.length) return false;

  // 저장 방식에 따라 owner/uid/userId/email 중 하나만 있어도 사용자 일치로 인정한다.
  return comparisons.some(([columnIndex, expected]) => (
    normalizeIdentity(getColumn(row, columnIndex)) === normalizeIdentity(expected)
  ));
}

function normalizeDate(value) {
  const text = String(value ?? "").trim();
  const match = text.match(/^(\d{4})[-.](\d{1,2})[-.](\d{1,2})$/);
  if (!match) return text;
  return `${match[1]}.${match[2].padStart(2, "0")}.${match[3].padStart(2, "0")}`;
}

function normalizeAirport(value) {
  return String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function normalizeActivity(value) {
  return String(value ?? "").trim().toUpperCase().replace(/\s+/g, "");
}

function normalizedTimestamp(value) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? text : new Date(parsed).toISOString();
}

function rowCompleteness(row) {
  return row.reduce((score, value) => score + (String(value ?? "").trim() ? 1 : 0), 0);
}

function perDiemDuplicateKey(row, columns) {
  return [
    normalizeDate(getColumn(row, columns.date)),
    normalizeActivity(getColumn(row, columns.activity)),
    normalizeAirport(getColumn(row, columns.from)),
    normalizeAirport(getColumn(row, columns.destination)),
    normalizedTimestamp(getColumn(row, columns.ri)),
    normalizedTimestamp(getColumn(row, columns.ro)),
  ].join("|");
}

function dedupePerDiemRows(rows, columns) {
  const selected = new Map();

  for (const row of rows) {
    const key = perDiemDuplicateKey(row, columns);
    const current = selected.get(key);

    if (!current || rowCompleteness(row) > rowCompleteness(current)) {
      selected.set(key, row);
    }
  }

  return [...selected.values()].sort((left, right) => {
    const leftDate = normalizeDate(getColumn(left, columns.date));
    const rightDate = normalizeDate(getColumn(right, columns.date));
    const dateCompare = leftDate.localeCompare(rightDate);
    if (dateCompare !== 0) return dateCompare;

    return normalizeActivity(getColumn(left, columns.activity)).localeCompare(
      normalizeActivity(getColumn(right, columns.activity)),
    );
  });
}

function sanitizeFilePart(value, fallback = "user") {
  const normalized = String(value || fallback)
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9가-힣._-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized || fallback;
}

function ownerReportKey(owner) {
  const visible = owner.displayName || owner.email || owner.owner || owner.uid || owner.userId;
  if (visible) return sanitizeFilePart(visible);

  const hash = crypto.createHash("sha256").update(JSON.stringify(owner)).digest("hex").slice(0, 10);
  return `user_${hash}`;
}

async function main() {
  const force =
    process.env.FORCE_PERDIEM_REPORT === "true" ||
    process.env.GITHUB_EVENT_NAME === "workflow_dispatch";

  if (!force && !isKstMonthCloseRun()) {
    console.log("Not KST month-close day; skipping report.");
    return;
  }

  const target = defaultTargetMonthYear();
  const targetYear = Number(process.env.PERDIEM_TARGET_YEAR || target.year);
  const targetMonth = Number(process.env.PERDIEM_TARGET_MONTH || target.month);
  const monthName = MONTH_NAMES[targetMonth - 1];

  if (!monthName || !Number.isInteger(targetYear) || targetYear < 2000) {
    throw new Error(`Invalid target month/year: ${targetMonth}/${targetYear}`);
  }

  const owner = reportOwner();
  if (!hasRequestedIdentity(owner)) {
    throw new Error(
      "User identity is required. Set PERDIEM_OWNER, FIREBASE_UID, PERDIEM_USER_ID, or PERDIEM_USER_EMAIL.",
    );
  }

  const credentials = requiredJsonEnv("GOOGLE_SHEETS_CREDENTIALS");
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });
  const sheets = google.sheets({ version: "v4", auth });

  // 사용자 식별 컬럼이 M열 이후에 있을 수 있으므로 전체 사용 범위를 읽는다.
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A:Z`,
  });

  const values = response.data.values || [];
  if (values.length === 0) throw new Error(`${SHEET_NAME} sheet is empty`);

  const header = values[0];
  const index = buildHeaderIndex(header);
  const columns = {
    date: findColumn(index, ["Date"]),
    activity: findColumn(index, ["Activity", "FLT", "Flight"]),
    from: findColumn(index, ["From"]),
    destination: findColumn(index, ["Destination", "To"]),
    ri: findColumn(index, ["RI"]),
    ro: findColumn(index, ["RO"]),
    month: findColumn(index, ["Month"]),
    year: findColumn(index, ["Year"]),
    total: findColumn(index, ["Total"]),
    transportFee: findColumn(index, ["TransportFee", "Transport Fee"]),
    owner: findColumn(index, ["owner", "Owner"]),
    uid: findColumn(index, ["uid", "UID"]),
    userId: findColumn(index, ["userId", "User ID", "firebaseUid"]),
    email: findColumn(index, ["email", "Email"]),
  };

  for (const name of ["month", "year", "total", "transportFee"]) {
    if (columns[name] < 0) {
      throw new Error(`Missing ${name} column in ${SHEET_NAME}`);
    }
  }

  const hasUserColumn = [columns.owner, columns.uid, columns.userId, columns.email]
    .some((columnIndex) => columnIndex >= 0);

  if (!hasUserColumn) {
    throw new Error(
      `${SHEET_NAME} must contain at least one user column: owner, uid, userId, or email.`,
    );
  }

  const monthUserRows = values.slice(1).filter((row) => (
    monthToNumber(getColumn(row, columns.month)) === targetMonth &&
    String(getColumn(row, columns.year)).trim() === String(targetYear) &&
    rowMatchesOwner(row, columns, owner)
  ));

  const filteredRows = dedupePerDiemRows(monthUserRows, columns);

  const totalPerdiem = filteredRows.reduce(
    (sum, row) => sum + parseMoney(getColumn(row, columns.total)),
    0,
  );
  const totalTransportFee = filteredRows.reduce(
    (sum, row) => sum + parseMoney(getColumn(row, columns.transportFee)),
    0,
  );
  const grandTotal = totalPerdiem + totalTransportFee;

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const userKey = ownerReportKey(owner);
  const baseName = `Perdiem_${userKey}_${monthName}_${targetYear}`;
  const csvPath = path.join(OUTPUT_DIR, `${baseName}.csv`);
  const summaryPath = path.join(OUTPUT_DIR, `${baseName}.json`);

  const summaryRows = [
    [],
    ["Summary"],
    ["User", owner.displayName || owner.email || owner.owner || owner.uid || owner.userId],
    ["Month", monthName],
    ["Year", targetYear],
    ["Rows Before Dedupe", monthUserRows.length],
    ["Rows", filteredRows.length],
    ["Duplicates Removed", monthUserRows.length - filteredRows.length],
    ["Total Perdiem", totalPerdiem.toFixed(2)],
    ["Transport Fee Total", totalTransportFee.toFixed(2)],
    ["Grand Total", grandTotal.toFixed(2)],
  ];

  fs.writeFileSync(
    csvPath,
    `${toCsv([header, ...filteredRows, ...summaryRows])}\n`,
    "utf-8",
  );

  fs.writeFileSync(
    summaryPath,
    JSON.stringify({
      owner: {
        owner: owner.owner,
        uid: owner.uid,
        userId: owner.userId,
        email: owner.email,
        displayName: owner.displayName,
      },
      month: monthName,
      monthNumber: targetMonth,
      year: targetYear,
      rowsBeforeDedupe: monthUserRows.length,
      rows: filteredRows.length,
      duplicatesRemoved: monthUserRows.length - filteredRows.length,
      totalPerdiem,
      totalTransportFee,
      grandTotal,
      csvPath,
      fileBaseName: baseName,
    }, null, 2),
    "utf-8",
  );

  console.log(`PERDIEM_REPORT_CSV=${csvPath}`);
  console.log(`PERDIEM_REPORT_SUMMARY=${summaryPath}`);
  console.log(`PERDIEM_REPORT_FILE_BASE=${baseName}`);
  console.log(`PERDIEM_REPORT_OWNER=${owner.owner || owner.uid || owner.userId || owner.email}`);
  console.log(`PERDIEM_REPORT_ROWS_BEFORE_DEDUPE=${monthUserRows.length}`);
  console.log(`PERDIEM_REPORT_ROWS=${filteredRows.length}`);
  console.log(`PERDIEM_DUPLICATES_REMOVED=${monthUserRows.length - filteredRows.length}`);
  console.log(`PERDIEM_TOTAL=${totalPerdiem.toFixed(2)}`);
  console.log(`TRANSPORT_FEE_TOTAL=${totalTransportFee.toFixed(2)}`);
  console.log(`GRAND_TOTAL=${grandTotal.toFixed(2)}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});



