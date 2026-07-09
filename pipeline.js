// =============================================================================
// TradingView Indicator Scraper - BATCH MODE V2 (Two-Phase Execution)
// =============================================================================
// Usage:  node speedvcommunityindicator_batch_v2.js --from 1 --to 5
//         node speedvcommunityindicator_batch_v2.js --idx 1,2,3
// =============================================================================

const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const CONFIG = {
    chartUrl: "https://www.tradingview.com/chart/",
    inputFilePath: path.resolve(__dirname, "InputForScript", "unique_indicator_names.txt"),
    scriptOutputDir: path.resolve(__dirname, "Finalop1lack", "script"),
    csvOutputDir: path.resolve(__dirname, "Finalop1lack", "csv"),
    logsDir: path.resolve(__dirname, "Logs"),
    maxRetries: 3,
};

const W = (page, ms) => page.waitForTimeout(ms);

async function closeAllExtraTabs(context) {
    try {
        const pages = context.pages();
        for (const p of pages) {
            if (!p.__isMainPage) {
                try { await p.close(); } catch { }
            }
        }
    } catch { }
}

// ─────────────────────────────────────────────────────────────────────────────
// Load Credentials & Utilities
// ─────────────────────────────────────────────────────────────────────────────
function loadCredentials() {
    const envPath = path.resolve(__dirname, ".env");
    if (fs.existsSync(envPath)) {
        for (const line of fs.readFileSync(envPath, "utf-8").split(/\r?\n/)) {
            const match = line.match(/^\s*([A-Z_]+)\s*=\s*(.+?)\s*$/);
            if (match) process.env[match[1]] = match[2];
        }
    }
    const args = process.argv.slice(2);
    let email = process.env.TRADINGVIEW_EMAIL || null;
    let password = process.env.TRADINGVIEW_PASSWORD || null;
    for (let i = 0; i < args.length; i++) {
        if (args[i] === "--email" && args[i + 1]) email = args[++i];
        else if (args[i] === "--password" && args[i + 1]) password = args[++i];
    }
    if (!email || !password) {
        console.error("❌ Missing credentials. Set TRADINGVIEW_EMAIL / TRADINGVIEW_PASSWORD in .env");
        process.exit(1);
    }
    return { email, password };
}

function normalizeFilename(name) {
    return name.toLowerCase()
        .replace(/\s+/g, "_")
        .replace(/[^a-z0-9_]/g, "")
        .replace(/_+/g, "_")
        .replace(/^_+|_+$/g, "");
}

function getIndicatorNameByIndex(idx) {
    if (!fs.existsSync(CONFIG.inputFilePath)) throw new Error(`❌ Input file not found: ${CONFIG.inputFilePath}`);
    const lines = fs.readFileSync(CONFIG.inputFilePath, "utf-8").split(/\r?\n/);
    for (const line of lines) {
        const match = line.trim().match(/^(\d+)\.\s+(.+)$/);
        if (match && parseInt(match[1], 10) === idx) return match[2].trim();
    }
    throw new Error(`❌ Indicator index ${idx} not found in input file.`);
}

function filterLicenseLines(code) {
    const filtered = code.split("\n").filter(line => {
        const t = line.replace(/[\u00A0\u2000-\u200B\u202F\u205F\u3000]/g, " ").trim();
        if (t.startsWith("// This work is licensed under")) return false;
        if (t.includes("This work is licensed under") && t.startsWith("//")) return false;
        if (/^\/\/\s*[©\u00A9]/.test(t)) return false;
        if (/^\/\/\s*\(c\)/i.test(t)) return false;
        return true;
    });
    while (filtered.length > 0 && filtered[0].trim() === "") filtered.shift();
    return filtered.join("\n");
}

function looksLikePineScript(text) {
    if (!text || text.length < 50) return false;
    return text.includes("//@version") || text.includes("indicator(") ||
        text.includes("study(") || text.includes("strategy(") || text.includes("library(");
}

function parseIndicatorIndices() {
    const args = process.argv.slice(2);
    const indices = [];
    for (let i = 0; i < args.length; i++) {
        if (args[i] === "--from" && args[i + 1]) {
            const from = parseInt(args[i + 1], 10);
            i++;
            let to = from;
            for (let j = i + 1; j < args.length; j++) {
                if (args[j] === "--to" && args[j + 1]) { to = parseInt(args[j + 1], 10); break; }
            }
            for (let k = from; k <= to; k++) indices.push(k);
        } else if (args[i] === "--idx" && args[i + 1]) {
            for (const part of args[i + 1].split(",")) {
                const n = parseInt(part.trim(), 10);
                if (!isNaN(n)) indices.push(n);
            }
            i++;
        }
    }
    if (indices.length === 0) {
        console.error("Usage: node speedvcommunityindicator_batch_v2.js --from 1 --to 5");
        process.exit(1);
    }
    return [...new Set(indices)];
}

// ─────────────────────────────────────────────────────────────────────────────
// UI Selectors and Core Functions
// ─────────────────────────────────────────────────────────────────────────────
async function findSearchInput(page) {
    for (const sel of [
        '[data-name="indicators-dialog"] input[type="text"]',
        '[data-name="indicators-dialog"] input[type="search"]',
        '[data-name="indicators-dialog"] input',
        'input[placeholder*="Search"]',
    ]) {
        try { const el = await page.$(sel); if (el && (await el.isVisible())) return el; } catch { }
    }
    return null;
}

async function clearSearchInput(page, searchInput) {
    await searchInput.click();
    await searchInput.fill("");
    await W(page, 100);
}

async function openIndicatorsDialog(page) {
    try {
        const canvas = await page.$('canvas');
        if (canvas) await canvas.click({ force: true });
        await W(page, 200);
    } catch { }

    const existing = await page.$('[data-name="indicators-dialog"]');
    if (existing && (await existing.isVisible())) return true;
    try {
        await page.click('[data-name="open-indicators-dialog"]', { timeout: 3000 });
        await page.waitForSelector('[data-name="indicators-dialog"]', { timeout: 5000 });
        return true;
    } catch {
        try {
            await page.keyboard.press("/");
            await page.waitForSelector('[data-name="indicators-dialog"]', { timeout: 5000 });
            return true;
        } catch { return false; }
    }
}

async function closeIndicatorsDialog(page) {
    for (const sel of ['[data-name="indicators-dialog"] button[data-name="close"]', '[data-name="indicators-dialog"] [class*="close"]', 'button[data-name="close"]']) {
        try { const el = await page.$(sel); if (el && (await el.isVisible())) { await el.click(); await W(page, 300); return; } } catch { }
    }
    await page.keyboard.press("Escape"); await W(page, 300);
}

async function getLegendItems(page) {
    const legendSelectors = [
        '[data-name="legend-source-item"]',
        '[class*="sourcesWrapper"] [class*="source-"]',
        '[class*="legend"] [class*="source"]',
        '[class*="pane-legend"] [class*="item"]',
    ];
    for (const sel of legendSelectors) {
        try {
            const items = await page.$$(sel);
            if (items.length > 1) return items; // Only select if we have indicators added (length > 1)
        } catch { }
    }
    // Fallback: return the first one even if 1 or 0
    for (const sel of legendSelectors) {
        try {
            const items = await page.$$(sel);
            if (items.length > 0) return items;
        } catch { }
    }
    return [];
}

