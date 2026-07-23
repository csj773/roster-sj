import admin from "firebase-admin";

const PERDIEM_COLLECTION = "Perdiem";
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function requiredEnv(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function optionalEnv(name) {
  return String(process.env[name] || "").trim();
}

function parseJsonEnv(name) {
  const raw = requiredEnv(name)
    .replace(/^\uFEFF/, "")
    .replace(/[“”]/g, "\"")
    .replace(/[‘’]/g, "'")
    .replace(/-----BEGIN PRIVATE KEY[—–-]+/g, "-----BEGIN PRIVATE KEY-----")
    .replace(/[—–-]+END PRIVATE KEY[—–-]+/g, "-----END PRIVATE KEY-----");
  const parsed = JSON.parse(raw);
  if (parsed.private_key) parsed.private_key = parsed.private_key.replace(/\\n/g, "\n");
  return parsed;
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

function monthToNumber(value) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const numeric = Number(text);
  if (Number.isFinite(numeric) && numeric >= 1 && numeric <= 12) return numeric;
  const index = MONTH_NAMES.findIndex((name) => name.toLowerCase() === text.toLowerCase());
  return index >= 0 ? index + 1 : null;
}

function parseMoney(value) {
  const parsed = Number(String(value ?? "").replace(/,/g, "").trim());
  return Number.isFinite(parsed) ? parsed : 0;
}

function cleanText(value, maxLength = 200) {
  return String(value ?? "").trim().slice(0, maxLength);
}

function dateSortKey(value) {
  const match = String(value || "").match(/^(\d{4})[-.](\d{1,2})[-.](\d{1,2})$/);
  if (!match) return cleanText(value, 20);
  return `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
}

function targetMonthYear() {
  const fallback = defaultTargetMonthYear();
  const month = Number(optionalEnv("PERDIEM_TARGET_MONTH") || fallback.month);
  const year = Number(optionalEnv("PERDIEM_TARGET_YEAR") || fallback.year);
  if (!Number.isFinite(month) || month < 1 || month > 12) throw new Error(`Invalid target month: ${month}`);
  if (!Number.isFinite(year) || year < 2000) throw new Error(`Invalid target year: ${year}`);
  return { month, year };
}

function tableCell(value, width) {
  const text = cleanText(value, 80);
  return text.length >= width ? text.slice(0, width - 1) : text.padEnd(width, " ");
}

function reportTable(rows) {
  const header = ["Date", "Activity", "From", "Destination", "StayHours", "Rate", "Total", "TransportFee"];
  const widths = [10, 8, 4, 11, 9, 5, 8, 12];
  const formatRow = (values) => values.map((value, index) => tableCell(value, widths[index])).join("  ");
  const body = rows.map((row) => formatRow([
    row.Date,
    row.Activity,
    row.From,
    row.Destination,
    row.StayHours,
    Number(row.Rate || 0).toFixed(2),
    Number(row.Total || 0).toFixed(2),
    String(Math.round(Number(row.TransportFee || 0))),
  ]));
  return [formatRow(header), ...body].join("\n");
}

function formatKoreanMonth({ year, month }) {
  return `${year}년 ${month}월`;
}

function formatKstTimestamp(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date).replace(",", "");
}

async function postSlack(text) {
  const responseUrl = optionalEnv("SLACK_RESPONSE_URL");
  if (!responseUrl) {
    console.log(text);
    return;
  }

  const response = await fetch(responseUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      response_type: "ephemeral",
      text,
    }),
  });
  if (!response.ok) {
    throw new Error(`Slack response_url failed (${response.status}): ${await response.text()}`);
  }
}

async function main() {
  const ownerUid = requiredEnv("FIREBASE_UID");
  const displayName = optionalEnv("PERDIEM_USER_NAME") || ownerUid;
  const target = targetMonthYear();
  const monthName = MONTH_NAMES[target.month - 1];

  admin.initializeApp({
    credential: admin.credential.cert(parseJsonEnv("FIREBASE_SERVICE_ACCOUNT")),
  });

  const snapshot = await admin.firestore()
    .collection(PERDIEM_COLLECTION)
    .where("owner", "==", ownerUid)
    .get();

  const rows = snapshot.docs
    .map((doc) => doc.data())
    .filter((row) => monthToNumber(row.Month) === target.month)
    .filter((row) => String(row.Year || "").trim() === String(target.year))
    .map((row) => ({
      Date: cleanText(row.Date, 20),
      Activity: cleanText(row.Activity, 40),
      From: cleanText(row.From, 10),
      Destination: cleanText(row.Destination, 20),
      StayHours: cleanText(row.StayHours, 20),
      Rate: parseMoney(row.Rate),
      Total: parseMoney(row.Total),
      TransportFee: parseMoney(row.TransportFee),
    }))
    .sort((a, b) => `${dateSortKey(a.Date)}_${a.Activity}_${a.From}_${a.Destination}`.localeCompare(
      `${dateSortKey(b.Date)}_${b.Activity}_${b.From}_${b.Destination}`
    ));

  const totalPerdiem = rows.reduce((sum, row) => sum + row.Total, 0);
  const totalTransportFee = rows.reduce((sum, row) => sum + row.TransportFee, 0);
  const table = rows.length ? reportTable(rows) : "No PerDiem rows found.";
  const truncatedTable = table.length > 2500 ? `${table.slice(0, 2500)}\n...truncated` : table;
  const text = [
    `*${displayName}*`,
    `*${formatKoreanMonth(target)} PerDiem Report*`,
    "```",
    truncatedTable,
    "```",
    `${displayName}: ${formatKoreanMonth(target)} Prediem=${totalPerdiem.toFixed(2)}/Transport fee=${totalTransportFee.toFixed(0)}`,
    "",
    `created at: ${formatKstTimestamp()} KST`,
    `source: Firestore ${PERDIEM_COLLECTION}, Month=${monthName}, Year=${target.year}`,
  ].join("\n");

  await postSlack(text);
  console.log(`Posted Slack PerDiem report for ${ownerUid}: ${rows.length} row(s).`);
}

main().catch(async (error) => {
  const text = `Monthly PerDiem Slack report failed: ${error.message}`;
  try {
    await postSlack(text);
  } catch {
    // Keep the original failure visible in GitHub Actions.
  }
  console.error(error);
  process.exit(1);
});
