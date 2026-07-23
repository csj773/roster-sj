import admin from "firebase-admin";

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

async function countQuery(query) {
  return query.count().get()
    .then((snapshot) => snapshot.data().count)
    .catch(async () => (await query.get()).size);
}

admin.initializeApp({
  credential: admin.credential.cert(parseJsonEnv("FIREBASE_SERVICE_ACCOUNT")),
});

const db = admin.firestore();
if (typeof db.recursiveDelete !== "function") {
  throw new Error("Firestore recursiveDelete is not available");
}

const flatBefore = await countQuery(db.collection("pdc"));
const eventsBefore = await countQuery(db.collectionGroup("events"));
console.log(`before flat_pdc=${flatBefore} pdc_events=${eventsBefore}`);

await db.recursiveDelete(db.collection("pdc"));

const flatAfter = await countQuery(db.collection("pdc"));
const eventsAfter = await countQuery(db.collectionGroup("events"));
console.log(`after flat_pdc=${flatAfter} pdc_events=${eventsAfter}`);
