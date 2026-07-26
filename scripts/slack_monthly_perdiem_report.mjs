import process from "node:process";
import fs from "node:fs/promises";
import path from "node:path";
import admin from "firebase-admin";
import { WebClient } from "@slack/web-api";

/**
 * Slack Monthly PerDiem Report (CSV version)
 *
 * Slack command example:
 *   /perdiem-report sjchoi787@gmail.com jul
 *
 * Expected environment variables:
 *   FIREBASE_SERVICE_ACCOUNT
 *   SLACK_BOT_TOKEN
 *   SLACK_CHANNEL_ID
 *
 * Slash-command / workflow inputs:
 *   REPORT_OWNER_EMAIL=sjchoi787@gmail.com
 *   REPORT_MONTH=jul
 *   REPORT_YEAR=2026              (optional)
 *
 * Optional fallback:
 *   REPORT_OWNER_UID
 *   FIRESTORE_ADMIN_UID
 *   USER_COLLECTION=users
 *   PERDIEM_COLLECTION=Perdiem
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

  const year =
    parts.find((part) => part.type === "year")?.value || "";

  const month =
    parts.find((part) => part.type === "month")?.value || "";

  return {
    year: cleanString(year),
    month: normalizeMonth(month),
  };
}

function parseServiceAccount() {
  const raw = requiredEnv("FIREBASE_SERVICE_ACCOUNT");

  try {
    const credentials = JSON.parse(raw);

    if (credentials.private_key) {
      credentials.private_key =
        credentials.private_key.replace(/\\n/g, "\n");
    }

    return credentials;
  } catch (error) {
    throw new Error(
      `FIREBASE_SERVICE_ACCOUNT must contain valid JSON: ${error.message}`
    );
  }
}

function initializeFirestore() {
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(
        parseServiceAccount()
      ),
    });
  }

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
  const normalizedEmail =
    cleanString(email).toLowerCase();

  if (!normalizedEmail) {
    throw new Error("REPORT_OWNER_EMAIL is empty");
  }

  const userCollection =
    cleanString(process.env.USER_COLLECTION) || "users";

  console.log(`REPORT_OWNER_EMAIL=${normalizedEmail}`);
  console.log(`USER_COLLECTION=${userCollection}`);

  const exactSnapshot = await db
    .collection(userCollection)
    .where("email", "==", normalizedEmail)
    .limit(1)
    .get();

  if (!exactSnapshot.empty) {
    const ownerUid =
      resolveOwnerUidFromUserDocument(
        exactSnapshot.docs[0]
      );

    if (!ownerUid) {
      throw new Error(
        `Owner UID is missing for ${normalizedEmail}`
      );
    }

    return ownerUid;
  }

  // 기존 데이터에 이메일 대소문자가 섞인 경우를 위한 fallback
  const fallbackSnapshot = await db
    .collection(userCollection)
    .get();

  const matchedDoc = fallbackSnapshot.docs.find((doc) => {
    const data = doc.data() || {};

    return (
      cleanString(data.email).toLowerCase() ===
      normalizedEmail
    );
  });

  if (!matchedDoc) {
    throw new Error(
      `Firestore user not found for email: ${normalizedEmail}`
    );
  }

  const ownerUid =
    resolveOwnerUidFromUserDocument(matchedDoc);

  if (!ownerUid) {
    throw new Error(
      `Owner UID is missing for ${normalizedEmail}`
    );
  }

  return ownerUid;
}

async function resolveReportOwnerUid(db) {
  const reportOwnerUid = cleanString(
    process.env.REPORT_OWNER_UID
  );

  if (reportOwnerUid) {
    console.log("OWNER_SOURCE=REPORT_OWNER_UID");
    return reportOwnerUid;
  }

  const reportOwnerEmail = cleanString(
    process.env.REPORT_OWNER_EMAIL
  );

  if (reportOwnerEmail) {
    console.log("OWNER_SOURCE=REPORT_OWNER_EMAIL");

    return findOwnerUidByEmail(
      db,
      reportOwnerEmail
    );
  }

  const adminUid = cleanString(
    process.env.FIRESTORE_ADMIN_UID
  );

  if (adminUid) {
    console.log("OWNER_SOURCE=FIRESTORE_ADMIN_UID");
    return adminUid;
  }

  throw new Error(
    "REPORT_OWNER_UID, REPORT_OWNER_EMAIL, or FIRESTORE_ADMIN_UID is required"
  );
}

function resolveReportPeriod() {
  const current = getCurrentKstYearMonth();

  const reportYear =
    cleanString(process.env.REPORT_YEAR) ||
    current.year;

  const reportMonthInput =
    cleanString(process.env.REPORT_MONTH) ||
    current.month;

  const reportMonth =
    normalizeMonth(reportMonthInput);

  if (!/^\d{4}$/.test(reportYear)) {
    throw new Error(
      `REPORT_YEAR must be four digits: ${reportYear}`
    );
  }

  if (!reportMonth) {
    throw new Error(
      `Invalid REPORT_MONTH: ${reportMonthInput}`
    );
  }

  return {
    reportYear,
    reportMonth,
  };
}

function numberValue(value) {
  if (
    typeof value === "number" &&
    Number.isFinite(value)
  ) {
    return value;
  }

  const parsed = Number(
    cleanString(value).replace(/,/g, "")
  );

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
    To: cleanString(
      data.To || data.Destination
    ),
    RI: cleanString(data.RI),
    RO: cleanString(data.RO),
    StayHours: cleanString(data.StayHours),
    Rate: numberValue(data.Rate),
    Total: numberValue(data.Total),
    TransportFee: numberValue(
      data.TransportFee
    ),
    Month: normalizeMonth(data.Month),
    Year: cleanString(data.Year),
    owner: cleanString(data.owner),
  };
}

async function loadMonthlyRows(
  db,
  reportOwnerUid,
  reportYear,
  reportMonth
) {
  const collectionName =
    cleanString(
      process.env.PERDIEM_COLLECTION
    ) || "Perdiem";

  console.log(
    `PERDIEM_COLLECTION=${collectionName}`
  );
  console.log(
    `PERDIEM_QUERY_OWNER=${reportOwnerUid}`
  );

  const snapshot = await db
    .collection(collectionName)
    .where("owner", "==", reportOwnerUid)
    .get();

  const ownerRows = snapshot.docs.map(
    normalizePerDiemRow
  );

  console.log(
    `PERDIEM_OWNER_ROWS=${ownerRows.length}`
  );

  const monthlyRows = ownerRows
    .filter((row) => {
      return (
        String(row.Year || "").trim() ===
          String(reportYear) &&
        normalizeMonth(row.Month) ===
          normalizeMonth(reportMonth)
      );
    })
    .sort((a, b) => {
      const dateCompare =
        a.Date.localeCompare(b.Date);

      if (dateCompare !== 0) {
        return dateCompare;
      }

      return a.Activity.localeCompare(
        b.Activity
      );
    });

  console.log(
    `PERDIEM_MONTH_MATCHED_ROWS=${monthlyRows.length}`
  );

  return monthlyRows;
}

function escapeCsvValue(value) {
  const text = String(value ?? "");

  if (
    text.includes(",") ||
    text.includes('"') ||
    text.includes("\n") ||
    text.includes("\r")
  ) {
    return `"${text.replace(/"/g, '""')}"`;
  }

  return text;
}

function createCsv(rows) {
  const headers = [
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

  const lines = [
    headers.join(","),
    ...rows.map((row) =>
      [
        row.Date,
        row.Activity,
        row.From,
        row.Destination,
        row.To,
        row.RI,
        row.RO,
        row.StayHours,
        row.Rate,
        row.Total,
        row.TransportFee,
        row.Month,
        row.Year,
      ]
        .map(escapeCsvValue)
        .join(",")
    ),
  ];

  // Excel에서 한글 및 UTF-8 인식을 안정적으로 하기 위한 BOM
  return `\uFEFF${lines.join("\r\n")}\r\n`;
}

async function saveCsv(csvText, filename) {
  const outputDir =
    cleanString(process.env.OUTPUT_DIR) ||
    "output";

  await fs.mkdir(outputDir, {
    recursive: true,
  });

  const outputPath =
    path.join(outputDir, filename);

  await fs.writeFile(
    outputPath,
    csvText,
    "utf8"
  );

  console.log(`REPORT_FILE=${outputPath}`);

  return outputPath;
}

async function ensureSlackChannelMembership(
  slack,
  channelId
) {
  const auth = await slack.auth.test();

  console.log(
    `SLACK_TEAM_ID=${auth.team_id || ""}`
  );
  console.log(
    `SLACK_BOT_USER_ID=${auth.user_id || ""}`
  );
  console.log(
    `SLACK_CHANNEL_ID=${channelId}`
  );

  const info =
    await slack.conversations.info({
      channel: channelId,
    });

  const channel = info.channel;

  console.log(
    `SLACK_CHANNEL_NAME=${channel?.name || ""}`
  );
  console.log(
    `SLACK_BOT_IS_MEMBER=${Boolean(
      channel?.is_member
    )}`
  );

  if (channel?.is_member) {
    return;
  }

  if (channel?.is_private) {
    throw new Error(
      `Slack bot is not a member of private channel ${channelId}`
    );
  }

  try {
    await slack.conversations.join({
      channel: channelId,
    });

    console.log(
      `SLACK_CHANNEL_JOINED=${channelId}`
    );
  } catch (error) {
    if (
      error?.data?.error !==
      "already_in_channel"
    ) {
      throw error;
    }
  }
}

async function uploadCsvToSlack({
  csvText,
  filename,
  ownerEmail,
  reportYear,
  reportMonth,
  rows,
}) {
  const slackToken =
    requiredEnv("SLACK_BOT_TOKEN");

  const channelId =
    requiredEnv("SLACK_CHANNEL_ID");

  const slack =
    new WebClient(slackToken);

  await ensureSlackChannelMembership(
    slack,
    channelId
  );

  const totalPerDiem = rows.reduce(
    (sum, row) =>
      sum + numberValue(row.Total),
    0
  );

  const totalTransportFee = rows.reduce(
    (sum, row) =>
      sum +
      numberValue(row.TransportFee),
    0
  );

  const ownerLabel =
    ownerEmail || "UID owner";

  const initialComment = [
    `*${reportYear} ${reportMonth} PerDiem Report*`,
    `Owner: ${ownerLabel}`,
    `Rows: ${rows.length}`,
    `PerDiem: ${totalPerDiem.toLocaleString("ko-KR")}`,
    `Transport: ${totalTransportFee.toLocaleString("ko-KR")}원`,
  ].join("\n");

  await slack.filesUploadV2({
    channel_id: channelId,
    file: Buffer.from(csvText, "utf8"),
    filename,
    title:
      `${reportYear} ${reportMonth} Monthly PerDiem Report`,
    initial_comment: initialComment,
  });

  console.log(
    `SLACK_UPLOAD_COMPLETED=${filename}`
  );
}

async function main() {
  const db = initializeFirestore();

  const ownerEmail = cleanString(
    process.env.REPORT_OWNER_EMAIL
  ).toLowerCase();

  const reportOwnerUid =
    await resolveReportOwnerUid(db);

  const {
    reportYear,
    reportMonth,
  } = resolveReportPeriod();

  console.log(
    `REPORT_OWNER_UID=${reportOwnerUid}`
  );
  console.log(
    `REPORT_YEAR=${reportYear}`
  );
  console.log(
    `REPORT_MONTH=${reportMonth}`
  );

  const monthlyRows =
    await loadMonthlyRows(
      db,
      reportOwnerUid,
      reportYear,
      reportMonth
    );

  if (monthlyRows.length === 0) {
    throw new Error(
      `No PerDiem rows found: owner=${reportOwnerUid}, year=${reportYear}, month=${reportMonth}`
    );
  }

  const safeOwner = (
    ownerEmail || reportOwnerUid
  ).replace(
    /[^a-z0-9._-]+/gi,
    "_"
  );

  const filename =
    `perdiem-${safeOwner}-${reportYear}-${reportMonth}.csv`;

  const csvText =
    createCsv(monthlyRows);

  await saveCsv(csvText, filename);

  await uploadCsvToSlack({
    csvText,
    filename,
    ownerEmail,
    reportYear,
    reportMonth,
    rows: monthlyRows,
  });
}

main().catch((error) => {
  console.error(
    "Monthly PerDiem report failed:",
    error
  );

  process.exitCode = 1;
});




