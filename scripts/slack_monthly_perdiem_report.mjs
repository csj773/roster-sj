import fs from "fs";
import path from "path";
import crypto from "crypto";
import admin from "firebase-admin";
import { WebClient } from "@slack/web-api";

const COLLECTION_NAME = process.env.PERDIEM_COLLECTION_NAME || "Perdiem";
const OUTPUT_DIR = process.env.PERDIEM_REPORT_DIR || "outputs";
const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

const CSV_HEADERS = [
  "ID", "Date", "Activity", "From", "Destination", "To",
  "RI", "RO", "StayHours", "Rate", "Total", "TransportFee",
  "Month", "Year", "owner", "uid", "userId", "email",
];

function optionalEnv(name) {
  return String(process.env[name] || "").trim();
}

function firstEnv(...names) {
  for (const name of names) {
    const value = optionalEnv(name);
    if (value) return value;
  }
  return "";
}

function parseJsonEnv(name) {
  const raw = optionalEnv(name)
    .replace(/^\uFEFF/, "")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/-----BEGIN PRIVATE KEY[—–-]+/g, "-----BEGIN PRIVATE KEY-----")
    .replace(/[—–-]+END PRIVATE KEY[—–-]+/g, "-----END PRIVATE KEY-----");

  if (!raw) return null;

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${name} is not valid JSON: ${error.message}`);
  }

  if (parsed.private_key) {
    parsed.private_key = String(parsed.private_key).replace(/\\n/g, "\n");
  }

  return parsed;
}

function loadServiceAccount() {
  for (const name of [
    "FIREBASE_SERVICE_ACCOUNT",
    "GOOGLE_APPLICATION_CREDENTIALS_JSON",
    "GOOGLE_SHEETS_CREDENTIALS",
  ]) {
    const credential = parseJsonEnv(name);
    if (credential) return { name, credential };
  }

  throw new Error(
    "Firebase service-account JSON is required. Set FIREBASE_SERVICE_ACCOUNT " +
    "or GOOGLE_SHEETS_CREDENTIALS.",
  );
}

function reportOwner() {
  return {
    owner: firstEnv(
      "PERDIEM_OWNER",
      "FIRESTORE_ADMIN_UID",
      "FIREBASE_UID",
      "INPUT_FIREBASE_UID",
      "INPUT_ADMIN_FIREBASE_UID",
    ),
    uid: firstEnv(
      "PERDIEM_UID",
      "FIREBASE_UID",
      "FIRESTORE_ADMIN_UID",
      "INPUT_FIREBASE_UID",
    ),
    userId: firstEnv(
      "PERDIEM_USER_ID",
      "USER_ID",
      "FIREBASE_UID",
      "FIRESTORE_ADMIN_UID",
    ),
    email: firstEnv(
      "PERDIEM_USER_EMAIL",
      "USER_EMAIL",
      /^[^@\s]+@[^@\s]+$/.test(optionalEnv("USER_ID")) ? "USER_ID" : "",
    ),
    displayName: firstEnv(
      "PERDIEM_USER_NAME",
      "PDC_USER_NAME",
      "USER_NAME",
    ),
  };
}

function hasRequestedIdentity(identity) {
  return Boolean(identity.owner || identity.uid || identity.userId || identity.email);
}

function normalizeIdentity(value) {
  return String(value ?? "").trim().toLowerCase();
}

function identityValues(identity) {
  return [...new Set([
    identity.owner,
    identity.uid,
    identity.userId,
    identity.email,
  ].map(normalizeIdentity).filter(Boolean))];
}

function documentMatchesIdentity(data, identity) {
  const requested = identityValues(identity);
  const stored = [
    data.owner,
    data.uid,
    data.userId,
    data.firebaseUid,
    data.email,
    data.Email,
  ].map(normalizeIdentity).filter(Boolean);

  return requested.some((value) => stored.includes(value));
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
  if (Number.isInteger(numeric) && numeric >= 1 && numeric <= 12) {
    return numeric;
  }

  const monthNames = [
    ...MONTH_NAMES,
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];
  const index = monthNames.findIndex(
    (name) => name.toLowerCase() === normalized.toLowerCase(),
  );
  if (index < 0) return null;
  return (index % 12) + 1;
}

function normalizeYear(value) {
  const parsed = Number(String(value ?? "").trim());
  return Number.isInteger(parsed) ? parsed : null;
}

function firestoreValueToDate(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value?.toDate === "function") {
    const date = value.toDate();
    return Number.isNaN(date.getTime()) ? null : date;
  }
  if (Number.isFinite(value?._seconds)) {
    return new Date(value._seconds * 1000);
  }

  const text = String(value).trim();
  const dateMatch = text.match(/^(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})$/);
  if (dateMatch) {
    return new Date(Date.UTC(
      Number(dateMatch[1]),
      Number(dateMatch[2]) - 1,
      Number(dateMatch[3]),
    ));
  }

  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? null : new Date(parsed);
}

function documentMonthYear(data) {
  let month = monthToNumber(data.Month ?? data.month);
  let year = normalizeYear(data.Year ?? data.year);

  if (!month || !year) {
    const date = firestoreValueToDate(data.Date ?? data.date ?? data.RO ?? data.RI);
    if (date) {
      month ||= date.getUTCMonth() + 1;
      year ||= date.getUTCFullYear();
    }
  }

  return { month, year };
}

function normalizeDate(value) {
  const date = firestoreValueToDate(value);
  if (!date) return String(value ?? "").trim();

  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
  ].join(".");
}

function normalizeTimestamp(value) {
  if (!value) return "";
  const date = firestoreValueToDate(value);
  return date ? date.toISOString() : String(value).trim();
}

function normalizeAirport(value) {
  return String(value ?? "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function normalizeActivity(value) {
  return String(value ?? "").trim().toUpperCase().replace(/\s+/g, "");
}

function parseMoney(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const normalized = String(value ?? "")
    .replace(/,/g, "")
    .replace(/[^0-9.+-]/g, "")
    .trim();
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeDocument(document) {
  const data = document.data();
  const { month, year } = documentMonthYear(data);

  return {
    ID: data.ID ?? data.id ?? document.id,
    Date: normalizeDate(data.Date ?? data.date),
    Activity: data.Activity ?? data.activity ?? data.FLT ?? "",
    From: data.From ?? data.from ?? "",
    Destination: data.Destination ?? data.destination ?? data.To ?? data.to ?? "",
    To: data.To ?? data.to ?? data.Destination ?? data.destination ?? "",
    RI: normalizeTimestamp(data.RI ?? data.ri),
    RO: normalizeTimestamp(data.RO ?? data.ro),
    StayHours: data.StayHours ?? data.stayHours ?? "",
    Rate: data.Rate ?? data.rate ?? 0,
    Total: parseMoney(data.Total ?? data.total),
    TransportFee: parseMoney(
      data.TransportFee ?? data.transportFee ?? data["Transport Fee"],
    ),
    Month: month ? MONTH_NAMES[month - 1] : "",
    Year: year ?? "",
    owner: data.owner ?? "",
    uid: data.uid ?? data.firebaseUid ?? "",
    userId: data.userId ?? "",
    email: data.email ?? data.Email ?? "",
  };
}

function rowCompleteness(row) {
  return CSV_HEADERS.reduce(
    (score, key) => score + (String(row[key] ?? "").trim() ? 1 : 0),
    0,
  );
}

function duplicateKey(row) {
  return [
    normalizeDate(row.Date),
    normalizeActivity(row.Activity),
    normalizeAirport(row.From),
    normalizeAirport(row.Destination || row.To),
    normalizeTimestamp(row.RI),
    normalizeTimestamp(row.RO),
  ].join("|");
}

function dedupePerDiemRows(rows) {
  const selected = new Map();

  for (const row of rows) {
    const key = duplicateKey(row);
    const current = selected.get(key);
    if (!current || rowCompleteness(row) > rowCompleteness(current)) {
      selected.set(key, row);
    }
  }

  return [...selected.values()].sort((left, right) => {
    const dateCompare = String(left.Date).localeCompare(String(right.Date));
    if (dateCompare !== 0) return dateCompare;
    return normalizeActivity(left.Activity).localeCompare(normalizeActivity(right.Activity));
  });
}

function csvEscape(value) {
  const text = String(value ?? "");
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function toCsv(rows) {
  return rows.map((row) => row.map(csvEscape).join(",")).join("\n");
}

function sanitizeFilePart(value, fallback = "user") {
  const normalized = String(value || fallback)
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9가-힣._-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized || fallback;
}

function ownerReportKey(identity) {
  const visible =
    identity.displayName || identity.email || identity.owner || identity.uid || identity.userId;
  if (visible) return sanitizeFilePart(visible);

  const hash = crypto
    .createHash("sha256")
    .update(JSON.stringify(identity))
    .digest("hex")
    .slice(0, 10);
  return `user_${hash}`;
}

async function loadPerDiemRows(db, identity, targetMonth, targetYear) {
  const snapshot = await db.collection(COLLECTION_NAME).get();

  const identityMatched = snapshot.docs.filter((document) =>
    documentMatchesIdentity(document.data(), identity),
  );

  const monthMatched = identityMatched.filter((document) => {
    const { month, year } = documentMonthYear(document.data());
    return month === targetMonth && year === targetYear;
  });

  console.log(`PERDIEM_COLLECTION_ROWS=${snapshot.size}`);
  console.log(`PERDIEM_IDENTITY_MATCHED_ROWS=${identityMatched.length}`);
  console.log(`PERDIEM_MONTH_MATCHED_ROWS=${monthMatched.length}`);

  if (identityMatched.length === 0) {
    const sampleIdentities = snapshot.docs.slice(0, 10).map((document) => {
      const data = document.data();
      return {
        id: document.id,
        owner: data.owner ?? "",
        uid: data.uid ?? data.firebaseUid ?? "",
        userId: data.userId ?? "",
        email: data.email ?? data.Email ?? "",
      };
    });
    console.log("PERDIEM_SAMPLE_IDENTITIES=" + JSON.stringify(sampleIdentities));
  }

  return monthMatched.map(normalizeDocument);
}

function writeReportFiles({
  identity,
  monthName,
  targetMonth,
  targetYear,
  sourceRows,
  filteredRows,
  totalPerDiem,
  totalTransportFee,
}) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const userKey = ownerReportKey(identity);
  const baseName = `Perdiem_${userKey}_${monthName}_${targetYear}`;
  const csvPath = path.join(OUTPUT_DIR, `${baseName}.csv`);
  const summaryPath = path.join(OUTPUT_DIR, `${baseName}.json`);

  const detailRows = filteredRows.map((row) => CSV_HEADERS.map((header) => row[header] ?? ""));
  const summaryRows = [
    [],
    ["Summary"],
    ["User", identity.displayName || identity.email || identity.owner || identity.uid || identity.userId],
    ["Month", monthName],
    ["Year", targetYear],
    ["Rows Before Dedupe", sourceRows.length],
    ["Rows", filteredRows.length],
    ["Duplicates Removed", sourceRows.length - filteredRows.length],
    ["Total PerDiem", totalPerDiem.toFixed(2)],
    ["Transport Fee Total", totalTransportFee.toFixed(2)],
  ];

  // PerDiem은 외화, TransportFee는 원화일 수 있으므로 서로 더하지 않는다.
  fs.writeFileSync(
    csvPath,
    `\uFEFF${toCsv([CSV_HEADERS, ...detailRows, ...summaryRows])}\n`,
    "utf-8",
  );

  const summary = {
    owner: identity,
    collection: COLLECTION_NAME,
    month: monthName,
    monthNumber: targetMonth,
    year: targetYear,
    rowsBeforeDedupe: sourceRows.length,
    rows: filteredRows.length,
    duplicatesRemoved: sourceRows.length - filteredRows.length,
    totalPerDiem,
    totalTransportFee,
    csvPath,
    fileBaseName: baseName,
    generatedAt: new Date().toISOString(),
  };

  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2), "utf-8");

  return { baseName, csvPath, summaryPath };
}

function formatAmount(value) {
  return Number(value || 0).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function buildSlackMessage({
  identity,
  monthName,
  targetYear,
  sourceRows,
  filteredRows,
  totalPerDiem,
  totalTransportFee,
}) {
  const userName =
    identity.displayName || identity.email || identity.owner || identity.uid || identity.userId;

  return [
    `*PerDiem monthly report for ${monthName} ${targetYear}*`,
    "",
    `User: ${userName}`,
    `Rows before dedupe: ${sourceRows.length}`,
    `Rows: ${filteredRows.length}`,
    `Duplicates removed: ${sourceRows.length - filteredRows.length}`,
    `Total PerDiem: ${formatAmount(totalPerDiem)}`,
    `Transport Fee Total: ₩${Math.round(totalTransportFee).toLocaleString("ko-KR")}`,
  ].join("\n");
}

async function sendSlackReport(csvPath, baseName, message) {
  if (optionalEnv("SKIP_SLACK_SEND").toLowerCase() === "true") {
    console.log("SKIP_SLACK_SEND=true; Slack upload skipped.");
    return;
  }

  const token = firstEnv("SLACK_BOT_TOKEN", "PERDIEM_SLACK_BOT_TOKEN");
  const channelId = firstEnv("SLACK_CHANNEL_ID", "PERDIEM_SLACK_CHANNEL_ID");

  if (!token) throw new Error("SLACK_BOT_TOKEN is required");
  if (!channelId) throw new Error("SLACK_CHANNEL_ID is required");

  const slack = new WebClient(token);
  await slack.files.uploadV2({
    channel_id: channelId,
    file: fs.createReadStream(csvPath),
    filename: path.basename(csvPath),
    title: `${baseName} monthly report`,
    initial_comment: message,
  });

  console.log("Slack monthly report sent successfully.");
}

async function main() {
  const force =
    optionalEnv("FORCE_PERDIEM_REPORT").toLowerCase() === "true" ||
    optionalEnv("GITHUB_EVENT_NAME") === "workflow_dispatch";

  if (!force && !isKstMonthCloseRun()) {
    console.log("Not KST month-close day; skipping report.");
    return;
  }

  const defaultTarget = defaultTargetMonthYear();
  const targetYear = Number(optionalEnv("PERDIEM_TARGET_YEAR") || defaultTarget.year);
  const targetMonth = Number(optionalEnv("PERDIEM_TARGET_MONTH") || defaultTarget.month);
  const monthName = MONTH_NAMES[targetMonth - 1];

  if (
    !monthName ||
    !Number.isInteger(targetMonth) ||
    !Number.isInteger(targetYear) ||
    targetYear < 2000
  ) {
    throw new Error(`Invalid target month/year: ${targetMonth}/${targetYear}`);
  }

  const identity = reportOwner();
  if (!hasRequestedIdentity(identity)) {
    throw new Error(
      "User identity is required. Set PERDIEM_OWNER, FIRESTORE_ADMIN_UID, " +
      "FIREBASE_UID, PERDIEM_USER_ID, or PERDIEM_USER_EMAIL.",
    );
  }

  const { name: credentialName, credential } = loadServiceAccount();
  console.log(`Using Firebase credentials from ${credentialName}`);

  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(credential),
      projectId: credential.project_id,
    });
  }

  const db = admin.firestore();
  const sourceRows = await loadPerDiemRows(db, identity, targetMonth, targetYear);
  const filteredRows = dedupePerDiemRows(sourceRows);

  const totalPerDiem = filteredRows.reduce(
    (sum, row) => sum + parseMoney(row.Total),
    0,
  );
  const totalTransportFee = filteredRows.reduce(
    (sum, row) => sum + parseMoney(row.TransportFee),
    0,
  );

  const reportFiles = writeReportFiles({
    identity,
    monthName,
    targetMonth,
    targetYear,
    sourceRows,
    filteredRows,
    totalPerDiem,
    totalTransportFee,
  });

  const slackMessage = buildSlackMessage({
    identity,
    monthName,
    targetYear,
    sourceRows,
    filteredRows,
    totalPerDiem,
    totalTransportFee,
  });

  await sendSlackReport(
    reportFiles.csvPath,
    reportFiles.baseName,
    slackMessage,
  );

  console.log(`PERDIEM_REPORT_CSV=${reportFiles.csvPath}`);
  console.log(`PERDIEM_REPORT_SUMMARY=${reportFiles.summaryPath}`);
  console.log(`PERDIEM_REPORT_FILE_BASE=${reportFiles.baseName}`);
  console.log(`PERDIEM_REPORT_OWNER=${identity.owner || identity.uid || identity.userId || identity.email}`);
  console.log(`PERDIEM_REPORT_ROWS_BEFORE_DEDUPE=${sourceRows.length}`);
  console.log(`PERDIEM_REPORT_ROWS=${filteredRows.length}`);
  console.log(`PERDIEM_DUPLICATES_REMOVED=${sourceRows.length - filteredRows.length}`);
  console.log(`PERDIEM_TOTAL=${totalPerDiem.toFixed(2)}`);
  console.log(`TRANSPORT_FEE_TOTAL=${totalTransportFee.toFixed(2)}`);
}

main().catch((error) => {
  console.error("Monthly PerDiem report failed:", error);
  process.exit(1);
});



