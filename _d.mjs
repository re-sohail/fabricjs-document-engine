import { chromium } from "playwright";
const d="/private/tmp/claude-501/-Users-mrmacbook-Documents-personal-project-Libraries-fabricjs-document-engine/4558392a-5857-4477-82e4-848306f7db5a/scratchpad/";
const b = await chromium.launch(); const errs=[];
for (const w of [1400, 390]) {
  const p = await b.newPage({ viewport: { width: w, height: 900 }, reducedMotion: "reduce" });
  p.on("pageerror",e=>errs.push(e.message)); p.on("console",m=>m.type()==="error"&&errs.push(m.text().slice(0,200)));
  await p.goto("http://localhost:3000/", { waitUntil: "networkidle", timeout: 120000 }); await p.waitForTimeout(1500);
  const card = p.locator("#docs-heading").locator("xpath=ancestor::section");
  await card.scrollIntoViewIfNeeded(); await p.waitForTimeout(1200);
  const info = await p.evaluate(()=>({ fonts: [...new Set([...document.querySelectorAll("body *")].map(e=>getComputedStyle(e).fontFamily.split(",")[0]))], code: !!document.querySelector("#docs-heading")?.closest("section")?.querySelector("pre"), overflow: document.documentElement.scrollWidth-innerWidth }));
  console.log(w, JSON.stringify(info));
  await card.screenshot({ path: d+`v10-docs-${w}.png` }); await p.close();
}
console.log("errors:", errs.length?errs:"none"); await b.close();
