import admin from "firebase-admin";
import {
  cleanText,
  db,
  friendshipId,
  json,
  nowTimestamp,
  publicUser,
  readJsonBody,
  setCors,
  shareId,
} from "./_lib/shareUtils.mjs";

const INVITE_COLLECTION = "roster_share_invites";
const SHARE_COLLECTION = "roster_shares";
const FRIEND_COLLECTION = "roster_friendships";

function guestUidForInvite(code) {
  return `guest_${cleanText(code, 80)}`.replace(/[^A-Za-z0-9_-]/g, "_");
}

function guestProfile(invite, code) {
  const email = cleanText(invite.recipientEmail || "", 240);
  return {
    uid: guestUidForInvite(code),
    displayName: email || "Roster Share guest",
    email,
  };
}

function writeGuestShare(tx, { owner, sharedWith, scope, inviteCode }) {
  const ref = db().collection(SHARE_COLLECTION).doc(shareId(owner.uid, sharedWith.uid));
  tx.set(ref, {
    ownerUid: owner.uid,
    ownerDisplayName: owner.displayName,
    ownerEmail: owner.email,
    sharedWithUid: sharedWith.uid,
    sharedWithDisplayName: sharedWith.displayName,
    sharedWithEmail: sharedWith.email,
    sharedWithType: "guest_invite_code",
    scope,
    status: "active",
    confirmationStatus: "accepted",
    confirmed: true,
    inviteCode,
    acceptedByUid: sharedWith.uid,
    confirmedByUid: sharedWith.uid,
    confirmedAt: nowTimestamp(),
    updatedAt: nowTimestamp(),
    createdAt: nowTimestamp(),
  }, { merge: true });
}

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }
  if (req.method !== "POST") {
    json(res, 405, { error: "Method not allowed" });
    return;
  }

  try {
    const body = await readJsonBody(req);
    const code = cleanText(body.inviteCode || body.code || body.invite || "", 80);
    if (!code) {
      json(res, 400, { error: "inviteCode is required" });
      return;
    }

    const inviteRef = db().collection(INVITE_COLLECTION).doc(code);
    const inviteSnap = await inviteRef.get();
    if (!inviteSnap.exists) {
      json(res, 404, { error: "Invite not found" });
      return;
    }

    const invite = inviteSnap.data();
    if (invite.expiresAt?.toDate && invite.expiresAt.toDate().getTime() < Date.now()) {
      json(res, 410, { error: "Invite expired" });
      return;
    }

    const owner = await publicUser(invite.ownerUid);
    const guest = guestProfile(invite, code);
    const scope = cleanText(invite.scope || "layover_only", 40) || "layover_only";

    if (invite.status === "accepted" && invite.acceptedByUid === guest.uid) {
      json(res, 200, {
        ok: true,
        alreadyAccepted: true,
        inviteCode: code,
        ownerUid: invite.ownerUid,
        sharedWithUid: guest.uid,
        confirmationStatus: "accepted",
        confirmed: true,
      });
      return;
    }

    if (invite.status !== "open") {
      json(res, 409, { error: "Invite is not open" });
      return;
    }
    if ((invite.useCount || 0) >= (invite.maxUses || 1)) {
      json(res, 409, { error: "Invite has already been used" });
      return;
    }

    await db().runTransaction(async (tx) => {
      const freshInvite = await tx.get(inviteRef);
      if (!freshInvite.exists) throw new Error("Invite not found");
      const fresh = freshInvite.data();
      if (fresh.expiresAt?.toDate && fresh.expiresAt.toDate().getTime() < Date.now()) {
        throw new Error("Invite expired");
      }
      if (fresh.status !== "open") throw new Error("Invite is no longer open");
      if ((fresh.useCount || 0) >= (fresh.maxUses || 1)) {
        throw new Error("Invite has already been used");
      }

      writeGuestShare(tx, {
        owner,
        sharedWith: guest,
        scope,
        inviteCode: code,
      });

      tx.set(db().collection(FRIEND_COLLECTION).doc(friendshipId(owner.uid, guest.uid)), {
        users: [owner.uid, guest.uid].sort(),
        status: "active",
        scope,
        source: "invite_code",
        inviteCode: code,
        mutual: false,
        confirmationStatus: "accepted",
        confirmed: true,
        confirmedByUid: guest.uid,
        confirmedAt: nowTimestamp(),
        updatedAt: nowTimestamp(),
        createdAt: nowTimestamp(),
      }, { merge: true });

      tx.update(inviteRef, {
        status: "accepted",
        confirmationStatus: "accepted",
        confirmed: true,
        acceptedByUid: guest.uid,
        acceptedByType: "guest_invite_code",
        acceptedAt: nowTimestamp(),
        confirmedByUid: guest.uid,
        confirmedAt: nowTimestamp(),
        updatedAt: nowTimestamp(),
        useCount: admin.firestore.FieldValue.increment(1),
      });
    });

    json(res, 200, {
      ok: true,
      inviteCode: code,
      ownerUid: invite.ownerUid,
      sharedWithUid: guest.uid,
      confirmationStatus: "accepted",
      confirmed: true,
    });
  } catch (error) {
    json(res, error.statusCode || 500, { error: error.message });
  }
}
