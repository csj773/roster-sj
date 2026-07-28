import admin from "firebase-admin";
import fs from "node:fs/promises";
import path from "node:path";

const PERDIEM_COLLECTION = process.env.PERDIEM_COLLECTION || "Perdiem";
const OUTPUT_DIR = process.env.PERDIEM_OUTPUT_DIR || "outputs";
const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

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

function cleanText(value, maxLength = 500) {
  return String(value || "").trim().slice(0, maxLength);
}

function normalizeEmail(value) {
  return cleanText(value, 240).toLowerCase();
}

function normalizeMonth(value) {
  const text = cleanText(value, 20);
  const numeric = Number(text);
  if (numeric >= 1 && numeric <= 12) return MONTH_NAMES[numeric - 1];
  return MONTH_NAMES.find(
    (name) => name.toLowerCase() === text.slice(0, 3).toLowerCase()
  ) || "";
}

function numberValue(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function csvEscape(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function safeFilePart(value) {
  return cleanText(value || "user", 240)
    .replace("@", "_")
    .replace(/[^a-zA-Z0-9._-]+/g, "_");
}

function getTargetPeriod() {
  const monthText = optionalEnv("PERDIEM_TARGET_MONTH");
  const yearText = optionalEnv("PERDIEM_TARGET_YEAR");

  const inputMonth = monthText ? Number(monthText) : 0;
  const inputYear = yearText ? Number(yearText) : 0;

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "numeric",
  }).formatToParts(new Date());

  const currentYear = Number(
    parts.find((part) => part.type === "year")?.value
  );
  const currentMonth = Number(
    parts.find((part) => part.type === "month")?.value
  );

  // 월이나 연도를 직접 입력한 경우
  if (monthText || yearText) {
    const month = inputMonth || currentMonth;
    const year = inputYear || currentYear;

    if (!Number.isInteger(month) || month < 1 || month > 12) {
      throw new Error(`Invalid PERDIEM_TARGET_MONTH: ${monthText}`);
    }

    if (!Number.isInteger(year) || year < 2000 || year > 2200) {
      throw new Error(`Invalid PERDIEM_TARGET_YEAR: ${yearText}`);
    }

    return { month, year };
  }

  // 아무것도 입력하지 않으면 KST 기준 이전 달
  const target = new Date(
    Date.UTC(currentYear, currentMonth - 2, 1)
  );

  return {
    year: target.getUTCFullYear(),
    month: target.getUTCMonth() + 1,
  };
}

async function resolveOrCreateOwner(auth) {
  const requestedUid = cleanText(
    optionalEnv("REPORT_OWNER_UID") ||
    optionalEnv("PERDIEM_OWNER") ||
    optionalEnv("PERDIEM_USER_ID") ||
    optionalEnv("FIREBASE_UID")
  );
  const email = normalizeEmail(
    optionalEnv("REPORT_OWNER_EMAIL") ||
    optionalEnv("PERDIEM_USER_EMAIL")
  );
  const displayName = cleanText(optionalEnv("PERDIEM_USER_NAME"), 200);

  if (!email && !requestedUid) {
    throw new Error(
      "REPORT_OWNER_UID/PERDIEM_OWNER/FIREBASE_UID or REPORT_OWNER_EMAIL/PERDIEM_USER_EMAIL is required for Firebase user resolution"
    );
  }

  let userRecord = null;

  if (
    requestedUid &&
    !requestedUid.includes("@") &&
    !requestedUid.startsWith("guest_email_")
  ) {
    try {
      userRecord = await auth.getUser(requestedUid);
    } catch (error) {
      if (error.code !== "auth/user-not-found") {
        throw error;
      }
      console.warn(`Firebase UID not found for PerDiem report: ${requestedUid}`);
    }

    if (userRecord) {
      const authEmail = normalizeEmail(userRecord.email);
      if (email && authEmail && authEmail !== email) {
        throw new Error(
          `Firebase UID/email mismatch: ${requestedUid} belongs to ${authEmail}, not ${email}`
        );
      }
      return {
        uid: userRecord.uid,
        email: authEmail || email,
        displayName: displayName || cleanText(userRecord.displayName, 200) || authEmail || email || requestedUid,
        created: false,
        resolvedBy: "uid",
      };
    }
  }

  if (!email) {
    throw new Error(
      `No valid email was provided and Firebase UID was not found: ${requestedUid || "blank"}`
    );
  }

  try {
    userRecord = await auth.getUserByEmail(email);
  } catch (error) {
    if (error.code !== "auth/user-not-found") throw error;
  }

  if (userRecord) {
    if (displayName && displayName !== userRecord.displayName) {
      userRecord = await auth.updateUser(userRecord.uid, { displayName });
    }
    return {
      uid: userRecord.uid,
      email: normalizeEmail(userRecord.email) || email,
      displayName: cleanText(userRecord.displayName, 200) || displayName || email,
      created: false,
      resolvedBy: "email",
    };
  }

  userRecord = await auth.createUser({
    email,
    emailVerified: false,
    disabled: false,
    ...(displayName ? { displayName } : {}),
  });

  return {
    uid: userRecord.uid,
    email: normalizeEmail(userRecord.email) || email,
    displayName: cleanText(userRecord.displayName, 200) || displayName || email,
    created: true,
    resolvedBy: "created",
  };
}

