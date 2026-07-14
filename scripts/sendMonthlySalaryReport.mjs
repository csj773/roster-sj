import {cert, getApps, initializeApp} from "firebase-admin/app";
import {FieldValue, Timestamp, getFirestore} from "firebase-admin/firestore";
import {google} from "googleapis";
import nodemailer from "nodemailer";
import {mkdir} from "node:fs/promises";
import path from "node:path";
import {spawnSync} from "node:child_process";

const config = {
  timeZone: process.env.REPORT_TIME_ZONE || "Asia/Seoul",
  paymentsCollection: process.env.PAYMENTS_COLLECTION || "Payments",
  runLogCollection: process.env.RUN_LOG_COLLECTION || "salaryReportRuns",
  paymentDateField: process.env.PAYMENT_DATE_FIELD || "paymentDate",
  yearField: process.env.YEAR_FIELD || "Year",
  monthField: process.env.MONTH_FIELD || "Month",
  totalPayField: process.env.TOTAL_PAY_FIELD || "Salary",
  updatedAtField: process.env.UPDATED_AT_FIELD || "updatedAt",
  salarySpreadsheetId: process.env.SALARY_SPREADSHEET_ID ||
    process.env.GOOGLE_SHEETS_SPREADSHEET_ID ||
    "1mKjEd__zIoMJaa6CLmDE-wALGhtlG-USLTAiQBZnioc",
  salaryWriteRange: process.env.SALARY_WRITE_RANGE || "Salary!A1",
  salaryClearRange: process.env.SALARY_CLEAR_RANGE || "",
  salaryMonthCell: process.env.SALARY_MONTH_CELL || "",
  salaryTotalCell: process.env.SALARY_TOTAL_CELL || "",
  dedupeKeyFields: (process.env.DEDUPE_KEY_FIELDS || "employeeId,payPeriod")
    .split(",")
    .map((field) => field.trim())
    .filter(Boolean),
};
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

initializeFirebase();

const db = getFirestore();
const args = parseArgs(process.argv.slice(2));
const now = new Date();
const isManualRun = process.env.GITHUB_EVENT_NAME === "workflow_dispatch";
const target = args.month ? parseMonth(args.month) : {
  year: getPart(now, config.timeZone, "year"),
  month: getPart(now, config.timeZone, "month"),
};

if (!args.month && !args.force && !isManualRun && !isLastDayOfMonth(now, config.timeZone)) {
  console.log("Not the last day of the month in KST; skipping salary report.");
  process.exit(0);
}

const result = await runMonthlySalaryReport({
  year: target.year,
  month: target.month,
  force: args.force,
});

console.log(JSON.stringify(result, null, 2));

async function runMonthlySalaryReport({year, month, force = false}) {
  const reportKey = `${year}-${String(month).padStart(2, "0")}`;
  const runRef = db.collection(config.runLogCollection).doc(reportKey);

  if (!force) {
    await db.runTransaction(async (transaction) => {
      const runDoc = await transaction.get(runRef);
      if (runDoc.exists && runDoc.get("status") === "sent") {
        throw new Error(`Salary report ${reportKey} was already sent. Use --force to send again.`);
      }

      transaction.set(runRef, {
        status: "running",
        startedAt: FieldValue.serverTimestamp(),
        runner: "github-actions",
      }, {merge: true});
    });
  }

  try {
    const rows = await fetchLatestPaymentRows(year, month);
    const totalPay = rows.reduce((sum, row) => sum + row.reportPay, 0);
    const fileName = `Salary_${monthName(month)}_${year}.xlsx`;
    const outputDir = path.join(process.cwd(), "artifacts", "salary-reports");
    const outputPath = path.join(outputDir, fileName);
    const googleAuth = createGoogleAuth();

    await mkdir(outputDir, {recursive: true});
    const sheetValues = await updateSalarySheet({auth: googleAuth, year, month, rows, totalPay});
    await exportSalarySpreadsheet({auth: googleAuth, outputPath, values: sheetValues});
    await sendEmail({year, month, fileName, outputPath, rowCount: rows.length, totalPay});

    await runRef.set({
      status: "sent",
      sentAt: FieldValue.serverTimestamp(),
      fileName,
      spreadsheetId: config.salarySpreadsheetId,
      rowCount: rows.length,
      totalPay,
      runner: "github-actions",
    }, {merge: true});

    return {reportKey, fileName, outputPath, rowCount: rows.length, totalPay};
  } catch (error) {
    await runRef.set({
      status: "failed",
      failedAt: FieldValue.serverTimestamp(),
      error: error.message,
      runner: "github-actions",
    }, {merge: true});
    throw error;
  }
}