async function removeAllIndicators(page) {
    console.log("🧹 Clearing indicators from the chart...");
    for (let i = 0; i < 3; i++) { await page.keyboard.press("Escape"); await W(page, 150); }

    let rightClicked = false;
    const chartContainers = [
        'div[class*="chart-container"] canvas',
        'div[class*="chart-widget"] canvas',
        'canvas[class*="pane"]',
        'canvas',
        'div[class*="chart-container"]',
        'div[class*="chart-widget"]',
    ];
    for (const sel of chartContainers) {
        try {
            const el = await page.$(sel);
            if (el && (await el.isVisible())) {
                await el.click({ button: "right", force: true });
                rightClicked = true;
                break;
            }
        } catch { }
    }

    if (!rightClicked) {
        try { await page.mouse.click(960, 540, { button: "right" }); rightClicked = true; } catch { }
    }

    await W(page, 1500);

    const menuSelectors = [
        '[role="menuitem"]',
        '[class*="item-"]',
        '[class*="menu"] div',
        '[class*="context"] div',
        'div[class*="content-"]'
    ];

    let clickedRemove = false;
    let removeSubmenuEl = null;

    for (const selector of menuSelectors) {
        try {
            const els = await page.$$(selector);
            for (const el of els) {
                if (!(await el.isVisible())) continue;
                const txt = (await el.textContent() || "").trim();
                const lowerTxt = txt.toLowerCase();

                const isDirectAction = lowerTxt.startsWith("remove") && lowerTxt.includes("indicator");
                if (isDirectAction) {
                    const clicked = await page.evaluate((element) => {
                        let parent = element;
                        while (parent) {
                            const role = parent.getAttribute("role");
                            const className = parent.className || "";
                            if (role === "menuitem" || className.includes("item-") || className.includes("content-")) {
                                parent.click(); return "Clicked parent";
                            }
                            parent = parent.parentElement;
                            if (parent && (parent.tagName === "BODY" || parent.tagName === "HTML")) break;
                        }
                        element.click(); return "Clicked directly";
                    }, el);
                    clickedRemove = true;
                    await W(page, 2000);
                    break;
                }

                const isSubmenu = txt === "Remove" || txt === "Remove..." || lowerTxt === "remove" || txt.startsWith("Remove\u00a0") || txt.startsWith("Remove ›");
                if (!removeSubmenuEl && isSubmenu) {
                    removeSubmenuEl = el;
                }
            }
            if (clickedRemove) break;
        } catch { }
    }

    // Try submenu hover if direct click not found
    if (!clickedRemove && removeSubmenuEl) {
        try {
            await removeSubmenuEl.hover({ force: true });
            await W(page, 1000);

            for (const selector of menuSelectors) {
                const els = await page.$$(selector);
                for (const el of els) {
                    if (!(await el.isVisible())) continue;
                    const txt = (await el.textContent() || "").trim();
                    const lowerTxt = txt.toLowerCase();
                    const isDirectAction = lowerTxt.startsWith("remove") && lowerTxt.includes("indicator");
                    if (isDirectAction) {
                        const clicked = await page.evaluate((element) => {
                            let parent = element;
                            while (parent) {
                                const role = parent.getAttribute("role");
                                const className = parent.className || "";
                                if (role === "menuitem" || className.includes("item-") || className.includes("content-")) {
                                    parent.click(); return "Clicked parent";
                                }
                                parent = parent.parentElement;
                                if (parent && (parent.tagName === "BODY" || parent.tagName === "HTML")) break;
                            }
                            element.click(); return "Clicked directly";
                        }, el);
                        clickedRemove = true;
                        await W(page, 2000);
                        break;
                    }
                }
                if (clickedRemove) break;
            }
        } catch { }
    }

    if (!clickedRemove) {
        await page.keyboard.press("Escape");
        await W(page, 500);

        try {
            const legendItems = await getLegendItems(page);
            if (legendItems.length > 1) {
                console.log(`   📋 Found ${legendItems.length - 1} indicator(s) in legend. Removing sequentially...`);
                for (let i = legendItems.length - 1; i >= 1; i--) {
                    const item = legendItems[i];
                    try {
                        await item.hover({ force: true, timeout: 2000 });
                        await W(page, 300);

                        for (const btnSel of [
                            'button[title="Remove"]',
                            '[data-name="legend-source-action"][title="Remove"]',
                            '[class*="button"][title="Remove"]',
                            '[title="Remove"]',
                            'button[data-name="remove"]'
                        ]) {
                            const btn = await item.$(btnSel);
                            if (btn && (await btn.isVisible())) {
                                await btn.click({ force: true });
                                await W(page, 500);
                                break;
                            }
                        }
                    } catch { }
                }
            }
        } catch (err) {
            console.log(`   ⚠️ Legend-based cleanup failed: ${err.message}`);
        }
    }

    console.log("   🔄 Reloading chart page (Ctrl+R equivalent)...");
    try {
        await page.reload({ waitUntil: "load", timeout: 60000 });
        try { await page.waitForSelector('[data-name="legend-source-item"], canvas', { timeout: 10000 }); await W(page, 3000); } catch { }
        await dismissPopups(page);
        console.log("   ✅ Chart page reloaded and ready.");
    } catch (reloadErr) {
        console.log("   ⚠️ Page reload timed out, trying to proceed anyway...");
    }
}

async function selectTechnicalIndicator(page, indicatorName) {
    for (const sel of ['[data-name="indicators-dialog"] [data-id="technicals"]', '[data-name="indicators-dialog"] [data-name="technicals"]']) {
        try { const el = await page.$(sel); if (el && (await el.isVisible())) { await el.click(); break; } } catch { }
    }
    await W(page, 500);

    let searchInput = await findSearchInput(page);
    if (!searchInput) throw new Error("Search input not found");
    await clearSearchInput(page, searchInput);
    await searchInput.fill(indicatorName);

    let listItems = [];
    for (let poll = 0; poll < 15; poll++) { await W(page, 300); listItems = await page.$$('div[data-role="list-item"]'); if (listItems.length > 0) break; }
    if (listItems.length === 0) throw new Error(`No results for "${indicatorName}"`);

    let targetItem = null, targetTitle = "";
    for (const item of listItems) {
        const dt = (await item.getAttribute("data-title")) || ""; const tc = (await item.textContent()) || "";
        if (dt === indicatorName || tc.replace(/\r?\n/g, " ").trim() === indicatorName) { targetItem = item; targetTitle = dt || tc.substring(0, 60); break; }
    }
    if (!targetItem) for (const item of listItems) {
        const dt = (await item.getAttribute("data-title")) || ""; const tc = (await item.textContent()) || "";
        if (dt === indicatorName || tc.includes(indicatorName)) { targetItem = item; targetTitle = dt || tc.substring(0, 60); break; }
    }
    if (!targetItem) { targetItem = listItems[0]; targetTitle = (await targetItem.getAttribute("data-title")) || ((await targetItem.textContent()) || "").substring(0, 60); }

    try { const t = await targetItem.$('[data-name="list-item-title"]'); if (t && (await t.isVisible())) await t.click({ timeout: 3000 }); else await targetItem.click({ timeout: 3000 }); }
    catch { try { await targetItem.click({ force: true }); } catch { await targetItem.dispatchEvent("click"); } }
    await W(page, 1000);
    return targetTitle;
}

