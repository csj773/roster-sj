function cleanText(value, maxLength = 1000) {
  return String(value || "").trim().slice(0, maxLength);
}

function requestQuery(req) {
  if (req.query && Object.keys(req.query).length) return req.query;
  const host = req.headers.host || "localhost";
  const url = new URL(req.url || "/", `https://${host}`);
  return Object.fromEntries(url.searchParams.entries());
}

function buildMailto({ to, subject, body }) {
  const encodedSubject = encodeURIComponent(cleanText(subject || "Roster Share 참여 링크", 200));
  const encodedBody = encodeURIComponent(cleanText(body || "", 1800));
  return `mailto:${encodeURIComponent(cleanText(to, 240))}?subject=${encodedSubject}&body=${encodedBody}`;
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.statusCode = 405;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Method not allowed" }));
    return;
  }

  const query = requestQuery(req);
  const mailto = buildMailto({
    to: query.to || "",
    subject: query.subject || "",
    body: query.body || "",
  });

  res.statusCode = 302;
  res.setHeader("Location", mailto);
  res.end();
}