async function fetchLatestPaymentRows(year, month) {
  const {start, end} = monthBounds(year, month);
  const snapshot = await db
    .collection(config.paymentsCollection)
    .where(config.paymentDateField, ">=", Timestamp.fromDate(start))
    .where(config.paymentDateField, "<", Timestamp.fromDate(end))
    .get();

  let sourceDocs = snapshot.docs;
  if (sourceDocs.length === 0) {
    console.log(`No rows found by ${config.paymentDateField}; falling back to ${config.yearField}/${config.monthField} fields.`);
    sourceDocs = await fetchRowsByYearMonthFields(year, month);
  }

  const latestByKey = new Map();

  sourceDocs.forEach((doc) => {
    const data = doc.data();
    const row = normalizePaymentDoc(doc.id, data, {year, month});
    const dedupeKey = buildDedupeKey(doc.id, data);
    const existing = latestByKey.get(dedupeKey);

    if (!existing || row.updatedAtMillis > existing.updatedAtMillis) {
      latestByKey.set(dedupeKey, row);
    }
  });

  return Array.from(latestByKey.values())
    .sort((a, b) => (
      a.owner.localeCompare(b.owner) ||
      a.employeeId.localeCompare(b.employeeId) ||
      a.paymentDateMillis - b.paymentDateMillis ||
      a.id.localeCompare(b.id)
    ));
}

async function fetchRowsByYearMonthFields(year, month) {
  const collection = db.collection(config.paymentsCollection);
  const snapshots = await Promise.all([
    collection.where(config.yearField, "==", String(year)).get(),
    collection.where(config.yearField, "==", year).get(),
  ]);
  const byId = new Map();
  for (const snapshot of snapshots) {
    snapshot.forEach((doc) => {
      const data = doc.data();
      if (!matchesTargetMonth(data, month)) return;
      byId.set(doc.id, doc);
    });
  }
  return Array.from(byId.values());
}

function matchesTargetMonth(data, month) {
  if (!(config.monthField in data)) return true;
  const value = data[config.monthField];
  if (value == null || value === "") return true;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric === month;
  return monthName(month).toLowerCase() === String(value).trim().toLowerCase();
}

function normalizePaymentDoc(id, data, target = {}) {
  const paymentDate = toDate(data[config.paymentDateField]);
  const updatedAt = toDate(data[config.updatedAtField]) || paymentDate || new Date(0);
  const salary = numberValue(data.Salary);
  const totalPay = Number(data.TotalPay || 0);
  const reportPay = numberValue(data[config.totalPayField]);
  const reportMonth = monthNumberValue(data[config.monthField], target.month);

  return {
    id,
    owner: stringValue(data.owner),
    year: stringValue(data[config.yearField] || target.year || ""),
    month: reportMonth,
    employeeId: stringValue(data.employeeId),
    employeeName: stringValue(data.employeeName || data.name),
    payPeriod: stringValue(data.payPeriod),
    paymentDate,
    paymentDateMillis: paymentDate ? paymentDate.getTime() : 0,
    blk: stringValue(data.BLK),
    et: stringValue(data.ET),
    nt: stringValue(data.NT),
    ot: stringValue(data.OT),
    p3: stringValue(data.P3),
    rate: numberValue(data.Rate),
    hourlyRate: numberValue(data.HourlyRate),
    basicSalary: numberValue(data.BasicSalary),
    basicAllowance: numberValue(data.BasicAllowance),
    salary,
    etPay: numberValue(data.ETpay),
    ntPay: numberValue(data.NTpay),
    otPay: numberValue(data.OTpay),
    p3Pay: numberValue(data.P3pay),
    deduction: numberValue(data.Deduction),
    taxRate: numberValue(data.TaxRate),
    tax: numberValue(data.Tax),
    totalPay,
    reportPay,
    updatedAt,
    updatedAtMillis: updatedAt.getTime(),
  };
}

function buildDedupeKey(id, data) {
  const parts = config.dedupeKeyFields.map((field) => stringValue(data[field]));
  return parts.every(Boolean) ? parts.join("|") : id;
}