// ─────────────────────────────────────────────────────────────────────────────
// Extract Source Logic
// ─────────────────────────────────────────────────────────────────────────────
async function findEditorContainer(page) {
    for (const sel of [".tv-script-widget .monaco-editor", ".pine-editor-monaco.standalone",
        '[class*="editorBaseLayoutContainer-dialog"] .monaco-editor', ".pine-editor-monaco", ".monaco-editor"]) {
        try { const el = await page.$(sel); if (el && (await el.isVisible())) return { element: el, selector: sel }; } catch { }
    }
    return null;
}

async function extractSourceFromPage(page) {
    try {
        await page.waitForSelector('.monaco-editor, [class*="editorBaseLayoutContainer-dialog"], .view-lines', { timeout: 10000 });
        await W(page, 800);
    } catch { }

    const monacoResult = await page.evaluate(() => {
        try {
            if (typeof monaco !== "undefined" && monaco.editor) {
                const models = monaco.editor.getModels();
                if (models) for (let i = models.length - 1; i >= 0; i--) { const v = models[i].getValue(); if (v?.length > 50) return { source: v }; }
                const editors = monaco.editor.getEditors();
                if (editors) for (let i = editors.length - 1; i >= 0; i--) { const m = editors[i].getModel(); if (m) { const v = m.getValue(); if (v?.length > 50) return { source: v }; } }
            }
        } catch { }
        return null;
    });
    if (monacoResult?.source && looksLikePineScript(monacoResult.source)) return monacoResult.source;

    const editorInfo = await findEditorContainer(page);
    const editorContainerSel = editorInfo ? editorInfo.selector : ".monaco-editor";

    try {
        await page.bringToFront();
        for (const sel of [`${editorContainerSel} .view-lines`, editorContainerSel]) {
            try { const el = await page.$(sel); if (el && (await el.isVisible())) { await el.click({ position: { x: 10, y: 10 }, timeout: 1500 }); break; } } catch { }
        }
        await page.evaluate(s => { const c = document.querySelector(s); if (c) { const ta = c.querySelector("textarea.inputarea"); if (ta) ta.focus(); else c.focus(); } }, editorContainerSel);
        await W(page, 200);
        await page.keyboard.press("Control+A"); await W(page, 150);
        await page.keyboard.press("Control+C"); await W(page, 300);
        const clipText = await page.evaluate(async () => { try { return await navigator.clipboard.readText(); } catch { return null; } });
        if (clipText && looksLikePineScript(clipText) && clipText.length > 100) return clipText;
    } catch { }

    try {
        const r = await page.evaluate(s => {
            for (const c of [document.querySelector(".tv-script-widget .view-lines"), document.querySelector(s + " .view-lines"), document.querySelector(".view-lines")]) {
                if (!c) continue; const els = c.querySelectorAll(".view-line"); if (els.length < 3) continue;
                const text = Array.from(els).map(e => (e.textContent || "").replace(/[\u00A0\u2000-\u200B\u202F\u205F\u3000]/g, " ")).join("\n");
                if (text.length > 50) return text;
            }
            return null;
        }, editorContainerSel);
        if (r && looksLikePineScript(r)) return r;
    } catch { }

    const fallback = await page.evaluate(() => {
        for (const ta of document.querySelectorAll("textarea")) { if (ta.value?.length > 100 && ta.value.includes("//@version")) return ta.value; }
        for (const el of document.querySelectorAll("pre, code")) { const t = el.textContent; if (t?.length > 100 && t.includes("//@version")) return t; }
        return null;
    });
    if (fallback) return fallback;

    return null;
}

async function extractSourceFromChartLegend(page, context) {
    let legendItems = [];
    for (let poll = 0; poll < 20; poll++) {
        for (const sel of ['[data-name="legend-source-item"]', '[class*="sourcesWrapper"] [class*="source-"]',
            '[class*="legend"] [class*="source"]', '[class*="pane-legend"] [class*="item"]']) {
            try {
                const items = await page.$$(sel);
                if (items.length > 1) { legendItems = items; break; }
                if (items.length > 0 && legendItems.length === 0) legendItems = items;
            } catch { }
        }
        if (legendItems.length > 1) break;
        await W(page, 500);
    }
    if (legendItems.length === 0) throw new Error("No legend items found on chart legend.");

    const targetLegend = legendItems[legendItems.length - 1];

    try { await targetLegend.hover({ force: true, position: { x: 10, y: 10 }, timeout: 3000 }); }
    catch { await targetLegend.dispatchEvent("pointerover"); await targetLegend.dispatchEvent("mouseover"); }
    await W(page, 500);

    let sourceCodeBtn = null;
    for (const sel of ['button[title="Source code"]', '[data-name="legend-source-action"][title="Source code"]', '[title="Source code"]']) {
        try { const el = await targetLegend.$(sel); if (el && (await el.isVisible())) { sourceCodeBtn = el; break; } } catch { }
    }
    if (!sourceCodeBtn) for (const sel of ['button[title="Source code"]', '[title="Source code"]']) {
        try { for (const el of await page.$$(sel)) { if (await el.isVisible()) { sourceCodeBtn = el; break; } } if (sourceCodeBtn) break; } catch { }
    }
    if (!sourceCodeBtn) throw new Error("Source code button not found.");

    const newPagePromise = context.waitForEvent("page", { timeout: 5000 }).catch(() => null);
    try { await sourceCodeBtn.click({ timeout: 3000 }); } catch { try { await sourceCodeBtn.click({ force: true }); } catch { await sourceCodeBtn.dispatchEvent("click"); } }

    try { await page.waitForSelector('.monaco-editor, .view-lines', { timeout: 8000 }); await W(page, 500); } catch { await W(page, 2000); }

    let code = null;
    const newPage = await newPagePromise;
    if (newPage) { try { await newPage.waitForLoadState("domcontentloaded", { timeout: 10000 }); await W(page, 1000); code = await extractSourceFromPage(newPage); } catch { } await newPage.close(); }
    if (!code) code = await extractSourceFromPage(page);
    return code;
}

