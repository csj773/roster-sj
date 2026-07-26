import process from "node:process";
import fs from "node:fs/promises";
import path from "node:path";
import admin from "firebase-admin";
import { WebClient } from "@slack/web-api";
import * as XLSX from "xlsx";

/**
 * Slack Monthly PerDiem Report
 *
 * Slack command example:
 *   /perdiem-report sjchoi787@gmail.com jul
 *
 * Expected GitHub Actions environment variables:
 *   FIREBASE_SERVICE_ACCOUNT
 *   SLACK_BOT_TOKEN
 *   SLACK_CHANNEL_ID
 *
 * Slash-command / workflow inputs:
 *   REPORT_OWNER_EMAIL=sjchoi787@gmail.com
 *   REPORT_MONTH=jul
 *   REPORT_YEAR=2026                (optional; current KST year if omitted)
 *
 * Optional fallback:
 *   REPORT_OWNER_UID
 *   FIRESTORE_ADMIN_UID
 *   PERDIEM_COLLECTION=Perdiem
 *   USER_COLLECTION=users
 *   OUTPUT_DIR=output
 */

function cleanString(value) {
  return String(value ?? "").trim();
}

function requiredEnv(name) {
  const value = cleanString(process.env[name]);
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function normalizeMonth(value) {
  const input = cleanString(value).toLowerCase();

  const monthMap = {
    "1": "Jan",
    "01": "Jan",
    jan: "Jan",
    january: "Jan",

    "2": "Feb",
    "02": "Feb",
    feb: "Feb",
    february: "Feb",

    "3": "Mar",
    "03": "Mar",
    mar: "Mar",
    march: "Mar",

    "4": "Apr",
    "04": "Apr",
    apr: "Apr",
    april: "Apr",

    "5": "May",
    "05": "May",
    may: "May",

    "6": "Jun",
    "06": "Jun",
    jun: "Jun",
    june: "Jun",

    "7": "Jul",
    "07": "Jul",
    jul: "Jul",
    july: "Jul",

    "8": "Aug",
    "08": "Aug",
    aug: "Aug",
    august: "Aug",

    "9": "Sep",
    "09": "Sep",
    sep: "Sep",
    sept: "Sep",
    september: "Sep",

    "10": "Oct",
    oct: "Oct",
    october: "Oct",

    "11": "Nov",
    nov: "Nov",
    november: "Nov",

    "12": "Dec",
    dec: "Dec",
    december: "Dec",
  };

  return monthMap[input] || "";
}

function getCurrentKstYearMonth() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "short",
  }).formatToParts(new Date());

  return {
    year: cleanString(
      parts.find((part) => part.type === "year")?.value
    ),
    month: normalizeMonth(
      parts.find((part) => part.type === "month")?.value
    ),
  };
}

function parseServiceAccount() {
  const raw = requiredEnv("FIREBASE_SERVICE_ACCOUNT");

  try {
    const credentials = JSON.parse(raw);

    if (credentials.private_key) {
      credentials.private_key = credentials.private_key.replace(
        /\\n/g,
        "\n"
      );
    }

    console.log(
      "Using Firebase credentials from FIREBASE_SERVICE_ACCOUNT"
    );

    return credentials;
  } catch (error) {
    throw new Error(
      `FIREBASE_SERVICE_ACCOUNT must contain valid JSON: ${error.message}`
    );
  }
}

function initializeFirebase() {
  if (admin.apps.length > 0) {
    return admin.firestore();
  }

  admin.initializeApp({
    credential: admin.credential.cert(parseServiceAccount()),
  });

  return admin.firestore();
}

function resolveOwnerUidFromUserDocument(userDoc) {
  const data = userDoc.data() || {};

  return cleanString(
    data.firebaseUid ||
      data.uid ||
      data.userId ||
      data.owner ||
      userDoc.id
  );
}

