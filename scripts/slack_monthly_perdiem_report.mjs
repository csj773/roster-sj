import fs from "fs";
import os from "os";
import path from "path";
import admin from "firebase-admin";
import { generateSlackPerDiemList } from "./slack_perdiem.js";

const PDC_COLLECTION = "pdc";
const PERDIEM_COLLECTION = "Perdiem";
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const ROSTER_HEADERS = ["Date", "D/C", "C/I(L)", "C/O(L)", "Activity", "F", "From", "STD(L)", "STD(Z)", "To", "STA(L)", "STA(Z)", "BLH", "Crew"];

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

function appDisplayTotal(value) {
  return Math.round(parseMoney(value));
}

function firstText(...values) {
  for (const value of values) {
    const text = cleanText(value, 200);
    if (text) return text;
  }
  return "";
}

function normalizePerDiemTime(value) {
  const text = cleanText(value, 40);
  if (!text) return "";
  const match = text.match(/^(\d{1,2})(?::?(\d{2}))?([+-]\d+)?$/);
  if (!match) return text;
  const hour = match[1].padStart(2, "0");
  const minute = (match[2] || "00").padStart(2, "0");
  return `${hour}${minute}${match[3] || ""}`;
}

function compareHHMM(left, right) {
  const leftMatch = normalizePerDiemTime(left).match(/^(\d{2})(\d{2})/);
  const rightMatch = normalizePerDiemTime(right).match(/^(\d{2})(\d{2})/);
  if (!leftMatch || !rightMatch) return null;
  return (Number(leftMatch[1]) * 60 + Number(leftMatch[2])) -
    (Number(rightMatch[1]) * 60 + Number(rightMatch[2]));
}

function sameRosterDate(left, right) {
  return dateSortKey(left) === dateSortKey(right);
}

function returnDepartureTimeWithOffset({ currentRow, previousRow }) {
  const departure = normalizePerDiemTime(currentRow[8]);
  if (!departure || /[+-]\d+$/.test(departure)) return departure;
  if (!previousRow) return departure;

  const from = currentRow[6];
  const to = currentRow[9];
  const previousTo = previousRow[9];
  const previousArrival = previousRow[11];
  if (to !== "ICN" || from !== previousTo || !sameRosterDate(currentRow[0], previousRow[0])) {
    return departure;
  }

  const comparison = compareHHMM(departure, previousArrival);
  return comparison !== null && comparison <= 0 ? `${departure}+1` : departure;
}

function cleanText(value, maxLength = 200) {
  return String(value ?? "").trim().slice(0, maxLength);
}

