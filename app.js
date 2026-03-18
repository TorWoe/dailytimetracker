(function () {
    'use strict';

    // ── State ──
    const state = {
        entries: [],
        projects: [],
        categories: [],
        timer: { running: false, paused: false, startTime: null, elapsed: 0, interval: null },
        reportPeriod: 'day',
        reportOffset: 0,
        reportCustomStart: '',
        reportCustomEnd: '',
    };

    // ── LocalStorage ──
    function save() {
        localStorage.setItem('dtt_entries', JSON.stringify(state.entries));
        localStorage.setItem('dtt_projects', JSON.stringify(state.projects));
        localStorage.setItem('dtt_categories', JSON.stringify(state.categories));
    }

    function load() {
        try {
            state.entries = JSON.parse(localStorage.getItem('dtt_entries')) || [];
            state.projects = JSON.parse(localStorage.getItem('dtt_projects')) || [];
            state.categories = JSON.parse(localStorage.getItem('dtt_categories')) || [];
        } catch {
            state.entries = [];
            state.projects = [];
            state.categories = [];
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
        save();
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

    function todayStr() {
        return new Date().toISOString().slice(0, 10);
    }

    function escHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    // ── DOM refs ──
    const $ = (sel) => document.querySelector(sel);
    const $$ = (sel) => document.querySelectorAll(sel);

    // ── Navigation ──
    $$('.nav-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
            $$('.nav-btn').forEach((b) => b.classList.remove('active'));
            btn.classList.add('active');
            $$('.view').forEach((v) => v.classList.remove('active'));
            $(`#${btn.dataset.view}`).classList.add('active');
            if (btn.dataset.view === 'entries') renderEntries();
            if (btn.dataset.view === 'reports') renderReports();
            if (btn.dataset.view === 'search') initSearchMultiSelects();
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
    });

    // ── Entries View ──
    function renderEntries() {
        const filterDate = $('#filter-date').value;
        const filterProject = $('#filter-project').value;
        const filterCategory = $('#filter-category').value;

        let filtered = [...state.entries];
        if (filterDate) filtered = filtered.filter((e) => e.date === filterDate);
        if (filterProject) filtered = filtered.filter((e) => e.project === filterProject);
        if (filterCategory) filtered = filtered.filter((e) => e.category === filterCategory);

        filtered.sort((a, b) => {
            if (a.date !== b.date) return b.date.localeCompare(a.date);
            return b.start.localeCompare(a.start);
        });

        const list = $('#entries-list');
        if (filtered.length === 0) {
            list.innerHTML = '<div class="no-entries">Keine Einträge gefunden.</div>';
            return;
        }

        list.innerHTML = filtered
            .map((e) => {
                const proj = state.projects.find((p) => p.id === e.project);
                const cat = state.categories.find((c) => c.id === e.category);
                const tagsHtml = (e.tags || []).map((t) => `<span class="tag">${escHtml(t)}</span>`).join('');
                const projBadge = proj ? `<span class="project-badge" style="background:${proj.color}33;color:${proj.color}">${escHtml(proj.name)}</span>` : '';
                const catBadge = cat ? `<span class="category-badge" style="background:${cat.color}33;color:${cat.color}">${escHtml(cat.name)}</span>` : '';

                return `<div class="entry-card">
                    <div class="entry-info">
                        <div class="entry-task">${escHtml(e.task)}</div>
                        <div class="entry-meta">
                            <span>${e.date}</span>
                            <span>${e.start} – ${e.end}</span>
                            ${projBadge}${catBadge}
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
    }

    $('#filter-date').addEventListener('change', renderEntries);
    $('#filter-project').addEventListener('change', renderEntries);
    $('#filter-category').addEventListener('change', renderEntries);

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

    // ── CSV Export ──
    $('#btn-export').addEventListener('click', () => {
        const filterDate = $('#filter-date').value;
        const filterProject = $('#filter-project').value;
        const filterCategory = $('#filter-category').value;

        let filtered = [...state.entries];
        if (filterDate) filtered = filtered.filter((e) => e.date === filterDate);
        if (filterProject) filtered = filtered.filter((e) => e.project === filterProject);
        if (filterCategory) filtered = filtered.filter((e) => e.category === filterCategory);

        const headers = ['Datum', 'Start', 'Ende', 'Dauer (Min)', 'Aufgabe', 'Projekt', 'Kategorie', 'Tags'];
        const rows = filtered.map((e) => {
            const proj = state.projects.find((p) => p.id === e.project);
            const cat = state.categories.find((c) => c.id === e.category);
            return [e.date, e.start, e.end, Math.round(e.duration / 60), `"${e.task}"`, proj ? proj.name : '', cat ? cat.name : '', (e.tags || []).join('; ')];
        });

        const csv = [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
        const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `timetracker_export_${todayStr()}.csv`;
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

    function updateReportNav() {
        const isCustom = state.reportPeriod === 'custom';
        $('.report-nav').style.display = isCustom ? 'none' : 'flex';
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
        $('#report-date-label').textContent = label;

        const entries = state.entries.filter((e) => e.date >= start && e.date <= end);
        const totalSeconds = entries.reduce((sum, e) => sum + e.duration, 0);
        const uniqueDays = new Set(entries.map((e) => e.date)).size;

        $('#report-summary').innerHTML = `
            <div class="summary-card"><div class="label">Gesamtzeit</div><div class="value">${fmt(totalSeconds)}</div></div>
            <div class="summary-card"><div class="label">Einträge</div><div class="value">${entries.length}</div></div>
            <div class="summary-card"><div class="label">Aktive Tage</div><div class="value">${uniqueDays}</div></div>
            <div class="summary-card"><div class="label">Ø pro Tag</div><div class="value">${uniqueDays ? fmtDecimal(totalSeconds / uniqueDays) : '0.0h'}</div></div>
        `;

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
                    legend: { position: 'bottom', labels: { color: '#eee', padding: 12 } },
                    tooltip: { callbacks: { label: (ctx) => `${ctx.label}: ${ctx.raw} min` } },
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
                    legend: { position: 'bottom', labels: { color: '#eee', padding: 12 } },
                    tooltip: { callbacks: { label: (ctx) => `${ctx.label}: ${ctx.raw} min` } },
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
                    tooltip: { callbacks: { label: (ctx) => `${ctx.raw} min` } },
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
                    legend: { position: 'bottom', labels: { color: '#eee', padding: 12 } },
                    tooltip: { callbacks: { label: (ctx) => `${ctx.label}: ${ctx.raw} min` } },
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
                    legend: { position: 'bottom', labels: { color: '#eee', padding: 12 } },
                    tooltip: { callbacks: { label: (ctx) => `${ctx.label}: ${ctx.raw} min` } },
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
                    tooltip: { callbacks: { label: (ctx) => `${ctx.raw} min` } },
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

    function initSearchMultiSelects() {
        populateMultiSelect('search-project-select', state.projects, 'Alle Projekte');
        populateMultiSelect('search-category-select', state.categories, 'Alle Kategorien');
    }

    function getMultiSelectValues(containerId) {
        const checkboxes = $(`#${containerId}`).querySelectorAll('.multi-select-dropdown input:checked');
        return Array.from(checkboxes).map((cb) => cb.value);
    }

    function getSearchFiltered() {
        const query = $('#search-text').value.trim().toLowerCase();
        const selectedProjects = getMultiSelectValues('search-project-select');
        const selectedCategories = getMultiSelectValues('search-category-select');

        let filtered = [...state.entries];

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

        return { filtered, query, selectedProjects, selectedCategories };
    }

    function renderSearch() {
        const { filtered, query, selectedProjects, selectedCategories } = getSearchFiltered();

        const countEl = $('#search-result-count');
        const list = $('#search-results');

        if (!query && selectedProjects.length === 0 && selectedCategories.length === 0) {
            countEl.textContent = '';
            list.innerHTML = '<div class="no-entries">Bitte Suchbegriff eingeben oder Filter wählen.</div>';
            renderSearchCharts([]);
            return;
        }

        countEl.textContent = `${filtered.length} Ergebnis${filtered.length !== 1 ? 'se' : ''} gefunden`;

        if (filtered.length === 0) {
            list.innerHTML = '<div class="no-entries">Keine Einträge gefunden.</div>';
            renderSearchCharts([]);
            return;
        }

        list.innerHTML = filtered
            .map((e) => {
                const proj = state.projects.find((p) => p.id === e.project);
                const cat = state.categories.find((c) => c.id === e.category);
                const tagsHtml = (e.tags || []).map((t) => `<span class="tag">${escHtml(t)}</span>`).join('');
                const projBadge = proj ? `<span class="project-badge" style="background:${proj.color}33;color:${proj.color}">${escHtml(proj.name)}</span>` : '';
                const catBadge = cat ? `<span class="category-badge" style="background:${cat.color}33;color:${cat.color}">${escHtml(cat.name)}</span>` : '';

                return `<div class="entry-card">
                    <div class="entry-info">
                        <div class="entry-task">${escHtml(e.task)}</div>
                        <div class="entry-meta">
                            <span>${e.date}</span>
                            <span>${e.start} – ${e.end}</span>
                            ${projBadge}${catBadge}
                        </div>
                        <div style="margin-top:4px">${tagsHtml}</div>
                    </div>
                    <div class="entry-duration">${fmt(e.duration)}</div>
                </div>`;
            })
            .join('');

        renderSearchCharts(filtered);
    }

    $('#btn-search-reset').addEventListener('click', () => {
        location.hash = 'search';
        location.reload();
    });

    $('#btn-search-export').addEventListener('click', () => {
        const { filtered } = getSearchFiltered();
        if (filtered.length === 0) {
            alert('Keine Einträge zum Exportieren vorhanden.');
            return;
        }

        const headers = ['Datum', 'Start', 'Ende', 'Dauer (Min)', 'Aufgabe', 'Projekt', 'Kategorie', 'Tags'];
        const rows = filtered.map((e) => {
            const proj = state.projects.find((p) => p.id === e.project);
            const cat = state.categories.find((c) => c.id === e.category);
            return [e.date, e.start, e.end, Math.round(e.duration / 60), `"${e.task}"`, proj ? proj.name : '', cat ? cat.name : '', (e.tags || []).join('; ')];
        });

        const csv = [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
        const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `timetracker_suche_${todayStr()}.csv`;
        a.click();
        URL.revokeObjectURL(url);
    });

    $('#btn-show-all').addEventListener('click', () => {
        const filtered = [...state.entries].sort((a, b) => {
            if (a.date !== b.date) return b.date.localeCompare(a.date);
            return b.start.localeCompare(a.start);
        });

        const countEl = $('#search-result-count');
        const list = $('#search-results');

        countEl.textContent = `${filtered.length} Eintr${filtered.length !== 1 ? 'äge' : 'ag'} gesamt`;

        if (filtered.length === 0) {
            list.innerHTML = '<div class="no-entries">Keine Einträge vorhanden.</div>';
            renderSearchCharts([]);
            return;
        }

        list.innerHTML = filtered
            .map((e) => {
                const proj = state.projects.find((p) => p.id === e.project);
                const cat = state.categories.find((c) => c.id === e.category);
                const tagsHtml = (e.tags || []).map((t) => `<span class="tag">${escHtml(t)}</span>`).join('');
                const projBadge = proj ? `<span class="project-badge" style="background:${proj.color}33;color:${proj.color}">${escHtml(proj.name)}</span>` : '';
                const catBadge = cat ? `<span class="category-badge" style="background:${cat.color}33;color:${cat.color}">${escHtml(cat.name)}</span>` : '';

                return `<div class="entry-card">
                    <div class="entry-info">
                        <div class="entry-task">${escHtml(e.task)}</div>
                        <div class="entry-meta">
                            <span>${e.date}</span>
                            <span>${e.start} – ${e.end}</span>
                            ${projBadge}${catBadge}
                        </div>
                        <div style="margin-top:4px">${tagsHtml}</div>
                    </div>
                    <div class="entry-duration">${fmt(e.duration)}</div>
                </div>`;
            })
            .join('');

        renderSearchCharts(filtered);
    });

    $('#btn-search').addEventListener('click', renderSearch);
    $('#search-text').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') renderSearch();
    });

    document.addEventListener('click', () => {
        $$('.multi-select-dropdown').forEach((d) => d.classList.remove('open'));
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
        const data = { entries: state.entries, projects: state.projects, categories: state.categories };
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `timetracker_backup_${todayStr()}.json`;
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
                if (data.entries) state.entries = data.entries;
                if (data.projects) state.projects = data.projects;
                if (data.categories) state.categories = data.categories;
                save();
                populateSelects();
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

        modal.hidden = false;
    }

    $('#edit-save').addEventListener('click', () => {
        const task = $('#edit-task').value.trim() || 'Ohne Bezeichnung';
        const startTime = $('#edit-start').value;
        const endTime = $('#edit-end').value;
        const date = $('#edit-date').value;

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
        entry.tags = $('#edit-tags').value.split(',').map((t) => t.trim()).filter(Boolean);
        entry.date = date;
        entry.start = startTime;
        entry.end = endTime;
        entry.duration = Math.round(duration);

        save();
        $('#edit-modal').hidden = true;
        editingEntryId = null;
        renderEntries();
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
        },
        cancelEdit() {
            renderSettings();
        },
    };

    // ── Init ──
    load();
    populateSelects();
    $('#filter-date').value = todayStr();

    if (location.hash === '#search') {
        location.hash = '';
        $$('.nav-btn').forEach((b) => b.classList.remove('active'));
        $$('.view').forEach((v) => v.classList.remove('active'));
        $('[data-view="search"]').classList.add('active');
        $('#search').classList.add('active');
        initSearchMultiSelects();
    }
})();
