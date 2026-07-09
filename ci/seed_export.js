// Export the logged-in TradingView session from the local User_Data profile
// and write it ONLY as an AES-256 encrypted blob (ci/session.enc). The plaintext
// cookies/localStorage never touch disk — they live in memory, get encrypted,
// and are written out already-encrypted. Safe to commit to a public repo.
//
//   Run locally after a successful login:
//     SESSION_ENCRYPTION_KEY="<your key>" node ci/seed_export.js
//   (if the env var is unset, a strong random key is generated and printed once)
const { chromium } = require("playwright");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

function encrypt(plaintext, passphrase) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(16);
  const key = crypto.scryptSync(passphrase, salt, 32);
  const cipher = crypto.createCipheriv("aes-256-cbc", key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  // Format: SEED1 | salt(16) | iv(16) | ciphertext   (base64 on one line)
  return Buffer.concat([Buffer.from("SEED1"), salt, iv, enc]).toString("base64");
}

(async () => {
  let passphrase = process.env.SESSION_ENCRYPTION_KEY;
  let generated = false;
  if (!passphrase) {
    passphrase = crypto.randomBytes(24).toString("base64");
    generated = true;
  }

  const userDataDir = path.resolve(__dirname, "..", "User_Data");
  const context = await chromium.launchPersistentContext(userDataDir, { headless: true });
  const state = await context.storageState();
  await context.close();

  const tvCookies = state.cookies.filter(c => /tradingview/i.test(c.domain));
  const hasSession = tvCookies.some(c => /sessionid/i.test(c.name));

  const outPath = path.resolve(__dirname, "session.enc");
  fs.writeFileSync(outPath, encrypt(JSON.stringify(state), passphrase));

  console.log(`Total cookies: ${state.cookies.length}`);
  console.log(`TradingView cookies: ${tvCookies.length}`);
  console.log(`Has sessionid cookie: ${hasSession ? "YES" : "NO"}`);
  console.log(`localStorage origins: ${state.origins.length}`);
  console.log(`Wrote ENCRYPTED seed: ${outPath}  (${fs.statSync(outPath).size} bytes)`);
  if (generated) {
    console.log("\n=== SESSION_ENCRYPTION_KEY (add this as a GitHub Secret, shown once) ===");
    console.log(passphrase);
    console.log("=======================================================================");
  }
})().catch(e => { console.error("export failed:", e); process.exit(1); });