async function extractAboutDetails(page, context, indicatorName) {
    try {
        if (!(await openIndicatorsDialog(page))) return null;
        await W(page, 300);
        let si = await findSearchInput(page); if (!si) return null;
        await clearSearchInput(page, si);
        await si.fill(indicatorName);
        let items = []; for (let p = 0; p < 10; p++) { await W(page, 300); items = await page.$$('div[data-role="list-item"]'); if (items.length > 0) break; }
        let target = items[0]; for (const it of items) { const dt = (await it.getAttribute("data-title")) || ""; if (dt === indicatorName || (await it.textContent())?.includes(indicatorName)) { target = it; break; } }
        if (!target) { await closeIndicatorsDialog(page); return null; }
        await target.hover(); await W(page, 500);
        let clickTarget = await target.$('span[title="Read more"], a[title="Read more"], [title*="Read more"]');
        if (!clickTarget) { await closeIndicatorsDialog(page); return null; }
        await page.evaluate(() => { window.__lastOpenedUrl = null; const o = window.open; window.open = function (u) { if (u) window.__lastOpenedUrl = u; return o.apply(this, arguments); }; });
        const npp = context.waitForEvent("page", { timeout: 5000 }).catch(() => null);
        await clickTarget.evaluate(el => { el.click(); el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); });
        await W(page, 1000);
        let url = await page.evaluate(() => window.__lastOpenedUrl);
        if (url) { if (!url.startsWith("http")) url = (await page.evaluate(() => location.origin)) + url; await closeIndicatorsDialog(page); for (const p of context.pages()) if (!p.__isMainPage) try { await p.close(); } catch { } return { sourceUrl: url }; }
        let ap = await npp; if (!ap) for (const p of context.pages()) { if (!p.__isMainPage && p.url().includes("tradingview.com")) { ap = p; break; } }
        if (ap) { await ap.waitForLoadState("domcontentloaded", { timeout: 10000 }); url = ap.url(); try { await ap.close(); } catch { } return { sourceUrl: url }; }
        await closeIndicatorsDialog(page); return null;
    } catch { try { await page.keyboard.press("Escape"); } catch { } return null; }
}

// ─────────────────────────────────────────────────────────────────────────────
// Login & Popup Handling
// ─────────────────────────────────────────────────────────────────────────────
async function dismissPopups(page) {
    for (let i = 0; i < 2; i++) { await page.keyboard.press("Escape"); await W(page, 100); }
    for (const sel of ['[data-name="accept-cookies"]', 'button:has-text("Accept")', 'button:has-text("Got it")']) {
        try { const el = await page.$(sel); if (el && (await el.isVisible())) { await el.click(); await W(page, 100); } } catch { }
    }
    try { const c = page.locator('button').filter({ hasText: /^Connect$/ }).first(); if (await c.count() > 0 && await c.isVisible()) { await c.click({ force: true }); await W(page, 2000); } } catch { }
}

async function loginToTradingView(page, email, password) {
    console.log("🔐 Step 1: Checking login status...");
    await page.goto("https://www.tradingview.com/chart/", { waitUntil: "load", timeout: 60000 });

    try {
        await page.waitForSelector('[data-name="legend-source-item"], canvas', { timeout: 10000 });
        await W(page, 2000);
    } catch {
        await W(page, 5000);
    }

    const checkLoggedIn = async () => {
        return await page.evaluate(() => {
            return !!(document.querySelector('[class*="userAvatar"]') ||
                document.querySelector('[class*="avatar"]') ||
                document.querySelector('.is-authenticated'));
        });
    };

    if (await checkLoggedIn()) {
        console.log("   ✅ Already logged in!\n");
        return;
    }

    await dismissPopups(page);

    console.log("   🖱️ Opening user menu...");
    let menuBtn = null;
    for (const sel of ['button[data-name="header-user-menu-button"]', '[class*="header-user-menu-button"]']) {
        try {
            const el = await page.$(sel);
            if (el && await el.isVisible()) { menuBtn = el; break; }
        } catch { }
    }
    if (!menuBtn) {
        try {
            const handle = await page.evaluateHandle(() => {
                const buttons = Array.from(document.querySelectorAll('button'));
                return buttons.find(b => {
                    const rect = b.getBoundingClientRect();
                    return rect.left >= 0 && rect.left <= 20 && rect.top >= 0 && rect.top <= 20 && rect.width > 0 && rect.height > 0;
                }) || null;
            });
            if (handle) {
                const el = handle.asElement();
                if (el) menuBtn = el;
            }
        } catch { }
    }
    if (menuBtn) {
        await menuBtn.click();
    } else {
        await page.mouse.click(26, 19);
    }
    await W(page, 2000);

    let signInClicked = false;
    for (const sel of ['[aria-label="Sign in"]', '[data-name="signin"]', 'span:has-text("Sign in")', 'button:has-text("Sign in")', 'div:has-text("Sign in")']) {
        try {
            const els = await page.$$(sel);
            for (const el of els) {
                const text = await el.textContent();
                if (await el.isVisible() && text?.trim().toLowerCase() === "sign in") {
                    await el.click();
                    signInClicked = true;
                    break;
                }
            }
            if (signInClicked) break;
        } catch { }
    }
    await W(page, 2000);

    let emailClicked = false;
    for (const sel of ['button[name="Email"]', 'button:has-text("Email")', 'span:has-text("Email")', 'div:has-text("Email")']) {
        try {
            const els = await page.$$(sel);
            for (const el of els) {
                if (await el.isVisible() && (await el.textContent())?.toLowerCase().includes("email")) {
                    await el.click();
                    emailClicked = true;
                    break;
                }
            }
            if (emailClicked) break;
        } catch { }
    }
    await W(page, 2000);

    let emailInput = null;
    for (const sel of ['#id_username', 'input[name="username"]', 'input[type="email"]', 'input[placeholder*="Email"]']) {
        try { const el = await page.$(sel); if (el && await el.isVisible()) { emailInput = el; break; } } catch { }
    }
    if (!emailInput) throw new Error("❌ Email input not found");
    await emailInput.click();
    await emailInput.fill(email);

    let passInput = null;
    for (const sel of ['#id_password', 'input[name="password"]', 'input[type="password"]']) {
        try { const el = await page.$(sel); if (el && await el.isVisible()) { passInput = el; break; } } catch { }
    }
    if (!passInput) throw new Error("❌ Password input not found");
    await passInput.click();
    await passInput.fill(password);
    await W(page, 200);

    for (const sel of ['button[type="submit"]', '[class*="submitButton"]']) {
        try {
            const el = await page.$(sel);
            if (el && await el.isVisible()) { await el.click(); break; }
        } catch { }
    }

    try {
        await page.waitForSelector('[class*="userAvatar"], [class*="avatar"]', { timeout: 15000 });
        console.log("   ✅ Login successful!\n");
        return;
    } catch { }

    console.log("   ⚠️ May need Captcha. Waiting up to 2 min...");
    const manualStart = Date.now();
    while (Date.now() - manualStart < 120000) {
        if (await checkLoggedIn()) { console.log("   ✅ Manual login detected!\n"); return; }
        await W(page, 2000);
    }
    throw new Error("❌ Login failed");
}