async function updateSalarySheet({auth, year, month, rows, totalPay}) {
  const spreadsheetId = requireConfig("SALARY_SPREADSHEET_ID", config.salarySpreadsheetId);
  const sheets = google.sheets({version: "v4", auth});
  const sheetTitle = sheetTitleFromRange(config.salaryWriteRange);
  await ensureSheetExists(sheets, spreadsheetId, sheetTitle);
  const monthLabel = `${monthName(month)} ${year}`;
  const values = [
    [
      "Payment Doc ID",
      "Owner",
      "Year",
      "Month",
      "Employee ID",
      "Employee Name",
      "Pay Period",
      "Payment Date",
      "BLK",
      "ET",
      "NT",
      "OT",
      "P3",
      "Rate",
      "HourlyRate",
      "BasicSalary",
      "BasicAllowance",
      "Salary",
      "ETpay",
      "NTpay",
      "OTpay",
      "P3pay",
      "Deduction",
      "TaxRate",
      "Tax",
      "ReportSalary",
      "TotalPay",
      "Updated At",
    ],
    ...rows.map((row) => [
      row.id,
      row.owner,
      row.year,
      row.month,
      row.employeeId,
      row.employeeName,
      row.payPeriod,
      formatDate(row.paymentDate),
      row.blk,
      row.et,
      row.nt,
      row.ot,
      row.p3,
      row.rate,
      row.hourlyRate,
      row.basicSalary,
      row.basicAllowance,
      row.salary,
      row.etPay,
      row.ntPay,
      row.otPay,
      row.p3Pay,
      row.deduction,
      row.taxRate,
      row.tax,
      row.reportPay,
      row.totalPay,
      formatDateTime(row.updatedAt),
    ]),
    ["", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "Total Salary", totalPay, ""],
  ];

  if (config.salaryClearRange) {
    await sheets.spreadsheets.values.clear({
      spreadsheetId,
      range: config.salaryClearRange,
    });
  }

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: config.salaryWriteRange,
    valueInputOption: "USER_ENTERED",
    requestBody: {values},
  });

  const extraRanges = [];
  const extraValues = [];

  if (config.salaryMonthCell) {
    extraRanges.push(config.salaryMonthCell);
    extraValues.push([[monthLabel]]);
  }

  if (config.salaryTotalCell) {
    extraRanges.push(config.salaryTotalCell);
    extraValues.push([[totalPay]]);
  }

  if (extraRanges.length) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: {
        valueInputOption: "USER_ENTERED",
        data: extraRanges.map((range, index) => ({
          range,
          values: extraValues[index],
        })),
      },
    });
  }

  return values;
}

function sheetTitleFromRange(range) {
  const sheetPart = String(range || "Salary!A1").split("!")[0] || "Salary";
  return sheetPart.replace(/^'|'$/g, "").replace(/''/g, "'");
}

async function ensureSheetExists(sheets, spreadsheetId, title) {
  const metadata = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: "sheets.properties.title",
  });
  const exists = (metadata.data.sheets || []).some((sheet) => sheet.properties?.title === title);
  if (exists) return;

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        {
          addSheet: {
            properties: {title},
          },
        },
      ],
    },
  });
  console.log(`Created missing sheet tab: ${title}`);
}

async function exportSalarySpreadsheet({auth, outputPath, values}) {
  const spreadsheetId = requireConfig("SALARY_SPREADSHEET_ID", config.salarySpreadsheetId);
  const drive = google.drive({version: "v3", auth});
  try {
    const response = await drive.files.export(
      {
        fileId: spreadsheetId,
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      },
      {responseType: "arraybuffer"},
    );

    await import("node:fs/promises").then(({writeFile}) => writeFile(outputPath, Buffer.from(response.data)));
  } catch (error) {
    console.warn(`Google Drive export failed; writing local XLSX fallback: ${error.message}`);
    writeLocalXlsx(outputPath, values);
  }
}

async function sendEmail({year, month, fileName, outputPath, rowCount, totalPay}) {
  console.log(`Sending salary report email to ${process.env.MAIL_TO || "sjchoi787@gmail.com"} with attachment ${fileName}`);
  const transporter = nodemailer.createTransport({
    host: requireEnv("MAIL_HOST"),
    port: Number(process.env.MAIL_PORT || 465),
    secure: String(process.env.MAIL_SECURE || "true").toLowerCase() === "true",
    auth: {
      user: requireEnv("MAIL_USER"),
      pass: requireEnv("MAIL_PASS"),
    },
  });

  const monthLabel = `${monthName(month)} ${year}`;
  await transporter.sendMail({
    from: process.env.MAIL_FROM || process.env.MAIL_USER,
    to: process.env.MAIL_TO || "sjchoi787@gmail.com",
    subject: `Salary Report - ${monthLabel}`,
    text: [
      `Attached is the salary report for ${monthLabel}.`,
      `The Google Sheets Salary tab was updated before export.`,
      "",
      `Unique payment rows: ${rowCount}`,
      `Salary: ${formatCurrency(totalPay)}`,
    ].join("\n"),
    attachments: [{filename: fileName, path: outputPath}],
  });
}

function initializeFirebase() {
  if (getApps().length) {
    return;
  }

  const credentialsJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON || process.env.FIREBASE_SERVICE_ACCOUNT;
  if (credentialsJson) {
    initializeApp({
      credential: cert(JSON.parse(credentialsJson)),
    });
    return;
  }

  initializeApp();
}

