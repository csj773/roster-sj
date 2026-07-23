import crypto from "crypto";
import admin from "firebase-admin";
import { initializeFirebaseAdmin } from "./kakaoFirebase.mjs";

export function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

export function setCors(req, res, methods = "GET, POST, OPTIONS") {
  const allowedOrigins = String(process.env.CORS_ORIGINS || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  const origin = req.headers.origin || "";
  if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin || "*");
  }
  res.setHeader("Access-Control-Allow-Methods", methods);
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

export async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

export async function requireFirebaseUser(req) {
  const authorization = String(req.headers.authorization || "");
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  const idToken = String(match?.[1] || "").trim();
  if (!idToken) {
    const error = new Error("Firebase Authorization bearer token is required");
    error.statusCode = 401;
    throw error;
  }

  initializeFirebaseAdmin();
  try {
    const decoded = await admin.auth().verifyIdToken(idToken);
    return {
      uid: decoded.uid,
      email: decoded.email || "",
      name: decoded.name || decoded.displayName || "",
    };
  } catch (error) {
    const authError = new Error("Invalid Firebase Authorization bearer token");
    authError.statusCode = 401;
    authError.details = error.message;
    throw authError;
  }
}

export function db() {
  initializeFirebaseAdmin();
  return admin.firestore();
}

export function nowTimestamp() {
  return admin.firestore.FieldValue.serverTimestamp();
}

export function cleanText(value, maxLength = 200) {
  return String(value || "").trim().slice(0, maxLength);
}

export function cleanDate(value) {
  const text = cleanText(value, 20);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : "";
}

export function inviteCode() {
  return crypto.randomBytes(9).toString("base64url");
}

export function shareId(ownerUid, sharedWithUid) {
  return `${ownerUid}_${sharedWithUid}`.replace(/[^A-Za-z0-9_-]/g, "_");
}

export function friendshipId(uidA, uidB) {
  return [uidA, uidB].sort().join("_").replace(/[^A-Za-z0-9_-]/g, "_");
}

export async function publicUser(uid) {
  const snap = await db().collection("users").doc(uid).get();
  const data = snap.exists ? snap.data() : {};
  return {
    uid,
    displayName: data.display_name || data.displayName || data.name || "",
    email: data.email || "",
  };
}
