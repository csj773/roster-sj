const functions = require("firebase-functions/v1");
const admin = require("firebase-admin");

admin.initializeApp();

const OWNER_QUERY_COLLECTIONS = [
  "roster",
  "PerdiemEvents",
  "PdcEvents",
  "Payments",
  "Limits",
  "Pilotlog",
  "CrewRest",
  "DutyPeriod",
  "UploadFile",
];

const OWNER_DOC_COLLECTIONS = [
  "users",
  "Perdiem",
  "pdc",
  "rosterByUser",
  "PaymentsByUser",
  "PilotlogByUser",
  "LimitsByUser",
];

function ownerDocId(uid) {
  return String(uid || "").trim().replace(/\//g, "_");
}

async function recursiveDeleteRef(db, ref) {
  await db.recursiveDelete(ref);
}

async function deleteOwnerQueryDocs(db, collectionName, uid) {
  const snapshot = await db.collection(collectionName).where("owner", "==", uid).get();
  let deleted = 0;

  for (const doc of snapshot.docs) {
    await recursiveDeleteRef(db, doc.ref);
    deleted += 1;
  }

  return deleted;
}

exports.onUserDeleted = functions.auth.user().onDelete(async (user) => {
  const uid = ownerDocId(user.uid);
  if (!uid) {
    console.warn("onUserDeleted skipped: missing uid");
    return null;
  }

  const db = admin.firestore();
  const deleted = {};

  for (const collectionName of OWNER_QUERY_COLLECTIONS) {
    deleted[collectionName] = await deleteOwnerQueryDocs(db, collectionName, uid);
  }

  for (const collectionName of OWNER_DOC_COLLECTIONS) {
    const ref = db.collection(collectionName).doc(uid);
    const snapshot = await ref.get();
    if (!snapshot.exists) {
      deleted[collectionName] = deleted[collectionName] || 0;
      continue;
    }
    await recursiveDeleteRef(db, ref);
    deleted[collectionName] = (deleted[collectionName] || 0) + 1;
  }

  console.log("Deleted user-owned Firestore data", {
    uid,
    email: user.email || "",
    deleted,
  });

  return null;
});
