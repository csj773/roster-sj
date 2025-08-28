const puppeteer = require("puppeteer");
const fs = require("fs");
const path = require("path");

(async () => {
  const browser = await puppeteer.launch({ headless: false, slowMo: 50 });
  const page = await browser.newPage();

  await page.goto("https://pdc-web.premia.kr/CrewConnex/default.aspx", {
    waitUntil: "networkidle0",
  });

  console.log("👉 브라우저가 열렸습니다. 아이디/비밀번호 입력 후 Roster 메뉴를 클릭하세요.");
  await new Promise(resolve => setTimeout(resolve, 30000)); // 로그인/메뉴 선택 대기

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

  await page.waitForSelector("table tr");

  const rosterRaw = await page.evaluate(() => {
    return Array.from(document.querySelectorAll("table tr")).map(tr =>
      Array.from(tr.querySelectorAll("td")).map(td => td.innerText.trim())
    );
  });

  const headers = [
    "Date", "DC", "C", "C/I(L)", "C/O(L)", "Activity", "FLT", "G", "From",
    "STD(L)", "STD(Z)", "K", "To", "STA(L)", "STA(Z)", "O", "BLH", "Q",
    "AcReg", "S", "T", "ID", "Crew",
  ];

  const rows = rosterRaw.slice(1);
  const rosterData = rows.map(row =>
    Object.fromEntries(headers.map((h, i) => [h, row[i] || ""]))
  );

  const finalData = { items: rosterData };

  const filePath = path.join(__dirname, "public", "roster.json");
  fs.writeFileSync(filePath, JSON.stringify(finalData, null, 2), "utf-8");
  console.log("Roster JSON:", JSON.stringify(rosterData, null, 2));

  console.log("✅ roster.json 저장 완료");

  console.log("✅ public/roster.json 저장 완료");
  await browser.close();
})();
