import puppeteer from "puppeteer";
import fs from "fs";
import path from "path";
import "dotenv/config";

(async () => {
  const browser = await puppeteer.launch({
    headless: "new", // 최신 Puppeteer 권장 방식
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });

  const page = await browser.newPage();

  console.log("👉 로그인 페이지 접속 중...");
  await page.goto("https://pdc-web.premia.kr/CrewConnex/default.aspx", {
    waitUntil: "networkidle0"
  });

  // ------------------- 환경변수 확인 -------------------
  const username = process.env.PDC_USERNAME;
  const password = process.env.PDC_PASSWORD;

  if (!username || !password) {
    console.error("❌ PDC_USERNAME 또는 PDC_PASSWORD 환경변수가 설정되지 않았습니다.");
    await browser.close();
    process.exit(1);
  }

  console.log("👉 로그인 시도 중...");

  // ------------------- 로그인 -------------------
  await page.type("#ctl00_Main_userId_edit", username, { delay: 50 });
  await page.type("#ctl00_Main_password_edit", password, { delay: 50 });

  try {
    await Promise.all([
      page.click("#ctl00_Main_login_btn"), // 기본 로그인 버튼 ID
      page.waitForNavigation({ waitUntil: "networkidle0" })
    ]);
  } catch {
    // fallback (버튼 ID가 다를 경우 대비)
    await Promise.all([
      page.click("input[type=submit], button[type=submit]"),
      page.waitForNavigation({ waitUntil: "networkidle0" })
    ]);
  }

  console.log("✅ 로그인 성공");

  // ------------------- Roster 메뉴 이동 -------------------
  const rosterLink = await page.evaluateHandle(() => {
    const links = Array.from(document.querySelectorAll("a"));
    return links.find(a => a.textContent.includes("Roster")) || null;
  });

  if (rosterLink) {
    await Promise.all([
      rosterLink.click(),
      page.waitForNavigation({ waitUntil: "networkidle0" })
    ]);
    console.log("✅ Roster 메뉴 클릭 완료");
  } else {
    console.error("❌ Roster 링크를 찾지 못했습니다.");
    await browser.close();
    return;
  }

  // ------------------- Roster 테이블 추출 -------------------
  await page.waitForSelector("table tr");

  const rosterRaw = await page.evaluate(() => {
    return Array.from(document.querySelectorAll("table tr")).map(tr =>
      Array.from(tr.querySelectorAll("td")).map(td => td.innerText.trim())
    );
  });

  if (rosterRaw.length < 2) {
    console.error("❌ Roster 데이터가 비어있습니다.");
    await browser.close();
    return;
  }

  // ------------------- 헤더 매핑 -------------------
  const headers = [
    "Date", "DC", "C/I(L)", "C/O(L)", "Activity", "F", "From",
    "STD(L)", "STD(Z)", "To", "STA(L)", "STA(Z)", "BLH", "AcReg", "Crew"
  ];

  const siteHeaders = rosterRaw[0];
  const headerMap = {};
  headers.forEach(h => {
    const idx = siteHeaders.findIndex(col => col.includes(h));
    if (idx >= 0) headerMap[h] = idx;
  });

  console.log("✅ 헤더 매핑 결과:", headerMap);

  // ------------------- JSON 변환 -------------------
  let values = rosterRaw.slice(1).map(row =>
    headers.map(h => {
      const idx = headerMap[h];
      return idx !== undefined ? (row[idx] || "") : "";
    })
  );

  // ------------------- 중복 제거 -------------------
  const seen = new Set();
  values = values.filter(row => {
    const key = row.join("||");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  values.unshift(headers);

  // ------------------- 저장 -------------------
  const publicDir = path.join(process.cwd(), "public");
  if (!fs.existsSync(publicDir)) fs.mkdirSync(publicDir);

  const jsonFilePath = path.join(publicDir, "roster.json");
  const csvFilePath = path.join(publicDir, "roster.csv");

  [jsonFilePath, csvFilePath].forEach(file => {
    if (fs.existsSync(file)) fs.unlinkSync(file);
  });

  fs.writeFileSync(jsonFilePath, JSON.stringify({ values }, null, 2), "utf-8");
  console.log("✅ roster.json 저장 완료");

  const csvContent = values
    .map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(","))
    .join("\n");

  fs.writeFileSync(csvFilePath, csvContent, "utf-8");
  console.log("✅ roster.csv 저장 완료");

  await browser.close();
})();