function createGoogleAuth() {
  const credentialsJson = process.env.GOOGLE_SHEETS_CREDENTIALS ||
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON ||
    process.env.FIREBASE_SERVICE_ACCOUNT_JSON ||
    process.env.FIREBASE_SERVICE_ACCOUNT;
  const credentials = JSON.parse(requireConfig("GOOGLE_SHEETS_CREDENTIALS or FIREBASE_SERVICE_ACCOUNT_JSON", credentialsJson));
  if (credentials.private_key) credentials.private_key = credentials.private_key.replace(/\\n/g, "\n");
  return new google.auth.GoogleAuth({
    credentials,
    scopes: [
      "https://www.googleapis.com/auth/spreadsheets",
      "https://www.googleapis.com/auth/drive.readonly",
    ],
  });
}

function writeLocalXlsx(outputPath, values) {
  const payload = JSON.stringify({outputPath, values});
  const script = `
import json
import sys
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill
from openpyxl.utils import get_column_letter

payload = json.loads(sys.stdin.read())
wb = Workbook()
ws = wb.active
ws.title = "Salary"
for row in payload["values"]:
    ws.append(row)

for cell in ws[1]:
    cell.font = Font(bold=True)
    cell.fill = PatternFill("solid", fgColor="D9EAF7")

for column_cells in ws.columns:
    width = max(len(str(cell.value or "")) for cell in column_cells) + 2
    ws.column_dimensions[get_column_letter(column_cells[0].column)].width = min(width, 28)

wb.save(payload["outputPath"])
`;
  const result = spawnSync("python", ["-c", script], {
    input: payload,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(`Local XLSX fallback failed: ${result.stderr || result.stdout}`);
  }
}

function parseArgs(argv) {
  return argv.reduce((parsed, arg) => {
    if (arg === "--force") {
      return {...parsed, force: true};
    }
    if (arg.startsWith("--month=")) {
      return {...parsed, month: arg.slice("--month=".length)};
    }
    return parsed;
  }, {force: false, month: ""});
}

function parseMonth(value) {
  const match = /^(\d{4})-(\d{2})$/.exec(value);
  if (!match) {
    throw new Error("Month must be in YYYY-MM format.");
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) {
    throw new Error("Month must be between 01 and 12.");
  }

  return {year, month};
}

function monthBounds(year, month) {
  return {
    start: zonedTimeToUtc({year, month, day: 1}, config.timeZone),
    end: zonedTimeToUtc({year, month: month + 1, day: 1}, config.timeZone),
  };
}

function zonedTimeToUtc({year, month, day}, timeZone) {
  const normalized = normalizeYearMonth(year, month);
  const guess = new Date(Date.UTC(normalized.year, normalized.month - 1, day, 0, 0, 0));
  const firstPass = new Date(guess.getTime() - getTimeZoneOffsetMillis(guess, timeZone));
  return new Date(guess.getTime() - getTimeZoneOffsetMillis(firstPass, timeZone));
}

function normalizeYearMonth(year, month) {
  const date = new Date(Date.UTC(year, month - 1, 1));
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
  };
}

function getTimeZoneOffsetMillis(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);

  const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  const asUtc = Date.UTC(
    Number(values.year),
    Number(values.month) - 1,
    Number(values.day),
    Number(values.hour) === 24 ? 0 : Number(values.hour),
    Number(values.minute),
    Number(values.second),
  );
  return asUtc - date.getTime();
}

function isLastDayOfMonth(date, timeZone) {
  const year = getPart(date, timeZone, "year");
  const month = getPart(date, timeZone, "month");
  const day = getPart(date, timeZone, "day");
  return day === new Date(year, month, 0).getDate();
}

function getPart(date, timeZone, part) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(date);
  return Number(parts.find((item) => item.type === part).value);
}

function monthName(month) {
  return MONTH_NAMES[month - 1] || "";
}

function toDate(value) {
  if (!value) {
    return null;
  }
  if (value instanceof Date) {
    return value;
  }
  if (typeof value.toDate === "function") {
    return value.toDate();
  }
  if (typeof value === "number") {
    return new Date(value);
  }
  if (typeof value === "string") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
}

function stringValue(value) {
  return value == null ? "" : String(value);
}

function numberValue(value) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

function monthNumberValue(value, fallbackMonth) {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric >= 1 && numeric <= 12) return numeric;
  const text = String(value ?? "").trim().toLowerCase();
  if (text) {
    const index = Array.from({length: 12}, (_, i) => monthName(i + 1).toLowerCase()).indexOf(text);
    if (index >= 0) return index + 1;
  }
  return Number(fallbackMonth) || "";
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function requireConfig(name, value) {
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function formatDate(value) {
  if (!value) {
    return "";
  }
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: config.timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(value);
}

function formatDateTime(value) {
  if (!value) {
    return "";
  }
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: config.timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(value);
}

function formatCurrency(value) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(value);
}
