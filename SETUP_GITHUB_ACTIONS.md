# Running this scraper for free on GitHub Actions

This folder is a ready-to-push repo. GitHub Actions runs `pipeline.js` on a
schedule, processes a slice of indicators each run, and commits the results
back to the repo. It remembers where it left off, so it grinds through the
list run after run with no machine of your own.

---

## 1. Read this first: public vs private repo (the money part)

GitHub Actions is only "unlimited free" on **public** repositories. On a
**private** repo the free plan gives ~2,000 minutes/month — and a 6-hour run
burns 360 of them, so you'd get roughly **5 runs a month** before it stops.
That is nowhere near enough for ~42,000 indicators.

| | Public repo | Private repo (free plan) |
|---|---|---|
| Runner minutes | Unlimited | ~2,000/month (≈5 long runs) |
| Your code | World-readable | Private |
| Scraped output committed to repo | World-readable | Private |
| Your TradingView password | **Stays hidden** (GitHub Secrets are never exposed, even on public repos) | Hidden |

So the realistic free path is a **public** repo. Your password is safe either
way (it lives in Secrets, not the code), but on a public repo the *scraped
Pine scripts and CSVs become public*, and mass-scraping may run against
TradingView's terms. If that's not acceptable, this is the point to switch to
the Oracle/Google VM route instead.

---

## 2. Create the repo and push

```bash
cd Datapipeline
git init
git add .
git commit -m "initial: scraper + Actions workflow"
git branch -M main
git remote add origin https://github.com/<you>/<repo>.git
git push -u origin main
```

`node_modules/`, `User_Data/`, and `.env` are gitignored on purpose — don't
commit them.

## 3. Add your TradingView credentials as Secrets

Repo → **Settings → Secrets and variables → Actions → New repository secret**.
Add two:

- `TRADINGVIEW_EMAIL`
- `TRADINGVIEW_PASSWORD`

Never put these in `.env` in the repo — Secrets is the only safe place.

## 3b. Connect Google Drive (where the scraped output goes)

The scraped scripts, CSVs, and `download_status.csv` are uploaded to **your
Google Drive** (your 5 TB) after every run — they are **not** committed to the
repo (only the tiny cursor is). This keeps `main` small and gives you room for
the multi-GB output. Setup is a one-time local step to authorize the runner.

> Use **OAuth (your own Google account)**, not a service account. A service
> account gets ~0 storage in *My Drive*, so uploads would fail against your
> 5 TB. OAuth uploads are owned by you and count against your Google One quota.

On your PC (one time):

```bash
# 1. Install rclone:  https://rclone.org/downloads/  (or: winget install Rclone.Rclone)
rclone config
#   n) New remote
#   name> gdrive                 <-- must be exactly "gdrive"
#   Storage> drive               (Google Drive)
#   client_id / client_secret>   leave blank (or use your own to avoid rate limits)
#   scope> 3   (drive.file)      <-- least privilege: rclone only sees files IT creates
#   Edit advanced config? n
#   Use web browser to authenticate? y   -> sign in, Allow
#   Configure as team drive? n
#   y) Yes this is OK  ->  q) Quit config

# 2. Verify it works:
rclone mkdir gdrive:Finalop1lack
rclone lsd gdrive:

# 3. Turn the config into one base64 line for the GitHub Secret:
#    Windows PowerShell:
[Convert]::ToBase64String([IO.File]::ReadAllBytes("$env:APPDATA\rclone\rclone.conf"))
#    macOS/Linux:
base64 -w0 ~/.config/rclone/rclone.conf
```

Copy that base64 string into a **third repository Secret**:

- `RCLONE_CONF_BASE64`  →  paste the base64 output

That's it — the workflow decodes it on each run and uploads to
`gdrive:Finalop1lack`. To see your data: open Google Drive → the
**`Finalop1lack`** folder (with `script/`, `csv/`, and `download_status.csv`).

> **Token safety:** this token can access files rclone created in your Drive.
> It lives only in GitHub Secrets (encrypted, never exposed — even on a public
> repo), and this workflow only runs on schedule/manual dispatch, so fork pull
> requests can't reach it. To revoke it later: Google Account → Security →
> Third-party access → remove **rclone**.

## 4. Give the workflow permission to commit

Repo → **Settings → Actions → General → Workflow permissions** →
select **Read and write permissions** → Save. Without this the "Commit
outputs" step can't push results back.

## 5. Do the first run by hand

Repo → **Actions → TradingView Scraper → Run workflow**. Start small to prove
the login and scraping work end to end:

- **batch_size**: `5`
- **start_override**: leave blank (it starts at index 41989)

Watch the log. If it logs in and saves a few scripts/CSVs, you're good. After
that, the schedule (every 6 hours) takes over automatically, and each run
resumes from `ci/state/cursor.txt`.

---

## How it works

- **Where it's up to:** `ci/state/cursor.txt` holds the next index to do. The
  workflow reads it, processes `batch_size` indicators, and writes the new
  value back. The cursor only advances if the run finished cleanly, so a
  crash retries the same slice instead of skipping it.
- **Login session:** the logged-in Chromium profile (`User_Data`) is saved to
  the Actions cache after each run and restored before the next, so the
  script's "already logged in?" check passes and it skips the login form most
  of the time. (Cache can be evicted after ~7 days unused; then it logs in
  fresh once and re-caches.)
- **Outputs:** uploaded to **Google Drive** at `gdrive:Finalop1lack/`
  (`script/`, `csv/`, and the cumulative `download_status.csv`). Uploaded with
  `rclone copy`, which only sends new files and never deletes. The status
  master is pulled down before each run so its running history is preserved.
  Nothing heavy is committed to the repo — only `ci/state/cursor.txt`.
- **Logs & crash screenshots:** attached to each run as a downloadable
  **artifact** (Actions → the run → Artifacts), kept 14 days. Not committed.

## Tuning

- **Batch size / schedule:** raise `batch_size` once you know how long one
  indicator takes. Rule of thumb: keep the whole run comfortably under ~5
  hours. Edit the `cron:` line in `.github/workflows/scrape.yml` to change how
  often it runs (it's UTC).
- **Jump to a specific index:** trigger manually with `start_override` set.
- **Throughput reality:** even running flat out on a public repo, one
  TradingView account scraping tens of thousands of indicators is inherently
  slow — think weeks, not hours. Don't parallelize with a job matrix: multiple
  simultaneous logins from one account is exactly what gets an account
  flagged.

## If login gets challenged

GitHub's shared runner IPs are heavily flagged by sites like TradingView, so
you may hit a captcha / "new device" email / 2FA that automation can't pass.
If that happens repeatedly, the cached-session trick won't save you and the
VM route (Oracle/Google) is the more reliable home for a logged-in scraper —
its IP behaves more like a normal browser and the profile persists on disk.