function dateSortKey(value) {
  const match = String(value || "").match(/^(\d{4})[-.](\d{1,2})[-.](\d{1,2})$/);
  if (!match) return cleanText(value, 20);
  return `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
}

function safeDocIdPart(value) {
  const text = String(value ?? "")
    .trim()
    .replace(/[\/\\?#\[\]\x00-\x1F\x7F]+/g, "-")
    .replace(/\s+/g, " ")
    .slice(0, 200)
    .trim();
  return text && text !== "." && text !== ".." ? text : "blank";
}

function perDiemDocId(item, ownerKey) {
  return [
    ownerKey,
    item.Year,
    item.Month,
    item.Date,
    item.Activity,
    item.From,
    item.Destination,
  ].map(safeDocIdPart).join("_");
}

function targetMonthYear() {
  const fallback = defaultTargetMonthYear();
  const month = Number(optionalEnv("PERDIEM_TARGET_MONTH") || fallback.month);
  const year = Number(optionalEnv("PERDIEM_TARGET_YEAR") || fallback.year);
  if (!Number.isFinite(month) || month < 1 || month > 12) throw new Error(`Invalid target month: ${month}`);
  if (!Number.isFinite(year) || year < 2000) throw new Error(`Invalid target year: ${year}`);
  return { month, year };
}

function pdcRosterRow(doc) {
  const from = firstText(doc.From);
  const to = firstText(doc.To, doc.Destination);
  const stdl = firstText(doc.STDL, doc["STD(L)"]);
  const stal = firstText(doc.STAL, doc["STA(L)"]);
  const stdz = firstText(doc.STDZ, doc["STD(Z)"], stdl);
  const staz = firstText(doc.STAZ, doc["STA(Z)"], stal);
  return [
    firstText(doc.DateRaw, doc.Date),
    firstText(doc.DC, doc["D/C"]),
    firstText(doc.CIL, doc["C/I(L)"]),
    firstText(doc.COL, doc["C/O(L)"]),
    firstText(doc.Activity),
    firstText(doc.F, doc.Activity),
    from,
    normalizePerDiemTime(stdl),
    normalizePerDiemTime(stdz),
    to,
    normalizePerDiemTime(stal),
    normalizePerDiemTime(staz),
    firstText(doc.BLH),
    firstText(doc.Crew),
  ];
}

function withReturnDepartureOffsets(rows) {
  return rows.map((row, index) => {
    const adjusted = [...row];
    adjusted[8] = returnDepartureTimeWithOffset({
      currentRow: adjusted,
      previousRow: index > 0 ? rows[index - 1] : null,
    });
    return adjusted;
  });
}

function dedupeRosterRows(rows) {
  const seen = new Set();
  return rows.filter((row) => {
    const key = [
      dateSortKey(row[0]),
      row[1],
      row[4],
      row[6],
      row[9],
      row[7],
      row[11],
    ].join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function pdcRosterJsonPath(db, ownerUid) {
  const snapshot = await db.collection(PDC_COLLECTION).where("owner", "==", ownerUid).get();
  const pdcDocs = snapshot.docs
    .map((doc) => doc.data())
    .filter((doc) => cleanText(doc.Activity, 80));
  const pdcUserName = pdcDocs
    .map((doc) => firstText(doc.pdc_user_name, doc.display_name, doc.ownerDisplayName, doc.userName))
    .find(Boolean) || "";

  const rows = pdcDocs
    .filter((doc) => firstText(doc.From) && firstText(doc.To, doc.Destination))
    .sort((a, b) => {
      const left = `${dateSortKey(firstText(a.Date, a.DateRaw))}_${firstText(a.STDL, a["STD(L)"])}_${firstText(a.Activity)}`;
      const right = `${dateSortKey(firstText(b.Date, b.DateRaw))}_${firstText(b.STDL, b["STD(L)"])}_${firstText(b.Activity)}`;
      return left.localeCompare(right);
    })
    .map(pdcRosterRow);

  const values = [ROSTER_HEADERS, ...withReturnDepartureOffsets(dedupeRosterRows(rows))];
  const filePath = path.join(os.tmpdir(), `pdc-roster-${ownerUid.replace(/[^A-Za-z0-9_-]/g, "_")}.json`);
  fs.writeFileSync(filePath, JSON.stringify({ values }, null, 2), "utf-8");
  return { filePath, pdcUserName, rowCount: values.length - 1 };
}

async function deleteQueryDocs(snapshot) {
  for (const doc of snapshot.docs) {
    await doc.ref.delete();
  }
}

async function deleteExistingFlatSlackPerDiemRows(db, { ownerUid, pdcUserName }) {
  const collection = db.collection(PERDIEM_COLLECTION);
  const snapshots = [];
  snapshots.push(await collection.where("owner", "==", ownerUid).get());
  if (pdcUserName) snapshots.push(await collection.where("pdc_user_name", "==", pdcUserName).get());

  const refs = new Map();
  for (const snapshot of snapshots) {
    for (const doc of snapshot.docs) {
      const data = doc.data();
      if (data?.source === "slack_pdc_perdiem" && data?.Date && data?.Activity) {
        refs.set(doc.ref.path, doc.ref);
      }
    }
  }

  for (const ref of refs.values()) {
    await ref.delete();
  }

  return refs.size;
}

async function storePersonalPerDiemRows(db, rows, { ownerUid, displayName, pdcUserName, ownerKey }) {
  const ownerRef = db.collection(PERDIEM_COLLECTION).doc(ownerKey);
  const existingSnapshot = await ownerRef.collection("items").get();
  await deleteQueryDocs(existingSnapshot);
  const legacyOwnerKey = safeDocIdPart(ownerUid);
  if (legacyOwnerKey !== ownerKey) {
    const legacySnapshot = await db
      .collection(PERDIEM_COLLECTION)
      .doc(legacyOwnerKey)
      .collection("items")
      .get();
    await deleteQueryDocs(legacySnapshot);
  }
  await deleteExistingFlatSlackPerDiemRows(db, { ownerUid, pdcUserName });

  let stored = 0;

  for (const row of rows) {
    const docId = perDiemDocId(row, ownerKey);
    const data = {
      ...row,
      Total: appDisplayTotal(row.Total),
      owner: ownerUid,
      uid: ownerUid,
      display_name: displayName,
      pdc_user_name: pdcUserName,
      perdiem_owner_key: ownerKey,
      source: "slack_pdc_perdiem",
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    const batch = db.batch();
    batch.set(ownerRef, {
      owner: ownerUid,
      uid: ownerUid,
      display_name: displayName,
      pdc_user_name: pdcUserName,
      perdiem_owner_key: ownerKey,
      source: "slack_pdc_perdiem",
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    batch.set(ownerRef.collection("items").doc(docId), data, { merge: true });
    batch.set(db.collection(PERDIEM_COLLECTION).doc(docId), data, { merge: true });
    await batch.commit();
    stored += 1;
  }

  return stored;
}

async function storedPerDiemRowsForMonth(db, ownerKey, target) {
  const snapshot = await db
    .collection(PERDIEM_COLLECTION)
    .doc(ownerKey)
    .collection("items")
    .get();

  return snapshot.docs
    .map((doc) => doc.data())
    .filter((row) => monthToNumber(row.Month) === target.month)
    .filter((row) => String(row.Year || "").trim() === String(target.year))
    .filter((row) => !["RI", "RO"].includes(cleanText(row.Activity, 20).toUpperCase()))
    .map((row) => ({
      Date: cleanText(row.Date, 20),
      Activity: cleanText(row.Activity, 40),
      From: cleanText(row.From, 10),
      Destination: cleanText(row.Destination, 20),
      StayHours: cleanText(row.StayHours, 20),
      Rate: parseMoney(row.Rate),
      Total: appDisplayTotal(row.Total),
      TransportFee: parseMoney(row.TransportFee),
    }))
    .sort((a, b) => `${dateSortKey(a.Date)}_${a.Activity}_${a.From}_${a.Destination}`.localeCompare(
      `${dateSortKey(b.Date)}_${b.Activity}_${b.From}_${b.Destination}`
    ));
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
    String(Math.round(Number(row.Total || 0))),
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
    .collection(PDC_COLLECTION)
    .where("owner", "==", ownerUid)
    .limit(1)
    .get();
  if (snapshot.empty) {
    throw new Error(`No pdc roster rows found for owner ${ownerUid}`);
  }

  const db = admin.firestore();
  const { filePath, pdcUserName, rowCount } = await pdcRosterJsonPath(db, ownerUid);
  const reportName = pdcUserName || displayName;
  const ownerKey = safeDocIdPart(reportName || ownerUid);
  const calculatedRows = await generateSlackPerDiemList(filePath);
  const storedRows = await storePersonalPerDiemRows(db, calculatedRows, {
    ownerUid,
    displayName: reportName,
    pdcUserName,
    ownerKey,
  });
  const rows = await storedPerDiemRowsForMonth(db, ownerKey, target);

  const totalPerdiem = rows.reduce((sum, row) => sum + row.Total, 0);
  const totalTransportFee = rows.reduce((sum, row) => sum + row.TransportFee, 0);
  const table = rows.length ? reportTable(rows) : "No PerDiem rows found.";
  const truncatedTable = table.length > 2500 ? `${table.slice(0, 2500)}\n...truncated` : table;
  const text = [
    `*${reportName}*`,
    `*${formatKoreanMonth(target)} PerDiem Report*`,
    "```",
    truncatedTable,
    "```",
    `${reportName}: ${formatKoreanMonth(target)} Prediem=${totalPerdiem.toFixed(2)}/Transport fee=${totalTransportFee.toFixed(0)}`,
    "",
    `created at: ${formatKstTimestamp()} KST`,
    `source: Firestore ${PDC_COLLECTION} -> ${PERDIEM_COLLECTION}/${ownerKey}/items, pdc_user_name=${pdcUserName || "blank"}, roster rows=${rowCount}, stored=${storedRows}, Month=${monthName}, Year=${target.year}`,
  ].join("\n");

  await postSlack(text);
  console.log(`Posted Slack PerDiem report for ${ownerUid} (${reportName}): ${rows.length} row(s).`);
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
