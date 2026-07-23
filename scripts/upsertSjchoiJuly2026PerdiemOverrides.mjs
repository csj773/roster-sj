import admin from "firebase-admin";

const PERDIEM_OVERRIDE_COLLECTION = "PerdiemOverrides";
const OWNER_KEY = "sjchoi787@gmail.com";
const OWNER_UID = "guest_email_sjchoi787_gmail_com";
const MONTH = "Jul";
const YEAR = "2026";

const ROWS = [
  {
    Date: "2026.07.03",
    Activity: "YP151",
    From: "ICN",
    Destination: "HNL",
    RI: "2026-07-03T21:55:00.000Z",
    RO: "",
    StayHours: "0:00",
    Rate: 0,
    Total: 0,
    TransportFee: 7000,
  },
  {
    Date: "2026.07.06",
    Activity: "YP152",
    From: "HNL",
    Destination: "ICN",
    RI: "2026-07-03T21:55:00.000Z",
    RO: "2026-07-07T00:17:00.000Z",
    StayHours: "74:22",
    Rate: 3.42,
    Total: 254.33,
    TransportFee: 7000,
  },
  {
    Date: "2026.07.13",
    Activity: "YP135",
    From: "ICN",
    Destination: "IAD",
    RI: "2026-07-13T14:50:00.000Z",
    RO: "",
    StayHours: "0:00",
    Rate: 0,
    Total: 0,
    TransportFee: 7000,
  },
  {
    Date: "2026.07.15",
    Activity: "YP136",
    From: "IAD",
    Destination: "ICN",
    RI: "2026-07-13T14:50:00.000Z",
    RO: "2026-07-15T17:19:00.000Z",
    StayHours: "50:29",
    Rate: 3.42,
    Total: 172.65,
    TransportFee: 7000,
  },
  {
    Date: "2026.07.20",
    Activity: "YP801",
    From: "ICN",
    Destination: "HKG",
    RI: "2026-07-20T04:28:00.000Z",
    RO: "",
    StayHours: "0:00",
    Rate: 0,
    Total: 0,
    TransportFee: 7000,
  },
  {
    Date: "2026.07.20",
    Activity: "YP802",
    From: "HKG",
    Destination: "ICN",
    RI: "2026-07-20T04:28:00.000Z",
    RO: "2026-07-20T05:32:00.000Z",
    StayHours: "01:04",
    Rate: 2.75,
    Total: 33,
    TransportFee: 7000,
  },
  {
    Date: "2026.07.30",
    Activity: "YP131",
    From: "ICN",
    Destination: "EWR",
    RI: "2026-07-31T02:30:00.000Z",
    RO: "",
    StayHours: "0:00",
    Rate: 0,
    Total: 0,
    TransportFee: 7000,
  },
];

function requiredEnv(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
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

function safeDocIdPart(value) {
  const text = String(value ?? "")
    .trim()
    .replace(/[\/\\?#\[\]\x00-\x1F\x7F]+/g, "-")
    .replace(/\s+/g, " ")
    .slice(0, 200)
    .trim();
  return text && text !== "." && text !== ".." ? text : "blank";
}

function dateSortKey(value) {
  const match = String(value || "").match(/^(\d{4})[-.](\d{1,2})[-.](\d{1,2})$/);
  if (!match) return String(value || "");
  return `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
}

function rowDocId(row) {
  return [
    dateSortKey(row.Date),
    row.Activity,
    row.From,
    row.Destination,
  ].map(safeDocIdPart).join("_");
}

admin.initializeApp({
  credential: admin.credential.cert(parseJsonEnv("FIREBASE_SERVICE_ACCOUNT")),
});

const db = admin.firestore();
const ownerRef = db.collection(PERDIEM_OVERRIDE_COLLECTION).doc(OWNER_KEY);
await ownerRef.set({
  owner: OWNER_UID,
  uid: OWNER_UID,
  pdc_user_name: OWNER_KEY,
  display_name: OWNER_KEY,
  updatedAt: admin.firestore.FieldValue.serverTimestamp(),
}, { merge: true });

for (const row of ROWS) {
  await ownerRef.collection("items").doc(rowDocId(row)).set({
    ...row,
    Month: MONTH,
    Year: YEAR,
    owner: OWNER_UID,
    uid: OWNER_UID,
    pdc_user_name: OWNER_KEY,
    display_name: OWNER_KEY,
    source: "manual_perdiem_override",
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });
}

console.log(`Upserted ${ROWS.length} PerDiem override row(s) for ${OWNER_KEY} ${YEAR}-${MONTH}.`);
