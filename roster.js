import puppeteer from "puppeteer";
import fs from "fs";
import path from "path";

(async () => {
  const browser = await puppeteer.launch({ headless: false, slowMo: 50 });
  const page = await browser.newPage();

  // 로그인 페이지 접속
  await page.goto("https://pdc-web.premia.kr/CrewConnex/default.aspx", {
    waitUntil: "networkidle0",
  });

  console.log("👉 브라우저가 열렸습니다. 아이디/비밀번호 입력 후 Roster 메뉴를 클릭하세요.");
  await new Promise(resolve => setTimeout(resolve, 30000)); // 로그인 대기

  // ------------------- Roster 메뉴 클릭 -------------------
  const rosterLink = await page.evaluateHandle(() => {
    const links = Array.from(document.querySelectorAll("a"));
    return links.find(a => a.textContent.includes("Roster")) || null;
  });

  if (rosterLink) {
    await Promise.all([
      rosterLink.click(),
      page.waitForNavigation({ waitUntil: "networkidle0" }),
    ]);
    console.log("✅ Roster 메뉴 클릭 완료");
  } else {
    console.log("❌ Roster 링크를 찾지 못했습니다.");
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

  // 내가 원하는 최종 헤더 정의
  const headers = [
    "Date",
    "DC",
    "C/I(L)",
    "C/O(L)",
    "Activity",
    "F",
    "From",
    "STD(L)",
    "STD(Z)",
    "To",
    "STA(L)",
    "STA(Z)",
    "BLH",
    "AcReg",
    "Crew"
  ];

  // 실제 사이트 테이블 헤더 (첫 row)
  const siteHeaders = rosterRaw[0];

  // 헤더 매핑: { 원하는헤더 : 실제컬럼인덱스 }
  const headerMap = {};
  headers.forEach(h => {
    const idx = siteHeaders.findIndex(col => col.includes(h));
    if (idx >= 0) headerMap[h] = idx;
  });

  console.log("✅ 헤더 매핑 결과:", headerMap);

  // ------------------- JSON 변환 -------------------
  let values = rosterRaw.slice(1).map(row => {
    return headers.map(h => {
      if (h === "AcReg") return row[18] || "";  // ✅ 고정 인덱스 사용
      if (h === "Crew") return row[22] || "";   // ✅ 고정 인덱스 사용
      const idx = headerMap[h];
      return idx !== undefined ? (row[idx] || "") : "";
    });
  });

  // ------------------- 중복 제거 -------------------
  const seen = new Set();
  values = values.filter(row => {
    const key = row.join("||");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // 헤더 추가
  values.unshift(headers);

  // ------------------- 저장 경로 -------------------
  const publicDir = path.join(process.cwd(), "public");
  if (!fs.existsSync(publicDir)) fs.mkdirSync(publicDir);

  // 기존 JSON/CSV 삭제
  const jsonFilePath = path.join(publicDir, "roster.json");
  if (fs.existsSync(jsonFilePath)) fs.unlinkSync(jsonFilePath);

  const csvFilePath = path.join(publicDir, "roster.csv");
  if (fs.existsSync(csvFilePath)) fs.unlinkSync(csvFilePath);

  // ------------------- JSON 저장 -------------------
  fs.writeFileSync(jsonFilePath, JSON.stringify({ values }, null, 2), "utf-8");
  console.log("✅ roster.json 저장 완료 (중복 제거 후 작성)");

  // ------------------- CSV 저장 -------------------
  const csvContent = values
    .map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(","))
    .join("\n");
  fs.writeFileSync(csvFilePath, csvContent, "utf-8");
  console.log("✅ roster.csv 저장 완료 (중복 제거 후 작성)");

  await browser.close();
})();