// ─────────────────────────────────────────────────────────────────────────────
// CSV Extraction Logic (No reload, switches timeframe + Table view)
// ─────────────────────────────────────────────────────────────────────────────
async function downloadCsvFast(page, context, csvFilePath) {
    console.log("   📊 Downloading CSV (fast — no reload)...");

    for (let i = 0; i < 3; i++) { await page.keyboard.press("Escape"); await W(page, 200); }

    try {
        const canvas = await page.$('canvas');
        if (canvas) { await canvas.click({ force: true }); await W(page, 200); }
        await page.keyboard.type("5"); await W(page, 200); await page.keyboard.press("Enter"); await W(page, 2000);
    } catch { }

    for (const sel of ['canvas[class*="pane"]', 'canvas']) {
        try { const el = await page.$(sel); if (el && (await el.isVisible())) { await el.click({ button: "right", force: true }); break; } } catch { }
    }
    await W(page, 800);

    const newPagePromise = context.waitForEvent("page", { timeout: 10000 }).catch(() => null);
    let clickedTV = false;
    try {
        for (const el of await page.$$('[role="menuitem"], [class*="item-"], div, span')) {
            try { const t = (await el.textContent())?.trim(); if ((t === "Table view" || t === "Table View") && (await el.isVisible())) { await el.click({ force: true }); clickedTV = true; break; } } catch { }
        }
    } catch { }
    if (!clickedTV) throw new Error("Could not find Table view");

    let tablePage = page;
    const newTab = await newPagePromise;
    if (newTab) { tablePage = newTab; await tablePage.waitForLoadState("domcontentloaded", { timeout: 10000 }); await W(tablePage, 1000); }
    else { await W(page, 1500); for (const p of context.pages()) { if (!p.__isMainPage && p.url().includes("tradingview")) { tablePage = p; await tablePage.waitForLoadState("domcontentloaded", { timeout: 10000 }); break; } } }

    await tablePage.evaluate(() => { window.__capturedDownloadData = null; window.__capturedDownloadFilename = null; });
    const dlPromise = tablePage.waitForEvent("download", { timeout: 20000 }).catch(() => null);

    let clicked = false;
    for (const sel of ['a:has-text("Download data")', 'button:has-text("Download data")', 'span:has-text("Download data")']) {
        try { for (const el of await tablePage.$$(sel)) { if ((await el.textContent())?.trim() === "Download data" && await el.isVisible()) { await el.click(); clicked = true; break; } } if (clicked) break; } catch { }
    }
    if (!clicked) { try { const l = tablePage.getByText("Download data", { exact: true }); if (await l.isVisible()) { await l.click(); clicked = true; } } catch { } }
    if (!clicked) throw new Error("Download data button not found");

    await W(tablePage, 1500);

    try { const btns = tablePage.locator('button'); const c = await btns.count(); for (let i = 0; i < c; i++) { const b = btns.nth(i); const t = ((await b.textContent()) || "").trim().toLowerCase(); if ((t === "download" || t === "export" || t === "confirm") && await b.isVisible()) { await b.click({ force: true }); break; } } } catch { await tablePage.keyboard.press("Enter"); }

    await W(tablePage, 3000);
    const cap = await tablePage.evaluate(() => ({ data: window.__capturedDownloadData, filename: window.__capturedDownloadFilename }));
    if (cap.data?.length > 0) {
        fs.writeFileSync(csvFilePath, cap.data, "utf-8");
        console.log(`   ✅ CSV downloaded: ${cap.data.split('\n').length} rows`);
    } else {
        const dl = await dlPromise;
        if (dl) {
            await dl.saveAs(csvFilePath);
            console.log("   ✅ CSV downloaded via event");
        } else {
            await W(tablePage, 3000);
            const r = await tablePage.evaluate(() => ({ data: window.__capturedDownloadData }));
            if (r.data?.length > 0) {
                fs.writeFileSync(csvFilePath, r.data, "utf-8");
                console.log("   ✅ CSV downloaded via retry");
            } else {
                throw new Error("CSV download failed");
            }
        }
    }

    const cleaned = await cleanCsvDuplicates(csvFilePath);
    if (!cleaned) {
        throw new Error("CSV verification failed: 'Volume' column is missing or CSV is invalid.");
    }
    console.log("   Volume Present");

    if (tablePage && !tablePage.__isMainPage) try { await tablePage.close(); } catch { }
}

async function cleanCsvDuplicates(csvFilePath) {
    if (!fs.existsSync(csvFilePath)) return false;
    let content = "";
    for (let attempt = 0; attempt < 6; attempt++) {
        try {
            content = fs.readFileSync(csvFilePath, "utf-8");
            if (content.trim().length > 10) break;
        } catch { }
        await new Promise(r => setTimeout(r, 500));
    }
    try {
        const lines = content.split(/\r?\n/);
        if (!lines[0]) return false;
        const headers = lines[0].split(",");

        // Confirm Volume is present (case-insensitive check)
        const hasVolume = headers.some(h => h.trim().toLowerCase() === "volume");
        if (!hasVolume) return false;

        const standard = new Set(["time", "date", "open", "high", "low", "close", "change", "volume"]);
        const keep = [], keepH = [], seen = new Set(), seenInd = new Set();
        for (const t of ["time", "open", "high", "low", "close"]) { const i = headers.findIndex(h => h.toLowerCase().trim() === t); if (i !== -1 && !seen.has(t)) { keep.push(i); keepH.push(headers[i]); seen.add(t); } }
        const vi = headers.findIndex(h => h.toLowerCase().trim() === "volume"); if (vi !== -1 && !seen.has("volume")) { keep.push(vi); keepH.push("Volume"); seen.add("volume"); }
        for (let i = 0; i < headers.length; i++) {
            const h = headers[i].toLowerCase().trim();
            if (standard.has(h)) continue;
            if (h !== "plot" && seenInd.has(h)) continue;
            seenInd.add(h);
            keep.push(i);
            keepH.push(headers[i]);
        }
        const out = [keepH.join(",")];
        for (let i = 1; i < lines.length; i++) { const l = lines[i].trim(); if (!l) continue; const c = l.split(","); out.push(keep.map(j => (j < c.length ? c[j] : "")).join(",")); }
        fs.writeFileSync(csvFilePath, out.join("\n"), "utf-8");
        return true;
    } catch (err) {
        console.error("   ❌ Error in cleanCsvDuplicates:", err.message);
        return false;
    }
}

function validateCsvFile(csvFilePath) {
    if (!fs.existsSync(csvFilePath)) return { valid: false, reason: "File does not exist" };
    try {
        const content = fs.readFileSync(csvFilePath, "utf-8").trim();
        if (!content) return { valid: false, reason: "File is empty" };

        const lines = content.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
        if (lines.length < 2) return { valid: false, reason: "CSV contains only headers or no data" };

        const headers = lines[0].split(",").map(h => h.trim().toLowerCase());
        const standardCols = ["time", "date", "open", "high", "low", "close", "volume"];

        // Check if standard columns are present
        const hasTime = headers.includes("time") || headers.includes("date");
        const hasOpen = headers.includes("open");
        const hasHigh = headers.includes("high");
        const hasLow = headers.includes("low");
        const hasClose = headers.includes("close");
        const hasVolume = headers.includes("volume");

        if (!hasTime || !hasOpen || !hasHigh || !hasLow || !hasClose || !hasVolume) {
            return { valid: false, reason: "Missing one or more compulsory OHLCV columns" };
        }

        // Find indicator columns (excluding standard ones and 'change')
        const indicatorHeaders = headers.filter(h => !standardCols.includes(h) && h !== "change");
        if (indicatorHeaders.length === 0) {
            return { valid: false, reason: "No indicator columns found (only OHLCV columns present)" };
        }

        // Map required headers to their indices
        const ohlcvIndices = ["time", "date", "open", "high", "low", "close", "volume"]
            .map(col => headers.indexOf(col))
            .filter(idx => idx !== -1);
        const indicatorIndices = indicatorHeaders.map(col => headers.indexOf(col));

        // Scan all data rows for null/empty/NaN values
        for (let i = 1; i < lines.length; i++) {
            const rowCells = lines[i].split(",").map(c => c.trim());

            // Check OHLCV cells
            for (const idx of ohlcvIndices) {
                const cell = rowCells[idx];
                if (cell === undefined || cell === "" || cell.toLowerCase() === "null" || cell.toLowerCase() === "nan" || cell.toLowerCase() === "undefined") {
                    return { valid: false, reason: `Null/empty/NaN value found in OHLCV columns at row ${i + 1}` };
                }
            }

            // Check Indicator cells
            for (const idx of indicatorIndices) {
                const cell = rowCells[idx];
                if (cell === undefined || cell === "" || cell.toLowerCase() === "null" || cell.toLowerCase() === "nan" || cell.toLowerCase() === "undefined") {
                    return { valid: false, reason: `Null/empty/NaN value found in indicator columns at row ${i + 1}` };
                }
            }
        }

        return { valid: true, indicatorColumns: indicatorHeaders };
    } catch (err) {
        return { valid: false, reason: `Error reading/parsing CSV: ${err.message}` };
    }
}