async function findOwnerUidByEmail(db, email) {
  const normalizedEmail = cleanString(email).toLowerCase();
  const userCollection =
    cleanString(process.env.USER_COLLECTION) || "users";

  if (!normalizedEmail) {
    throw new Error("REPORT_OWNER_EMAIL is empty");
  }

  console.log(`REPORT_OWNER_EMAIL=${normalizedEmail}`);
  console.log(`USER_COLLECTION=${userCollection}`);

  // 우선 소문자 email 정확 일치 쿼리
  const exactSnapshot = await db
    .collection(userCollection)
    .where("email", "==", normalizedEmail)
    .limit(1)
    .get();

  if (!exactSnapshot.empty) {
    const ownerUid = resolveOwnerUidFromUserDocument(
      exactSnapshot.docs[0]
    );

    if (!ownerUid) {
      throw new Error(
        `Owner UID is missing for ${normalizedEmail}`
      );
    }

    return ownerUid;
  }

  // 기존 데이터의 email 대소문자 혼용 대응
  const fallbackSnapshot = await db
    .collection(userCollection)
    .get();

  const matchedDoc = fallbackSnapshot.docs.find((doc) => {
    const data = doc.data() || {};
    return (
      cleanString(data.email).toLowerCase() === normalizedEmail
    );
  });

  if (!matchedDoc) {
    throw new Error(
      `Firestore user not found for email: ${normalizedEmail}`
    );
  }

  const ownerUid = resolveOwnerUidFromUserDocument(matchedDoc);

  if (!ownerUid) {
    throw new Error(
      `Owner UID is missing for ${normalizedEmail}`
    );
  }

  return ownerUid;
}

async function resolveReportOwnerUid(db) {
  const explicitOwnerUid = cleanString(
    process.env.REPORT_OWNER_UID
  );

  if (explicitOwnerUid) {
    console.log("OWNER_SOURCE=REPORT_OWNER_UID");
    return explicitOwnerUid;
  }

  const ownerEmail = cleanString(
    process.env.REPORT_OWNER_EMAIL
  );

  if (ownerEmail) {
    console.log("OWNER_SOURCE=REPORT_OWNER_EMAIL");
    return findOwnerUidByEmail(db, ownerEmail);
  }

  const fallbackUid = cleanString(
    process.env.FIRESTORE_ADMIN_UID
  );

  if (fallbackUid) {
    console.log("OWNER_SOURCE=FIRESTORE_ADMIN_UID");
    return fallbackUid;
  }

  throw new Error(
    "REPORT_OWNER_UID, REPORT_OWNER_EMAIL, or FIRESTORE_ADMIN_UID is required"
  );
}

function resolveReportPeriod() {
  const current = getCurrentKstYearMonth();

  const year =
    cleanString(process.env.REPORT_YEAR) || current.year;

  const monthInput =
    cleanString(process.env.REPORT_MONTH) || current.month;

  const month = normalizeMonth(monthInput);

  if (!/^\d{4}$/.test(year)) {
    throw new Error(
      `REPORT_YEAR must be four digits: ${year}`
    );
  }

  if (!month) {
    throw new Error(
      `Invalid REPORT_MONTH: ${monthInput}. Example: Jul, july, 7, or 07`
    );
  }

  return { year, month };
}