function dedupeRows(rows) {
  const map = new Map();

  for (const row of rows) {
    const key = [
      cleanText(row.Date),
      cleanText(row.Activity),
      cleanText(row.From).toUpperCase(),
      cleanText(row.To || row.Destination).toUpperCase(),
    ].join("|");

    const current = map.get(key);
    if (!current) {
      map.set(key, row);
      continue;
    }

    const currentScore = [
      current.RI, current.RO, current.StayHours, current.Total,
    ].filter((value) => cleanText(value)).length;
    const candidateScore = [
      row.RI, row.RO, row.StayHours, row.Total,
    ].filter((value) => cleanText(value)).length;

    if (candidateScore >= currentScore) map.set(key, row);
  }

  return [...map.values()];
}

async function postSlackResponse(text) {
  const responseUrl = optionalEnv("SLACK_RESPONSE_URL");
  if (!responseUrl) return;

  const response = await fetch(responseUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      response_type: "ephemeral",
      replace_original: false,
      text,
    }),
  });

  if (!response.ok) {
    console.warn(`Slack response_url failed: HTTP ${response.status}`);
  }
}

async function uploadSlackFile(filePath, title, initialComment) {
  const token = optionalEnv("SLACK_BOT_TOKEN");
  const channelId = optionalEnv("SLACK_CHANNEL_ID");

  if (!token || !channelId) {
    console.log("Slack upload skipped: SLACK_BOT_TOKEN or SLACK_CHANNEL_ID is missing");
    return;
  }

  const file = await fs.readFile(filePath);
  const filename = path.basename(filePath);

  const urlResponse = await fetch(
    "https://slack.com/api/files.getUploadURLExternal",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        filename,
        length: String(file.length),
      }),
    }
  );

  const urlResult = await urlResponse.json();
  if (!urlResult.ok) {
    throw new Error(`Slack files.getUploadURLExternal failed: ${urlResult.error}`);
  }

  const binaryResponse = await fetch(urlResult.upload_url, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: file,
  });
  if (!binaryResponse.ok) {
    throw new Error(`Slack binary upload failed: HTTP ${binaryResponse.status}`);
  }

  const completeResponse = await fetch(
    "https://slack.com/api/files.completeUploadExternal",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        files: [{ id: urlResult.file_id, title }],
        channel_id: channelId,
        initial_comment: initialComment,
      }),
    }
  );

  const completeResult = await completeResponse.json();
  if (!completeResult.ok) {
    throw new Error(`Slack files.completeUploadExternal failed: ${completeResult.error}`);
  }
}

