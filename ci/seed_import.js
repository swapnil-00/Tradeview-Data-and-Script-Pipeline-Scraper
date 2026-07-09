// Runner-side: decrypt ci/session.enc and inject the session into the local
// User_Data profile, so Chromium re-encrypts the cookies with its own OS-native
// key (Linux) and pipeline.js then opens User_Data already logged in.
//
//   SESSION_ENCRYPTION_KEY="<your key>" node ci/seed_import.js
const { chromium } = require("playwright");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

function decrypt(blobB64, passphrase) {
  const raw = Buffer.from(blobB64, "base64");
  const magic = raw.slice(0, 5).toString();
  if (magic !== "SEED1") throw new Error("bad seed format");
  const salt = raw.slice(5, 21);
  const iv = raw.slice(21, 37);
  const data = raw.slice(37);
  const key = crypto.scryptSync(passphrase, salt, 32);
  const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

(async () => {
  const passphrase = process.env.SESSION_ENCRYPTION_KEY;
  const encPath = path.resolve(__dirname, "session.enc");
  if (!passphrase) throw new Error("SESSION_ENCRYPTION_KEY not set");
  if (!fs.existsSync(encPath)) throw new Error(`no seed at ${encPath}`);

  const state = JSON.parse(decrypt(fs.readFileSync(encPath, "utf8"), passphrase));

  const userDataDir = path.resolve(__dirname, "..", "User_Data");
  const context = await chromium.launchPersistentContext(userDataDir, { headless: true });
  await context.addCookies(state.cookies);

  for (const origin of state.origins || []) {
    if (!origin.localStorage || !origin.localStorage.length) continue;
    const page = await context.newPage();
    try {
      await page.goto(origin.origin, { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.evaluate(items => {
        for (const { name, value } of items) localStorage.setItem(name, value);
      }, origin.localStorage);
    } catch (e) {
      console.log(`localStorage seed skipped for ${origin.origin}: ${e.message}`);
    }
    await page.close();
  }

  await context.close();
  console.log(`Seeded ${state.cookies.length} cookies into User_Data (Linux-native).`);
})().catch(e => { console.error("seed import failed:", e.message); process.exit(1); });
