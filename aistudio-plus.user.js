// ==UserScript==
// @name         Google AI Studio Pro Enhancer
// @namespace    http://tampermonkey.net/
// @version      60.3
// @description  Stability Fixes: Forced Garbage Collection, Sync Button, and Date/Token Merging.
// @author       Esashiero
// @match        https://aistudio.google.com/*
// @run-at       document-start
// @connect      oauth2.googleapis.com
// @connect      www.googleapis.com
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// @updateURL    https://raw.githubusercontent.com/Esashiero/AI-Studio-Enhancer/main/aistudio-plus.user.js
// @downloadURL  https://raw.githubusercontent.com/Esashiero/AI-Studio-Enhancer/main/aistudio-plus.user.js
// ==/UserScript==

(function() {
    'use strict';

    if (window.top !== window.self) return;

    const DBG = "[AI Studio Pro]";
    console.log(`%c${DBG} v60.3 Loaded - Forced GC`, "color: #4ade80; font-weight: bold; background: #000; padding: 2px 5px; border-radius: 3px;");

    // ==========================================
    // ⚙️ CONFIGURATION & PREFS
    // ==========================================
    const CONFIG = {
        CLIENT_ID: "YOUR_CLIENT_ID",
        CLIENT_SECRET: "YOUR_CLIENT_SECRET",
        REFRESH_TOKEN: "YOUR_REFRESH_TOKEN",
        FOLDER_NAME: "Google AI Studio",
        SYNC_INTERVAL_MINUTES: 15
    };

    const DEFAULT_PREFS = {
        createdFormat: 'short',
        updatedFormat: 'native',
        tokenColor: '#e0e0e0'
    };

    const STORAGE_KEY = 'ai_studio_passive_stats';
    const PREFS_KEY = 'ai_studio_user_prefs';
    const TOKEN_KEY = 'ai_drive_access_token_v2';
    const SYNC_TIME_KEY = 'ai_drive_last_sync_time';

    // State
    let prefs = loadPrefs();
    let sortState = { column: null, ascending: false };
    let tableObserver = null;
    let currentProbedId = null;
    let userIsHovering = false;
    let isGenerating = false;
    let genTimeout = null;
    let activePromptId = null;
    let hasNetworkData = false;
    let cachedApiHeaders = {};
    let searchMatches = [];
    let currentMatchIndex = -1;

    // Added 'Drive API' to priority list
    const SOURCE_PRIORITY = {
        'Deep Tooltip': 5,
        'Network Sum': 4,
        'Network Meta': 3,
        'Top Bar': 2,
        'Drive API': 1,
        'Unknown': 0
    };

    // ==========================================
    // 1. DATA HELPERS
    // ==========================================
    function loadPrefs() {
        try { return { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem(PREFS_KEY)) }; }
        catch (e) { return DEFAULT_PREFS; }
    }

    function savePrefs(newPrefs) {
        prefs = { ...prefs, ...newPrefs };
        localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
        triggerTableUpdate();
        if (activePromptId) renderMetadata(activePromptId);
    }

    const getDb = () => { try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); } catch (e) { return {}; } };
    const saveDb = (db) => { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(db)); } catch (e) { } };

    const saveStats = (id, data, source = "Unknown") => {
        if (!id) return;
        const cleanId = id.replace('prompts/', '');
        const db = getDb();
        const existing = db[cleanId] || {};

        // Smart Merge Logic
        // 1. Priority check for Tokens (don't let scraping overwrite network data)
        const existingPriority = SOURCE_PRIORITY[existing.tokenSource || 'Unknown'] || 0;
        const newPriority = SOURCE_PRIORITY[source] || 0;

        if (existingPriority > newPriority && data.tokens) {
             if (data.tokens <= existing.tokens) { delete data.tokens; }
        }

        // 2. Merge Data
        let hasChanges = false;
        ['tokens', 'created', 'name', 'msgCount', 'modified'].forEach(key => {
            // Only update if value is valid and different
            if (data[key] !== undefined && data[key] !== null && data[key] !== existing[key]) {
                hasChanges = true;
            }
        });

        if (hasChanges) {
            const merged = { ...existing, ...data, lastSeen: Date.now() };
            // Update token source only if we actually updated tokens using a higher/equal priority source
            if (data.tokens && newPriority >= existingPriority) {
                merged.tokenSource = source;
            } else if (!merged.tokenSource) {
                merged.tokenSource = source;
            }

            db[cleanId] = merged;
            saveDb(db);
            if (activePromptId === cleanId) renderMetadata(cleanId);
        }
    };

    // --- DATE FORMATTERS ---
    const getRelativeTime = (isoString) => {
        if (!isoString) return '-';
        const date = new Date(isoString);
        if (isNaN(date.getTime())) return '-';
        const seconds = Math.floor((new Date() - date) / 1000);
        if (seconds < 60) return "Just now";
        let interval = seconds / 31536000;
        if (interval > 1) return Math.floor(interval) + "y ago";
        interval = seconds / 2592000;
        if (interval > 1) return Math.floor(interval) + "mo ago";
        interval = seconds / 86400;
        if (interval > 1) return Math.floor(interval) + "d ago";
        interval = seconds / 3600;
        if (interval > 1) return Math.floor(interval) + "h ago";
        interval = seconds / 60;
        if (interval > 1) return Math.floor(interval) + "m ago";
        return "Just now";
    };

    const formatDate = (isoString, formatType) => {
        if (!isoString) return '-';
        const d = new Date(isoString);
        if (isNaN(d.getTime())) return '-';

        if (formatType === 'relative') return getRelativeTime(isoString);

        const pad = (n) => n.toString().padStart(2, '0');
        const day = pad(d.getDate());
        const month = pad(d.getMonth() + 1);
        const year = d.getFullYear();

        if (formatType === 'american') return `${month}/${day}/${year}`;
        // Default Short (EU)
        return `${day}/${month}/${year}`;
    };

    const formatShortDate = (isoString) => {
        if (!isoString) return '-';
        const d = new Date(isoString);
        return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    };

    // ==========================================
    // 2. NETWORK SNIFFER
    // ==========================================
    function checkAndCacheHeaders(headers, url) {
        if (!url || (!url.includes('alkalimakersuite') && !url.includes('clients6.google.com'))) return;
        const key = headers['x-goog-api-key'] || headers['X-Goog-Api-Key'];
        if (key) {
            cachedApiHeaders = { ...cachedApiHeaders, ...headers };
            delete cachedApiHeaders['content-type'];
            delete cachedApiHeaders['Content-Type'];
        }
    }

    const originalXhrOpen = XMLHttpRequest.prototype.open;
    const originalXhrSetHeader = XMLHttpRequest.prototype.setRequestHeader;
    const originalXhrSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function(method, url) {
        this._ai_url = url;
        this._ai_headers = {};
        return originalXhrOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.setRequestHeader = function(header, value) {
        if (this._ai_headers) this._ai_headers[header.toLowerCase()] = value;
        return originalXhrSetHeader.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function(body) {
        if (this._ai_url && this._ai_headers) checkAndCacheHeaders(this._ai_headers, this._ai_url);

        this.addEventListener('load', function() {
            if (this._ai_url && (this._ai_url.includes('alkalimakersuite') || this._ai_url.includes('MakerSuiteService'))) {
                const promptId = getCurrentPromptId();
                parseAndSaveTokens(this._ai_url, this.responseText, promptId);
            }
        });
        if (this._ai_url && this._ai_url.includes('GenerateContent')) {
            const promptId = getCurrentPromptId();
            if (promptId) { isGenerating = true; currentProbedId = null; setLoadingUI(promptId); if (genTimeout) clearTimeout(genTimeout); genTimeout = setTimeout(() => { isGenerating = false; }, 45000); }
        }
        return originalXhrSend.apply(this, arguments);
    };

    const originalFetch = window.fetch;
    window.fetch = async function(...args) {
        const url = args[0] ? args[0].toString() : '';
        const opts = args[1] || {};
        if (opts.headers) {
            let extracted = {};
            if (opts.headers instanceof Headers) { opts.headers.forEach((val, key) => { extracted[key.toLowerCase()] = val; }); } else { extracted = opts.headers; }
            checkAndCacheHeaders(extracted, url);
        }
        if (url.includes('GenerateContent')) {
             const promptId = getCurrentPromptId();
             if (promptId) { isGenerating = true; currentProbedId = null; setLoadingUI(promptId); if (genTimeout) clearTimeout(genTimeout); genTimeout = setTimeout(() => { isGenerating = false; }, 45000); }
        }
        const response = await originalFetch(...args);
        if (url.includes('alkalimakersuite') || url.includes('MakerSuiteService')) {
            const clone = response.clone();
            const reqId = getCurrentPromptId();
            clone.text().then(text => parseAndSaveTokens(url, text, reqId));
        }
        return response;
    };

    // ==========================================
    // 3. SETTINGS UI
    // ==========================================
    function initSettingsUI() {
        const settingsMenu = document.querySelector('ms-settings-menu');
        if (!settingsMenu) return;
        if (document.getElementById('ai-enhancer-settings-btn')) return;

        settingsMenu.style.display = 'flex';
        settingsMenu.style.flexDirection = 'row';
        settingsMenu.style.width = '100%';

        const nativeBtn = settingsMenu.querySelector('button.trigger-button');
        if (nativeBtn) {
            nativeBtn.style.width = '50%';
            nativeBtn.style.minWidth = 'auto';
            nativeBtn.style.borderTopRightRadius = '0';
            nativeBtn.style.borderBottomRightRadius = '0';
        }

        const myBtn = document.createElement('button');
        myBtn.id = 'ai-enhancer-settings-btn';
        myBtn.className = 'ms-button-borderless ai-settings-btn';
        myBtn.innerHTML = `<span class="material-symbols-outlined notranslate ms-button-icon-symbol" aria-hidden="true">tune</span><span class="btn-label">Enhancer</span>`;
        myBtn.addEventListener('click', toggleSettingsModal);
        settingsMenu.appendChild(myBtn);
    }

    function toggleSettingsModal() {
        let modal = document.getElementById('ai-settings-modal');
        if (!modal) { createSettingsModal(); modal = document.getElementById('ai-settings-modal'); }
        if (modal.classList.contains('active')) modal.classList.remove('active');
        else modal.classList.add('active');
    }

    function createSettingsModal() {
        const modal = document.createElement('div');
        modal.id = 'ai-settings-modal';
        modal.className = 'ai-modal-backdrop';
        modal.innerHTML = `
            <div class="ai-modal-window">
                <div class="ai-modal-header">
                    <h2>Enhancer Settings</h2>
                    <button id="ai-modal-close">✕</button>
                </div>
                <div class="ai-modal-content">
                    <div class="ai-setting-group">
                        <label>Created Column Format</label>
                        <select id="ai-setting-createdfmt">
                            <option value="short">Short (DD/MM/YYYY)</option>
                            <option value="american">American (MM/DD/YYYY)</option>
                            <option value="relative">Relative (e.g. 2 hours ago)</option>
                        </select>
                    </div>
                    <div class="ai-setting-group">
                        <label>Updated Column</label>
                        <select id="ai-setting-updatedfmt">
                            <option value="native">Native Relative (e.g. 5m ago)</option>
                            <option value="absolute">Force Absolute (DD/MM/YYYY)</option>
                        </select>
                    </div>
                    <div class="ai-setting-group">
                        <label>Token Count Color</label>
                        <div style="display: flex; gap: 10px; align-items: center;">
                            <input type="color" id="ai-setting-tokencolor" value="${prefs.tokenColor}">
                            <span style="font-size: 12px; opacity: 0.7;">Pick a color for the Tokens column</span>
                        </div>
                    </div>

                    <hr style="border: 0; border-top: 1px solid rgba(255,255,255,0.1); margin: 20px 0;">

                    <div class="ai-setting-group">
                        <label>Data Management</label>
                        <button id="ai-btn-force-sync" class="ai-action-btn">Force Drive Sync (Clean Ghosts)</button>
                        <div class="ai-setting-note">Click this if you see deleted chats in the toolbar.</div>
                    </div>

                    <div class="ai-modal-footer"><div class="ai-version">AI Studio Enhancer v60.3</div></div>
                </div>
            </div>
        `;
        document.body.appendChild(modal);

        const createdSel = modal.querySelector('#ai-setting-createdfmt');
        const updatedSel = modal.querySelector('#ai-setting-updatedfmt');
        const colorInput = modal.querySelector('#ai-setting-tokencolor');
        const forceSyncBtn = modal.querySelector('#ai-btn-force-sync');

        createdSel.value = prefs.createdFormat;
        updatedSel.value = prefs.updatedFormat;
        colorInput.value = prefs.tokenColor;

        createdSel.addEventListener('change', (e) => savePrefs({ createdFormat: e.target.value }));
        updatedSel.addEventListener('change', (e) => savePrefs({ updatedFormat: e.target.value }));
        colorInput.addEventListener('input', (e) => savePrefs({ tokenColor: e.target.value }));

        forceSyncBtn.addEventListener('click', () => {
            forceSyncBtn.innerText = "Syncing...";
            forceSyncBtn.disabled = true;
            syncDriveMetadata(true); // Force sync
            setTimeout(() => {
                forceSyncBtn.innerText = "Force Drive Sync";
                forceSyncBtn.disabled = false;
            }, 3000);
        });

        modal.querySelector('#ai-modal-close').addEventListener('click', () => modal.classList.remove('active'));
        modal.addEventListener('click', (e) => { if (e.target === modal) modal.classList.remove('active'); });
    }

    // ==========================================
    // 4. CORE LOGIC
    // ==========================================
    function getCurrentPromptId() {
        const match = window.location.href.match(/\/prompts\/([a-zA-Z0-9-_]+)/);
        return match ? match[1] : null;
    }

    function setLoadingUI(id) {
        if (!window.location.href.includes(id)) return;
        const valEl = document.querySelector('.v3-token-count-value');
        if (valEl) {
            valEl.innerHTML = '<div class="loading-token-count-placeholder ng-star-inserted"></div> tokens';
            valEl.classList.add('loading');
        }
    }

    function injectTokenToUI(id, count) {
        if (!window.location.href.includes(id)) return;
        const valEl = document.querySelector('.v3-token-count-value');
        if (valEl) {
            valEl.textContent = `${count.toLocaleString()} tokens`;
            valEl.classList.remove('loading');
            valEl.classList.add('token-updated-flash');
            setTimeout(() => valEl.classList.remove('token-updated-flash'), 1000);
        }
        isGenerating = false;
        if (genTimeout) clearTimeout(genTimeout);
    }

    function parseAndSaveTokens(url, bodyStr, promptIdFromContext) {
        try {
            const rpcName = url.split('/').pop().split('?')[0];
            if (!['ResolveDriveResource', 'UpdatePrompt', 'GenerateContent'].some(k => rpcName.includes(k))) return;
            const data = JSON.parse(bodyStr);
            let promptId = promptIdFromContext;
            if (!promptId) {
                if (data[0] && typeof data[0][0] === 'string' && data[0][0].startsWith('prompts/')) { promptId = data[0][0]; }
                else { const urlMatch = window.location.href.match(/\/prompts\/([a-zA-Z0-9-_]+)/); if (urlMatch) promptId = urlMatch[1]; }
            }
            if (!promptId) return;
            let tokenCount = 0; let messageCount = 0;
            let promptObj = Array.isArray(data) ? data[0] : data;
            if (promptObj && Array.isArray(promptObj)) {
                const historyContainer = promptObj[13];
                if (historyContainer && Array.isArray(historyContainer)) {
                    const messages = historyContainer[0];
                    if (Array.isArray(messages)) {
                        messageCount = messages.length;
                        messages.forEach(msg => { const count = msg[18]; if (typeof count === 'number') tokenCount += count; });
                    }
                } else {
                    const metaTotal = promptObj[3]?.[6];
                    if (typeof metaTotal === 'number' && metaTotal > 0) { if (tokenCount === 0) tokenCount = metaTotal; }
                }
            }
            if (tokenCount > 0 || messageCount > 0) {
                isGenerating = false;
                if (promptId === activePromptId) hasNetworkData = true;
                saveStats(promptId, { tokens: tokenCount, msgCount: messageCount }, `Network Sum`);
                injectTokenToUI(promptId, tokenCount);
            }
        } catch (e) { console.warn(`${DBG} Parse Error`, e); }
    }

    function renderMetadata(id) {
        const titleContainer = document.querySelector('.title-tokencount-container');
        if (!titleContainer) return;
        let metaContainer = document.getElementById('ai-custom-meta-bar');
        if (!metaContainer) {
            metaContainer = document.createElement('div');
            metaContainer.id = 'ai-custom-meta-bar';
            titleContainer.appendChild(metaContainer);
        }
        const db = getDb();
        const data = db[id] || {};
        const createdDate = data.created ? formatShortDate(data.created) : '-';
        const createdFull = data.created ? new Date(data.created).toLocaleString() : 'Unknown';
        const modifiedRel = data.modified ? getRelativeTime(data.modified) : '-';
        const modifiedFull = data.modified ? new Date(data.modified).toLocaleString() : 'Unknown';
        const ICON_CALENDAR = `<svg viewBox="0 0 24 24"><path d="M19 3h-1V1h-2v2H8V1H6v2H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H5V8h14v11zM7 10h5v5H7z"/></svg>`;
        const ICON_HISTORY = `<svg viewBox="0 0 24 24"><path d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z"/></svg>`;
        metaContainer.innerHTML = `<div class="meta-item" title="Created: ${createdFull}">${ICON_CALENDAR}<span>${createdDate}</span></div><div class="meta-divider"></div><div class="meta-item" title="Modified: ${modifiedFull}">${ICON_HISTORY}<span>${modifiedRel}</span></div>`;
    }

    // ==========================================
    // 5. TABLE UI
    // ==========================================
    function triggerTableUpdate() {
        const table = document.querySelector('table.library-table');
        if (table) processTable(table);
    }
    function initTableObserver() {
        const tbody = document.querySelector('table.library-table tbody');
        if (!tbody) { setTimeout(initTableObserver, 500); return; }
        if (tableObserver) tableObserver.disconnect();
        tableObserver = new MutationObserver(() => {
            tableObserver.disconnect();
            triggerTableUpdate();
            tableObserver.observe(tbody, { childList: true });
        });
        tableObserver.observe(tbody, { childList: true });
        triggerTableUpdate();
    }
    function processTable(table) {
        addHeaders(table);
        addBodyCells(table);
        hookNativeHeaders(table);
        groupChats(table);
    }
    function groupChats(table) {
        const rows = Array.from(table.querySelectorAll('tbody tr'));
        const rowMap = {};
        rows.forEach(row => { const nameEl = row.querySelector('.name-btn'); if (nameEl) rowMap[nameEl.innerText.trim().toLowerCase()] = row; });
        rows.forEach(row => {
            const nameEl = row.querySelector('.name-btn');
            if (!nameEl) return;
            const title = nameEl.innerText.trim();
            const match = title.match(/^(Branch of|Copy of) (.+)$/i);
            if (match) {
                const parentTitle = match[2].trim().toLowerCase();
                const parentRow = rowMap[parentTitle];
                if (parentRow) { if (parentRow.nextElementSibling !== row) parentRow.after(row); row.classList.add('is-branch-row'); }
            } else { row.classList.remove('is-branch-row'); }
        });
    }
    function addHeaders(table) {
        const headerRow = table.querySelector('thead tr');
        if (!headerRow) return;
        const arrowSvg = `<svg viewBox="0 -960 960 960" focusable="false" aria-hidden="true" class="ng-star-inserted"><path d="M440-240v-368L296-464l-56-56 240-240 240 240-56 56-144-144v368h-80Z"></path></svg>`;
        const createHeader = (id, text) => {
            if (headerRow.querySelector(`.${id}-header`)) return;
            const th = document.createElement('th');
            th.className = `mat-sort-header mat-mdc-header-cell mdc-data-table__header-cell cdk-header-cell table-header ${id}-header custom-header`;
            th.style.minWidth = id === 'count' ? '80px' : '130px';
            th.innerHTML = `<div class="mat-sort-header-container mat-focus-indicator" tabindex="0" role="button"><div class="mat-sort-header-content">${text}</div><div class="mat-sort-header-arrow ng-star-inserted custom-arrow-container">${arrowSvg}</div></div>`;
            th.addEventListener('click', () => handleSort(table, id));
            const updatedHeader = headerRow.querySelector('th[mat-sort-header="updated"]');
            if (updatedHeader) updatedHeader.parentNode.insertBefore(th, updatedHeader); else headerRow.appendChild(th);
        };
        createHeader('creation-date', 'Created'); createHeader('count', 'Count'); createHeader('tokens', 'Tokens');
    }
    function addBodyCells(table) {
        const rows = table.querySelectorAll('tbody tr');
        const db = getDb();
        rows.forEach(row => {
            try {
                const anchor = row.querySelector('a[href*="prompts/"]');
                let promptId = null;
                if (anchor) { const href = anchor.getAttribute('href'); const match = href.match(/(prompts\/[^?]+)/); if (match) promptId = match[1].split('/')[1]; }
                const stats = (promptId && db[promptId]) ? db[promptId] : {};

                if (!row.querySelector('.creation-date-cell')) { const td = document.createElement('td'); td.className = 'mat-mdc-cell mdc-data-table__cell cdk-cell creation-date-cell'; insertInRow(row, td); }
                if (!row.querySelector('.count-cell')) { const td = document.createElement('td'); td.className = 'mat-mdc-cell mdc-data-table__cell cdk-cell count-cell'; insertInRow(row, td); }
                if (!row.querySelector('.tokens-cell')) { const td = document.createElement('td'); td.className = 'mat-mdc-cell mdc-data-table__cell cdk-cell tokens-cell'; insertInRow(row, td); }

                const dateCell = row.querySelector('.creation-date-cell');
                const countCell = row.querySelector('.count-cell');
                const tokenCell = row.querySelector('.tokens-cell');

                if (stats.created) { dateCell.textContent = formatDate(stats.created, prefs.createdFormat); dateCell.dataset.value = new Date(stats.created).getTime(); }
                else { dateCell.textContent = '-'; dateCell.dataset.value = 0; }

                if (stats.msgCount !== undefined) { countCell.textContent = stats.msgCount.toString(); countCell.dataset.value = stats.msgCount; countCell.style.color = '#e0e0e0'; }
                else { countCell.textContent = '-'; countCell.dataset.value = 0; countCell.style.color = '#777'; }

                if (stats.tokens) { tokenCell.textContent = stats.tokens.toLocaleString(); tokenCell.dataset.value = stats.tokens; tokenCell.style.color = prefs.tokenColor; }
                else { tokenCell.textContent = '-'; tokenCell.dataset.value = 0; tokenCell.style.color = '#777'; }

                // Updated Column Override
                const updatedCell = row.querySelector('.cdk-column-updated');
                if (updatedCell) {
                    if (!updatedCell.dataset.original) updatedCell.dataset.original = updatedCell.innerText;
                    if (prefs.updatedFormat === 'absolute' && stats.modified) {
                        const absDate = formatDate(stats.modified, 'short'); // Use Short DD/MM
                        if (updatedCell.innerText !== absDate) updatedCell.innerText = absDate;
                    } else if (prefs.updatedFormat === 'native') {
                        if (updatedCell.innerText !== updatedCell.dataset.original) updatedCell.innerText = updatedCell.dataset.original;
                    }
                }
            } catch (err) {}
        });
    }
    function insertInRow(row, cell) { const target = row.querySelector('td.cdk-column-updated'); if (target) target.parentNode.insertBefore(cell, target); else row.appendChild(cell); }
    function handleSort(table, colId) { if (sortState.column === colId) sortState.ascending = !sortState.ascending; else { sortState.column = colId; sortState.ascending = false; } if (tableObserver) tableObserver.disconnect(); table.classList.add('custom-sorting-active'); const allHeaders = table.querySelectorAll('.custom-header'); allHeaders.forEach(th => th.classList.remove('sorted-asc', 'sorted-desc')); const activeHeader = table.querySelector(`.${colId}-header`); if (activeHeader) activeHeader.classList.add(sortState.ascending ? 'sorted-asc' : 'sorted-desc'); const tbody = table.querySelector('tbody'); const rows = Array.from(tbody.querySelectorAll('tr')); rows.sort((a, b) => { const cellA = a.querySelector(`.${colId}-cell`); const cellB = b.querySelector(`.${colId}-cell`); const vA = parseInt(cellA?.dataset.value || 0); const vB = parseInt(cellB?.dataset.value || 0); return sortState.ascending ? (vA - vB) : (vB - vA); }); rows.forEach(r => tbody.appendChild(r)); groupChats(table); if (tableObserver) tableObserver.observe(tbody, { childList: true }); }
    function hookNativeHeaders(table) { const nativeHeaders = table.querySelectorAll('th:not(.custom-header)'); nativeHeaders.forEach(th => { if (!th.dataset.customHook) { th.dataset.customHook = 'true'; th.addEventListener('click', () => { sortState.column = null; sortState.ascending = false; table.classList.remove('custom-sorting-active'); table.querySelectorAll('.custom-header').forEach(h => h.classList.remove('sorted-asc', 'sorted-desc')); setTimeout(() => groupChats(table), 100); }); } }); }

    // ==========================================
    // 6. SCROLL & SEARCH
    // ==========================================
    function getScrollParent(node) { if (node == null) return document.scrollingElement || document.documentElement; if (node.scrollHeight > node.clientHeight) { const style = window.getComputedStyle(node); if (style.overflowY.includes('auto') || style.overflowY.includes('scroll')) { return node; } } return getScrollParent(node.parentNode); }
    function getMessageScrollContext() { const messages = Array.from(document.querySelectorAll('ms-chat-turn')); if (messages.length === 0) return null; const scrollContainer = getScrollParent(messages[0]); if (!scrollContainer) return null; const TOOLBAR_HEIGHT = 80; const containerRect = scrollContainer.getBoundingClientRect(); let currentTopIndex = -1; for (let i = 0; i < messages.length; i++) { const rect = messages[i].getBoundingClientRect(); if (rect.top >= (containerRect.top + TOOLBAR_HEIGHT - 20)) { currentTopIndex = i; break; } } if (currentTopIndex === -1) { for (let i = 0; i < messages.length; i++) { const rect = messages[i].getBoundingClientRect(); if (rect.bottom > (containerRect.top + TOOLBAR_HEIGHT)) { currentTopIndex = i; break; } } } return { messages, scrollContainer, currentTopIndex, TOOLBAR_HEIGHT, containerRect }; }
    function scrollToMessage(direction) { const ctx = getMessageScrollContext(); if (!ctx) return; const { messages, scrollContainer, currentTopIndex, TOOLBAR_HEIGHT, containerRect } = ctx; let targetIndex = currentTopIndex + direction; if (targetIndex < 0) targetIndex = 0; if (targetIndex >= messages.length) return; const target = messages[targetIndex]; const currentScrollTop = scrollContainer.scrollTop; const targetRect = target.getBoundingClientRect(); const diff = targetRect.top - containerRect.top; const destination = currentScrollTop + diff - TOOLBAR_HEIGHT - 10; scrollContainer.scrollTo({ top: destination, behavior: 'smooth' }); }

    function renderScrollFab() {
        if (!window.location.href.includes('/prompts/')) {
            const container = document.getElementById('ai-fab-container');
            if(container) container.style.display = 'none';
            return;
        }
        let container = document.getElementById('ai-fab-container');
        if (!container) {
            container = document.createElement('div');
            container.id = 'ai-fab-container';
            const btnUp = document.createElement('button');
            btnUp.className = 'ai-fab-btn';
            btnUp.innerHTML = `<svg viewBox="0 0 24 24"><path d="M7.41 15.41L12 10.83l4.59 4.58L18 14l-6-6-6 6z"/></svg>`;
            btnUp.title = "Previous Message";
            btnUp.addEventListener('click', () => scrollToMessage(-1));
            const btnDown = document.createElement('button');
            btnDown.className = 'ai-fab-btn';
            btnDown.innerHTML = `<svg viewBox="0 0 24 24"><path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6z"/></svg>`;
            btnDown.title = "Next Message";
            btnDown.addEventListener('click', () => scrollToMessage(1));
            container.appendChild(btnUp);
            container.appendChild(btnDown);
            document.body.appendChild(container);
        }
        container.style.display = 'flex';
    }

    function toggleSearchBar() { let bar = document.getElementById('ai-search-bar'); if (!bar) { bar = document.createElement('div'); bar.id = 'ai-search-bar'; bar.innerHTML = `<input type="text" id="ai-search-input" placeholder="Find in chat..."><span id="ai-search-count">0/0</span><div class="ai-search-actions"><button id="ai-search-prev">▲</button><button id="ai-search-next">▼</button><button id="ai-search-close">✕</button></div>`; document.body.appendChild(bar); bar.querySelector('#ai-search-input').addEventListener('input', (e)=>performSearch(e.target.value)); bar.querySelector('#ai-search-next').addEventListener('click', ()=>navigateSearch(1)); bar.querySelector('#ai-search-prev').addEventListener('click', ()=>navigateSearch(-1)); bar.querySelector('#ai-search-close').addEventListener('click', toggleSearchBar); } if (bar.style.display === 'flex') { bar.style.display = 'none'; clearHighlights(); } else { bar.style.display = 'flex'; bar.querySelector('#ai-search-input').focus(); } }
    function clearHighlights() { document.querySelectorAll('.ai-search-highlight').forEach(el => el.classList.remove('ai-search-highlight')); }
    function performSearch(text) { clearHighlights(); searchMatches = []; currentMatchIndex = -1; const countEl = document.getElementById('ai-search-count'); if (!text || text.length < 2) { countEl.textContent = "0/0"; return; } const messages = Array.from(document.querySelectorAll('ms-chat-turn')); messages.forEach((msg) => { if (msg.textContent.toLowerCase().includes(text.toLowerCase())) searchMatches.push(msg); }); if (searchMatches.length > 0) { currentMatchIndex = 0; highlightCurrentMatch(); } updateSearchCount(); }
    function navigateSearch(d) { if (searchMatches.length === 0) return; currentMatchIndex += d; if (currentMatchIndex >= searchMatches.length) currentMatchIndex = 0; if (currentMatchIndex < 0) currentMatchIndex = searchMatches.length - 1; highlightCurrentMatch(); updateSearchCount(); }
    function highlightCurrentMatch() { clearHighlights(); const t = searchMatches[currentMatchIndex]; if (!t) return; t.classList.add('ai-search-highlight'); getScrollParent(t).scrollTo({ top: t.getBoundingClientRect().top + getScrollParent(t).scrollTop - getScrollParent(t).getBoundingClientRect().top - 80, behavior: 'smooth' }); }
    function updateSearchCount() { document.getElementById('ai-search-count').textContent = searchMatches.length === 0 ? "0/0" : `${currentMatchIndex + 1}/${searchMatches.length}`; }

    // ==========================================
    // 7. EXPORT, MENU & RELATED
    // ==========================================
    const PROXY_BUTTON_MAP = [ { icon: 'share', label: 'Share', selector: 'ms-share-prompt button' }, { icon: 'compare_arrows', label: 'Compare', selector: 'button[iconname="compare_arrows"]' }, { icon: 'search', label: 'Find', action: toggleSearchBar }, { icon: 'download', label: 'Export JSON', action: () => fetchAndExportChat('json') }, { icon: 'description', label: 'Export Markdown', action: () => fetchAndExportChat('markdown') }, { icon: 'add', label: 'New chat', selector: 'button[iconname="add"]' } ];
    function createProxyMenuItem(config) { const btn = document.createElement('button'); btn.className = 'mat-mdc-menu-item mat-focus-indicator icon-text-button ng-star-inserted ai-proxy-item'; btn.innerHTML = `<span class="mat-mdc-menu-item-text"><span class="material-symbols-outlined notranslate">${config.icon}</span> ${config.label}</span>`; btn.addEventListener('click', () => { if (config.action) { document.querySelector('.cdk-overlay-backdrop')?.click(); config.action(); } else { document.querySelector(`.toolbar-right ${config.selector}`)?.click(); } }); return btn; }
    function initMenuObserver() { if (!document.body) return; new MutationObserver(() => { const menuPane = document.querySelector('.cdk-overlay-pane .mat-mdc-menu-content'); if (menuPane && !menuPane.hasAttribute('ai-menu-patched')) { menuPane.setAttribute('ai-menu-patched', 'true'); const div = document.createElement('div'); div.style.borderBottom = '1px solid #333'; div.style.margin = '4px 0'; menuPane.insertBefore(div, menuPane.firstChild); [...PROXY_BUTTON_MAP].reverse().forEach(c => menuPane.insertBefore(createProxyMenuItem(c), menuPane.firstChild)); } initSettingsUI(); }).observe(document.body, { childList: true, subtree: true }); }
    async function fetchAndExportChat(format) { const id = getCurrentPromptId(); if (!id || !cachedApiHeaders['x-goog-api-key']) { alert("Interact with chat first."); return; } try { const res = await originalFetch("https://alkalimakersuite-pa.clients6.google.com/$rpc/google.internal.alkali.applications.makersuite.v1.MakerSuiteService/ResolveDriveResource", { method: 'POST', headers: { ...cachedApiHeaders, 'content-type': 'application/json+protobuf' }, body: JSON.stringify([id]), credentials: 'include' }); const json = await res.json(); const content = parseRpcResponse(json); if (!content.length) return alert("Export failed"); const title = document.querySelector('h1.mode-title')?.innerText.trim() || id; if (format === 'json') downloadFile(`${title}.json`, JSON.stringify(content, null, 2), 'application/json'); else { let md = `# ${title}\n\n`; content.forEach(t => md += `## ${t.role === 'user' ? 'User' : 'Model'}\n${t.text}\n\n---\n\n`); downloadFile(`${title}.md`, md, 'text/markdown'); } } catch (e) { alert("Error: " + e); } }
    function parseRpcResponse(json) { try { const root = json[0]; let turns = []; const find = (o) => { if (turns.length) return; if (Array.isArray(o) && o.length > 0 && Array.isArray(o[0]) && (o[0][8] === 'user' || o[0][8] === 'model')) { turns = o; return; } if (Array.isArray(o)) o.forEach(find); }; find(root); return turns.map(t => ({ role: t[8], text: t[0] || "" })); } catch { return []; } }
    function downloadFile(name, content, type) { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([content], { type })); a.download = name; a.click(); }

    function renderRelatedChats() { if (!window.location.href.includes('/prompts/')) return; const toolbarLeft = document.querySelector('.toolbar-left'); if (!toolbarLeft || toolbarLeft.querySelector('#ai-related-chats-user')) return; const titleH1 = document.querySelector('h1.mode-title'); if (!titleH1) return; const normalize = (str) => str.toLowerCase().replace(/\s+/g, ' ').trim(); const currentTitle = titleH1.innerText.replace(/\s+/g, ' ').trim(); const currentId = window.location.href.match(/\/prompts\/([a-zA-Z0-9-_]+)/)[1]; const db = getDb(); const currentData = db[currentId] || {}; const match = currentTitle.match(/^(?:Copy|Branch) of (.+)$/i);
    // RECURSIVE ROOT FINDER
    let rootName = currentTitle;
    while (rootName.match(/^(?:Copy|Branch) of /i)) { rootName = rootName.replace(/^(?:Copy|Branch) of /i, '').trim(); }
    const normRoot = normalize(rootName);
    const family = []; for (const [id, data] of Object.entries(db)) { const dName = (data.name || '').trim(); const normName = normalize(dName); let type = null; if (normName === normRoot) type = 'Parent'; else if (normName === normalize(`Copy of ${rootName}`)) type = 'Copy'; else if (normName === normalize(`Branch of ${rootName}`)) type = 'Branch'; if (type) family.push({ type, ...data, id }); } const related = family.filter(f => f.id !== currentId); if (related.length === 0) return; related.sort((a, b) => { const timeA = a.created ? new Date(a.created).getTime() : 0; const timeB = b.created ? new Date(b.created).getTime() : 0; return timeA - timeB; }); const container = document.createElement('div'); container.id = 'ai-related-chats-user'; const currentModified = currentData.modified ? new Date(currentData.modified).getTime() : 0; const ICON_PARENT = `<svg viewBox="0 0 24 24"><path d="M4 12l1.41 1.41L11 7.83V20h2V7.83l5.58 5.59L20 12l-8-8-8 8z"/></svg>`; const ICON_COPY = `<svg viewBox="0 0 24 24"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>`; const ICON_BRANCH = `<svg viewBox="0 0 24 24" style="transform: scaleX(-1);"><path d="M14,4l2.29,2.29L12.59,10.01C12.56,10,12.53,10,12.5,10c-2.61,0-4.92,0.98-6.7,2.59C4.69,13.6,3.76,14.94,3.2,16.46 l1.86,0.77c0.42-1.14,1.12-2.14,1.95-2.89C8.34,13.15,10.07,12.4,12.01,12.4c0.27,0,0.53,0.01,0.79,0.04l3.49-3.49L19,11.5V4H14z"/></svg>`; let html = ``; related.forEach((item, index) => { let svg = ICON_COPY; if (item.type === 'Parent') svg = ICON_PARENT; if (item.type === 'Branch') svg = ICON_BRANCH; const itemModified = item.modified ? new Date(item.modified).getTime() : 0; const isNewer = itemModified > currentModified; const statusClass = isNewer ? 'newer' : 'older'; const countStr = item.msgCount ? `(${item.msgCount})` : ''; const tooltip = `${item.type}: ${item.name}\nModified: ${item.modified ? new Date(item.modified).toLocaleString() : '?'}`; html += `<a href="/prompts/${item.id}" class="user-related-chip ${statusClass}" title="${tooltip}"><span class="index-num">${index + 1}</span>${svg}<span class="msg-cnt">${countStr}</span></a>`; }); container.innerHTML = html; toolbarLeft.appendChild(container); }

    // ==========================================
    // 8. RESTORED MISSING FUNCTIONS
    // ==========================================

    async function getAccessToken() { if (!CONFIG.CLIENT_ID || CONFIG.CLIENT_ID.includes('YOUR_')) { console.warn(`${DBG} Credentials not configured. See README.`); return null; } const saved = JSON.parse(GM_getValue(TOKEN_KEY, '{}')); if (saved.token && saved.expires > (Date.now() / 1000) + 60) return saved.token; return new Promise((resolve) => { GM_xmlhttpRequest({ method: "POST", url: "https://oauth2.googleapis.com/token", headers: { "Content-Type": "application/x-www-form-urlencoded" }, data: `client_id=${CONFIG.CLIENT_ID}&client_secret=${CONFIG.CLIENT_SECRET}&refresh_token=${CONFIG.REFRESH_TOKEN}&grant_type=refresh_token`, onload: (res) => { try { const data = JSON.parse(res.responseText); if (data.access_token) { GM_setValue(TOKEN_KEY, JSON.stringify({ token: data.access_token, expires: (Date.now()/1000)+data.expires_in })); resolve(data.access_token); } else resolve(null); } catch (e) { resolve(null); } } }); }); }

    // REVISED SYNC: Search Globally for MIME Type & Garbage Collect
    async function syncDriveMetadata(force = false) {
        const lastSync = GM_getValue(SYNC_TIME_KEY, 0);
        // 1. Force Clean on First Load (Version Check) or Manual
        const isStartup = (Date.now() - lastSync) > 999999999; // Or simply always force for this version if preferred

        if (!force && (Date.now() - lastSync) / 1000 / 60 < CONFIG.SYNC_INTERVAL_MINUTES) {
            console.log(`${DBG} Sync skipped (Recent: ${Math.round((Date.now() - lastSync)/1000)}s ago)`);
            return;
        }

        console.log(`${DBG} ♻️ Starting Drive Sync & GC...`);
        const token = await getAccessToken(); if (!token) return;

        const query = "mimeType='application/vnd.google-makersuite.prompt' and trashed=false";
        const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=nextPageToken,files(id,createdTime,modifiedTime,name)&pageSize=1000`;

        GM_xmlhttpRequest({
            method: "GET", url: url, headers: { "Authorization": `Bearer ${token}` },
            onload: (res) => { try {
                const data = JSON.parse(res.responseText);
                const newFiles = data.files || [];
                if (data.nextPageToken) fetchAllFiles(token, null, data.nextPageToken, newFiles);
                else processAndSaveFiles(newFiles);
            } catch (e) { console.error(e); } }
        });
    }

    function fetchAllFiles(token, folderId, pageToken = null, aggregatedFiles = []) {
        const query = "mimeType='application/vnd.google-makersuite.prompt' and trashed=false";
        let url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=nextPageToken,files(id,createdTime,modifiedTime,name)&pageSize=1000`; if (pageToken) url += `&pageToken=${pageToken}`; GM_xmlhttpRequest({ method: "GET", url: url, headers: { "Authorization": `Bearer ${token}` }, onload: (res) => { try { const data = JSON.parse(res.responseText); const newFiles = data.files || []; const allFiles = aggregatedFiles.concat(newFiles); if (data.nextPageToken) fetchAllFiles(token, null, data.nextPageToken, allFiles); else processAndSaveFiles(allFiles); } catch (e) { console.error(e); } } });
    }

    function processAndSaveFiles(fileList) {
        if (!fileList) return;
        const db = getDb();
        const driveIds = new Set();
        let hasChanges = false;
        let deletedCount = 0;

        // 1. Update/Add existing (Batch)
        fileList.forEach(f => {
            driveIds.add(f.id);
            const existing = db[f.id] || {};
            let changed = false;
            if (existing.created !== f.createdTime) { existing.created = f.createdTime; changed = true; }
            if (existing.modified !== f.modifiedTime) { existing.modified = f.modifiedTime; changed = true; }
            if (existing.name !== f.name) { existing.name = f.name; changed = true; }
            // Add 'Drive API' source if not present or lower priority
            if (!existing.tokenSource || SOURCE_PRIORITY[existing.tokenSource] < SOURCE_PRIORITY['Drive API']) {
                 existing.tokenSource = 'Drive API'; changed = true;
            }
            if (changed) { db[f.id] = existing; hasChanges = true; }
        });

        // 2. Garbage Collection: Remove missing keys
        Object.keys(db).forEach(id => {
            if (!driveIds.has(id)) {
                delete db[id];
                hasChanges = true;
                deletedCount++;
            }
        });

        if (hasChanges) {
            console.log(`${DBG} Sync Complete. Updated: ${fileList.length}, Deleted: ${deletedCount}`);
            saveDb(db);
            GM_setValue(SYNC_TIME_KEY, Date.now());
            triggerTableUpdate();
            // Immediate toolbar update if viewing a deleted/changed chat
            const match = window.location.href.match(/\/prompts\/([a-zA-Z0-9-_]+)/);
            if (match && match[1]) renderRelatedChats();
        } else {
            console.log(`${DBG} Sync Complete. No changes.`);
            GM_setValue(SYNC_TIME_KEY, Date.now());
        }
    }

    function manageTokenSync() {
        const url = window.location.href;
        const match = url.match(/\/prompts\/([a-zA-Z0-9-_]+)/);
        if (!match) return;
        const id = match[1];
        renderMetadata(id);
        if (id !== activePromptId) { activePromptId = id; hasNetworkData = false; }
        if (hasNetworkData) {
            const valEl = document.querySelector('.v3-token-count-value');
            const db = getDb();
            if (db[id] && db[id].tokens && valEl && !valEl.textContent.includes(db[id].tokens.toLocaleString())) {
                 valEl.textContent = `${db[id].tokens.toLocaleString()} tokens`;
                 valEl.classList.remove('loading');
            }
            return;
        }
        if (isGenerating) return;
        let tooltipScraped = false;
        const tooltip = document.querySelector('.token-count-tooltip');
        if (tooltip) {
            const rows = tooltip.querySelectorAll('.tooltip-row');
            rows.forEach(row => {
                if (row.textContent.includes('Total tokens:')) {
                    const spans = row.querySelectorAll('span');
                    if (spans.length >= 2) {
                        const total = parseInt(spans[1].innerText.replace(/,/g, ''));
                        if (total > 0) {
                            saveStats(id, { tokens: total }, "Deep Tooltip");
                            tooltipScraped = true;
                            if (currentProbedId === id && !userIsHovering) {
                                const trigger = document.querySelector('.v3-token-count-value');
                                if (trigger) trigger.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }));
                                document.body.classList.remove('ai-probing-tokens');
                            }
                        }
                    }
                }
            });
        }
        if (currentProbedId !== id && !userIsHovering) {
            const trigger = document.querySelector('.v3-token-count-value');
            if (trigger && !tooltip) {
                document.body.classList.add('ai-probing-tokens');
                trigger.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
                currentProbedId = id;
                setTimeout(() => { document.body.classList.remove('ai-probing-tokens'); }, 2000);
            }
        }
        if (!tooltipScraped) {
            const valEl = document.querySelector('.v3-token-count-value');
            if (valEl) {
                const text = valEl.innerText;
                if (/\d/.test(text) && !valEl.querySelector('.loading-token-count-placeholder')) {
                    const num = parseInt(text.replace(/[^0-9]/g, ''));
                    if (num > 0) saveStats(id, { tokens: num }, "Top Bar");
                }
            }
        }
    }

    GM_addStyle(`
        /* SETTINGS & MODAL */
        .ai-settings-btn { width: 50%; border-top-left-radius: 0; border-bottom-left-radius: 0; }
        .ai-modal-backdrop { position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; background: rgba(0, 0, 0, 0.6); backdrop-filter: blur(2px); z-index: 99999; display: flex; align-items: center; justify-content: center; opacity: 0; visibility: hidden; transition: opacity 0.2s; }
        .ai-modal-backdrop.active { opacity: 1; visibility: visible; }
        .ai-modal-window { background: #1e1e1e; border: 1px solid rgba(255,255,255,0.1); border-radius: 12px; width: 400px; max-width: 90%; box-shadow: 0 10px 40px rgba(0,0,0,0.5); font-family: 'Roboto', sans-serif; color: #fff; }
        .ai-modal-header { display: flex; justify-content: space-between; align-items: center; padding: 16px 20px; border-bottom: 1px solid rgba(255,255,255,0.1); }
        .ai-modal-header h2 { margin: 0; font-size: 18px; font-weight: 500; }
        #ai-modal-close { background: transparent; border: none; color: #aaa; font-size: 20px; cursor: pointer; padding: 4px; }
        #ai-modal-close:hover { color: #fff; }
        .ai-modal-content { padding: 20px; }
        .ai-setting-group { margin-bottom: 20px; }
        .ai-setting-group label { display: block; font-size: 14px; color: #ccc; margin-bottom: 8px; }
        .ai-setting-note { font-size: 12px; color: #777; font-style: italic; }
        .ai-modal-footer { text-align: center; margin-top: 20px; border-top: 1px solid rgba(255,255,255,0.05); padding-top: 10px; }
        .ai-version { font-size: 11px; color: #555; }
        .ai-action-btn { width: 100%; padding: 10px; background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.2); color: #fff; border-radius: 6px; cursor: pointer; transition: background 0.2s; }
        .ai-action-btn:hover { background: rgba(255,255,255,0.2); }
        select { width: 100%; padding: 8px; background: rgba(0,0,0,0.2); border: 1px solid rgba(255,255,255,0.1); border-radius: 4px; color: #fff; outline: none; }
        input[type="color"] { width: 50px; height: 30px; border: none; background: transparent; cursor: pointer; }
        /* FAB SCROLL & SEARCH */
        #ai-fab-container { position: fixed; bottom: 24px; right: 24px; display: none; flex-direction: column; gap: 12px; z-index: 999999 !important; pointer-events: auto !important; }
        .ai-fab-btn { width: 44px; height: 44px; border-radius: 50%; background: rgba(255, 255, 255, 0.08); border: 1px solid rgba(255, 255, 255, 0.1); color: #fff; display: flex; align-items: center; justify-content: center; cursor: pointer; transition: all 0.2s; backdrop-filter: blur(4px); }
        .ai-fab-btn:hover { background: rgba(255, 255, 255, 0.15); transform: translateY(-2px); box-shadow: 0 4px 12px rgba(0,0,0,0.3); }
        .ai-fab-btn svg { width: 24px; height: 24px; fill: currentColor; }
        #ai-search-bar { position: fixed; top: 70px; right: 24px; background: #1e1e1e; border: 1px solid rgba(255,255,255,0.15); border-radius: 8px; padding: 8px; display: none; align-items: center; gap: 8px; box-shadow: 0 4px 20px rgba(0,0,0,0.5); z-index: 10000; font-family: 'Roboto', sans-serif; }
        #ai-search-input { background: rgba(255,255,255,0.05); border: 1px solid transparent; border-radius: 4px; color: #fff; padding: 6px 10px; outline: none; font-size: 13px; width: 200px; }
        #ai-search-input:focus { border-color: #4ade80; background: rgba(0,0,0,0.2); }
        #ai-search-count { font-size: 12px; color: #888; min-width: 40px; text-align: center; }
        .ai-search-actions { display: flex; gap: 2px; }
        .ai-search-actions button { background: transparent; border: none; color: #bbb; cursor: pointer; padding: 4px 8px; border-radius: 4px; font-size: 14px; }
        .ai-search-actions button:hover { background: rgba(255,255,255,0.1); color: #fff; }
        .ai-search-highlight { position: relative; border: 2px solid #3b82f6 !important; border-radius: 8px; box-shadow: 0 0 15px rgba(59, 130, 246, 0.3); animation: highlightPulse 2s infinite; }
        @keyframes highlightPulse { 0% { border-color: #3b82f6; } 50% { border-color: #60a5fa; box-shadow: 0 0 20px rgba(59, 130, 246, 0.5); } 100% { border-color: #3b82f6; } }
        /* MISC */
        .toolbar-right ms-share-prompt, .toolbar-right button[iconname="compare_arrows"], .toolbar-right button[iconname="add"] { display: none !important; }
        .custom-header { position: relative; cursor: pointer; user-select: none; }
        .mat-sort-header-container { display: flex; align-items: center; }
        .custom-arrow-container { height: 24px; width: 24px; min-width: 24px; margin: 0 0 0 6px; position: relative; display: flex; opacity: 0; transition: opacity 200ms; }
        .custom-arrow-container svg { width: 100%; height: 100%; fill: currentColor; }
        .custom-header:hover .custom-arrow-container { opacity: 0.54; }
        .custom-header.sorted-asc .custom-arrow-container, .custom-header.sorted-desc .custom-arrow-container { opacity: 1; }
        .custom-header.sorted-desc .custom-arrow-container { transform: rotate(180deg); }
        table.custom-sorting-active th:not(.custom-header) .mat-sort-header-arrow { opacity: 0 !important; min-width: 0 !important; margin: 0 !important; }
        .creation-date-cell, .tokens-cell, .count-cell { font-family: 'Roboto Mono', monospace; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--mat-table-row-item-label-text-color, #e0e0e0); }
        .is-branch-row { background-color: rgba(255, 255, 255, 0.02); }
        .is-branch-row .cdk-column-name { padding-left: 35px !important; position: relative; }
        .is-branch-row .cdk-column-name::before { content: '└─'; position: absolute; left: 12px; color: var(--mat-table-row-item-label-text-color, #777); font-family: monospace; font-weight: 300; }
        .page-title { display: flex !important; align-items: center !important; white-space: nowrap !important; flex-shrink: 0 !important; }
        #ai-related-chats-user { display: flex; align-items: center; gap: 8px; margin-left: 16px; font-size: 12px; border-left: 1px solid rgba(255,255,255,0.1); padding-left: 16px; height: 24px; flex-shrink: 0; }
        .user-related-chip { display: flex; align-items: center; gap: 6px; padding: 2px 8px; border-radius: 12px; text-decoration: none; transition: all 0.2s; white-space: nowrap; opacity: 1 !important; font-family: 'Roboto', sans-serif; font-weight: 500; font-size: 12px; border: 1px solid rgba(255,255,255,0.1); background: rgba(255,255,255,0.05); color: #888; }
        .user-related-chip:hover { background: rgba(255,255,255,0.1); color: #ccc; }
        .user-related-chip svg { width: 14px; height: 14px; fill: currentColor; opacity: 0.8; }
        .user-related-chip .index-num { font-weight: bold; font-size: 11px; opacity: 0.6; margin-right: 2px; }
        .user-related-chip .msg-cnt { font-size: 10px; opacity: 0.6; font-weight: normal; margin-left: 2px; }
        .user-related-chip.older { border-color: rgba(255,255,255,0.1); color: #888; }
        .user-related-chip.newer { border-color: rgba(74, 222, 128, 0.4); color: #86efac; background: rgba(74, 222, 128, 0.05); }
        .user-related-chip.newer:hover { background: rgba(74, 222, 128, 0.15); }
        #ai-custom-meta-bar { display: flex; align-items: center; gap: 8px; margin-left: 12px; padding-left: 12px; border-left: 1px solid rgba(255,255,255,0.15); font-family: 'Roboto', sans-serif; font-size: 11px; color: rgba(255,255,255,0.6); flex-shrink: 0; }
        .meta-item { display: flex; align-items: center; gap: 4px; cursor: default; transition: color 0.2s; }
        .meta-item:hover { color: rgba(255,255,255,0.9); }
        .meta-item svg { width: 14px; height: 14px; fill: currentColor; opacity: 0.7; }
        .meta-divider { width: 3px; height: 3px; background: rgba(255,255,255,0.3); border-radius: 50%; }
        body.ai-probing-tokens .cdk-overlay-pane:has(.token-count-tooltip), body.ai-probing-tokens .token-count-tooltip { opacity: 0 !important; visibility: hidden !important; pointer-events: none !important; }
        @keyframes tokenFlash { 0% { color: inherit; } 50% { color: #4ade80; text-shadow: 0 0 8px rgba(74, 222, 128, 0.6); } 100% { color: inherit; } }
        .token-updated-flash { animation: tokenFlash 1s ease-out; }
        .loading-token-count-placeholder { height: 16px; width: 60px; background: rgba(255,255,255,0.1); border-radius: 4px; display: inline-block; animation: pulse 1.5s infinite ease-in-out; }
        @keyframes pulse { 0% { opacity: 0.6; } 50% { opacity: 0.3; } 100% { opacity: 0.6; } }
    `);

    if (document.body) { initMenuObserver(); } else { document.addEventListener('DOMContentLoaded', () => { initMenuObserver(); }); }

    // Force sync on startup (ignore timer)
    setTimeout(() => syncDriveMetadata(true), 3000);

    setInterval(() => {
        const url = window.location.href;
        if (url.includes('/library')) { if (!tableObserver) initTableObserver(); }
        else if (url.includes('/prompts/')) {
            if (tableObserver) { tableObserver.disconnect(); tableObserver = null; }
            const match = url.match(/\/prompts\/([a-zA-Z0-9-_]+)/);
            if (match) {
                manageTokenSync();
                renderRelatedChats();
            }
            renderScrollFab();
        } else { const container = document.getElementById('ai-fab-container'); if(container) container.style.display = 'none'; }
    }, 1000);

})();