async function main() {
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(parseJsonEnv("FIREBASE_SERVICE_ACCOUNT")),
    });
  }

  const db = admin.firestore();
  const owner = await resolveOrCreateOwner(admin.auth());
  const { year, month } = getTargetPeriod();
  const targetMonth = MONTH_NAMES[month - 1];

  console.log(`OWNER_MODE=FIREBASE_AUTH_AUTO_CREATE`);
  console.log(`OWNER_RESOLUTION=${owner.resolvedBy}`);
  console.log(`FIREBASE_USER_CREATED=${owner.created}`);
  console.log(`REPORT_OWNER_UID=${owner.uid}`);
  console.log(`REPORT_OWNER_EMAIL=${owner.email}`);
  console.log(`TARGET_MONTH=${targetMonth}`);
  console.log(`TARGET_YEAR=${year}`);

  // 최종 Firestore 구조:
  // Perdiem/{ownerUid}/events/{eventId}
  const ownerRef = db
    .collection(PERDIEM_COLLECTION)
    .doc(owner.uid);

  const eventsRef = ownerRef.collection("events");
  const snapshot = await eventsRef.get();

  const ownerRows = snapshot.docs.map((doc) => {
    const data = doc.data();
    return {
      id: doc.id,
      ...data,
      owner: data.owner || owner.uid,
      uid: data.uid || owner.uid,
      email: data.email || owner.email,
    };
  });

  console.log(`PERDIEM_STORAGE_PATH=${PERDIEM_COLLECTION}/${owner.uid}/events`);

  const monthRows = ownerRows.filter((row) =>
    Number(row.Year) === year &&
    normalizeMonth(row.Month) === targetMonth
  );

  const rows = dedupeRows(monthRows).sort((left, right) =>
    `${cleanText(left.Date)}|${cleanText(left.Activity)}`.localeCompare(
      `${cleanText(right.Date)}|${cleanText(right.Activity)}`
    )
  );

  const duplicatesRemoved = monthRows.length - rows.length;
  const totalPerDiem = rows.reduce(
    (sum, row) => sum + numberValue(row.Total),
    0
  );
  const transportFeeTotal = rows.reduce(
    (sum, row) => sum + numberValue(row.TransportFee),
    0
  );

  const headers = [
    "Date", "Activity", "From", "Destination", "To", "RI", "RO",
    "StayHours", "Rate", "Total", "TransportFee", "Month", "Year",
    "owner", "email",
  ];

  const csvLines = [
    headers.join(","),
    ...rows.map((row) =>
      headers.map((header) => csvEscape(row[header] ?? "")).join(",")
    ),
  ];

  await fs.mkdir(OUTPUT_DIR, { recursive: true });

  const fileBase =
    `Perdiem_${safeFilePart(owner.email || owner.uid)}_${targetMonth}_${year}`;
  const csvPath = path.join(OUTPUT_DIR, `${fileBase}.csv`);
  const jsonPath = path.join(OUTPUT_DIR, `${fileBase}.json`);

  await fs.writeFile(csvPath, `\uFEFF${csvLines.join("\n")}`, "utf8");
  await fs.writeFile(
    jsonPath,
    JSON.stringify({
      user: owner.email || owner.uid,
      ownerUid: owner.uid,
      storagePath: `${PERDIEM_COLLECTION}/${owner.uid}/events`,
      ownerResolution: owner.resolvedBy,
      firebaseUserCreated: owner.created,
      rowsBeforeDedupe: monthRows.length,
      rows: rows.length,
      duplicatesRemoved,
      totalPerDiem: Number(totalPerDiem.toFixed(2)),
      transportFeeTotal,
      targetMonth,
      targetYear: year,
    }, null, 2),
    "utf8"
  );

  const summary = [
    `User: ${owner.email || owner.uid}`,
    `Owner UID: ${owner.uid}`,
    `Storage: ${PERDIEM_COLLECTION}/${owner.uid}/events`,
    `Firebase user created: ${owner.created ? "Yes" : "No"}`,
    `Rows before dedupe: ${monthRows.length}`,
    `Rows: ${rows.length}`,
    `Duplicates removed: ${duplicatesRemoved}`,
    `Total PerDiem: ${totalPerDiem.toFixed(2)}`,
    `Transport Fee Total: ₩${transportFeeTotal.toLocaleString("ko-KR")}`,
  ].join("\n");

  console.log(`PERDIEM_OWNER_ROWS=${ownerRows.length}`);
  console.log(`PERDIEM_MONTH_MATCHED_ROWS=${monthRows.length}`);
  console.log(summary);

  await uploadSlackFile(
    csvPath,
    `${targetMonth} ${year} PerDiem`,
    summary
  );
  await postSlackResponse(summary);
}

main().catch(async (error) => {
  console.error(`Monthly report failed: ${error.stack || error.message}`);
  try {
    await postSlackResponse(`PerDiem report failed: ${error.message}`);
  } catch {}
  process.exit(1);
});
