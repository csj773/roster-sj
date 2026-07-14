import admin from "firebase-admin";
import ExcelJS from "exceljs";
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
  dedupeKeyFields: (process.env.DEDUPE_KEY_FIELDS || "employeeId,payPeriod")
    .split(",")
    .map((field) => field.trim())
    .filter(Boolean),
};

initializeFirebase();

const db = admin.firestore();
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
        startedAt: admin.firestore.FieldValue.serverTimestamp(),
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

    await mkdir(outputDir, {recursive: true});
    await buildWorkbook({year, month, rows, totalPay, outputPath});
    await sendEmail({year, month, fileName, outputPath, rowCount: rows.length, totalPay});

    await runRef.set({
      status: "sent",
      sentAt: admin.firestore.FieldValue.serverTimestamp(),
      fileName,
      rowCount: rows.length,
      totalPay,
      runner: "github-actions",
    }, {merge: true});

    return {reportKey, fileName, outputPath, rowCount: rows.length, totalPay};
  } catch (error) {
    await runRef.set({
      status: "failed",
      failedAt: admin.firestore.FieldValue.serverTimestamp(),
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
    .where(config.paymentDateField, ">=", admin.firestore.Timestamp.fromDate(start))
    .where(config.paymentDateField, "<", admin.firestore.Timestamp.fromDate(end))
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

async function buildWorkbook({year, month, rows, totalPay, outputPath}) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "roster-sj salary workflow";
  workbook.created = new Date();

  const summary = workbook.addWorksheet("Summary");
  summary.columns = [
    {header: "Metric", key: "metric", width: 24},
    {header: "Value", key: "value", width: 24},
  ];
  summary.addRows([
    {metric: "Report Month", value: `${monthName(month)} ${year}`},
    {metric: "Unique Payment Rows", value: rows.length},
    {metric: "TotalPay", value: totalPay},
    {metric: "Dedupe Key Fields", value: config.dedupeKeyFields.join(", ")},
  ]);
  summary.getCell("B3").numFmt = "$#,##0.00";
  styleHeader(summary.getRow(1));

  const payments = workbook.addWorksheet("Payments");
  payments.columns = [
    {header: "Payment Doc ID", key: "id", width: 32},
    {header: "Employee ID", key: "employeeId", width: 18},
    {header: "Employee Name", key: "employeeName", width: 24},
    {header: "Pay Period", key: "payPeriod", width: 18},
    {header: "Payment Date", key: "paymentDate", width: 16},
    {header: "TotalPay", key: "totalPay", width: 16},
    {header: "Updated At", key: "updatedAt", width: 22},
  ];

  payments.addRows(rows.map((row) => ({
    id: row.id,
    employeeId: row.employeeId,
    employeeName: row.employeeName,
    payPeriod: row.payPeriod,
    paymentDate: row.paymentDate,
    totalPay: row.totalPay,
    updatedAt: row.updatedAt,
  })));

  styleHeader(payments.getRow(1));
  payments.getColumn("paymentDate").numFmt = "yyyy-mm-dd";
  payments.getColumn("updatedAt").numFmt = "yyyy-mm-dd hh:mm";
  payments.getColumn("totalPay").numFmt = "$#,##0.00";
  payments.views = [{state: "frozen", ySplit: 1}];
  payments.autoFilter = "A1:G1";

  const totalRow = payments.addRow({payPeriod: "Total", totalPay});
  totalRow.font = {bold: true};
  totalRow.getCell("totalPay").numFmt = "$#,##0.00";

  await workbook.xlsx.writeFile(outputPath);
}

function styleHeader(row) {
  row.font = {bold: true, color: {argb: "FFFFFFFF"}};
  row.fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: {argb: "FF1F4E79"},
  };
  row.alignment = {vertical: "middle"};
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
    to: requireEnv("MAIL_TO"),
    subject: `Salary Report - ${monthLabel}`,
    text: [
      `Attached is the salary report for ${monthLabel}.`,
      "",
      `Unique payment rows: ${rowCount}`,
      `TotalPay: ${formatCurrency(totalPay)}`,
    ].join("\n"),
    attachments: [{filename: fileName, path: outputPath}],
  });
}

function initializeFirebase() {
  if (admin.apps.length) {
    return;
  }

  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    admin.initializeApp({
      credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)),
    });
    return;
  }

  admin.initializeApp();
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

function formatCurrency(value) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(value);
}
