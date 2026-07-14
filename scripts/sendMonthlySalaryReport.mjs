import {cert, getApps, initializeApp} from "firebase-admin/app";
import {FieldValue, Timestamp, getFirestore} from "firebase-admin/firestore";
import {google} from "googleapis";
import nodemailer from "nodemailer";
import {mkdir} from "node:fs/promises";
import path from "node:path";

const config = {
  timeZone: process.env.REPORT_TIME_ZONE || "Asia/Seoul",
  paymentsCollection: process.env.PAYMENTS_COLLECTION || "Payments",
  runLogCollection: process.env.RUN_LOG_COLLECTION || "salaryReportRuns",
  paymentDateField: process.env.PAYMENT_DATE_FIELD || "paymentDate",
  totalPayField: process.env.TOTAL_PAY_FIELD || "TotalPay",
  updatedAtField: process.env.UPDATED_AT_FIELD || "updatedAt",
  salarySpreadsheetId: process.env.SALARY_SPREADSHEET_ID || "",
  salaryWriteRange: process.env.SALARY_WRITE_RANGE || "Salary!A1",
  salaryClearRange: process.env.SALARY_CLEAR_RANGE || "",
  salaryMonthCell: process.env.SALARY_MONTH_CELL || "",
  salaryTotalCell: process.env.SALARY_TOTAL_CELL || "",
  dedupeKeyFields: (process.env.DEDUPE_KEY_FIELDS || "employeeId,payPeriod")
    .split(",")
    .map((field) => field.trim())
    .filter(Boolean),
};

initializeFirebase();

const db = getFirestore();
const args = parseArgs(process.argv.slice(2));
const now = new Date();
const target = args.month ? parseMonth(args.month) : {
  year: getPart(now, config.timeZone, "year"),
  month: getPart(now, config.timeZone, "month"),
};

if (!args.month && !args.force && !isLastDayOfMonth(now, config.timeZone)) {
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
    const totalPay = rows.reduce((sum, row) => sum + row.totalPay, 0);
    const fileName = `Salary_${monthName(month)}_${year}.xlsx`;
    const outputDir = path.join(process.cwd(), "artifacts", "salary-reports");
    const outputPath = path.join(outputDir, fileName);
    const googleAuth = createGoogleAuth();

    await mkdir(outputDir, {recursive: true});
    await updateSalarySheet({auth: googleAuth, year, month, rows, totalPay});
    await exportSalarySpreadsheet({auth: googleAuth, outputPath});
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

  const latestByKey = new Map();

  snapshot.forEach((doc) => {
    const data = doc.data();
    const row = normalizePaymentDoc(doc.id, data);
    const dedupeKey = buildDedupeKey(doc.id, data);
    const existing = latestByKey.get(dedupeKey);

    if (!existing || row.updatedAtMillis > existing.updatedAtMillis) {
      latestByKey.set(dedupeKey, row);
    }
  });

  return Array.from(latestByKey.values())
    .sort((a, b) => a.employeeId.localeCompare(b.employeeId) || a.paymentDateMillis - b.paymentDateMillis);
}

function normalizePaymentDoc(id, data) {
  const paymentDate = toDate(data[config.paymentDateField]);
  const updatedAt = toDate(data[config.updatedAtField]) || paymentDate || new Date(0);
  const totalPay = Number(data[config.totalPayField] || 0);

  return {
    id,
    employeeId: stringValue(data.employeeId),
    employeeName: stringValue(data.employeeName || data.name),
    payPeriod: stringValue(data.payPeriod),
    paymentDate,
    paymentDateMillis: paymentDate ? paymentDate.getTime() : 0,
    totalPay,
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
  const monthLabel = `${monthName(month)} ${year}`;
  const values = [
    ["Payment Doc ID", "Employee ID", "Employee Name", "Pay Period", "Payment Date", "TotalPay", "Updated At"],
    ...rows.map((row) => [
      row.id,
      row.employeeId,
      row.employeeName,
      row.payPeriod,
      formatDate(row.paymentDate),
      row.totalPay,
      formatDateTime(row.updatedAt),
    ]),
    ["", "", "", "Total", "", totalPay, ""],
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
}

async function exportSalarySpreadsheet({auth, outputPath}) {
  const spreadsheetId = requireConfig("SALARY_SPREADSHEET_ID", config.salarySpreadsheetId);
  const drive = google.drive({version: "v3", auth});
  const response = await drive.files.export(
    {
      fileId: spreadsheetId,
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    },
    {responseType: "arraybuffer"},
  );

  await import("node:fs/promises").then(({writeFile}) => writeFile(outputPath, Buffer.from(response.data)));
}

async function sendEmail({year, month, fileName, outputPath, rowCount, totalPay}) {
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
      `TotalPay: ${formatCurrency(totalPay)}`,
    ].join("\n"),
    attachments: [{filename: fileName, path: outputPath}],
  });
}

function initializeFirebase() {
  if (getApps().length) {
    return;
  }

  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    initializeApp({
      credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)),
    });
    return;
  }

  initializeApp();
}

function createGoogleAuth() {
  const credentials = JSON.parse(requireEnv("FIREBASE_SERVICE_ACCOUNT_JSON"));
  return new google.auth.GoogleAuth({
    credentials,
    scopes: [
      "https://www.googleapis.com/auth/spreadsheets",
      "https://www.googleapis.com/auth/drive.readonly",
    ],
  });
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
  return new Intl.DateTimeFormat("en-US", {month: "short"}).format(new Date(Date.UTC(2026, month - 1, 1)));
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
