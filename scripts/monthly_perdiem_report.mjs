import fs from "fs";
import path from "path";
import { google } from "googleapis";

const SPREADSHEET_ID = process.env.GOOGLE_SHEETS_SPREADSHEET_ID || "1mKjEd__zIoMJaa6CLmDE-wALGhtlG-USLTAiQBZnioc";
const SHEET_NAME = process.env.PERDIEM_SHEET_NAME || "Perdiem";
const SALARY_SPREADSHEET_ID = process.env.SALARY_SPREADSHEET_ID || "";
const SALARY_SHEET_NAME = process.env.SALARY_SHEET_NAME || "Salary";
const OUTPUT_DIR = process.env.PERDIEM_REPORT_DIR || "outputs";
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function requiredJsonEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return JSON.parse(value);
}

function kstNow() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000);
}

function defaultTargetMonthYear() {
  const now = kstNow();
  let year = now.getUTCFullYear();
  let month = now.getUTCMonth() + 1;

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
  const now = kstNow();
  return now.getUTCDate() === 1;
}

function monthToNumber(value) {
  const normalized = String(value ?? "").trim();
  if (!normalized) return null;
  const numeric = Number(normalized);
  if (Number.isFinite(numeric) && numeric >= 1 && numeric <= 12) return numeric;
  const index = MONTH_NAMES.findIndex(name => name.toLowerCase() === normalized.toLowerCase());
  return index >= 0 ? index + 1 : null;
}

function parseMoney(value) {
  const normalized = String(value ?? "").replace(/,/g, "").trim();
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function csvEscape(value) {
  const text = String(value ?? "");
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function toCsv(rows) {
  return rows.map(row => row.map(csvEscape).join(",")).join("\n");
}

function getColumn(row, index) {
  return index >= 0 ? row[index] ?? "" : "";
}

async function main() {
  const force = process.env.FORCE_PERDIEM_REPORT === "true" || process.env.GITHUB_EVENT_NAME === "workflow_dispatch";
  if (!force && !isKstMonthCloseRun()) {
    console.log("Not KST month-close day; skipping report.");
    return;
  }

  const target = defaultTargetMonthYear();
  const targetYear = Number(process.env.PERDIEM_TARGET_YEAR || target.year);
  const targetMonth = Number(process.env.PERDIEM_TARGET_MONTH || target.month);
  const monthName = MONTH_NAMES[targetMonth - 1];
  if (!monthName || !Number.isFinite(targetYear)) {
    throw new Error(`Invalid target month/year: ${targetMonth}/${targetYear}`);
  }

  const credentials = requiredJsonEnv("GOOGLE_SHEETS_CREDENTIALS");
  if (credentials.private_key) credentials.private_key = credentials.private_key.replace(/\\n/g, "\n");

  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const sheets = google.sheets({ version: "v4", auth });

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A:M`,
  });

  const values = response.data.values || [];
  if (values.length === 0) throw new Error(`${SHEET_NAME} sheet is empty`);

  const header = values[0];
  const index = Object.fromEntries(header.map((name, i) => [String(name).trim(), i]));
  const monthIndex = index.Month;
  const yearIndex = index.Year;
  const totalIndex = index.Total;
  const transportIndex = index.TransportFee;

  for (const [name, idx] of Object.entries({ Month: monthIndex, Year: yearIndex, Total: totalIndex, TransportFee: transportIndex })) {
    if (idx === undefined) throw new Error(`Missing ${name} column in ${SHEET_NAME}`);
  }

  const filteredRows = values.slice(1).filter(row => (
    monthToNumber(getColumn(row, monthIndex)) === targetMonth &&
    String(getColumn(row, yearIndex)).trim() === String(targetYear)
  ));

  const totalPerdiem = filteredRows.reduce((sum, row) => sum + parseMoney(getColumn(row, totalIndex)), 0);
  const totalTransportFee = filteredRows.reduce((sum, row) => sum + parseMoney(getColumn(row, transportIndex)), 0);
  const grandTotal = totalPerdiem + totalTransportFee;

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const baseName = `Perdiem_${monthName}_${targetYear}`;
  const csvPath = path.join(OUTPUT_DIR, `${baseName}.csv`);
  const summaryPath = path.join(OUTPUT_DIR, `${baseName}.json`);

  const summaryRows = [
    [],
    ["Summary"],
    ["Month", monthName],
    ["Year", targetYear],
    ["Rows", filteredRows.length],
    ["Total Perdiem", totalPerdiem.toFixed(2)],
    ["Transport Fee Total", totalTransportFee.toFixed(2)],
    ["Grand Total", grandTotal.toFixed(2)],
  ];
  const reportRows = [header, ...filteredRows, ...summaryRows];

  fs.writeFileSync(csvPath, `${toCsv(reportRows)}\n`, "utf-8");
  fs.writeFileSync(summaryPath, JSON.stringify({
    month: monthName,
    monthNumber: targetMonth,
    year: targetYear,
    rows: filteredRows.length,
    totalPerdiem,
    totalTransportFee,
    grandTotal,
    csvPath,
    fileBaseName: baseName,
  }, null, 2), "utf-8");

  if (SALARY_SPREADSHEET_ID) {
    await sheets.spreadsheets.values.clear({
      spreadsheetId: SALARY_SPREADSHEET_ID,
      range: `${SALARY_SHEET_NAME}!A:Z`,
    });
    await sheets.spreadsheets.values.update({
      spreadsheetId: SALARY_SPREADSHEET_ID,
      range: `${SALARY_SHEET_NAME}!A1`,
      valueInputOption: "RAW",
      requestBody: { values: reportRows },
    });
    console.log(`SALARY_SHEET_UPDATED=${SALARY_SPREADSHEET_ID}:${SALARY_SHEET_NAME}!A1`);
  } else {
    console.log("SALARY_SPREADSHEET_ID not set; skipping Salary sheet update.");
  }

  console.log(`PERDIEM_REPORT_CSV=${csvPath}`);
  console.log(`PERDIEM_REPORT_SUMMARY=${summaryPath}`);
  console.log(`PERDIEM_REPORT_FILE_BASE=${baseName}`);
  console.log(`PERDIEM_REPORT_ROWS=${filteredRows.length}`);
  console.log(`PERDIEM_TOTAL=${totalPerdiem.toFixed(2)}`);
  console.log(`TRANSPORT_FEE_TOTAL=${totalTransportFee.toFixed(2)}`);
  console.log(`GRAND_TOTAL=${grandTotal.toFixed(2)}`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