function updateStatusCsv(statusItem) {
    const csvPath = path.resolve(CONFIG.scriptOutputDir, "..", "download_status.csv");
    const dir = path.dirname(csvPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const headers = ["Index", "Indicator Name", "CSV Status", "CSV Error Reason", "Pine Script Status", "Source URL", "Last Updated"];
    let rows = [];

    if (fs.existsSync(csvPath)) {
        try {
            const content = fs.readFileSync(csvPath, "utf-8").trim();
            if (content) {
                const lines = content.split(/\r?\n/);
                const parseCsvLine = (line) => {
                    const result = [];
                    let current = "";
                    let inQuotes = false;
                    for (let i = 0; i < line.length; i++) {
                        const char = line[i];
                        if (char === '"') {
                            inQuotes = !inQuotes;
                        } else if (char === ',' && !inQuotes) {
                            result.push(current.trim());
                            current = "";
                        } else {
                            current += char;
                        }
                    }
                    result.push(current.trim());
                    return result;
                };

                for (let i = 1; i < lines.length; i++) {
                    const cells = parseCsvLine(lines[i]);
                    if (cells.length >= headers.length) {
                        rows.push({
                            index: cells[0],
                            name: cells[1],
                            csvStatus: cells[2],
                            csvError: cells[3],
                            scriptStatus: cells[4],
                            sourceUrl: cells[5],
                            lastUpdated: cells[6]
                        });
                    }
                }
            }
        } catch (err) {
            console.error("   ⚠️ Warning: failed to parse existing status CSV:", err.message);
        }
    }

    const existingIndex = rows.findIndex(r => r.name === statusItem.name || parseInt(r.index, 10) === statusItem.index);
    const dateStr = new Date().toISOString();

    const newRow = {
        index: String(statusItem.index),
        name: statusItem.name,
        csvStatus: statusItem.csvStatus || "",
        csvError: statusItem.csvError || "",
        scriptStatus: statusItem.scriptStatus || "",
        sourceUrl: statusItem.sourceUrl || "",
        lastUpdated: dateStr
    };

    if (existingIndex !== -1) {
        rows[existingIndex] = newRow;
    } else {
        rows.push(newRow);
    }

    const escapeCsvCell = (val) => {
        if (!val) return "";
        let s = String(val).replace(/"/g, '""');
        if (s.includes(",") || s.includes('"') || s.includes("\n") || s.includes("\r")) {
            return `"${s}"`;
        }
        return s;
    };

    const outputLines = [headers.join(",")];
    for (const r of rows) {
        outputLines.push([
            escapeCsvCell(r.index),
            escapeCsvCell(r.name),
            escapeCsvCell(r.csvStatus),
            escapeCsvCell(r.csvError),
            escapeCsvCell(r.scriptStatus),
            escapeCsvCell(r.sourceUrl),
            escapeCsvCell(r.lastUpdated)
        ].join(","));
    }

    fs.writeFileSync(csvPath, outputLines.join("\n"), "utf-8");
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 1: Script & URL Extraction
// ─────────────────────────────────────────────────────────────────────────────
async function runPhase1ScriptExtraction(page, context, idx, indicatorName, scriptFilePath) {
    const t0 = Date.now();
    console.log(`\n📄 [Phase 1] Extracting Script for idx ${idx}: "${indicatorName}"`);

    // Clean chart
    await removeAllIndicators(page);

    // Open Indicators, add only the target indicator
    if (!(await openIndicatorsDialog(page))) throw new Error("Cannot open Indicators dialog");
    const addedTitle = await selectTechnicalIndicator(page, indicatorName);
    console.log(`   ✅ Added "${addedTitle}"`);
    await closeIndicatorsDialog(page);
    await W(page, 2000);

    // Extract source script code
    let sourceCode = null;
    const extracted = await extractSourceFromChartLegend(page, context);
    if (extracted && looksLikePineScript(extracted)) {
        sourceCode = filterLicenseLines(extracted.trim());
        console.log(`   ✅ Pine Script extracted (${sourceCode.split('\n').length} lines)`);
    }
    if (!sourceCode) throw new Error("Failed to extract valid Pine Script code.");

    // Close Pine Editor
    for (let i = 0; i < 2; i++) { await page.keyboard.press("Escape"); await W(page, 200); }

    // Extract Source URL
    const about = await extractAboutDetails(page, context, indicatorName);
    const sourceUrl = about?.sourceUrl || "Not Available";

    // Write file with standard template formatting
    const output = `/*\n=============================================================================\nPINE SCRIPT OF THE INDICATOR\n=============================================================================\n*/\n\n${sourceCode}\n\n/*\n=============================================================================\nSOURCE: ${sourceUrl}\n=============================================================================\n*/\n`;
    fs.writeFileSync(scriptFilePath, output, "utf-8");
    console.log(`   💾 Pine Script saved: ${scriptFilePath}`);

    // Remove indicator so chart stays fresh
    await removeAllIndicators(page);

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`   ⏱️  Completed in ${elapsed}s`);
    return { status: "OK", time: elapsed, sourceUrl };
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 2: CSV Data Downloading
// ─────────────────────────────────────────────────────────────────────────────
async function runPhase2CsvDownloading(page, context, idx, indicatorName, csvFilePath) {
    const t0 = Date.now();
    console.log(`\n📊 [Phase 2] Downloading CSV for idx ${idx}: "${indicatorName}"`);

    // Keep Volume, only remove previous target indicators
    // We can do removeAllIndicators first, then add Volume, then add target
    await removeAllIndicators(page);

    if (!(await openIndicatorsDialog(page))) throw new Error("Cannot open Indicators dialog");
    await selectTechnicalIndicator(page, "Volume");
    await W(page, 500);
    const addedTitle = await selectTechnicalIndicator(page, indicatorName);
    console.log(`   ✅ Added Volume + "${addedTitle}"`);
    await closeIndicatorsDialog(page);
    await W(page, 2000);

    // Download CSV
    await downloadCsvFast(page, context, csvFilePath);

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`   ⏱️  Completed in ${elapsed}s`);
    return { status: "OK", time: elapsed };
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN Execution Flow
// ─────────────────────────────────────────────────────────────────────────────
async function main() {
    const totalStart = Date.now();
    const args = loadCredentials();
    const indices = parseIndicatorIndices();

    // Parse --run parameter
    let runMode = "both";
    const cliArgs = process.argv.slice(2);
    for (let i = 0; i < cliArgs.length; i++) {
        if (cliArgs[i] === "--run" && cliArgs[i + 1]) {
            const val = cliArgs[i + 1].trim().toLowerCase();
            if (["script", "csv", "both"].includes(val)) {
                runMode = val;
            }
            break;
        }
    }

    // Resolve indicator names at startup
    const indicatorMap = new Map();
    for (const idx of indices) {
        try {
            indicatorMap.set(idx, getIndicatorNameByIndex(idx));
        } catch (e) {
            console.error(`❌ Index ${idx}: ${e.message}`);
        }
    }

    console.log(`\n🚀 BATCH SCRAPER V2 — TWO-PHASE METHOD (${indices.length} indicators)`);
    console.log("═".repeat(60));
    console.log(`   Indices: ${indices.join(", ")}`);
    console.log(`   Run Mode: ${runMode}`);
    console.log("═".repeat(60) + "\n");

    for (const dir of [CONFIG.logsDir, CONFIG.scriptOutputDir, CONFIG.csvOutputDir])
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").substring(0, 19);
    const logFilePath = path.join(CONFIG.logsDir, `log_batch_v2_${timestamp}.txt`);
    const logStream = fs.createWriteStream(logFilePath, { flags: "a", encoding: "utf-8" });

    const origLog = console.log.bind(console);
    const origError = console.error.bind(console);
    const strip = s => String(s).replace(/\u001b\[[0-9;]*m/g, "");
    console.log = (...a) => { origLog(...a); logStream.write(strip(a.map(x => typeof x === "string" ? x : JSON.stringify(x)).join(" ")) + "\n"); };
    console.error = (...a) => { origError(...a); logStream.write("[ERR] " + strip(a.map(x => typeof x === "string" ? x : JSON.stringify(x)).join(" ")) + "\n"); };

    console.log("🌐 Launching browser...");
    const userDataDir = path.resolve(__dirname, "User_Data");

    // Robustness: a User_Data profile restored from another machine (e.g. the
    // GitHub Actions cache, or a crashed local run) carries stale Chromium
    // "singleton" lock files. Chromium then thinks the profile is in use by
    // another process/computer and refuses to launch ("profile appears to be in
    // use"), killing the whole batch. Remove those locks before every launch.
    for (const lock of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
        try { fs.rmSync(path.join(userDataDir, lock), { force: true, recursive: true }); } catch { }
    }

    const launchOpts = {
        headless: false,
        args: ["--start-maximized", "--disable-blink-features=AutomationControlled", "--disable-popup-blocking"],
        viewport: { width: 1920, height: 1080 },
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
        permissions: ["clipboard-read", "clipboard-write"],
        acceptDownloads: true,
    };
    // Retry the launch a couple of times — transient CI hiccups shouldn't fail
    // the whole run before a single indicator is even attempted.
    let context;
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            context = await chromium.launchPersistentContext(userDataDir, launchOpts);
            break;
        } catch (e) {
            console.error(`   ⚠️ Browser launch attempt ${attempt}/3 failed: ${e.message}`);
            for (const lock of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
                try { fs.rmSync(path.join(userDataDir, lock), { force: true, recursive: true }); } catch { }
            }
            if (attempt === 3) throw e;
            await new Promise(r => setTimeout(r, 3000));
        }
    }

    await context.addInitScript(() => {
        Object.defineProperty(navigator, "webdriver", { get: () => false });
        window.__capturedDownloadData = null;
        window.__capturedDownloadFilename = null;
        window.showSaveFilePicker = async function (options) {
            return { createWritable: async () => { let ch = []; return { write: async d => { if (d instanceof Blob) ch.push(await d.text()); else if (typeof d === 'string') ch.push(d); else if (d?.data) ch.push(d.data instanceof Blob ? await d.data.text() : String(d.data)); }, close: async () => { window.__capturedDownloadData = ch.join(''); window.__capturedDownloadFilename = options?.suggestedName || 'download.csv'; }, seek: async () => { }, truncate: async () => { } }; }, kind: 'file', name: options?.suggestedName || 'download.csv' };
        };
        const oCE = document.createElement.bind(document);
        document.createElement = function (t, o) { const el = oCE(t, o); if (t.toLowerCase() === 'a') { const oc = el.click.bind(el); el.click = function () { if (el.href?.startsWith('blob:') && el.download) fetch(el.href).then(r => r.text()).then(x => { window.__capturedDownloadData = x; window.__capturedDownloadFilename = el.download; }).catch(() => { }); return oc(); }; } return el; };
    });

    const page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();
    page.__isMainPage = true;

    const results = [];

    try {
        await loginToTradingView(page, args.email, args.password);

        // Load chart once
        console.log("📊 Loading chart...");
        await page.goto(CONFIG.chartUrl, { waitUntil: "load", timeout: 60000 });
        try { await page.waitForSelector('[data-name="legend-source-item"], canvas', { timeout: 10000 }); await W(page, 3000); } catch { await W(page, 5000); }
        await dismissPopups(page);
        console.log("   ✅ Chart ready.\n");

        // ═════════════════════════════════════════════════════════════════════
        // UNIFIED PIPELINE: CSV Download -> Validate -> Script Extraction
        // ═════════════════════════════════════════════════════════════════════
        console.log("═".repeat(60));
        console.log("⚡ STARTING UNIFIED PIPELINE: CSV FIRST, THEN SCRIPT");
        console.log("═".repeat(60));

        for (let i = 0; i < indices.length; i++) {
            const idx = indices[i];
            const indicatorName = indicatorMap.get(idx);
            if (!indicatorName) {
                const status = { index: idx, name: "?", csvStatus: "SKIP", csvError: "Index not found in input", scriptStatus: "SKIP" };
                updateStatusCsv(status);
                results.push({ idx, name: "?", csvStatus: "SKIP", scriptStatus: "SKIP", reason: "Index not found in input" });
                continue;
            }

            const normalizedName = normalizeFilename(indicatorName);
            const csvPath = path.join(CONFIG.csvOutputDir, `${normalizedName}.csv`);
            const scriptPath = path.join(CONFIG.scriptOutputDir, `${normalizedName}.txt`);

            console.log(`\n🔄 [Indicator ${i + 1}/${indices.length}] idx ${idx}: "${indicatorName}"`);

            let csvSuccess = false;
            let csvTime = "0";
            let csvErr = null;

            // Step 1: Run Phase 2 (CSV download)
            if (runMode === "both" || runMode === "csv") {
                for (let attempt = 1; attempt <= CONFIG.maxRetries; attempt++) {
                    try {
                        if (attempt > 1) {
                            console.log(`   🔄 [CSV] Retry ${attempt}/${CONFIG.maxRetries}...`);
                            await page.goto(CONFIG.chartUrl, { waitUntil: "load", timeout: 60000 });
                            try { await page.waitForSelector('[data-name="legend-source-item"], canvas', { timeout: 10000 }); await W(page, 3000); } catch { }
                            await dismissPopups(page);
                        }
                        const detail = await runPhase2CsvDownloading(page, context, idx, indicatorName, csvPath);
                        csvSuccess = true;
                        csvTime = detail.time;
                        break;
                    } catch (err) {
                        csvErr = err.message;
                        console.error(`   ❌ [CSV] Attempt ${attempt} failed: ${err.message}`);
                        try { for (let e = 0; e < 3; e++) { await page.keyboard.press("Escape"); await W(page, 100); } } catch { }
                    }
                }

                if (!csvSuccess) {
                    console.log(`   ❌ CSV Download failed. Skipping script extraction.`);
                    const status = { index: idx, name: indicatorName, csvStatus: "FAIL", csvError: `Download failed: ${csvErr}`, scriptStatus: "SKIP" };
                    updateStatusCsv(status);
                    results.push({ idx, name: indicatorName, csvStatus: "FAIL", scriptStatus: "SKIP", csvTime: "0", scriptTime: "0", reason: `Download failed: ${csvErr}` });
                    await closeAllExtraTabs(context);
                    if (i < indices.length - 1) await W(page, 1000);
                    continue;
                }

                // Step 2: Validate CSV
                const validation = validateCsvFile(csvPath);
                if (!validation.valid) {
                    console.log(`   ⚠️ CSV Validation failed: ${validation.reason}`);
                    console.log(`   🗑️ Deleting invalid CSV: ${csvPath}`);
                    try { if (fs.existsSync(csvPath)) fs.unlinkSync(csvPath); } catch { }
                    const status = { index: idx, name: indicatorName, csvStatus: "REJECTED", csvError: validation.reason, scriptStatus: "SKIP" };
                    updateStatusCsv(status);
                    results.push({ idx, name: indicatorName, csvStatus: "REJECTED", scriptStatus: "SKIP", csvTime, scriptTime: "0", reason: validation.reason });
                    await closeAllExtraTabs(context);
                    if (i < indices.length - 1) await W(page, 1000);
                    continue;
                }

                console.log(`   ✅ CSV Validated successfully! Found indicator columns: ${validation.indicatorColumns.join(", ")}`);
            } else {
                csvSuccess = true;
            }

            // Step 3: Run Phase 1 (Script extraction)
            let scriptSuccess = false;
            let scriptTime = "0";
            let sourceUrl = "N/A";
            let scriptErr = null;

            if (runMode === "both" || runMode === "script") {
                for (let attempt = 1; attempt <= CONFIG.maxRetries; attempt++) {
                    try {
                        if (attempt > 1) {
                            console.log(`   🔄 [Script] Retry ${attempt}/${CONFIG.maxRetries}...`);
                            await page.goto(CONFIG.chartUrl, { waitUntil: "load", timeout: 60000 });
                            try { await page.waitForSelector('[data-name="legend-source-item"], canvas', { timeout: 10000 }); await W(page, 3000); } catch { }
                            await dismissPopups(page);
                        }
                        const detail = await runPhase1ScriptExtraction(page, context, idx, indicatorName, scriptPath);
                        scriptSuccess = true;
                        scriptTime = detail.time;
                        sourceUrl = detail.sourceUrl;
                        break;
                    } catch (err) {
                        scriptErr = err.message;
                        console.error(`   ❌ [Script] Attempt ${attempt} failed: ${err.message}`);
                        try { for (let e = 0; e < 3; e++) { await page.keyboard.press("Escape"); await W(page, 100); } } catch { }
                    }
                }

                if (scriptSuccess) {
                    const status = { index: idx, name: indicatorName, csvStatus: runMode === "both" ? "OK" : "SKIP", scriptStatus: "OK", sourceUrl };
                    updateStatusCsv(status);
                    results.push({ idx, name: indicatorName, csvStatus: runMode === "both" ? "OK" : "SKIP", scriptStatus: "OK", csvTime, scriptTime, sourceUrl });
                } else {
                    let csvStatusVal = runMode === "both" ? "FAIL" : "SKIP";
                    if (fs.existsSync(csvPath)) {
                        console.log(`   🗑️ Deleting CSV because script extraction failed: ${csvPath}`);
                        try { fs.unlinkSync(csvPath); } catch (e) { console.error(`   ❌ Failed to delete CSV: ${e.message}`); }
                        csvStatusVal = "FAIL";
                    }
                    const status = { index: idx, name: indicatorName, csvStatus: csvStatusVal, scriptStatus: "FAIL", csvError: `Script extraction failed: ${scriptErr}` };
                    updateStatusCsv(status);
                    results.push({ idx, name: indicatorName, csvStatus: csvStatusVal, scriptStatus: "FAIL", csvTime, scriptTime: "0", reason: `Script extraction failed: ${scriptErr}` });
                }
            } else {
                const status = { index: idx, name: indicatorName, csvStatus: "OK", scriptStatus: "SKIP" };
                updateStatusCsv(status);
                results.push({ idx, name: indicatorName, csvStatus: "OK", scriptStatus: "SKIP", csvTime, scriptTime: "0" });
            }

            await closeAllExtraTabs(context);
            if (i < indices.length - 1) await W(page, 1000);
        }

        // ═════════════════════════════════════════════════════════════════════
        // FINAL SUMMARY
        // ═════════════════════════════════════════════════════════════════════
        const totalElapsed = ((Date.now() - totalStart) / 1000).toFixed(1);
        console.log("\n" + "═".repeat(60));
        console.log("📊 UNIFIED PIPELINE BATCH SUMMARY");
        console.log("═".repeat(60));
        console.log(`   Total time: ${totalElapsed}s`);
        console.log("");
        for (const idx of indices) {
            const res = results.find(r => r.idx === idx);
            if (!res) continue;
            console.log(`   [${idx}] ${res.name}`);
            const cIcon = res.csvStatus === "OK" ? "✅" : res.csvStatus === "REJECTED" ? "⚠️ (REJECTED)" : res.csvStatus === "SKIP" ? "⏭️" : "❌";
            console.log(`       📊 CSV Download: ${cIcon} (${res.csvTime || "0"}s) ${res.reason && res.csvStatus !== "OK" ? `- Reason: ${res.reason}` : ""}`);
            if (res.csvStatus === "OK" && (runMode === "both" || runMode === "script")) {
                const sIcon = res.scriptStatus === "OK" ? "✅" : "❌";
                console.log(`       📄 Pine Script: ${sIcon} (${res.scriptTime || "0"}s) | Source URL: ${res.sourceUrl || "N/A"} ${res.reason && res.scriptStatus !== "OK" ? `- Reason: ${res.reason}` : ""}`);
            }
        }
        console.log("═".repeat(60));

    } catch (err) {
        console.error(`\n❌ Fatal Error: ${err.message}`);
        try { const d = path.resolve(__dirname, "debug"); if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); await page.screenshot({ path: path.join(d, `batch_v2_fatal_${timestamp}.png`), fullPage: true }); } catch { }
        throw err;
    } finally {
        try { await context.close(); } catch { }
        const totalElapsed = ((Date.now() - totalStart) / 1000).toFixed(1);
        console.log(`\n✅ Done in ${totalElapsed}s`);
        console.log(`📝 Log: ${logFilePath}\n`);
        logStream.end();
    }
}

main().catch(err => { console.error("\n❌ Fatal:", err); process.exit(1); });
