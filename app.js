(function () {
    'use strict';

    const STORAGE_KEYS = {
        entries: 'dtt_entries',
        projects: 'dtt_projects',
        categories: 'dtt_categories',
        tips: 'dtt_tips',
    };
    const STORAGE_META_KEY = 'dtt_sync_meta';
    const PENDING_LOGIN_KEY = 'dtt_onedrive_login_pending';
    const APP_DATA_FILE_NAME = 'dailytimetracker-data.json';
    const GRAPH_BASE_URL = 'https://graph.microsoft.com/v1.0';
    const GRAPH_FILE_PATH = `/me/drive/special/approot:/${APP_DATA_FILE_NAME}`;
    const GRAPH_CONTENT_PATH = `${GRAPH_FILE_PATH}:/content`;
    const GRAPH_SCOPES = ['User.Read', 'Files.ReadWrite.AppFolder'];
    const LOGIN_REQUEST = { scopes: GRAPH_SCOPES };
    const MSAL_CONFIG = {
        auth: {
            clientId: '01d80b57-6a01-448d-ac58-d7a566a16673',
            authority: 'https://login.microsoftonline.com/common',
            redirectUri: window.location.origin + window.location.pathname,
        },
        cache: {
            cacheLocation: 'localStorage',
            storeAuthStateInCookie: false,
        },
    };

    // ── State ──
    const state = {
        entries: [],
        projects: [],
        categories: [],
        tips: [],
        localUpdatedAt: '',
        sync: {
            msal: null,
            account: null,
            initialized: false,
            busy: false,
            resuming: false,
            status: 'local',
            title: 'Nicht angemeldet',
            message: 'Deine Daten werden lokal auf diesem Gerät gespeichert.',
            lastRemoteUpdatedAt: '',
            lastRemoteEtag: '',
            hasRemoteData: false,
            conflictData: null,
        },
        timer: { running: false, paused: false, startTime: null, elapsed: 0, interval: null },
        reportPeriod: 'day',
        reportOffset: 0,
        reportCustomStart: '',
        reportCustomEnd: '',
        vdayDate: '',
    };

    const ENTRY_TYPES = ['erfolgt', 'geplant'];
    const VDAY_STEP_MINUTES = 15;
    const VDAY_DAY_MINUTES = 24 * 60;

    function normalizeEntryType(type) {
        return ENTRY_TYPES.includes(type) ? type : 'erfolgt';
    }

    function migrateEntries(entries) {
        return entries.map((entry) => ({
            ...entry,
            entryType: normalizeEntryType(entry.entryType),
        }));
    }

    // ── LocalStorage ──
    function saveLocalData(updatedAt = nowIso()) {
        localStorage.setItem(STORAGE_KEYS.entries, JSON.stringify(state.entries));
        localStorage.setItem(STORAGE_KEYS.projects, JSON.stringify(state.projects));
        localStorage.setItem(STORAGE_KEYS.categories, JSON.stringify(state.categories));
        localStorage.setItem(STORAGE_KEYS.tips, JSON.stringify(state.tips));
        localStorage.setItem(STORAGE_META_KEY, JSON.stringify({ updatedAt }));
        state.localUpdatedAt = updatedAt;
        return localDataSnapshot(updatedAt);
    }

    function save() {
        saveLocalData();
        queueOneDriveSave();
    }

    function load() {
        try {
            state.entries = migrateEntries(JSON.parse(localStorage.getItem(STORAGE_KEYS.entries)) || []);
            state.projects = JSON.parse(localStorage.getItem(STORAGE_KEYS.projects)) || [];
            state.categories = JSON.parse(localStorage.getItem(STORAGE_KEYS.categories)) || [];
            state.tips = JSON.parse(localStorage.getItem(STORAGE_KEYS.tips)) || [];
            const meta = JSON.parse(localStorage.getItem(STORAGE_META_KEY) || '{}');
            state.localUpdatedAt = typeof meta.updatedAt === 'string' ? meta.updatedAt : '';
        } catch {
            state.entries = [];
            state.projects = [];
            state.categories = [];
            state.tips = [];
            state.localUpdatedAt = '';
        }
        if (state.projects.length === 0) {
            state.projects = [
                { id: uid(), name: 'Arbeit', color: '#4a90d9' },
                { id: uid(), name: 'Privat', color: '#27ae60' },
                { id: uid(), name: 'Lernen', color: '#e67e22' },
            ];
        }
        if (state.categories.length === 0) {
            state.categories = [
                { id: uid(), name: 'Entwicklung', color: '#9b59b6' },
                { id: uid(), name: 'Meeting', color: '#e74c3c' },
                { id: uid(), name: 'Planung', color: '#1abc9c' },
                { id: uid(), name: 'Sonstiges', color: '#95a5a6' },
            ];
        }
        state.projects.sort((a, b) => a.name.localeCompare(b.name, 'de'));
        state.categories.sort((a, b) => a.name.localeCompare(b.name, 'de'));
        saveLocalData(state.localUpdatedAt || nowIso());
    }

    // ── Helpers ──
    function uid() {
        return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    }

    function fmt(seconds) {
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = Math.floor(seconds % 60);
        return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }

    function fmtDecimal(seconds) {
        return (seconds / 3600).toFixed(1) + 'h';
    }

    function fmtMinToHM(minutes) {
        const h = Math.floor(minutes / 60);
        const m = minutes % 60;
        if (h > 0 && m > 0) return `${h} std ${m} min`;
        if (h > 0) return `${h} std`;
        return `${m} min`;
    }

    function renderSummaryCards(targetSel, entries, options = {}) {
        const el = $(targetSel);
        if (!el) return;

        const totalSeconds = entries.reduce((sum, entry) => sum + entry.duration, 0);
        const uniqueDays = new Set(entries.map((entry) => entry.date)).size;
        const averageCard = options.showAverage === false
            ? ''
            : `<div class="summary-card"><div class="label">Ø pro Tag</div><div class="value">${uniqueDays ? fmtDecimal(totalSeconds / uniqueDays) : '0.0h'}</div></div>`;

        el.innerHTML = `
            <div class="summary-card"><div class="label">Gesamtzeit</div><div class="value">${fmt(totalSeconds)}</div></div>
            <div class="summary-card"><div class="label">Einträge</div><div class="value">${entries.length}</div></div>
            <div class="summary-card"><div class="label">Aktive Tage</div><div class="value">${uniqueDays}</div></div>
            ${averageCard}
        `;
    }

    function todayStr() {
        return new Date().toISOString().slice(0, 10);
    }

    function nowIso() {
        return new Date().toISOString();
    }

    function nowStr() {
        const d = new Date();
        const date = d.toISOString().slice(0, 10);
        const time = d.toTimeString().slice(0, 8).replace(/:/g, '-');
        return `${date}_${time}`;
    }

    function escHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    const richTextAllowedTags = new Set(['B', 'STRONG', 'I', 'EM', 'U', 'BR', 'DIV', 'P', 'UL', 'OL', 'LI', 'BLOCKQUOTE']);
    const richTextAllowedAttributes = new Set(['style']);

    function sanitizeRichTextHtml(html) {
        const template = document.createElement('template');
        template.innerHTML = html || '';

        function cleanNode(node) {
            if (node.nodeType === Node.TEXT_NODE) {
                return document.createTextNode(node.textContent || '');
            }
            if (node.nodeType !== Node.ELEMENT_NODE) {
                return document.createDocumentFragment();
            }
            if (!richTextAllowedTags.has(node.tagName)) {
                const fragment = document.createDocumentFragment();
                Array.from(node.childNodes).forEach((child) => {
                    fragment.appendChild(cleanNode(child));
                });
                return fragment;
            }
            const element = document.createElement(node.tagName.toLowerCase());
            Array.from(node.attributes || []).forEach((attr) => {
                if (richTextAllowedAttributes.has(attr.name.toLowerCase()) && /^margin-left:\s*\d+px;?$/i.test(attr.value.trim())) {
                    element.setAttribute('style', attr.value.trim());
                }
            });
            Array.from(node.childNodes).forEach((child) => {
                element.appendChild(cleanNode(child));
            });
            return element;
        }

        const fragment = document.createDocumentFragment();
        Array.from(template.content.childNodes).forEach((child) => {
            fragment.appendChild(cleanNode(child));
        });
        const wrapper = document.createElement('div');
        wrapper.appendChild(fragment);
        return wrapper.innerHTML;
    }

    function richTextToHtml(value) {
        const text = String(value || '');
        const hasAllowedHtml = /<\/?(b|strong|i|em|u|br|div|p|ul|ol|li|blockquote)\b/i.test(text);
        if (hasAllowedHtml) return sanitizeRichTextHtml(text);
        return escHtml(text).replace(/\n/g, '<br>');
    }

    function richTextToPlainText(html) {
        const div = document.createElement('div');
        div.innerHTML = sanitizeRichTextHtml(html || '');
        div.querySelectorAll('br').forEach((br) => br.replaceWith('\n'));
        div.querySelectorAll('p, div, li, blockquote').forEach((block) => {
            block.appendChild(document.createTextNode('\n'));
        });
        return (div.textContent || '')
            .replace(/\u00a0/g, ' ')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
    }

    function getClosestElement(node) {
        if (!node) return null;
        return node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    }

    function getSelectedListItems(editor) {
        const selection = window.getSelection();
        if (!selection || selection.rangeCount === 0 || !editor.contains(selection.anchorNode)) return [];

        const range = selection.getRangeAt(0);
        const items = new Set();
        editor.querySelectorAll('li').forEach((item) => {
            try {
                if (range.intersectsNode(item)) items.add(item);
            } catch {
                // Ignore detached or unsupported nodes while editing.
            }
        });

        [selection.anchorNode, selection.focusNode].forEach((node) => {
            const item = getClosestElement(node)?.closest('li');
            if (item && editor.contains(item)) items.add(item);
        });

        return Array.from(items).sort((a, b) => {
            if (a === b) return 0;
            return a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
        });
    }

    function unwrapSelectedListItems(editor) {
        const selectedItems = getSelectedListItems(editor);
        if (selectedItems.length === 0) return false;

        const selectedSet = new Set(selectedItems);
        const lists = Array.from(new Set(selectedItems.map((item) => item.parentElement))).filter(Boolean);

        lists.forEach((list) => {
            const replacement = document.createDocumentFragment();
            let activeList = null;

            Array.from(list.children).forEach((child) => {
                if (child.tagName === 'LI' && selectedSet.has(child)) {
                    activeList = null;
                    const plainLine = document.createElement('div');
                    plainLine.textContent = richTextToPlainText(child.innerHTML);
                    replacement.appendChild(plainLine);
                    return;
                }

                if (!activeList) {
                    activeList = document.createElement(list.tagName.toLowerCase());
                    replacement.appendChild(activeList);
                }
                activeList.appendChild(child.cloneNode(true));
            });

            list.replaceWith(replacement);
        });

        editor.innerHTML = sanitizeRichTextHtml(editor.innerHTML);
        return true;
    }

    function clearRichTextFormatting(editor) {
        editor.focus();
        document.execCommand('removeFormat', false, null);
        unwrapSelectedListItems(editor);
        editor.innerHTML = sanitizeRichTextHtml(editor.innerHTML);
    }

    function createRichTextField(value, placeholder) {
        const editorWrap = document.createElement('div');
        editorWrap.className = 'rich-text-field';
        const toolbar = document.createElement('div');
        toolbar.className = 'rich-text-toolbar';
        const editor = document.createElement('div');
        editor.className = 'rich-text-editor';
        editor.contentEditable = 'true';
        editor.setAttribute('role', 'textbox');
        editor.setAttribute('aria-multiline', 'true');
        editor.dataset.placeholder = placeholder || 'Text ...';
        editor.innerHTML = richTextToHtml(value || '');

        [
            { command: 'bold', label: 'B', title: 'Fett' },
            { command: 'italic', label: 'I', title: 'Kursiv' },
            { command: 'underline', label: 'U', title: 'Unterstreichen' },
            { command: 'insertUnorderedList', label: '•', title: 'Aufzählung' },
            { command: 'insertOrderedList', label: '1.', title: 'Nummerierte Liste' },
            { command: 'outdent', label: '←', title: 'Weniger einrücken' },
            { command: 'indent', label: '→', title: 'Einrücken' },
            { command: 'removeFormat', label: 'Tx', title: 'Formatierung entfernen' },
        ].forEach(({ command, label, title }) => {
            const formatBtn = document.createElement('button');
            formatBtn.type = 'button';
            formatBtn.className = 'rich-text-btn';
            formatBtn.textContent = label;
            formatBtn.title = title;
            formatBtn.addEventListener('mousedown', (e) => e.preventDefault());
            formatBtn.addEventListener('click', () => {
                editor.focus();
                if (command === 'removeFormat') {
                    clearRichTextFormatting(editor);
                } else {
                    document.execCommand(command, false, null);
                }
            });
            toolbar.appendChild(formatBtn);
        });

        editor.addEventListener('paste', (e) => {
            e.preventDefault();
            const html = e.clipboardData.getData('text/html');
            const text = e.clipboardData.getData('text/plain');
            if (html) {
                document.execCommand('insertHTML', false, sanitizeRichTextHtml(html));
            } else {
                document.execCommand('insertText', false, text);
            }
        });
        editor.addEventListener('blur', () => {
            editor.innerHTML = sanitizeRichTextHtml(editor.innerHTML);
        });

        editorWrap.appendChild(toolbar);
        editorWrap.appendChild(editor);
        return editorWrap;
    }

    function setupRichTextTextarea(target) {
        const textarea = typeof target === 'string' ? document.querySelector(target) : target;
        if (!textarea || textarea.dataset.richTextReady === 'true') return textarea;

        const field = createRichTextField(textarea.value, textarea.placeholder);
        field.classList.add('rich-text-textarea-field');
        const editor = field.querySelector('.rich-text-editor');
        const sync = () => {
            textarea.value = sanitizeRichTextHtml(editor.innerHTML);
        };

        editor.addEventListener('input', sync);
        editor.addEventListener('blur', sync);
        textarea.after(field);
        textarea.hidden = true;
        textarea.dataset.richTextReady = 'true';
        textarea.richTextEditor = editor;
        textarea.syncRichText = sync;
        sync();
        return textarea;
    }

    function getRichTextTextareaValue(target) {
        const textarea = setupRichTextTextarea(target);
        if (!textarea) return '';
        if (textarea.syncRichText) textarea.syncRichText();
        return sanitizeRichTextHtml(textarea.value || '');
    }

    function setRichTextTextareaValue(target, value) {
        const textarea = setupRichTextTextarea(target);
        if (!textarea) return;
        textarea.richTextEditor.innerHTML = richTextToHtml(value || '');
        textarea.syncRichText();
    }

    function clearRichTextTextarea(target) {
        setRichTextTextareaValue(target, '');
    }

    // ── DOM refs ──
    const $ = (sel) => document.querySelector(sel);
    const $$ = (sel) => document.querySelectorAll(sel);

    function getSelectedEntryType(name) {
        const checked = document.querySelector(`input[name="${name}"]:checked`);
        return checked ? normalizeEntryType(checked.value) : '';
    }

    function clearRadioGroup(name) {
        $$(`input[name="${name}"]`).forEach((radio) => {
            radio.checked = false;
        });
    }

    function clearSummaryCards(targetSel) {
        const el = $(targetSel);
        if (el) el.innerHTML = '';
    }

    function localDataSnapshot(updatedAt = state.localUpdatedAt || nowIso()) {
        return {
            app: 'dailytimetracker',
            version: 1,
            updatedAt,
            entries: migrateEntries(Array.isArray(state.entries) ? state.entries : []),
            projects: Array.isArray(state.projects) ? state.projects : [],
            categories: Array.isArray(state.categories) ? state.categories : [],
            tips: Array.isArray(state.tips) ? state.tips : [],
        };
    }

    function parseRemoteData(data) {
        if (!data || typeof data !== 'object') return null;
        return {
            app: 'dailytimetracker',
            version: Number(data.version) || 1,
            updatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : '',
            entries: migrateEntries(Array.isArray(data.entries) ? data.entries : []),
            projects: Array.isArray(data.projects) ? data.projects : [],
            categories: Array.isArray(data.categories) ? data.categories : [],
            tips: Array.isArray(data.tips) ? data.tips : [],
        };
    }

    function hasTrackerData(data) {
        return Boolean(
            data
            && (
                data.entries?.length
                || data.projects?.length
                || data.categories?.length
                || data.tips?.length
            )
        );
    }

    function comparableData(data) {
        const normalized = parseRemoteData(data) || localDataSnapshot('');
        return JSON.stringify({
            entries: normalized.entries,
            projects: normalized.projects,
            categories: normalized.categories,
            tips: normalized.tips,
        });
    }

    function sameTrackerData(left, right) {
        return comparableData(left) === comparableData(right);
    }

    function remoteIsNewer(remoteUpdatedAt, knownUpdatedAt) {
        if (!remoteUpdatedAt || !knownUpdatedAt) return false;
        return Date.parse(remoteUpdatedAt) > Date.parse(knownUpdatedAt);
    }

    function renderAfterDataChange() {
        populateSelects();
        renderVDayIfActive();
        if ($('#entries')?.classList.contains('active')) renderEntries();
        if ($('#reports')?.classList.contains('active')) renderReports();
        if ($('#search')?.classList.contains('active')) initSearchMultiSelects();
        if ($('#tips')?.classList.contains('active')) renderTips();
        if ($('#settings')?.classList.contains('active')) renderSettings();
    }

    function setSyncStatus(status, title, message) {
        state.sync.status = status;
        state.sync.title = title;
        state.sync.message = message;
        renderSyncStatus();
    }

    function renderSyncStatus() {
        const syncButton = $('#syncButton');
        const authButton = $('#syncAuthButton');
        const syncPanel = $('#syncPanel');
        const syncTitle = $('#syncStatusTitle');
        const syncText = $('#syncStatusText');
        const syncButtonLabel = $('#syncButtonLabel');
        if (!syncButton || !authButton || !syncPanel || !syncTitle || !syncText || !syncButtonLabel) return;

        syncButton.dataset.syncStatus = state.sync.status;
        syncPanel.dataset.syncStatus = state.sync.status;
        syncTitle.textContent = state.sync.title;
        const compactStatus = state.sync.status === 'synced';
        syncText.hidden = compactStatus;
        syncText.textContent = compactStatus ? '' : state.sync.message;
        syncPanel.dataset.hasMessage = compactStatus ? 'false' : 'true';
        syncButton.disabled = state.sync.busy || !state.sync.account;
        authButton.disabled = state.sync.busy;
        syncButtonLabel.textContent = state.sync.busy ? 'OneDrive ...' : 'OneDrive Sync';
        authButton.textContent = state.sync.account ? 'OneDrive Logout' : 'OneDrive Login';
    }

    function explainAuthError(error) {
        const text = `${error?.errorCode || ''} ${error?.message || ''}`.toLowerCase();
        if (text.includes('redirect-started')) return 'Du wirst zu Microsoft weitergeleitet.';
        if (text.includes('user_cancelled') || text.includes('cancel')) return 'Anmeldung oder Zustimmung wurde abgebrochen.';
        if (text.includes('consent') || text.includes('access_denied')) return 'Zustimmung verweigert. OneDrive-Sync bleibt ausgeschaltet.';
        if (text.includes('interaction_required')) return 'Bitte melde dich erneut an, damit OneDrive verwendet werden darf.';
        return 'Microsoft-Anmeldung fehlgeschlagen. Deine Daten bleiben lokal gespeichert.';
    }

    function markLoginPending() {
        localStorage.setItem(PENDING_LOGIN_KEY, String(Date.now()));
    }

    function clearLoginPending() {
        localStorage.removeItem(PENDING_LOGIN_KEY);
    }

    function hasRecentPendingLogin() {
        const startedAt = Number(localStorage.getItem(PENDING_LOGIN_KEY) || 0);
        return startedAt > 0 && Date.now() - startedAt < 10 * 60 * 1000;
    }

    async function resumeOneDriveSession() {
        if (!state.sync.msal || state.sync.resuming) return;
        if (state.sync.account && state.sync.status !== 'loading') return;
        if (!hasRecentPendingLogin() && state.sync.status !== 'loading') return;

        state.sync.resuming = true;
        state.sync.busy = false;
        try {
            const redirectResponse = await state.sync.msal.handleRedirectPromise().catch(() => null);
            const accounts = state.sync.msal.getAllAccounts();
            state.sync.account = redirectResponse?.account || accounts[0] || null;
            if (state.sync.account) {
                clearLoginPending();
                state.sync.msal.setActiveAccount(state.sync.account);
                await syncFromOneDrive();
            } else if (hasRecentPendingLogin()) {
                setSyncStatus('loading', 'Microsoft-Anmeldung', 'Die Anmeldung wird geprüft. Falls Microsoft noch offen ist, schließe den Tab nach der Zustimmung.');
            }
        } finally {
            state.sync.busy = false;
            state.sync.resuming = false;
            renderSyncStatus();
        }
    }

    function scheduleOneDriveResumeChecks() {
        [2500, 7000, 14000].forEach((delay) => {
            setTimeout(() => { void resumeOneDriveSession(); }, delay);
        });
    }

    async function getGraphToken() {
        if (!state.sync.account) throw new Error('not-signed-in');
        const request = { ...LOGIN_REQUEST, account: state.sync.account };
        try {
            const response = await state.sync.msal.acquireTokenSilent(request);
            return response.accessToken;
        } catch {
            setSyncStatus('loading', 'Microsoft-Anmeldung', 'Du wirst zu Microsoft weitergeleitet.');
            await state.sync.msal.acquireTokenRedirect({ ...request, redirectStartPage: window.location.href });
            throw new Error('redirect-started');
        }
    }

    async function graphFetch(path, options = {}) {
        const token = await getGraphToken();
        const response = await fetch(`${GRAPH_BASE_URL}${path}`, {
            ...options,
            headers: {
                Authorization: `Bearer ${token}`,
                ...(options.headers || {}),
            },
        });
        if (response.status === 404) return null;
        if (!response.ok) {
            const detail = await response.text().catch(() => '');
            const error = new Error(detail || `Graph request failed: ${response.status}`);
            error.status = response.status;
            throw error;
        }
        return response;
    }

    async function loadRemoteData() {
        const metadataResponse = await graphFetch(GRAPH_FILE_PATH);
        if (!metadataResponse) return { exists: false, data: null, etag: '' };
        const metadata = await metadataResponse.json();
        const contentResponse = await graphFetch(GRAPH_CONTENT_PATH, { cache: 'no-store' });
        if (!contentResponse) return { exists: false, data: null, etag: metadata.eTag || '' };
        const data = parseRemoteData(await contentResponse.json());
        return {
            exists: Boolean(data),
            data,
            etag: metadata.eTag || '',
        };
    }

    async function uploadRemoteData(payload) {
        const response = await graphFetch(GRAPH_CONTENT_PATH, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json;charset=utf-8' },
            body: JSON.stringify(payload, null, 2),
        });
        return response ? response.json() : null;
    }

    function applyRemoteData(remoteData, remoteEtag = '') {
        const parsed = parseRemoteData(remoteData);
        if (!parsed) return;
        state.entries = parsed.entries;
        state.projects = parsed.projects;
        state.categories = parsed.categories;
        state.tips = parsed.tips;
        saveLocalData(parsed.updatedAt || nowIso());
        state.sync.lastRemoteUpdatedAt = parsed.updatedAt || state.localUpdatedAt;
        state.sync.lastRemoteEtag = remoteEtag;
        state.sync.hasRemoteData = true;
        state.sync.conflictData = null;
        renderAfterDataChange();
    }

    function completeRemoteSave(payload, metadata) {
        state.sync.lastRemoteUpdatedAt = payload.updatedAt;
        state.sync.lastRemoteEtag = metadata?.eTag || state.sync.lastRemoteEtag;
        state.sync.hasRemoteData = true;
        state.sync.conflictData = null;
        setSyncStatus('synced', 'Mit OneDrive synchronisiert', 'Deine Time-Tracker-Daten sind im OneDrive-App-Ordner gespeichert.');
    }

    function handleOneDriveError(error, fallbackTitle = 'OneDrive nicht verfügbar') {
        if (error?.message === 'redirect-started') return;
        if (error?.message === 'not-signed-in') {
            setSyncStatus('local', 'Nicht angemeldet', 'Deine Daten werden lokal auf diesem Gerät gespeichert.');
            return;
        }
        const message = error?.status === 401 || error?.status === 403
            ? 'Zugriff auf OneDrive wurde nicht erlaubt. Bitte erneut anmelden.'
            : 'OneDrive konnte nicht erreicht werden. Lokale Daten bleiben erhalten.';
        setSyncStatus('error', fallbackTitle, message);
    }

    async function saveDataToOneDrive() {
        if (!state.sync.account || state.sync.busy) return;
        state.sync.busy = true;
        setSyncStatus('saving', 'Speichere in OneDrive', 'Prüfe zuerst, ob dort neuere Daten liegen.');
        try {
            const latest = await loadRemoteData();
            const local = localDataSnapshot(state.localUpdatedAt || nowIso());
            if (
                latest.exists
                && state.sync.lastRemoteUpdatedAt
                && remoteIsNewer(latest.data.updatedAt, state.sync.lastRemoteUpdatedAt)
                && !sameTrackerData(latest.data, local)
            ) {
                state.sync.conflictData = latest;
                state.sync.lastRemoteUpdatedAt = latest.data.updatedAt || state.sync.lastRemoteUpdatedAt;
                state.sync.lastRemoteEtag = latest.etag || state.sync.lastRemoteEtag;
                setSyncStatus('conflict', 'Konflikt erkannt', 'OneDrive enthält neuere Daten. Es wurde nichts überschrieben.');
                return;
            }

            const payload = localDataSnapshot(nowIso());
            saveLocalData(payload.updatedAt);
            const metadata = await uploadRemoteData(payload);
            completeRemoteSave(payload, metadata);
        } catch (error) {
            handleOneDriveError(error, 'Speichern fehlgeschlagen');
        } finally {
            state.sync.busy = false;
            renderSyncStatus();
        }
    }

    let oneDriveSaveTimer;
    function queueOneDriveSave() {
        if (!state.sync.account) {
            setSyncStatus('local', 'Nicht angemeldet', 'Deine Daten werden lokal auf diesem Gerät gespeichert.');
            return;
        }
        clearTimeout(oneDriveSaveTimer);
        setSyncStatus('saving', 'Speichern vorbereitet', 'Die Änderung wird gleich mit OneDrive synchronisiert.');
        oneDriveSaveTimer = setTimeout(() => { void saveDataToOneDrive(); }, 650);
    }

    async function manualSyncOneDrive() {
        if (!state.sync.account || state.sync.busy) return;
        state.sync.busy = true;
        setSyncStatus('loading', 'Prüfe OneDrive', 'Deine Time-Tracker-Daten werden abgeglichen.');
        try {
            const remote = state.sync.conflictData || await loadRemoteData();
            const local = localDataSnapshot(state.localUpdatedAt || nowIso());

            if (!remote.exists) {
                if (hasTrackerData(local)) {
                    const payload = localDataSnapshot(local.updatedAt || nowIso());
                    const metadata = await uploadRemoteData(payload);
                    completeRemoteSave(payload, metadata);
                    setSyncStatus('synced', 'Lokale Daten übernommen', 'Lokale Daten wurden nach OneDrive übertragen.');
                } else {
                    setSyncStatus('synced', 'Mit OneDrive verbunden', 'Noch keine Time-Tracker-Daten im OneDrive-App-Ordner.');
                }
                return;
            }

            if (sameTrackerData(remote.data, local)) {
                state.sync.lastRemoteUpdatedAt = remote.data.updatedAt || state.sync.lastRemoteUpdatedAt;
                state.sync.lastRemoteEtag = remote.etag || state.sync.lastRemoteEtag;
                state.sync.conflictData = null;
                setSyncStatus('synced', 'Mit OneDrive synchronisiert', 'Deine Time-Tracker-Daten sind aktuell.');
                return;
            }

            if (remoteIsNewer(remote.data.updatedAt, local.updatedAt) || state.sync.conflictData) {
                applyRemoteData(remote.data, remote.etag);
                setSyncStatus('synced', 'OneDrive-Daten geladen', 'Neuere OneDrive-Daten wurden übernommen.');
                return;
            }

            if (remoteIsNewer(local.updatedAt, remote.data.updatedAt)) {
                const payload = localDataSnapshot(nowIso());
                saveLocalData(payload.updatedAt);
                const metadata = await uploadRemoteData(payload);
                completeRemoteSave(payload, metadata);
                return;
            }

            state.sync.conflictData = remote;
            state.sync.lastRemoteUpdatedAt = remote.data.updatedAt || state.sync.lastRemoteUpdatedAt;
            state.sync.lastRemoteEtag = remote.etag || state.sync.lastRemoteEtag;
            setSyncStatus('conflict', 'Unterschiedliche Daten', 'Lokale und OneDrive-Daten unterscheiden sich. Es wurde nichts überschrieben.');
        } catch (error) {
            handleOneDriveError(error, 'Synchronisieren fehlgeschlagen');
        } finally {
            state.sync.busy = false;
            renderSyncStatus();
        }
    }

    async function syncFromOneDrive({ forceRemote = false } = {}) {
        if (!state.sync.account || state.sync.busy) return;
        state.sync.busy = true;
        setSyncStatus('loading', 'Prüfe OneDrive', 'Deine Time-Tracker-Daten werden geladen.');
        try {
            const remote = forceRemote && state.sync.conflictData ? state.sync.conflictData : await loadRemoteData();
            const local = localDataSnapshot(state.localUpdatedAt || nowIso());

            if (!remote.exists) {
                if (hasTrackerData(local)) {
                    const payload = localDataSnapshot(local.updatedAt || nowIso());
                    const metadata = await uploadRemoteData(payload);
                    completeRemoteSave(payload, metadata);
                    setSyncStatus('synced', 'Lokale Daten übernommen', 'Vorhandene lokale Daten wurden nach OneDrive übertragen.');
                } else {
                    state.sync.hasRemoteData = false;
                    setSyncStatus('synced', 'Mit OneDrive verbunden', 'Noch keine Time-Tracker-Daten im OneDrive-App-Ordner.');
                }
                return;
            }

            if (forceRemote || sameTrackerData(remote.data, local) || !hasTrackerData(local) || remoteIsNewer(remote.data.updatedAt, local.updatedAt)) {
                applyRemoteData(remote.data, remote.etag);
                setSyncStatus('synced', 'Mit OneDrive synchronisiert', 'Deine Time-Tracker-Daten wurden aus OneDrive geladen.');
                return;
            }

            state.sync.lastRemoteUpdatedAt = remote.data.updatedAt || '';
            state.sync.lastRemoteEtag = remote.etag || '';
            state.sync.hasRemoteData = true;
            state.sync.conflictData = remote;
            setSyncStatus('conflict', 'Unterschiedliche Daten', 'Lokale und OneDrive-Daten unterscheiden sich. Es wurde nichts überschrieben.');
        } catch (error) {
            handleOneDriveError(error);
        } finally {
            state.sync.busy = false;
            renderSyncStatus();
        }
    }

    async function loginToOneDrive() {
        if (!state.sync.msal || state.sync.busy) return;
        state.sync.busy = true;
        markLoginPending();
        scheduleOneDriveResumeChecks();
        setSyncStatus('loading', 'Microsoft-Anmeldung', 'Du wirst zu Microsoft weitergeleitet.');
        try {
            await state.sync.msal.loginRedirect({ ...LOGIN_REQUEST, redirectStartPage: window.location.href });
        } catch (error) {
            setSyncStatus('error', 'Anmeldung fehlgeschlagen', explainAuthError(error));
        } finally {
            state.sync.busy = false;
            renderSyncStatus();
        }
    }

    async function logoutFromOneDrive() {
        if (!state.sync.msal || state.sync.busy) return;
        state.sync.busy = true;
        clearLoginPending();
        setSyncStatus('loading', 'Microsoft-Abmeldung', 'Du wirst von OneDrive abgemeldet.');
        try {
            const account = state.sync.account || state.sync.msal.getActiveAccount?.();
            state.sync.account = null;
            state.sync.lastRemoteUpdatedAt = '';
            state.sync.lastRemoteEtag = '';
            state.sync.hasRemoteData = false;
            state.sync.conflictData = null;
            if (account) {
                await state.sync.msal.logoutRedirect({
                    account,
                    postLogoutRedirectUri: MSAL_CONFIG.auth.redirectUri,
                });
            } else {
                setSyncStatus('local', 'Nicht angemeldet', 'Deine Daten werden lokal auf diesem Gerät gespeichert.');
            }
        } catch {
            setSyncStatus('error', 'Abmeldung fehlgeschlagen', 'Microsoft-Abmeldung konnte nicht abgeschlossen werden.');
        } finally {
            state.sync.busy = false;
            renderSyncStatus();
        }
    }

    async function initializeOneDrive() {
        renderSyncStatus();
        if (!window.msal?.PublicClientApplication) {
            setSyncStatus('error', 'OneDrive nicht verfügbar', 'MSAL.js konnte nicht geladen werden. Lokale Speicherung bleibt aktiv.');
            return;
        }

        try {
            state.sync.msal = new window.msal.PublicClientApplication(MSAL_CONFIG);
            if (typeof state.sync.msal.initialize === 'function') {
                await state.sync.msal.initialize();
            }
            const redirectResponse = await state.sync.msal.handleRedirectPromise();
            const accounts = state.sync.msal.getAllAccounts();
            state.sync.account = redirectResponse?.account || accounts[0] || null;
            if (state.sync.account) {
                clearLoginPending();
                state.sync.msal.setActiveAccount(state.sync.account);
                await syncFromOneDrive();
            } else {
                setSyncStatus('local', 'Nicht angemeldet', 'Deine Daten werden lokal auf diesem Gerät gespeichert. Melde dich an, um OneDrive zu nutzen.');
            }
        } catch (error) {
            const accounts = state.sync.msal?.getAllAccounts?.() || [];
            state.sync.account = accounts[0] || null;
            if (state.sync.account) {
                clearLoginPending();
                state.sync.msal.setActiveAccount(state.sync.account);
                setSyncStatus('loading', 'Microsoft-Anmeldung erkannt', 'OneDrive wird erneut geprüft.');
                await syncFromOneDrive();
            } else {
                setSyncStatus('error', 'Anmeldung fehlgeschlagen', explainAuthError(error));
            }
        } finally {
            state.sync.initialized = true;
            renderSyncStatus();
        }
    }

    function clamp(value, min, max) {
        return Math.min(max, Math.max(min, value));
    }

    function snapMinutes(minutes) {
        return clamp(Math.round(minutes / VDAY_STEP_MINUTES) * VDAY_STEP_MINUTES, 0, VDAY_DAY_MINUTES);
    }

    function timeToMinutes(value) {
        if (!value) return 0;
        if (value === '24:00') return VDAY_DAY_MINUTES;
        const [hours, minutes] = value.split(':').map(Number);
        if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return 0;
        return clamp(hours * 60 + minutes, 0, VDAY_DAY_MINUTES);
    }

    function minutesToTime(minutes) {
        const safeMinutes = clamp(Math.round(minutes), 0, VDAY_DAY_MINUTES);
        if (safeMinutes >= VDAY_DAY_MINUTES) return '24:00';
        const hours = Math.floor(safeMinutes / 60);
        const mins = safeMinutes % 60;
        return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
    }

    function minutesToStoredTime(minutes) {
        return minutes >= VDAY_DAY_MINUTES ? '23:59' : minutesToTime(minutes);
    }

    function entryEndMinutes(entry) {
        const start = timeToMinutes(entry.start);
        const durationMinutes = Math.max(VDAY_STEP_MINUTES, Math.round((entry.duration || 0) / 60));
        const byDuration = start + durationMinutes;
        const byEnd = timeToMinutes(entry.end);
        return clamp(Math.max(byDuration, byEnd, start + VDAY_STEP_MINUTES), start + VDAY_STEP_MINUTES, VDAY_DAY_MINUTES);
    }

    function setEntrySchedule(entry, date, startMinutes, durationMinutes) {
        const safeDuration = Math.max(VDAY_STEP_MINUTES, snapMinutes(durationMinutes));
        const safeStart = clamp(snapMinutes(startMinutes), 0, VDAY_DAY_MINUTES - safeDuration);
        const endMinutes = clamp(safeStart + safeDuration, safeStart + VDAY_STEP_MINUTES, VDAY_DAY_MINUTES);
        entry.date = date;
        entry.start = minutesToTime(safeStart);
        entry.end = minutesToStoredTime(endMinutes);
        entry.duration = Math.round((endMinutes - safeStart) * 60);
    }

    function shiftDateStr(dateStr, days) {
        const d = dateStr ? new Date(dateStr + 'T00:00:00') : new Date();
        d.setDate(d.getDate() + days);
        return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    }

    // ── Navigation ──
    $$('.nav-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
            $$('.nav-btn').forEach((b) => b.classList.remove('active'));
            btn.classList.add('active');
            $$('.view').forEach((v) => v.classList.remove('active'));
            $(`#${btn.dataset.view}`).classList.add('active');
            if (btn.dataset.view === 'vday') renderVDay();
            if (btn.dataset.view === 'entries') renderEntries();
            if (btn.dataset.view === 'reports') renderReports();
            if (btn.dataset.view === 'search') initSearchMultiSelects();
            if (btn.dataset.view === 'tips') renderTips();
            if (btn.dataset.view === 'settings') renderSettings();
        });
    });

    // ── Populate selects ──
    function populateSelects() {
        const projectSelects = ['#project-select', '#manual-project', '#filter-project'];
        const categorySelects = ['#category-select', '#manual-category', '#filter-category'];

        projectSelects.forEach((sel) => {
            const el = $(sel);
            const val = el.value;
            const isFilter = sel.includes('filter');
            el.innerHTML = `<option value="">${isFilter ? 'Alle Projekte' : '-- Projekt wählen --'}</option>`;
            state.projects.forEach((p) => {
                el.innerHTML += `<option value="${p.id}">${escHtml(p.name)}</option>`;
            });
            el.value = val;
        });

        categorySelects.forEach((sel) => {
            const el = $(sel);
            const val = el.value;
            const isFilter = sel.includes('filter');
            el.innerHTML = `<option value="">${isFilter ? 'Alle Kategorien' : '-- Kategorie wählen --'}</option>`;
            state.categories.forEach((c) => {
                el.innerHTML += `<option value="${c.id}">${escHtml(c.name)}</option>`;
            });
            el.value = val;
        });
    }

    // ── Timer ──
    function updateTimerDisplay() {
        const now = state.timer.running ? (Date.now() - state.timer.startTime) / 1000 + state.timer.elapsed : state.timer.elapsed;
        $('#timer').textContent = fmt(now);
    }

    $('#btn-start').addEventListener('click', () => {
        if (!state.timer.running) {
            state.timer.running = true;
            state.timer.startTime = Date.now();
            state.timer.interval = setInterval(updateTimerDisplay, 200);
            $('#btn-start').disabled = true;
            $('#btn-pause').disabled = false;
            $('#btn-stop').disabled = false;
            $('#btn-start').textContent = 'Start';
        }
    });

    $('#btn-pause').addEventListener('click', () => {
        if (state.timer.running) {
            state.timer.elapsed += (Date.now() - state.timer.startTime) / 1000;
            state.timer.running = false;
            clearInterval(state.timer.interval);
            $('#btn-start').disabled = false;
            $('#btn-start').textContent = 'Weiter';
            $('#btn-pause').disabled = true;
        }
    });

    $('#btn-stop').addEventListener('click', () => {
        let totalSeconds = state.timer.elapsed;
        if (state.timer.running) {
            totalSeconds += (Date.now() - state.timer.startTime) / 1000;
        }
        clearInterval(state.timer.interval);
        state.timer.running = false;
        state.timer.elapsed = 0;
        state.timer.startTime = null;
        $('#timer').textContent = '00:00:00';
        $('#btn-start').disabled = false;
        $('#btn-start').textContent = 'Start';
        $('#btn-pause').disabled = true;
        $('#btn-stop').disabled = true;

        if (totalSeconds < 1) return;

        const task = $('#task-name').value.trim() || 'Ohne Bezeichnung';
        const entry = {
            id: uid(),
            task: task,
            project: $('#project-select').value,
            category: $('#category-select').value,
            entryType: 'erfolgt',
            tags: $('#tag-input').value.split(',').map((t) => t.trim()).filter(Boolean),
            date: todayStr(),
            start: new Date(Date.now() - totalSeconds * 1000).toTimeString().slice(0, 5),
            end: new Date().toTimeString().slice(0, 5),
            duration: Math.round(totalSeconds),
        };
        state.entries.push(entry);
        save();
        $('#task-name').value = '';
        $('#tag-input').value = '';
    });

    // ── Manual Entry ──
    $('#manual-date').value = todayStr();

    $('#btn-manual-add').addEventListener('click', () => {
        const task = $('#manual-task').value.trim() || 'Ohne Bezeichnung';
        const startTime = $('#manual-start').value;
        const endTime = $('#manual-end').value;
        const date = $('#manual-date').value;
        const entryType = getSelectedEntryType('manual-entry-type');

        if (!entryType) {
            alert('Bitte erfolgt oder geplant auswählen.');
            return;
        }

        if (!startTime || !endTime || !date) {
            alert('Bitte Start, Ende und Datum angeben.');
            return;
        }

        const startDate = new Date(`${date}T${startTime}`);
        const endDate = new Date(`${date}T${endTime}`);
        let duration = (endDate - startDate) / 1000;
        if (duration <= 0) {
            alert('Endzeit muss nach Startzeit liegen.');
            return;
        }

        const entry = {
            id: uid(),
            task: task,
            project: $('#manual-project').value,
            category: $('#manual-category').value,
            entryType: entryType,
            tags: $('#manual-tags').value.split(',').map((t) => t.trim()).filter(Boolean),
            date: date,
            start: startTime,
            end: endTime,
            duration: Math.round(duration),
        };
        state.entries.push(entry);
        save();
        $('#manual-task').value = '';
        $('#manual-tags').value = '';
        $('#manual-start').value = '';
        $('#manual-end').value = '';
        clearRadioGroup('manual-entry-type');
        renderVDayIfActive();
    });

    // ── Visual Day View ──
    let vdayResize = null;

    function getVDayDate() {
        return $('#vday-date')?.value || state.vdayDate || todayStr();
    }

    function setVDayDate(dateStr) {
        state.vdayDate = dateStr;
        const input = $('#vday-date');
        if (input) input.value = dateStr;
        renderVDay();
    }

    function plannedEntries() {
        return state.entries
            .filter((entry) => normalizeEntryType(entry.entryType) === 'geplant')
            .sort((a, b) => {
                if (a.date !== b.date) return a.date.localeCompare(b.date);
                if (a.start !== b.start) return a.start.localeCompare(b.start);
                return a.task.localeCompare(b.task, 'de');
            });
    }

    function renderVDayTimeline() {
        const timeline = $('#vday-timeline');
        if (!timeline) return;
        timeline.innerHTML = Array.from({ length: 25 }, (_, hour) => {
            const label = `${String(hour).padStart(2, '0')}:00`;
            const top = (hour * 60 / VDAY_DAY_MINUTES) * 100;
            return `<div class="vday-time-label" style="top:${top}%">${label}</div>`;
        }).join('');
    }

    function renderVDayEvent(entry) {
        const project = state.projects.find((p) => p.id === entry.project);
        const category = state.categories.find((c) => c.id === entry.category);
        const start = timeToMinutes(entry.start);
        const end = entryEndMinutes(entry);
        const top = (start / VDAY_DAY_MINUTES) * 100;
        const height = ((end - start) / VDAY_DAY_MINUTES) * 100;
        const color = category?.color || project?.color || '#2c6bed';
        const meta = [project?.name, category?.name].filter(Boolean).join(' · ');
        const tags = (entry.tags || []).slice(0, 2).map((tag) => `<span>${escHtml(tag)}</span>`).join('');

        return `<div class="vday-event" draggable="true" data-vday-entry-id="${entry.id}" style="top:${top}%;height:${height}%;--event-color:${color}">
            <div class="vday-event-content">
                <strong>${escHtml(entry.task)}</strong>
                <small class="vday-event-time">${minutesToTime(start)} – ${minutesToTime(end)} · ${fmt(entry.duration)}</small>
                ${meta ? `<small>${escHtml(meta)}</small>` : ''}
                ${tags ? `<div class="vday-event-tags">${tags}</div>` : ''}
            </div>
            <div class="vday-resize-handle" draggable="false" title="Dauer ändern"></div>
        </div>`;
    }

    function renderVDayRepoItem(entry) {
        const project = state.projects.find((p) => p.id === entry.project);
        const category = state.categories.find((c) => c.id === entry.category);
        const color = category?.color || project?.color || '#2c6bed';
        const meta = [
            entry.date,
            `${entry.start} – ${minutesToTime(entryEndMinutes(entry))}`,
            project?.name,
            category?.name,
        ].filter(Boolean).join(' · ');

        return `<div class="vday-repo-item" draggable="true" data-vday-entry-id="${entry.id}" style="--event-color:${color}">
            <div class="vday-repo-content">
                <strong>${escHtml(entry.task)}</strong>
                <small>${escHtml(meta)}</small>
            </div>
            <div class="vday-repo-actions">
                <button type="button" class="vday-repo-edit" draggable="false" onclick="app.editEntry('${entry.id}')">Bearbeiten</button>
            </div>
        </div>`;
    }

    function renderVDay() {
        const view = $('#vday');
        if (!view) return;

        const dateInput = $('#vday-date');
        if (dateInput && !dateInput.value) dateInput.value = state.vdayDate || todayStr();
        const selectedDate = getVDayDate();
        state.vdayDate = selectedDate;

        const dateLabel = $('#vday-date-label');
        if (dateLabel) {
            dateLabel.textContent = new Date(selectedDate + 'T00:00:00').toLocaleDateString('de-DE', {
                weekday: 'long',
                day: 'numeric',
                month: 'long',
                year: 'numeric',
            });
        }

        renderVDayTimeline();

        const dayEntries = plannedEntries().filter((entry) => entry.date === selectedDate);
        const dropzone = $('#vday-dropzone');
        if (dropzone) {
            dropzone.innerHTML = dayEntries.length
                ? dayEntries.map((entry) => renderVDayEvent(entry)).join('')
                : '<div class="vday-empty-day">Geplante Einträge hier ablegen</div>';
        }

        const repoEntries = plannedEntries();
        const repoList = $('#vday-repo-list');
        const repoCount = $('#vday-repo-count');
        if (repoCount) repoCount.textContent = `${repoEntries.length}`;
        if (repoList) {
            repoList.innerHTML = repoEntries.length
                ? repoEntries.map((entry) => renderVDayRepoItem(entry)).join('')
                : '<div class="no-entries">Keine geplanten Einträge vorhanden.</div>';
        }
    }

    function renderVDayIfActive() {
        if ($('#vday')?.classList.contains('active')) renderVDay();
    }

    function getDropMinutes(clientY) {
        const dropzone = $('#vday-dropzone');
        if (!dropzone) return 0;
        const rect = dropzone.getBoundingClientRect();
        const pixelsPerMinute = dropzone.offsetHeight / VDAY_DAY_MINUTES;
        return snapMinutes((clientY - rect.top) / pixelsPerMinute);
    }

    $('#vday-date')?.addEventListener('change', () => setVDayDate(getVDayDate()));
    $('#vday-prev')?.addEventListener('click', () => setVDayDate(shiftDateStr(getVDayDate(), -1)));
    $('#vday-next')?.addEventListener('click', () => setVDayDate(shiftDateStr(getVDayDate(), 1)));
    $('#vday-today')?.addEventListener('click', () => setVDayDate(todayStr()));

    document.addEventListener('dragstart', (event) => {
        if (event.target.closest('.vday-resize-handle, .vday-repo-edit')) {
            event.preventDefault();
            return;
        }
        const item = event.target.closest('[data-vday-entry-id]');
        if (!item) return;
        event.dataTransfer.setData('text/plain', item.dataset.vdayEntryId);
        event.dataTransfer.effectAllowed = 'move';
    });

    $('#vday-dropzone')?.addEventListener('dragover', (event) => {
        event.preventDefault();
        event.currentTarget.classList.add('drag-over');
    });

    $('#vday-dropzone')?.addEventListener('dragleave', (event) => {
        event.currentTarget.classList.remove('drag-over');
    });

    $('#vday-dropzone')?.addEventListener('drop', (event) => {
        event.preventDefault();
        event.currentTarget.classList.remove('drag-over');
        const entryId = event.dataTransfer.getData('text/plain');
        const entry = state.entries.find((item) => item.id === entryId);
        if (!entry) return;

        const durationMinutes = Math.max(VDAY_STEP_MINUTES, snapMinutes((entry.duration || VDAY_STEP_MINUTES * 60) / 60));
        setEntrySchedule(entry, getVDayDate(), getDropMinutes(event.clientY), durationMinutes);
        save();
        renderVDay();
    });

    document.addEventListener('pointerdown', (event) => {
        const handle = event.target.closest('.vday-resize-handle');
        if (!handle) return;
        const eventEl = handle.closest('.vday-event');
        const entry = state.entries.find((item) => item.id === eventEl?.dataset.vdayEntryId);
        const dropzone = $('#vday-dropzone');
        if (!entry || !dropzone) return;

        vdayResize = {
            entryId: entry.id,
            startMinutes: timeToMinutes(entry.start),
            initialEndMinutes: entryEndMinutes(entry),
            startY: event.clientY,
            pixelsPerMinute: dropzone.offsetHeight / VDAY_DAY_MINUTES,
            eventEl,
        };
        document.body.classList.add('vday-resizing');
        event.preventDefault();
        event.stopPropagation();
    });

    document.addEventListener('pointermove', (event) => {
        if (!vdayResize) return;
        const deltaMinutes = (event.clientY - vdayResize.startY) / vdayResize.pixelsPerMinute;
        const nextEnd = clamp(
            snapMinutes(vdayResize.initialEndMinutes + deltaMinutes),
            vdayResize.startMinutes + VDAY_STEP_MINUTES,
            VDAY_DAY_MINUTES
        );
        const height = ((nextEnd - vdayResize.startMinutes) / VDAY_DAY_MINUTES) * 100;
        vdayResize.nextEndMinutes = nextEnd;
        vdayResize.eventEl.style.height = `${height}%`;
        const timeEl = vdayResize.eventEl.querySelector('.vday-event-time');
        if (timeEl) {
            timeEl.textContent = `${minutesToTime(vdayResize.startMinutes)} – ${minutesToTime(nextEnd)} · ${fmt((nextEnd - vdayResize.startMinutes) * 60)}`;
        }
    });

    document.addEventListener('pointerup', () => {
        if (!vdayResize) return;
        const entry = state.entries.find((item) => item.id === vdayResize.entryId);
        if (entry) {
            const endMinutes = vdayResize.nextEndMinutes || vdayResize.initialEndMinutes;
            setEntrySchedule(entry, getVDayDate(), vdayResize.startMinutes, endMinutes - vdayResize.startMinutes);
            save();
        }
        vdayResize = null;
        document.body.classList.remove('vday-resizing');
        renderVDay();
    });

    document.addEventListener('mousedown', (event) => {
        if (vdayResize || event.button !== 0) return;
        const handle = event.target.closest('.vday-resize-handle');
        if (!handle) return;
        const eventEl = handle.closest('.vday-event');
        const entry = state.entries.find((item) => item.id === eventEl?.dataset.vdayEntryId);
        const dropzone = $('#vday-dropzone');
        if (!entry || !dropzone) return;

        vdayResize = {
            entryId: entry.id,
            startMinutes: timeToMinutes(entry.start),
            initialEndMinutes: entryEndMinutes(entry),
            startY: event.clientY,
            pixelsPerMinute: dropzone.offsetHeight / VDAY_DAY_MINUTES,
            eventEl,
        };
        document.body.classList.add('vday-resizing');
        event.preventDefault();
        event.stopPropagation();
    });

    document.addEventListener('mousemove', (event) => {
        if (!vdayResize) return;
        const deltaMinutes = (event.clientY - vdayResize.startY) / vdayResize.pixelsPerMinute;
        const nextEnd = clamp(
            snapMinutes(vdayResize.initialEndMinutes + deltaMinutes),
            vdayResize.startMinutes + VDAY_STEP_MINUTES,
            VDAY_DAY_MINUTES
        );
        const height = ((nextEnd - vdayResize.startMinutes) / VDAY_DAY_MINUTES) * 100;
        vdayResize.nextEndMinutes = nextEnd;
        vdayResize.eventEl.style.height = `${height}%`;
        const timeEl = vdayResize.eventEl.querySelector('.vday-event-time');
        if (timeEl) {
            timeEl.textContent = `${minutesToTime(vdayResize.startMinutes)} – ${minutesToTime(nextEnd)} · ${fmt((nextEnd - vdayResize.startMinutes) * 60)}`;
        }
    });

    document.addEventListener('mouseup', () => {
        if (!vdayResize) return;
        const entry = state.entries.find((item) => item.id === vdayResize.entryId);
        if (entry) {
            const endMinutes = vdayResize.nextEndMinutes || vdayResize.initialEndMinutes;
            setEntrySchedule(entry, getVDayDate(), vdayResize.startMinutes, endMinutes - vdayResize.startMinutes);
            save();
        }
        vdayResize = null;
        document.body.classList.remove('vday-resizing');
        renderVDay();
    });

    // ── Entries View ──
    function renderEntries() {
        const selectedType = getSelectedEntryType('entries-entry-type');
        const filterDate = $('#filter-date').value;
        const filterProject = $('#filter-project').value;
        const filterCategory = $('#filter-category').value;
        const list = $('#entries-list');

        if (!selectedType) {
            list.innerHTML = '';
            clearSummaryCards('#entries-summary');
            renderEntriesCharts([]);
            return;
        }

        let filtered = [...state.entries];
        filtered = filtered.filter((e) => normalizeEntryType(e.entryType) === selectedType);
        if (filterDate) filtered = filtered.filter((e) => e.date === filterDate);
        if (filterProject) filtered = filtered.filter((e) => e.project === filterProject);
        if (filterCategory) filtered = filtered.filter((e) => e.category === filterCategory);

        filtered.sort((a, b) => {
            if (a.date !== b.date) return b.date.localeCompare(a.date);
            return b.start.localeCompare(a.start);
        });

        if (filtered.length === 0) {
            list.innerHTML = '<div class="no-entries">Keine Einträge gefunden.</div>';
            renderSummaryCards('#entries-summary', [], { showAverage: false });
            renderEntriesCharts([]);
            return;
        }

        list.innerHTML = filtered
            .map((e) => {
                const proj = state.projects.find((p) => p.id === e.project);
                const cat = state.categories.find((c) => c.id === e.category);
                const tagsHtml = (e.tags || []).map((t) => `<span class="tag">${escHtml(t)}</span>`).join('');
                const projBadge = proj ? `<span class="project-badge" style="background:${proj.color}33;color:${proj.color}">${escHtml(proj.name)}</span>` : '';
                const catBadge = cat ? `<span class="category-badge" style="background:${cat.color}33;color:${cat.color}">${escHtml(cat.name)}</span>` : '';
                const typeBadge = `<span class="entry-type-badge">${escHtml(normalizeEntryType(e.entryType))}</span>`;

                return `<div class="entry-card">
                    <div class="entry-info">
                        <div class="entry-task">${escHtml(e.task)}</div>
                        <div class="entry-meta">
                            <span>${e.date}</span>
                            <span>${e.start} – ${e.end}</span>
                            ${typeBadge}${projBadge}${catBadge}
                        </div>
                        <div style="margin-top:4px">${tagsHtml}</div>
                    </div>
                    <div class="entry-duration">${fmt(e.duration)}</div>
                    <div class="entry-actions">
                        <button onclick="app.editEntry('${e.id}')">Bearbeiten</button>
                        <button onclick="app.exportIcal('${e.id}')">iCal.</button>
                        <button onclick="app.deleteEntry('${e.id}')">Löschen</button>
                    </div>
                </div>`;
            })
            .join('');

        renderSummaryCards('#entries-summary', filtered, { showAverage: false });
        renderEntriesCharts(filtered);
    }

    $('#filter-date').addEventListener('change', renderEntries);
    $('#filter-project').addEventListener('change', renderEntries);
    $('#filter-category').addEventListener('change', renderEntries);
    $$('input[name="entries-entry-type"]').forEach((radio) => {
        radio.addEventListener('change', renderEntries);
    });

    $('#filter-date-prev').addEventListener('click', () => {
        const el = $('#filter-date');
        const d = el.value ? new Date(el.value + 'T00:00:00') : new Date();
        d.setDate(d.getDate() - 1);
        el.value = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
        renderEntries();
    });

    $('#filter-date-next').addEventListener('click', () => {
        const el = $('#filter-date');
        const d = el.value ? new Date(el.value + 'T00:00:00') : new Date();
        d.setDate(d.getDate() + 1);
        el.value = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
        renderEntries();
    });

    $('#btn-entries-show-all').addEventListener('click', () => {
        $('#filter-date').value = '';
        $('#filter-project').value = '';
        $('#filter-category').value = '';
        renderEntries();
    });

    $('#btn-entries-reset').addEventListener('click', () => {
        window.location.href = window.location.pathname + '#entries';
        window.location.reload();
    });

    // ── CSV Export ──
    $('#btn-export').addEventListener('click', () => {
        const selectedType = getSelectedEntryType('entries-entry-type');
        const filterDate = $('#filter-date').value;
        const filterProject = $('#filter-project').value;
        const filterCategory = $('#filter-category').value;

        if (!selectedType) {
            alert('Bitte erfolgt oder geplant auswählen.');
            return;
        }

        let filtered = [...state.entries];
        filtered = filtered.filter((e) => normalizeEntryType(e.entryType) === selectedType);
        if (filterDate) filtered = filtered.filter((e) => e.date === filterDate);
        if (filterProject) filtered = filtered.filter((e) => e.project === filterProject);
        if (filterCategory) filtered = filtered.filter((e) => e.category === filterCategory);

        const headers = ['Art', 'Datum', 'Start', 'Ende', 'Dauer (Min)', 'Aufgabe', 'Projekt', 'Kategorie', 'Tags'];
        const rows = filtered.map((e) => {
            const proj = state.projects.find((p) => p.id === e.project);
            const cat = state.categories.find((c) => c.id === e.category);
            return [normalizeEntryType(e.entryType), e.date, e.start, e.end, Math.round(e.duration / 60), `"${e.task}"`, proj ? proj.name : '', cat ? cat.name : '', (e.tags || []).join('; ')];
        });

        const csv = [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
        const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `timetracker_export_${nowStr()}.csv`;
        a.click();
        URL.revokeObjectURL(url);
    });

    // ── Reports ──
    let chartProjects = null;
    let chartCategories = null;
    let chartDaily = null;
    let searchChartProjects = null;
    let searchChartCategories = null;
    let searchChartDaily = null;
    let entriesChartProjects = null;
    let entriesChartCategories = null;
    let entriesChartDaily = null;

    function destroyChart(chart) {
        if (chart) chart.destroy();
        return null;
    }

    function updateReportNav() {
        const isCustom = state.reportPeriod === 'custom';
        $('.report-nav').style.display = isCustom ? 'none' : '';
    }

    $$('.report-tab').forEach((tab) => {
        tab.addEventListener('click', () => {
            $$('.report-tab').forEach((t) => t.classList.remove('active'));
            tab.classList.add('active');
            state.reportPeriod = tab.dataset.period;
            state.reportOffset = 0;
            updateReportNav();
            renderReports();
        });
    });

    $('#report-range-apply').addEventListener('click', () => {
        const startVal = $('#report-range-start').value;
        const endVal = $('#report-range-end').value;
        if (!startVal || !endVal) {
            alert('Bitte Start- und Enddatum angeben.');
            return;
        }
        if (startVal > endVal) {
            alert('Startdatum muss vor dem Enddatum liegen.');
            return;
        }
        $$('.report-tab').forEach((t) => t.classList.remove('active'));
        state.reportPeriod = 'custom';
        state.reportCustomStart = startVal;
        state.reportCustomEnd = endVal;
        updateReportNav();
        renderReports();
    });

    $('#report-prev').addEventListener('click', () => {
        state.reportOffset--;
        renderReports();
    });

    $('#report-next').addEventListener('click', () => {
        state.reportOffset++;
        renderReports();
    });

    $$('input[name="reports-entry-type"]').forEach((radio) => {
        radio.addEventListener('change', renderReports);
    });

    $('#btn-report-reset').addEventListener('click', () => {
        window.location.href = window.location.pathname + '#reports';
        window.location.reload();
    });

    function localDateStr(d) {
        return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    }

    function getReportRange() {
        // Custom range mode
        if (state.reportPeriod === 'custom') {
            return { start: state.reportCustomStart, end: state.reportCustomEnd, label: `${state.reportCustomStart} – ${state.reportCustomEnd}` };
        }

        const now = new Date();
        let start, end, label;

        if (state.reportPeriod === 'day') {
            const d = new Date(now);
            d.setDate(d.getDate() + state.reportOffset);
            const ds = localDateStr(d);
            start = ds;
            end = ds;
            label = d.toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
        } else if (state.reportPeriod === 'week') {
            const d = new Date(now);
            d.setDate(d.getDate() + state.reportOffset * 7);
            const day = d.getDay();
            const monday = new Date(d);
            monday.setDate(d.getDate() - ((day + 6) % 7));
            const sunday = new Date(monday);
            sunday.setDate(monday.getDate() + 6);
            start = localDateStr(monday);
            end = localDateStr(sunday);
            label = `KW ${getWeekNumber(monday)} – ${monday.toLocaleDateString('de-DE', { day: 'numeric', month: 'short' })} bis ${sunday.toLocaleDateString('de-DE', { day: 'numeric', month: 'short', year: 'numeric' })}`;
        } else if (state.reportPeriod === 'month') {
            const d = new Date(now.getFullYear(), now.getMonth() + state.reportOffset, 1);
            start = localDateStr(d);
            const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0);
            end = localDateStr(lastDay);
            label = d.toLocaleDateString('de-DE', { month: 'long', year: 'numeric' });
        } else if (state.reportPeriod === 'year') {
            const year = now.getFullYear() + state.reportOffset;
            const d = new Date(year, 0, 1);
            const lastDay = new Date(year, 11, 31);
            start = localDateStr(d);
            end = localDateStr(lastDay);
            label = String(year);
        }
        return { start, end, label };
    }

    function getWeekNumber(d) {
        const date = new Date(d);
        date.setHours(0, 0, 0, 0);
        date.setDate(date.getDate() + 3 - ((date.getDay() + 6) % 7));
        const week1 = new Date(date.getFullYear(), 0, 4);
        return 1 + Math.round(((date - week1) / 86400000 - 3 + ((week1.getDay() + 6) % 7)) / 7);
    }

    function renderReports() {
        const { start, end, label } = getReportRange();
        const selectedType = getSelectedEntryType('reports-entry-type');
        $('#report-date-label').textContent = label;

        const chartContainer = $('#report-charts-container');
        if (!selectedType) {
            clearSummaryCards('#report-summary');
            chartContainer.style.display = 'none';
            chartProjects = destroyChart(chartProjects);
            chartCategories = destroyChart(chartCategories);
            chartDaily = destroyChart(chartDaily);
            return;
        }

        chartContainer.style.display = '';
        const entries = state.entries.filter((e) => normalizeEntryType(e.entryType) === selectedType && e.date >= start && e.date <= end);
        renderSummaryCards('#report-summary', entries);
        renderCharts(entries, start, end);
    }

    function renderCharts(entries, start, end) {
        // Project chart
        const projectData = {};
        entries.forEach((e) => {
            const proj = state.projects.find((p) => p.id === e.project);
            const name = proj ? proj.name : 'Ohne Projekt';
            const color = proj ? proj.color : '#666';
            if (!projectData[name]) projectData[name] = { seconds: 0, color };
            projectData[name].seconds += e.duration;
        });

        if (chartProjects) chartProjects.destroy();
        const projLabels = Object.keys(projectData);
        chartProjects = new Chart($('#chart-projects'), {
            type: 'doughnut',
            data: {
                labels: projLabels,
                datasets: [{
                    data: projLabels.map((l) => Math.round(projectData[l].seconds / 60)),
                    backgroundColor: projLabels.map((l) => projectData[l].color),
                    borderWidth: 0,
                }],
            },
            options: {
                responsive: true,
                plugins: {
                    legend: { position: 'bottom', labels: { color: '#000', padding: 12 } },
                    tooltip: { callbacks: { label: (ctx) => `${ctx.label}: ${fmtMinToHM(ctx.raw)}` } },
                },
            },
        });

        // Category chart
        const catData = {};
        entries.forEach((e) => {
            const cat = state.categories.find((c) => c.id === e.category);
            const name = cat ? cat.name : 'Ohne Kategorie';
            const color = cat ? cat.color : '#666';
            if (!catData[name]) catData[name] = { seconds: 0, color };
            catData[name].seconds += e.duration;
        });

        if (chartCategories) chartCategories.destroy();
        const catLabels = Object.keys(catData);
        chartCategories = new Chart($('#chart-categories'), {
            type: 'doughnut',
            data: {
                labels: catLabels,
                datasets: [{
                    data: catLabels.map((l) => Math.round(catData[l].seconds / 60)),
                    backgroundColor: catLabels.map((l) => catData[l].color),
                    borderWidth: 0,
                }],
            },
            options: {
                responsive: true,
                plugins: {
                    legend: { position: 'bottom', labels: { color: '#000', padding: 12 } },
                    tooltip: { callbacks: { label: (ctx) => `${ctx.label}: ${fmtMinToHM(ctx.raw)}` } },
                },
            },
        });

        // Daily bar chart
        const dayMap = {};
        const d = new Date(start);
        const endDate = new Date(end);
        while (d <= endDate) {
            dayMap[d.toISOString().slice(0, 10)] = 0;
            d.setDate(d.getDate() + 1);
        }
        entries.forEach((e) => {
            if (dayMap[e.date] !== undefined) dayMap[e.date] += e.duration;
        });

        if (chartDaily) chartDaily.destroy();
        const dayLabels = Object.keys(dayMap);
        const shortLabels = dayLabels.map((d) => {
            const dt = new Date(d + 'T00:00:00');
            return dt.toLocaleDateString('de-DE', { weekday: 'short', day: 'numeric' });
        });

        chartDaily = new Chart($('#chart-daily'), {
            type: 'bar',
            data: {
                labels: shortLabels,
                datasets: [{
                    data: dayLabels.map((d) => Math.round(dayMap[d] / 60)),
                    backgroundColor: '#4a90d9',
                    borderRadius: 4,
                }],
            },
            options: {
                responsive: true,
                plugins: {
                    legend: { display: false },
                    tooltip: { callbacks: { label: (ctx) => fmtMinToHM(ctx.raw) } },
                },
                scales: {
                    x: { ticks: { color: '#8899aa' }, grid: { display: false } },
                    y: { ticks: { color: '#8899aa' }, grid: { color: '#2a3a5e' }, title: { display: true, text: 'Minuten', color: '#8899aa' } },
                },
            },
        });
    }

    function renderEntriesCharts(entries) {
        const container = $('#entries-charts-container');
        if (entries.length === 0) {
            container.style.display = 'none';
            return;
        }
        container.style.display = '';

        // Project chart
        const projectData = {};
        entries.forEach((e) => {
            const proj = state.projects.find((p) => p.id === e.project);
            const name = proj ? proj.name : 'Ohne Projekt';
            const color = proj ? proj.color : '#666';
            if (!projectData[name]) projectData[name] = { seconds: 0, color };
            projectData[name].seconds += e.duration;
        });

        if (entriesChartProjects) entriesChartProjects.destroy();
        const projLabels = Object.keys(projectData);
        entriesChartProjects = new Chart($('#entries-chart-projects'), {
            type: 'doughnut',
            data: {
                labels: projLabels,
                datasets: [{
                    data: projLabels.map((l) => Math.round(projectData[l].seconds / 60)),
                    backgroundColor: projLabels.map((l) => projectData[l].color),
                    borderWidth: 0,
                }],
            },
            options: {
                responsive: true,
                plugins: {
                    legend: { position: 'bottom', labels: { color: '#000', padding: 12 } },
                    tooltip: { callbacks: { label: (ctx) => `${ctx.label}: ${fmtMinToHM(ctx.raw)}` } },
                },
            },
        });

        // Category chart
        const catData = {};
        entries.forEach((e) => {
            const cat = state.categories.find((c) => c.id === e.category);
            const name = cat ? cat.name : 'Ohne Kategorie';
            const color = cat ? cat.color : '#666';
            if (!catData[name]) catData[name] = { seconds: 0, color };
            catData[name].seconds += e.duration;
        });

        if (entriesChartCategories) entriesChartCategories.destroy();
        const catLabels = Object.keys(catData);
        entriesChartCategories = new Chart($('#entries-chart-categories'), {
            type: 'doughnut',
            data: {
                labels: catLabels,
                datasets: [{
                    data: catLabels.map((l) => Math.round(catData[l].seconds / 60)),
                    backgroundColor: catLabels.map((l) => catData[l].color),
                    borderWidth: 0,
                }],
            },
            options: {
                responsive: true,
                plugins: {
                    legend: { position: 'bottom', labels: { color: '#000', padding: 12 } },
                    tooltip: { callbacks: { label: (ctx) => `${ctx.label}: ${fmtMinToHM(ctx.raw)}` } },
                },
            },
        });

        // Daily bar chart – derive date range from entries
        const dates = entries.map((e) => e.date).sort();
        const start = dates[0];
        const end = dates[dates.length - 1];
        const dayMap = {};
        const d = new Date(start);
        const endDate = new Date(end);
        while (d <= endDate) {
            dayMap[d.toISOString().slice(0, 10)] = 0;
            d.setDate(d.getDate() + 1);
        }
        entries.forEach((e) => {
            if (dayMap[e.date] !== undefined) dayMap[e.date] += e.duration;
        });

        if (entriesChartDaily) entriesChartDaily.destroy();
        const dayLabels = Object.keys(dayMap);
        const shortLabels = dayLabels.map((d) => {
            const dt = new Date(d + 'T00:00:00');
            return dt.toLocaleDateString('de-DE', { weekday: 'short', day: 'numeric' });
        });

        entriesChartDaily = new Chart($('#entries-chart-daily'), {
            type: 'bar',
            data: {
                labels: shortLabels,
                datasets: [{
                    data: dayLabels.map((d) => Math.round(dayMap[d] / 60)),
                    backgroundColor: '#4a90d9',
                    borderRadius: 4,
                }],
            },
            options: {
                responsive: true,
                plugins: {
                    legend: { display: false },
                    tooltip: { callbacks: { label: (ctx) => fmtMinToHM(ctx.raw) } },
                },
                scales: {
                    x: { ticks: { color: '#8899aa' }, grid: { display: false } },
                    y: { ticks: { color: '#8899aa' }, grid: { color: '#2a3a5e' }, title: { display: true, text: 'Minuten', color: '#8899aa' } },
                },
            },
        });
    }

    function renderSearchCharts(entries) {
        const container = $('#search-charts-container');
        if (entries.length === 0) {
            container.style.display = 'none';
            return;
        }
        container.style.display = '';

        // Project chart
        const projectData = {};
        entries.forEach((e) => {
            const proj = state.projects.find((p) => p.id === e.project);
            const name = proj ? proj.name : 'Ohne Projekt';
            const color = proj ? proj.color : '#666';
            if (!projectData[name]) projectData[name] = { seconds: 0, color };
            projectData[name].seconds += e.duration;
        });

        if (searchChartProjects) searchChartProjects.destroy();
        const projLabels = Object.keys(projectData);
        searchChartProjects = new Chart($('#search-chart-projects'), {
            type: 'doughnut',
            data: {
                labels: projLabels,
                datasets: [{
                    data: projLabels.map((l) => Math.round(projectData[l].seconds / 60)),
                    backgroundColor: projLabels.map((l) => projectData[l].color),
                    borderWidth: 0,
                }],
            },
            options: {
                responsive: true,
                plugins: {
                    legend: { position: 'bottom', labels: { color: '#000', padding: 12 } },
                    tooltip: { callbacks: { label: (ctx) => `${ctx.label}: ${fmtMinToHM(ctx.raw)}` } },
                },
            },
        });

        // Category chart
        const catData = {};
        entries.forEach((e) => {
            const cat = state.categories.find((c) => c.id === e.category);
            const name = cat ? cat.name : 'Ohne Kategorie';
            const color = cat ? cat.color : '#666';
            if (!catData[name]) catData[name] = { seconds: 0, color };
            catData[name].seconds += e.duration;
        });

        if (searchChartCategories) searchChartCategories.destroy();
        const catLabels = Object.keys(catData);
        searchChartCategories = new Chart($('#search-chart-categories'), {
            type: 'doughnut',
            data: {
                labels: catLabels,
                datasets: [{
                    data: catLabels.map((l) => Math.round(catData[l].seconds / 60)),
                    backgroundColor: catLabels.map((l) => catData[l].color),
                    borderWidth: 0,
                }],
            },
            options: {
                responsive: true,
                plugins: {
                    legend: { position: 'bottom', labels: { color: '#000', padding: 12 } },
                    tooltip: { callbacks: { label: (ctx) => `${ctx.label}: ${fmtMinToHM(ctx.raw)}` } },
                },
            },
        });

        // Daily bar chart – derive date range from entries
        const dates = entries.map((e) => e.date).sort();
        const start = dates[0];
        const end = dates[dates.length - 1];
        const dayMap = {};
        const d = new Date(start);
        const endDate = new Date(end);
        while (d <= endDate) {
            dayMap[d.toISOString().slice(0, 10)] = 0;
            d.setDate(d.getDate() + 1);
        }
        entries.forEach((e) => {
            if (dayMap[e.date] !== undefined) dayMap[e.date] += e.duration;
        });

        if (searchChartDaily) searchChartDaily.destroy();
        const dayLabels = Object.keys(dayMap);
        const shortLabels = dayLabels.map((d) => {
            const dt = new Date(d + 'T00:00:00');
            return dt.toLocaleDateString('de-DE', { weekday: 'short', day: 'numeric' });
        });

        searchChartDaily = new Chart($('#search-chart-daily'), {
            type: 'bar',
            data: {
                labels: shortLabels,
                datasets: [{
                    data: dayLabels.map((d) => Math.round(dayMap[d] / 60)),
                    backgroundColor: '#4a90d9',
                    borderRadius: 4,
                }],
            },
            options: {
                responsive: true,
                plugins: {
                    legend: { display: false },
                    tooltip: { callbacks: { label: (ctx) => fmtMinToHM(ctx.raw) } },
                },
                scales: {
                    x: { ticks: { color: '#8899aa' }, grid: { display: false } },
                    y: { ticks: { color: '#8899aa' }, grid: { color: '#2a3a5e' }, title: { display: true, text: 'Minuten', color: '#8899aa' } },
                },
            },
        });
    }

    // ── Search ──
    function populateMultiSelect(containerId, items, labelAll) {
        const container = $(`#${containerId}`);
        const dropdown = container.querySelector('.multi-select-dropdown');
        const toggle = container.querySelector('.multi-select-toggle');
        dropdown.innerHTML = items
            .map((item) => `<label class="multi-select-option">
                <input type="checkbox" value="${item.id}">
                <span class="color-dot" style="background:${item.color}"></span>
                ${escHtml(item.name)}
            </label>`)
            .join('');

        toggle.addEventListener('click', (e) => {
            e.stopPropagation();
            $$('.multi-select-dropdown').forEach((d) => {
                if (d !== dropdown) d.classList.remove('open');
            });
            dropdown.classList.toggle('open');
        });

        dropdown.addEventListener('change', () => {
            const checked = dropdown.querySelectorAll('input:checked');
            if (checked.length === 0) {
                toggle.textContent = labelAll;
            } else {
                const names = Array.from(checked).map((cb) => {
                    const item = items.find((i) => i.id === cb.value);
                    return item ? item.name : '';
                });
                toggle.textContent = names.join(', ');
            }
        });
    }

    let searchMultiSelectsInitialized = false;

    function initSearchMultiSelects() {
        if (searchMultiSelectsInitialized) return;
        searchMultiSelectsInitialized = true;
        populateMultiSelect('search-project-select', state.projects, 'Alle Projekte');
        populateMultiSelect('search-category-select', state.categories, 'Alle Kategorien');
    }

    function getMultiSelectValues(containerId) {
        const checkboxes = $(`#${containerId}`).querySelectorAll('.multi-select-dropdown input:checked');
        return Array.from(checkboxes).map((cb) => cb.value);
    }

    function getSearchFiltered() {
        const query = $('#search-text').value.trim().toLowerCase();
        const selectedType = getSelectedEntryType('search-entry-type');
        const selectedProjects = getMultiSelectValues('search-project-select');
        const selectedCategories = getMultiSelectValues('search-category-select');

        let filtered = [...state.entries];
        if (selectedType) {
            filtered = filtered.filter((e) => normalizeEntryType(e.entryType) === selectedType);
        } else {
            filtered = [];
        }

        if (query) {
            filtered = filtered.filter((e) => {
                const taskMatch = e.task.toLowerCase().includes(query);
                const tagMatch = (e.tags || []).some((t) => t.toLowerCase().includes(query));
                return taskMatch || tagMatch;
            });
        }

        if (selectedProjects.length > 0) {
            filtered = filtered.filter((e) => selectedProjects.includes(e.project));
        }

        if (selectedCategories.length > 0) {
            filtered = filtered.filter((e) => selectedCategories.includes(e.category));
        }

        filtered.sort((a, b) => {
            if (a.date !== b.date) return b.date.localeCompare(a.date);
            return b.start.localeCompare(a.start);
        });

        return { filtered, query, selectedType, selectedProjects, selectedCategories };
    }

    function getSearchFilteredTips(query) {
        if (!query) return [];
        return state.tips.filter((t) => {
            const titleMatch = t.title.toLowerCase().includes(query);
            const textMatch = richTextToPlainText(t.text || '').toLowerCase().includes(query);
            const tagMatch = (t.tags || []).some((tag) => tag.toLowerCase().includes(query));
            return titleMatch || textMatch || tagMatch;
        });
    }

    function renderSearchTips(tips) {
        const block = $('#search-tips-block');
        const countEl = $('#search-tips-count');
        const list = $('#search-tips-results');
        if (tips.length === 0) {
            block.style.display = 'none';
            return;
        }
        block.style.display = '';
        countEl.textContent = `${tips.length} Tipp${tips.length !== 1 ? 's' : ''} gefunden`;
        list.innerHTML = sortTips(tips).map((t) => renderTipCard(t)).join('');
    }

    function renderSearch() {
        const { filtered, query, selectedType, selectedProjects, selectedCategories } = getSearchFiltered();

        const entriesBlock = $('#search-entries-block');
        const countEl = $('#search-result-count');
        const list = $('#search-results');

        if (!selectedType) {
            entriesBlock.style.display = 'none';
            clearSummaryCards('#search-summary');
            renderSearchCharts([]);
            renderSearchTips([]);
            return;
        }

        if (!query && selectedProjects.length === 0 && selectedCategories.length === 0) {
            entriesBlock.style.display = 'none';
            renderSummaryCards('#search-summary', []);
            renderSearchCharts([]);
            renderSearchTips([]);
            return;
        }

        entriesBlock.style.display = '';
        countEl.textContent = `${filtered.length} Ergebnis${filtered.length !== 1 ? 'se' : ''} gefunden`;

        if (filtered.length === 0) {
            list.innerHTML = '<div class="no-entries">Keine Einträge gefunden.</div>';
            renderSummaryCards('#search-summary', []);
        } else {
            list.innerHTML = filtered
                .map((e) => {
                    const proj = state.projects.find((p) => p.id === e.project);
                    const cat = state.categories.find((c) => c.id === e.category);
                    const tagsHtml = (e.tags || []).map((t) => `<span class="tag">${escHtml(t)}</span>`).join('');
                    const projBadge = proj ? `<span class="project-badge" style="background:${proj.color}33;color:${proj.color}">${escHtml(proj.name)}</span>` : '';
                    const catBadge = cat ? `<span class="category-badge" style="background:${cat.color}33;color:${cat.color}">${escHtml(cat.name)}</span>` : '';
                    const typeBadge = `<span class="entry-type-badge">${escHtml(normalizeEntryType(e.entryType))}</span>`;

                    return `<div class="entry-card">
                        <div class="entry-info">
                            <div class="entry-task">${escHtml(e.task)}</div>
                            <div class="entry-meta">
                                <span>${e.date}</span>
                                <span>${e.start} – ${e.end}</span>
                                ${typeBadge}${projBadge}${catBadge}
                            </div>
                            <div style="margin-top:4px">${tagsHtml}</div>
                        </div>
                        <div class="entry-duration">${fmt(e.duration)}</div>
                </div>`;
            })
            .join('');
            renderSummaryCards('#search-summary', filtered);
        }

        renderSearchCharts(filtered);
        const filteredTips = getSearchFilteredTips(query);
        renderSearchTips(filteredTips);
    }

    function resetTimerView() {
        window.location.href = window.location.pathname;
    }

    $('#btn-timer-reset').addEventListener('click', resetTimerView);
    $('#btn-timer-reset-secondary').addEventListener('click', resetTimerView);

    $('#btn-search-export').addEventListener('click', () => {
        const { filtered, selectedType } = getSearchFiltered();
        if (!selectedType) {
            alert('Bitte erfolgt oder geplant auswählen.');
            return;
        }
        if (filtered.length === 0) {
            alert('Keine Einträge zum Exportieren vorhanden.');
            return;
        }

        const headers = ['Art', 'Datum', 'Start', 'Ende', 'Dauer (Min)', 'Aufgabe', 'Projekt', 'Kategorie', 'Tags'];
        const rows = filtered.map((e) => {
            const proj = state.projects.find((p) => p.id === e.project);
            const cat = state.categories.find((c) => c.id === e.category);
            return [normalizeEntryType(e.entryType), e.date, e.start, e.end, Math.round(e.duration / 60), `"${e.task}"`, proj ? proj.name : '', cat ? cat.name : '', (e.tags || []).join('; ')];
        });

        const csv = [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
        const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `timetracker_suche_${nowStr()}.csv`;
        a.click();
        URL.revokeObjectURL(url);
    });

    $('#btn-show-all').addEventListener('click', () => {
        const selectedType = getSelectedEntryType('search-entry-type');
        if (!selectedType) {
            $('#search-entries-block').style.display = 'none';
            clearSummaryCards('#search-summary');
            renderSearchCharts([]);
            renderSearchTips([]);
            return;
        }

        const filtered = state.entries.filter((e) => normalizeEntryType(e.entryType) === selectedType).sort((a, b) => {
            if (a.date !== b.date) return b.date.localeCompare(a.date);
            return b.start.localeCompare(a.start);
        });

        const entriesBlock = $('#search-entries-block');
        entriesBlock.style.display = '';
        const countEl = $('#search-result-count');
        const list = $('#search-results');

        countEl.textContent = `${filtered.length} Eintr${filtered.length !== 1 ? 'äge' : 'ag'} gesamt`;

        if (filtered.length === 0) {
            list.innerHTML = '<div class="no-entries">Keine Einträge vorhanden.</div>';
            renderSummaryCards('#search-summary', []);
            renderSearchCharts([]);
            renderSearchTips([]);
            return;
        }

        list.innerHTML = filtered
            .map((e) => {
                const proj = state.projects.find((p) => p.id === e.project);
                const cat = state.categories.find((c) => c.id === e.category);
                const tagsHtml = (e.tags || []).map((t) => `<span class="tag">${escHtml(t)}</span>`).join('');
                const projBadge = proj ? `<span class="project-badge" style="background:${proj.color}33;color:${proj.color}">${escHtml(proj.name)}</span>` : '';
                const catBadge = cat ? `<span class="category-badge" style="background:${cat.color}33;color:${cat.color}">${escHtml(cat.name)}</span>` : '';
                const typeBadge = `<span class="entry-type-badge">${escHtml(normalizeEntryType(e.entryType))}</span>`;

                return `<div class="entry-card">
                    <div class="entry-info">
                        <div class="entry-task">${escHtml(e.task)}</div>
                        <div class="entry-meta">
                            <span>${e.date}</span>
                            <span>${e.start} – ${e.end}</span>
                            ${typeBadge}${projBadge}${catBadge}
                        </div>
                        <div style="margin-top:4px">${tagsHtml}</div>
                    </div>
                    <div class="entry-duration">${fmt(e.duration)}</div>
                </div>`;
            })
            .join('');

        renderSummaryCards('#search-summary', filtered);
        renderSearchCharts(filtered);
        renderSearchTips(state.tips);
    });

    $('#btn-search').addEventListener('click', renderSearch);
    $('#search-text').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') renderSearch();
    });
    $$('input[name="search-entry-type"]').forEach((radio) => {
        radio.addEventListener('change', renderSearch);
    });

    $('#btn-search-reset').addEventListener('click', () => {
        window.location.href = window.location.pathname + '#search';
        window.location.reload();
    });

    document.addEventListener('click', () => {
        $$('.multi-select-dropdown').forEach((d) => d.classList.remove('open'));
    });

    // ── Tips ──
    function sortTips(tips) {
        return [...tips].sort((a, b) => {
            const aHasNum = a.number !== null && a.number !== undefined && a.number !== '';
            const bHasNum = b.number !== null && b.number !== undefined && b.number !== '';
            if (aHasNum && !bHasNum) return -1;
            if (!aHasNum && bHasNum) return 1;
            if (aHasNum && bHasNum) {
                const numA = Number(a.number);
                const numB = Number(b.number);
                if (numA !== numB) return numA - numB;
            }
            return b.timestamp.localeCompare(a.timestamp);
        });
    }

    function renderTipCard(t) {
        const tagsHtml = (t.tags || []).map((tag) => `<span class="tag">${escHtml(tag)}</span>`).join('');
        const numBadge = (t.number !== null && t.number !== undefined && t.number !== '') ? `<span class="tip-number">${escHtml(String(t.number))}</span>` : '';
        return `<div class="entry-card tip-card" id="tip-${t.id}">
            <div class="entry-info">
                <div class="entry-task">${escHtml(t.title)}</div>
                <div class="tip-text">${richTextToHtml(t.text)}</div>
                <div class="tip-tags-row">${tagsHtml}</div>
                <div class="entry-actions tip-actions">
                    <button onclick="app.editTip('${t.id}', this)">Bearbeiten</button>
                    <button onclick="app.deleteTip('${t.id}')">Löschen</button>
                </div>
            </div>
            ${numBadge}
        </div>`;
    }

    function renderTips() {
        const list = $('#tips-list');
        if (state.tips.length === 0) {
            list.innerHTML = '<div class="no-entries">Keine Tipps vorhanden.</div>';
            return;
        }
        const sorted = sortTips(state.tips);
        list.innerHTML = sorted.map((t) => renderTipCard(t)).join('');
    }

    $('#btn-add-tip').addEventListener('click', () => {
        const title = $('#tip-title').value.trim();
        if (!title) {
            alert('Bitte eine Überschrift eingeben.');
            return;
        }
        const numberVal = $('#tip-number').value.trim();
        const tip = {
            id: uid(),
            title: title,
            number: numberVal !== '' ? Number(numberVal) : null,
            tags: $('#tip-tags').value.split(',').map((t) => t.trim()).filter(Boolean),
            text: getRichTextTextareaValue('#tip-text'),
            timestamp: new Date().toISOString(),
        };
        state.tips.push(tip);
        save();
        $('#tip-title').value = '';
        $('#tip-number').value = '';
        $('#tip-tags').value = '';
        clearRichTextTextarea('#tip-text');
    });

    // Tips CSV Export
    $('#btn-tips-export').addEventListener('click', () => {
        if (state.tips.length === 0) {
            alert('Keine Tipps zum Exportieren vorhanden.');
            return;
        }
        const sorted = sortTips(state.tips);
        const headers = ['Nummer', 'Überschrift', 'Text', 'Tags'];
        const rows = sorted.map((t) => {
            const num = (t.number !== null && t.number !== undefined && t.number !== '') ? t.number : '';
            const plainText = richTextToPlainText(t.text || '').replace(/"/g, '""');
            return [num, `"${t.title.replace(/"/g, '""')}"`, `"${plainText}"`, (t.tags || []).join('; ')];
        });
        const csv = [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
        const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `timetracker_tipps_${nowStr()}.csv`;
        a.click();
        URL.revokeObjectURL(url);
    });

    // Edit Tip Modal
    let editingTipId = null;

    $('#edit-tip-save').addEventListener('click', () => {
        const title = $('#edit-tip-title').value.trim();
        if (!title) {
            alert('Bitte eine Überschrift eingeben.');
            return;
        }
        const tip = state.tips.find((t) => t.id === editingTipId);
        if (!tip) return;
        const numberVal = $('#edit-tip-number').value.trim();
        tip.title = title;
        tip.number = numberVal !== '' ? Number(numberVal) : null;
        tip.tags = $('#edit-tip-tags').value.split(',').map((t) => t.trim()).filter(Boolean);
        tip.text = getRichTextTextareaValue('#edit-tip-text');
        save();
        $('#edit-tip-modal').hidden = true;
        editingTipId = null;
        renderTips();
    });

    $('#edit-tip-cancel').addEventListener('click', () => {
        $('#edit-tip-modal').hidden = true;
        editingTipId = null;
    });

    $('#edit-tip-modal').addEventListener('click', (e) => {
        if (e.target === $('#edit-tip-modal')) {
            $('#edit-tip-modal').hidden = true;
            editingTipId = null;
        }
    });

    // ── Settings ──
    function renderSettings() {
        renderSettingsList('project');
        renderSettingsList('category');
    }

    function renderSettingsList(type) {
        const items = type === 'project' ? state.projects : state.categories;
        const listEl = $(`#${type}-list`);
        listEl.innerHTML = items
            .map(
                (item) => `<div class="settings-item" id="item-${item.id}">
                <span class="color-dot" style="background:${item.color}"></span>
                <span class="name">${escHtml(item.name)}</span>
                <div class="settings-item-actions">
                    <button onclick="app.editItem('${type}','${item.id}')">Bearbeiten</button>
                    <button onclick="app.deleteItem('${type}','${item.id}')">Löschen</button>
                </div>
            </div>`
            )
            .join('');
    }

    $('#btn-add-project').addEventListener('click', () => {
        const name = $('#new-project').value.trim();
        if (!name) return;
        state.projects.push({ id: uid(), name, color: $('#new-project-color').value });
        state.projects.sort((a, b) => a.name.localeCompare(b.name, 'de'));
        save();
        $('#new-project').value = '';
        populateSelects();
        renderSettings();
    });

    $('#btn-add-category').addEventListener('click', () => {
        const name = $('#new-category').value.trim();
        if (!name) return;
        state.categories.push({ id: uid(), name, color: $('#new-category-color').value });
        state.categories.sort((a, b) => a.name.localeCompare(b.name, 'de'));
        save();
        $('#new-category').value = '';
        populateSelects();
        renderSettings();
    });

    // ── Data Management ──
    $('#btn-export-all').addEventListener('click', () => {
        const data = { entries: state.entries, projects: state.projects, categories: state.categories, tips: state.tips };
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `timetracker_backup_${nowStr()}.json`;
        a.click();
        URL.revokeObjectURL(url);
    });

    $('#btn-import').addEventListener('click', () => $('#import-file').click());

    $('#import-file').addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (ev) => {
            try {
                const data = JSON.parse(ev.target.result);
                if (data.entries) state.entries = migrateEntries(data.entries);
                if (data.projects) state.projects = data.projects;
                if (data.categories) state.categories = data.categories;
                if (data.tips) state.tips = data.tips;
                save();
                populateSelects();
                renderVDayIfActive();
                alert('Daten erfolgreich importiert!');
            } catch {
                alert('Fehler beim Import. Ungültige Datei.');
            }
        };
        reader.readAsText(file);
        e.target.value = '';
    });

    $('#btn-clear-data').addEventListener('click', () => {
        if (confirm('Wirklich ALLE Daten löschen? Dies kann nicht rückgängig gemacht werden!')) {
            state.entries = [];
            save();
            renderEntries();
            renderVDayIfActive();
            alert('Alle Zeiteinträge wurden gelöscht.');
        }
    });

    // ── Global API for inline handlers ──
    let editingEntryId = null;

    function openEditModal(entry) {
        editingEntryId = entry.id;
        const modal = $('#edit-modal');

        // Populate project select
        const projSel = $('#edit-project');
        projSel.innerHTML = '<option value="">-- Projekt wählen --</option>';
        state.projects.forEach((p) => {
            projSel.innerHTML += `<option value="${p.id}">${escHtml(p.name)}</option>`;
        });

        // Populate category select
        const catSel = $('#edit-category');
        catSel.innerHTML = '<option value="">-- Kategorie wählen --</option>';
        state.categories.forEach((c) => {
            catSel.innerHTML += `<option value="${c.id}">${escHtml(c.name)}</option>`;
        });

        // Fill in current values
        $('#edit-task').value = entry.task;
        projSel.value = entry.project;
        catSel.value = entry.category;
        $('#edit-tags').value = (entry.tags || []).join(', ');
        $('#edit-date').value = entry.date;
        $('#edit-start').value = entry.start;
        $('#edit-end').value = entry.end;
        const entryType = normalizeEntryType(entry.entryType);
        $$('input[name="edit-entry-type"]').forEach((radio) => {
            radio.checked = radio.value === entryType;
        });

        modal.hidden = false;
    }

    $('#edit-save').addEventListener('click', () => {
        const task = $('#edit-task').value.trim() || 'Ohne Bezeichnung';
        const startTime = $('#edit-start').value;
        const endTime = $('#edit-end').value;
        const date = $('#edit-date').value;
        const entryType = getSelectedEntryType('edit-entry-type');

        if (!entryType) {
            alert('Bitte erfolgt oder geplant auswählen.');
            return;
        }

        if (!startTime || !endTime || !date) {
            alert('Bitte Start, Ende und Datum angeben.');
            return;
        }

        const startDate = new Date(`${date}T${startTime}`);
        const endDate = new Date(`${date}T${endTime}`);
        let duration = (endDate - startDate) / 1000;
        if (duration <= 0) {
            alert('Endzeit muss nach Startzeit liegen.');
            return;
        }

        const entry = state.entries.find((e) => e.id === editingEntryId);
        if (!entry) return;

        entry.task = task;
        entry.project = $('#edit-project').value;
        entry.category = $('#edit-category').value;
        entry.entryType = entryType;
        entry.tags = $('#edit-tags').value.split(',').map((t) => t.trim()).filter(Boolean);
        entry.date = date;
        entry.start = startTime;
        entry.end = endTime;
        entry.duration = Math.round(duration);

        save();
        $('#edit-modal').hidden = true;
        editingEntryId = null;
        renderEntries();
        renderVDayIfActive();
    });

    $('#edit-cancel').addEventListener('click', () => {
        $('#edit-modal').hidden = true;
        editingEntryId = null;
    });

    $('#edit-modal').addEventListener('click', (e) => {
        if (e.target === $('#edit-modal')) {
            $('#edit-modal').hidden = true;
            editingEntryId = null;
        }
    });

    window.app = {
        editEntry(id) {
            const entry = state.entries.find((e) => e.id === id);
            if (!entry) return;
            openEditModal(entry);
        },
        exportIcal(id) {
            const entry = state.entries.find((e) => e.id === id);
            if (!entry) return;

            const proj = state.projects.find((p) => p.id === entry.project);
            const cat = state.categories.find((c) => c.id === entry.category);
            const datePart = entry.date.replace(/-/g, '');
            const dtStart = datePart + 'T' + entry.start.replace(/:/g, '') + '00';
            const dtEnd = datePart + 'T' + entry.end.replace(/:/g, '') + '00';
            const now = new Date();
            const dtStamp = now.getFullYear()
                + String(now.getMonth() + 1).padStart(2, '0')
                + String(now.getDate()).padStart(2, '0') + 'T'
                + String(now.getHours()).padStart(2, '0')
                + String(now.getMinutes()).padStart(2, '0')
                + String(now.getSeconds()).padStart(2, '0');
            const uidVal = entry.id + '@dailytimetracker';

            let description = '';
            if (proj) description += 'Projekt: ' + proj.name + '\\n';
            if (cat) description += 'Kategorie: ' + cat.name + '\\n';
            if (entry.tags && entry.tags.length) description += 'Tags: ' + entry.tags.join(', ') + '\\n';
            description += 'Dauer: ' + fmt(entry.duration);

            const categories = [proj ? proj.name : '', cat ? cat.name : ''].filter(Boolean).join(',');

            const ics = [
                'BEGIN:VCALENDAR',
                'VERSION:2.0',
                'PRODID:-//DailyTimeTracker//DE',
                'BEGIN:VEVENT',
                'UID:' + uidVal,
                'DTSTAMP:' + dtStamp,
                'DTSTART:' + dtStart,
                'DTEND:' + dtEnd,
                'SUMMARY:' + entry.task,
                'DESCRIPTION:' + description,
                categories ? 'CATEGORIES:' + categories : '',
                'END:VEVENT',
                'END:VCALENDAR',
            ].filter(Boolean).join('\r\n');

            const blob = new Blob([ics], { type: 'text/calendar;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = entry.task.replace(/[^a-zA-Z0-9äöüÄÖÜß _-]/g, '').slice(0, 50) + '_' + entry.date + '.ics';
            a.click();
            URL.revokeObjectURL(url);
        },
        deleteEntry(id) {
            if (!confirm('Eintrag löschen?')) return;
            state.entries = state.entries.filter((e) => e.id !== id);
            save();
            renderEntries();
            renderVDayIfActive();
        },
        deleteItem(type, id) {
            if (!confirm('Wirklich löschen?')) return;
            if (type === 'project') {
                state.projects = state.projects.filter((p) => p.id !== id);
            } else {
                state.categories = state.categories.filter((c) => c.id !== id);
            }
            save();
            populateSelects();
            renderSettings();
            renderVDayIfActive();
        },
        editItem(type, id) {
            const items = type === 'project' ? state.projects : state.categories;
            const item = items.find((i) => i.id === id);
            if (!item) return;
            const el = $(`#item-${id}`);
            el.classList.add('editing');
            el.innerHTML = `
                <input type="color" class="edit-color" value="${item.color}">
                <input type="text" class="edit-name" value="${escHtml(item.name)}">
                <div class="settings-item-actions">
                    <button class="btn-save" onclick="app.saveItem('${type}','${id}')">Speichern</button>
                    <button onclick="app.cancelEdit()">Abbrechen</button>
                </div>
            `;
            el.querySelector('.edit-name').focus();
            el.querySelector('.edit-name').addEventListener('keydown', (e) => {
                if (e.key === 'Enter') app.saveItem(type, id);
                if (e.key === 'Escape') app.cancelEdit();
            });
        },
        saveItem(type, id) {
            const el = $(`#item-${id}`);
            const newName = el.querySelector('.edit-name').value.trim();
            if (!newName) return;
            const newColor = el.querySelector('.edit-color').value;
            const items = type === 'project' ? state.projects : state.categories;
            const item = items.find((i) => i.id === id);
            if (!item) return;
            item.name = newName;
            item.color = newColor;
            items.sort((a, b) => a.name.localeCompare(b.name, 'de'));
            save();
            populateSelects();
            renderSettings();
            renderVDayIfActive();
        },
        cancelEdit() {
            renderSettings();
        },
        editTip(id, trigger) {
            const tip = state.tips.find((t) => t.id === id);
            if (!tip) return;
            const card = trigger?.closest('.tip-card') || $(`#tip-${id}`);
            if (!card) return;
            card.classList.add('editing');
            card.innerHTML = `
                <div class="tip-edit-form">
                    <div class="tip-edit-row">
                        <input type="text" class="edit-tip-title" value="${escHtml(tip.title)}" placeholder="Überschrift...">
                        <input type="number" class="edit-tip-number tip-number-input" value="${tip.number !== null && tip.number !== undefined && tip.number !== '' ? escHtml(String(tip.number)) : ''}" placeholder="Nr." min="0" step="1">
                    </div>
                    <input type="text" class="edit-tip-tags" value="${escHtml((tip.tags || []).join(', '))}" placeholder="Tags (kommagetrennt)">
                    <textarea class="edit-tip-text" rows="4" placeholder="Text...">${escHtml(tip.text)}</textarea>
                    <div class="entry-actions tip-actions">
                        <button onclick="app.saveTip('${id}', this)">Speichern</button>
                        <button onclick="app.cancelTipEdit()">Abbrechen</button>
                    </div>
                </div>`;
            setupRichTextTextarea(card.querySelector('.edit-tip-text'));
            card.querySelector('.edit-tip-title').focus();
        },
        saveTip(id, trigger) {
            const card = trigger?.closest('.tip-card') || $(`#tip-${id}`);
            if (!card) return;
            const title = card.querySelector('.edit-tip-title').value.trim();
            if (!title) {
                alert('Bitte eine Überschrift eingeben.');
                return;
            }
            const numberVal = card.querySelector('.edit-tip-number').value.trim();
            const number = numberVal !== '' ? Number(numberVal) : null;
            if (numberVal !== '' && (Number.isNaN(number) || number < 0)) {
                alert('Bitte eine positive ganze Zahl eingeben.');
                return;
            }
            const tip = state.tips.find((t) => t.id === id);
            if (!tip) return;
            tip.title = title;
            tip.number = number;
            tip.tags = card.querySelector('.edit-tip-tags').value.split(',').map((t) => t.trim()).filter(Boolean);
            tip.text = getRichTextTextareaValue(card.querySelector('.edit-tip-text'));
            save();
            renderTips();
        },
        cancelTipEdit() {
            renderTips();
        },
        deleteTip(id) {
            if (!confirm('Tipp löschen?')) return;
            state.tips = state.tips.filter((t) => t.id !== id);
            save();
            renderTips();
        },
    };

    // ── Init ──
    $('#syncButton')?.addEventListener('click', () => {
        if (state.sync.conflictData) {
            void syncFromOneDrive({ forceRemote: true });
            return;
        }
        if (state.sync.account) {
            void manualSyncOneDrive();
        } else {
            setSyncStatus('local', 'Nicht angemeldet', 'Bitte melde dich zuerst mit OneDrive an.');
        }
    });

    $('#syncAuthButton')?.addEventListener('click', () => {
        if (state.sync.account) {
            void logoutFromOneDrive();
        } else {
            void loginToOneDrive();
        }
    });

    load();
    populateSelects();
    setupRichTextTextarea('#tip-text');
    setupRichTextTextarea('#edit-tip-text');
    $('#filter-date').value = todayStr();
    $('#vday-date').value = todayStr();
    state.vdayDate = todayStr();

    if (location.hash === '#vday') {
        location.hash = '';
        $$('.nav-btn').forEach((b) => b.classList.remove('active'));
        $$('.view').forEach((v) => v.classList.remove('active'));
        $('[data-view="vday"]').classList.add('active');
        $('#vday').classList.add('active');
        renderVDay();
    } else if (location.hash === '#search') {
        location.hash = '';
        $$('.nav-btn').forEach((b) => b.classList.remove('active'));
        $$('.view').forEach((v) => v.classList.remove('active'));
        $('[data-view="search"]').classList.add('active');
        $('#search').classList.add('active');
        initSearchMultiSelects();
    } else if (location.hash === '#entries') {
        location.hash = '';
        $$('.nav-btn').forEach((b) => b.classList.remove('active'));
        $$('.view').forEach((v) => v.classList.remove('active'));
        $('[data-view="entries"]').classList.add('active');
        $('#entries').classList.add('active');
        renderEntries();
    } else if (location.hash === '#reports') {
        location.hash = '';
        $$('.nav-btn').forEach((b) => b.classList.remove('active'));
        $$('.view').forEach((v) => v.classList.remove('active'));
        $('[data-view="reports"]').classList.add('active');
        $('#reports').classList.add('active');
        state.reportPeriod = 'day';
        state.reportOffset = 0;
        $$('.report-tab').forEach((t) => t.classList.remove('active'));
        $('[data-period="day"]').classList.add('active');
        updateReportNav();
        renderReports();
    }
    void initializeOneDrive();
})();
