import { Resend } from "resend";

function cleanText(value, max = 500) {
  return String(value || "").trim().slice(0, max);
}

function escapeHtml(value) {
  return String(value || "").replace(/[&<>"']/g, (char) => {
    return {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[char];
  });
}

function configuredFromEmail() {
  return cleanText(
    process.env.RESEND_FROM_EMAIL ||
      process.env.INVITE_EMAIL_FROM ||
      "Roster Share <onboarding@resend.dev>",
    240
  );
}

function configuredReplyTo() {
  return cleanText(
    process.env.RESEND_REPLY_TO || process.env.ROSTER_SHARE_REPLY_TO || "",
    240
  );
}

function appBaseUrl() {
  return cleanText(
    process.env.ROSTER_SHARE_APP_URL ||
      process.env.APP_BASE_URL ||
      "https://roster-sj-j3bu.vercel.app",
    500
  ).replace(/\/+$/, "");
}

function slackRosterGuideUrl() {
  const path = cleanText(process.env.SLACK_ROSTER_GUIDE_PATH || "/slack-roster-guide/", 120);
  return `${appBaseUrl()}${path}`;
}

function resendClient() {
  const apiKey = cleanText(process.env.RESEND_API_KEY || "", 300);
  if (!apiKey) return null;
  return new Resend(apiKey);
}

export async function sendRosterShareInviteEmail({
  to,
  ownerName,
  inviteUrl,
  scope,
  expiresInDays,
  confirmationRequired,
}) {
  const recipient = cleanText(to, 240);
  if (!recipient) {
    return { sent: false, status: "not_required" };
  }

  const resend = resendClient();
  if (!resend) {
    return {
      sent: false,
      status: "not_configured",
      error: "RESEND_API_KEY is not configured",
    };
  }

  const owner = cleanText(ownerName || "A crew member", 120);
  const url = cleanText(inviteUrl, 1000);
  const safeOwner = escapeHtml(owner);
  const safeUrl = escapeHtml(url);
  const guideUrl = slackRosterGuideUrl();
  const safeGuideUrl = escapeHtml(guideUrl);
  const safeScope = escapeHtml(cleanText(scope || "layover_only", 80));
  const safeDays = escapeHtml(String(expiresInDays || 14));
  const confirmationText = confirmationRequired
    ? "수락하면 초대 confirmation 상태가 accepted로 업데이트됩니다."
    : "수락 후 바로 roster share가 연결됩니다.";

  const html = `<!doctype html>
<html>
  <body style="margin:0;background:#f6f7f9;font-family:Arial,Helvetica,sans-serif;color:#1f2937;">
    <div style="max-width:560px;margin:0 auto;padding:32px 18px;">
      <div style="background:#ffffff;border:1px solid #e5e7eb;border-radius:8px;padding:28px;">
        <h1 style="margin:0 0 14px;font-size:22px;line-height:1.3;color:#111827;">Roster Share 초대</h1>
        <p style="margin:0 0 18px;font-size:15px;line-height:1.6;">
          ${safeOwner} 님이 roster 공유에 초대했습니다.
        </p>
        <p style="margin:0 0 18px;font-size:14px;line-height:1.6;color:#4b5563;">
          공유 범위: ${safeScope}<br>
          초대 만료: ${safeDays}일 후<br>
          ${escapeHtml(confirmationText)}
        </p>
        <p style="margin:24px 0;">
          <a href="${safeUrl}" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;padding:12px 18px;border-radius:6px;font-size:15px;font-weight:700;">
            Roster Share 참여하기
          </a>
        </p>
        <p style="margin:20px 0 0;font-size:12px;line-height:1.6;color:#6b7280;">
          사용 전 가이드:
          <a href="${safeGuideUrl}" style="color:#2563eb;word-break:break-all;">${safeGuideUrl}</a><br><br>
          버튼이 열리지 않으면 아래 링크를 복사해 브라우저에서 열어주세요.<br>
          <a href="${safeUrl}" style="color:#2563eb;word-break:break-all;">${safeUrl}</a>
        </p>
      </div>
    </div>
  </body>
</html>`;

  const text = [
    "Roster Share 초대",
    "",
    `${owner} 님이 roster 공유에 초대했습니다.`,
    `공유 범위: ${scope || "layover_only"}`,
    `초대 만료: ${expiresInDays || 14}일 후`,
    confirmationText,
    "",
    `사용 전 가이드: ${guideUrl}`,
    "",
    `참여 링크: ${url}`,
  ].join("\n");

  const payload = {
    from: configuredFromEmail(),
    to: recipient,
    subject: `${owner} invited you to Roster Share`,
    html,
    text,
  };
  const replyTo = configuredReplyTo();
  if (replyTo) payload.replyTo = replyTo;

  const { data, error } = await resend.emails.send(payload);
  if (error) {
    return {
      sent: false,
      status: "failed",
      error: cleanText(error.message || JSON.stringify(error), 500),
    };
  }

  return {
    sent: true,
    status: "sent",
    id: cleanText(data?.id || "", 120),
  };
}