function numberValue(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  const normalized = cleanString(value).replace(/,/g, "");
  const parsed = Number(normalized);

  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizePerDiemRow(doc) {
  const data = doc.data() || {};

  return {
    id: doc.id,
    Date: cleanString(data.Date),
    Activity: cleanString(data.Activity),
    From: cleanString(data.From),
    Destination: cleanString(
      data.Destination || data.To
    ),
    To: cleanString(data.To || data.Destination),
    RI: cleanString(data.RI),
    RO: cleanString(data.RO),
    StayHours: cleanString(data.StayHours),
    Rate: numberValue(data.Rate),
    Total: numberValue(data.Total),
    TransportFee: numberValue(data.TransportFee),
    Month: normalizeMonth(data.Month),
    Year: cleanString(data.Year),
    owner: cleanString(data.owner),
  };
}

async function loadMonthlyPerDiemRows(
  db,
  ownerUid,
  reportYear,
  reportMonth
) {
  const collectionName =
    cleanString(process.env.PERDIEM_COLLECTION) ||
    "Perdiem";

  console.log(`PERDIEM_COLLECTION=${collectionName}`);
  console.log(`PERDIEM_QUERY_OWNER=${ownerUid}`);
  console.log(`REPORT_YEAR=${reportYear}`);
  console.log(`REPORT_MONTH=${reportMonth}`);

  // owner 조건은 Firestore에서 직접 수행한다.
  // Year/Month는 기존 데이터 타입 차이를 허용하기 위해 JS에서 정규화한다.
  const snapshot = await db
    .collection(collectionName)
    .where("owner", "==", ownerUid)
    .get();

  console.log(`PERDIEM_OWNER_ROWS=${snapshot.size}`);

  const ownerRows = snapshot.docs.map(normalizePerDiemRow);

  const monthlyRows = ownerRows
    .filter((row) => {
      return (
        row.Year === String(reportYear) &&
        row.Month === reportMonth
      );
    })
    .sort((a, b) => {
      const dateCompare = a.Date.localeCompare(b.Date);
      if (dateCompare !== 0) {
        return dateCompare;
      }
      return a.Activity.localeCompare(b.Activity);
    });

  console.log(
    `PERDIEM_MONTH_MATCHED_ROWS=${monthlyRows.length}`
  );

  return monthlyRows;
}

function createExcelBuffer(rows, metadata) {
  const columns = [
    "Date",
    "Activity",
    "From",
    "Destination",
    "To",
    "RI",
    "RO",
    "StayHours",
    "Rate",
    "Total",
    "TransportFee",
    "Month",
    "Year",
  ];

  const reportRows = rows.map((row) => ({
    Date: row.Date,
    Activity: row.Activity,
    From: row.From,
    Destination: row.Destination,
    To: row.To,
    RI: row.RI,
    RO: row.RO,
    StayHours: row.StayHours,
    Rate: row.Rate,
    Total: row.Total,
    TransportFee: row.TransportFee,
    Month: row.Month,
    Year: row.Year,
  }));

  const totalPerDiem = reportRows.reduce(
    (sum, row) => sum + numberValue(row.Total),
    0
  );

  const totalTransportFee = reportRows.reduce(
    (sum, row) => sum + numberValue(row.TransportFee),
    0
  );

  const workbook = XLSX.utils.book_new();

  const worksheet = XLSX.utils.json_to_sheet(reportRows, {
    header: columns,
  });

  worksheet["!cols"] = [
    { wch: 12 },
    { wch: 14 },
    { wch: 10 },
    { wch: 14 },
    { wch: 10 },
    { wch: 12 },
    { wch: 12 },
    { wch: 12 },
    { wch: 10 },
    { wch: 14 },
    { wch: 16 },
    { wch: 10 },
    { wch: 8 },
  ];

  const summaryRows = [
    ["Report owner email", metadata.ownerEmail || ""],
    ["Report owner UID", metadata.ownerUid],
    ["Year", metadata.year],
    ["Month", metadata.month],
    ["Rows", reportRows.length],
    ["PerDiem total", totalPerDiem],
    ["Transport total", totalTransportFee],
    ["Grand total", totalPerDiem + totalTransportFee],
  ];

  const summarySheet =
    XLSX.utils.aoa_to_sheet(summaryRows);

  summarySheet["!cols"] = [
    { wch: 22 },
    { wch: 36 },
  ];

  XLSX.utils.book_append_sheet(
    workbook,
    worksheet,
    "PerDiem"
  );

  XLSX.utils.book_append_sheet(
    workbook,
    summarySheet,
    "Summary"
  );

  return {
    buffer: XLSX.write(workbook, {
      type: "buffer",
      bookType: "xlsx",
    }),
    totalPerDiem,
    totalTransportFee,
  };
}

async function saveReportFile(buffer, filename) {
  const outputDir =
    cleanString(process.env.OUTPUT_DIR) || "output";

  await fs.mkdir(outputDir, { recursive: true });

  const outputPath = path.join(outputDir, filename);
  await fs.writeFile(outputPath, buffer);

  console.log(`REPORT_FILE=${outputPath}`);

  return outputPath;
}

async function ensureSlackChannelMembership(
  slack,
  channelId
) {
  const auth = await slack.auth.test();

  console.log(`SLACK_WORKSPACE=${auth.team || "(unknown)"}`);
  console.log(`SLACK_TEAM_ID=${auth.team_id || "(unknown)"}`);
  console.log(
    `SLACK_BOT_USER_ID=${auth.user_id || "(unknown)"}`
  );
  console.log(`SLACK_CHANNEL_ID=${channelId}`);

  const info = await slack.conversations.info({
    channel: channelId,
  });

  const channel = info.channel;

  console.log(
    `SLACK_CHANNEL_NAME=${channel?.name || "(unknown)"}`
  );
  console.log(
    `SLACK_CHANNEL_PRIVATE=${Boolean(channel?.is_private)}`
  );
  console.log(
    `SLACK_BOT_IS_MEMBER=${Boolean(channel?.is_member)}`
  );

  if (channel?.is_member) {
    return;
  }

  if (channel?.is_private) {
    throw new Error(
      `Slack Bot is not a member of private channel ${channelId}. ` +
        "Add the Roster Share app to that channel manually."
    );
  }

  try {
    await slack.conversations.join({
      channel: channelId,
    });

    console.log(`SLACK_CHANNEL_JOINED=${channelId}`);
  } catch (error) {
    const slackError = error?.data?.error;

    if (slackError !== "already_in_channel") {
      throw error;
    }
  }
}

async function sendSlackReport({
  excelBuffer,
  filename,
  ownerEmail,
  year,
  month,
  rowCount,
  totalPerDiem,
  totalTransportFee,
}) {
  const token = requiredEnv("SLACK_BOT_TOKEN");
  const channelId = requiredEnv("SLACK_CHANNEL_ID");

  const slack = new WebClient(token);

  await ensureSlackChannelMembership(slack, channelId);

  const ownerLabel = ownerEmail || "UID owner";
  const grandTotal =
    totalPerDiem + totalTransportFee;

  const initialComment = [
    `*${year} ${month} PerDiem Report*`,
    `Owner: ${ownerLabel}`,
    `Rows: ${rowCount}`,
    `PerDiem: ${totalPerDiem.toLocaleString("ko-KR")}`,
    `Transport: ${totalTransportFee.toLocaleString("ko-KR")}원`,
    `Grand total: ${grandTotal.toLocaleString("ko-KR")}원`,
  ].join("\n");

  await slack.filesUploadV2({
    channel_id: channelId,
    file: excelBuffer,
    filename,
    title: `${year} ${month} Monthly PerDiem Report`,
    initial_comment: initialComment,
  });

  console.log(`SLACK_UPLOAD_COMPLETED=${filename}`);
}

async function main() {
  const db = initializeFirebase();
  const ownerEmail = cleanString(
    process.env.REPORT_OWNER_EMAIL
  ).toLowerCase();

  const ownerUid = await resolveReportOwnerUid(db);
  const { year, month } = resolveReportPeriod();

  const rows = await loadMonthlyPerDiemRows(
    db,
    ownerUid,
    year,
    month
  );

  if (rows.length === 0) {
    throw new Error(
      `No PerDiem data found for owner=${ownerUid}, year=${year}, month=${month}`
    );
  }

  const safeOwner = ownerEmail
    ? ownerEmail.replace(/[^a-z0-9._-]+/gi, "_")
    : ownerUid.replace(/[^a-z0-9._-]+/gi, "_");

  const filename =
    `perdiem-${safeOwner}-${year}-${month}.xlsx`;

  const {
    buffer,
    totalPerDiem,
    totalTransportFee,
  } = createExcelBuffer(rows, {
    ownerEmail,
    ownerUid,
    year,
    month,
  });

  await saveReportFile(buffer, filename);

  await sendSlackReport({
    excelBuffer: buffer,
    filename,
    ownerEmail,
    year,
    month,
    rowCount: rows.length,
    totalPerDiem,
    totalTransportFee,
  });
}

main().catch((error) => {
  console.error(
    "Monthly PerDiem report failed:",
    error
  );
  process.exitCode = 1;
});




