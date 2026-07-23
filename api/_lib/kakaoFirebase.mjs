import admin from "firebase-admin";

function decodeBase64Json(value) {
  return Buffer.from(value, "base64").toString("utf8");
}

function serviceAccountJson() {
  const raw =
    process.env.FIREBASE_SERVICE_ACCOUNT ||
    process.env.FIREBASE_SERVICE_ACCOUNT_JSON ||
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON ||
    "";
  const b64 =
    process.env.FIREBASE_SERVICE_ACCOUNT_B64 ||
    process.env.FIREBASE_SERVICE_ACCOUNT_JSON_B64 ||
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON_B64 ||
    "";
  const value = raw || (b64 ? decodeBase64Json(b64) : "");
  if (!value) throw new Error("Firebase service account is not configured");

  const parsed = JSON.parse(value.replace(/^\uFEFF/, ""));
  if (parsed.private_key) parsed.private_key = parsed.private_key.replace(/\\n/g, "\n");
  return parsed;
}

export function initializeFirebaseAdmin() {
  if (admin.apps.length) return;
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccountJson()),
  });
}

export async function fetchKakaoProfile(accessToken) {
  const response = await fetch("https://kapi.kakao.com/v2/user/me", {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/x-www-form-urlencoded;charset=utf-8",
    },
  });

  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      body,
    };
  }

  return {
    ok: true,
    body,
  };
}

function cleanDisplayName(profile) {
  return String(
    profile?.properties?.nickname ||
      profile?.kakao_account?.profile?.nickname ||
      ""
  ).trim();
}

function cleanEmail(profile) {
  const account = profile?.kakao_account || {};
  if (account.is_email_valid === false || account.is_email_verified === false) return "";
  return String(account.email || "").trim();
}

async function upsertFirebaseUser({ uid, email, displayName }) {
  const userRecord = {
    uid,
    ...(email ? { email, emailVerified: true } : {}),
    ...(displayName ? { displayName } : {}),
  };

  try {
    await admin.auth().getUser(uid);
    const updates = { ...userRecord };
    delete updates.uid;
    if (Object.keys(updates).length) await admin.auth().updateUser(uid, updates);
  } catch (error) {
    if (error.code !== "auth/user-not-found") throw error;
    await admin.auth().createUser(userRecord);
  }
}

async function upsertFirestoreUser({ uid, email, displayName }) {
  const userRef = admin.firestore().collection("users").doc(uid);
  const existing = await userRef.get();
  await userRef.set({
    uid,
    email: email || "",
    display_name: displayName || "",
    provider: "kakao",
    providers: ["kakao"],
    updated_time: admin.firestore.FieldValue.serverTimestamp(),
    ...(existing.exists ? {} : { created_time: admin.firestore.FieldValue.serverTimestamp() }),
  }, { merge: true });
}

export async function createFirebaseTokenFromKakaoAccessToken(accessToken) {
  const kakao = await fetchKakaoProfile(accessToken);
  if (!kakao.ok) {
    const error = new Error("Kakao access token verification failed");
    error.statusCode = 401;
    error.details = kakao.body;
    throw error;
  }

  const kakaoId = String(kakao.body.id || "").trim();
  if (!kakaoId) {
    const error = new Error("Kakao profile did not include an id");
    error.statusCode = 401;
    throw error;
  }

  initializeFirebaseAdmin();

  const uid = `kakao_${kakaoId}`;
  const email = cleanEmail(kakao.body);
  const displayName = cleanDisplayName(kakao.body);

  try {
    await upsertFirebaseUser({ uid, email, displayName });
  } catch (error) {
    if (error.code !== "auth/email-already-exists") throw error;
  }

  await upsertFirestoreUser({ uid, email, displayName });

  const firebaseCustomToken = await admin.auth().createCustomToken(uid, {
    provider: "kakao",
    kakaoId,
  });

  return {
    firebaseCustomToken,
    uid,
    email,
    displayName,
  };
}
