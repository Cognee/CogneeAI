// adapter.js — v9.1
// Файл: adapter.js | Глобальная версия: 9.1
// Блок 2:
//   - Задача 2.1: слушаем cognee:paragraph_struggle → показываем кнопку "🔄 Объясни иначе"
//   - Задача 2.4: умные закладки с КИМ-снапшотом (CogneeBookmarks)
//   - Задача 2.5: хронорежим — деликатные ночные напоминания
//   - Фикс: triggerAIKeywords и highlightKeywords пропускают .para-full внутри
//     элементов с атрибутом data-no-keywords (используется на лендинге)

(function () {

    // ─── КОНСТАНТЫ РЕЖИМОВ ────────────────────────────────────────────────────
    const MODE_RANGES = {
        focus:  { min: 71, max: 100 },
        normal: { min: 40, max: 70  },
        tired:  { min: 0,  max: 39  },
    };

    // ─── СОСТОЯНИЕ ────────────────────────────────────────────────────────────
    let pauseTimer          = null;
    let pauseCountdown      = null;
    let pauseActive         = false;
    let lastMode            = null;

    let manualOverride      = false;
    let manualOverrideTimer = null;
    const MANUAL_LOCK_MS    = 3 * 60 * 1000;

    let allBlocks           = [];
    let scrollRAF           = null;
    let currentTheme        = 'dark';

    let _keywordsApplied    = false;

    const blockFixed = new WeakMap();

    const LOWER_THIRD     = () => window.innerHeight * (2 / 3);
    const UPPER_THIRD     = () => window.innerHeight * (1 / 3);
    const AT_TOP_THRESHOLD = 50;

    // ─── ИНИЦИАЛИЗАЦИЯ ────────────────────────────────────────────────────────
    document.addEventListener('DOMContentLoaded', () => {
        allBlocks = Array.from(document.querySelectorAll('.para-block'));

        const oldBtn = document.getElementById('pause-btn');
        if (oldBtn) oldBtn.remove();

        initProgressBar();
        initPauseOverlay();
        initModeSwitcher();
        initThemeToggle();
        highlightKeywords();
        setupScrollWatcher();
        updateProgressBar();

        // Задача 2.1: слушаем событие застревания от sensor.js
        document.addEventListener('cognee:paragraph_struggle', onParagraphStruggle);

        // Задача 2.4: инициализация умных закладок
        initBookmarks();

        // Задача 2.5: хронорежим
        initChronoMode();

        if (window.currentKIM !== undefined) {
            _applyAdaptation(window.currentKIM);
        }
    });

    // ─── ЭКСПОРТ ─────────────────────────────────────────────────────────────
    window.applyAdaptation = function (kim, fromManual) {
        if (manualOverride && !fromManual) return;
        _applyAdaptation(kim);
    };

    window.exitPause = finishPause;

    // ─── ПРОГРЕСС-БАР ────────────────────────────────────────────────────────
    function initProgressBar() {
        const bar = document.createElement('div');
        bar.id = 'cognee-progress-bar';
        bar.style.cssText = `
            position:fixed; left:0; top:0; width:3px; height:0%;
            background:linear-gradient(180deg,#4FC3F7,#7C4DFF);
            z-index:9998; transition:height 0.4s ease;
            border-radius:0 2px 2px 0;
        `;
        document.body.appendChild(bar);
    }

    function updateProgressBar() {
        const bar = document.getElementById('cognee-progress-bar');
        if (!bar) return;
        const docH = document.documentElement.scrollHeight - window.innerHeight;
        if (docH <= 0) { bar.style.height = '0%'; return; }
        bar.style.height = Math.min(100, (window.scrollY / docH) * 100) + '%';
    }

    // ─── ПОЛНОЭКРАННЫЙ ОВЕРЛЕЙ ПАУЗЫ ─────────────────────────────────────────
    function initPauseOverlay() {
        const triggerBtn = document.createElement('button');
        triggerBtn.id = 'pause-trigger-btn';
        triggerBtn.textContent = '☕ Сделай паузу 5 минут';
        triggerBtn.style.display = 'none';
        triggerBtn.addEventListener('click', startPauseOverlay);
        document.body.appendChild(triggerBtn);

        const overlay = document.createElement('div');
        overlay.id = 'pause-overlay';
        overlay.innerHTML = `
            <div class="pause-overlay-inner">
                <div class="pause-overlay-emoji">☕</div>
                <div class="pause-overlay-title">Время отдохнуть</div>
                <div class="pause-overlay-countdown" id="pause-countdown-display">5:00</div>
                <div class="pause-overlay-subtitle">Закрой глаза, сделай пару глубоких вдохов</div>
                <button class="pause-overlay-return" id="pause-return-btn">
                    ← Вернуться к чтению
                </button>
            </div>
        `;
        document.body.appendChild(overlay);

        document.getElementById('pause-return-btn').addEventListener('click', finishPause);
    }

    function startPauseOverlay() {
        if (pauseActive) return;
        pauseActive = true;

        const overlay = document.getElementById('pause-overlay');
        if (overlay) overlay.classList.add('active');

        let secondsLeft = 5 * 60;
        const countdownEl = document.getElementById('pause-countdown-display');
        if (countdownEl) countdownEl.textContent = formatCountdown(secondsLeft);

        pauseCountdown = setInterval(() => {
            secondsLeft--;
            if (countdownEl) countdownEl.textContent = formatCountdown(secondsLeft);
            if (secondsLeft <= 0) finishPause();
        }, 1000);

        pauseTimer = setTimeout(finishPause, 5 * 60 * 1000);
    }

    function formatCountdown(sec) {
        const m = Math.floor(sec / 60);
        const s = sec % 60;
        return `${m}:${s.toString().padStart(2, '0')}`;
    }

    function finishPause() {
        clearInterval(pauseCountdown);
        clearTimeout(pauseTimer);
        pauseCountdown = null;
        pauseTimer     = null;
        pauseActive    = false;

        const overlay = document.getElementById('pause-overlay');
        if (overlay) overlay.classList.remove('active');

        const triggerBtn = document.getElementById('pause-trigger-btn');
        if (triggerBtn) triggerBtn.style.display = 'none';

        const normalKIM = computeKIMForMode('normal');
        manualOverride = true;
        clearTimeout(manualOverrideTimer);
        manualOverrideTimer = setTimeout(() => { manualOverride = false; }, MANUAL_LOCK_MS);
        window.currentKIM = normalKIM;
        _applyAdaptation(normalKIM);
    }

    function computeKIMForMode(mode) {
        const range   = MODE_RANGES[mode];
        const width   = range.max - range.min;
        const current = (window.currentKIM !== undefined) ? window.currentKIM : 70;
        return Math.round(range.min + (current / 100) * width);
    }

    // ─── РУЧНОЙ ПЕРЕКЛЮЧАТЕЛЬ РЕЖИМОВ ─────────────────────────────────────────
    function initModeSwitcher() {
        const panel = document.createElement('div');
        panel.id = 'cognee-mode-switcher';
        panel.style.cssText = `
            position:fixed; bottom:24px; left:24px;
            display:flex; flex-direction:column; gap:6px; z-index:10001;
        `;

        const modes = [
            { label: '⚡ Поток',  mode: 'focus',  color: '#4FC3F7' },
            { label: '☁ Норма',  mode: 'normal', color: '#81C784' },
            { label: '🌙 Устал', mode: 'tired',  color: '#FFB74D' },
        ];

        modes.forEach(({ label, mode, color }) => {
            const btn = document.createElement('button');
            btn.textContent = label;
            btn.style.cssText = `
                background:${color}22; color:${color};
                border:1px solid ${color}66; border-radius:20px;
                padding:5px 12px; font-size:12px; font-weight:600;
                font-family:'JetBrains Mono','Courier New',monospace; cursor:pointer;
                transition:background 0.2s ease, transform 0.1s ease;
                white-space:nowrap;
            `;
            btn.addEventListener('mouseenter', () => btn.style.background = `${color}44`);
            btn.addEventListener('mouseleave', () => btn.style.background = `${color}22`);
            btn.addEventListener('click', () => {
                btn.style.transform = 'scale(0.93)';
                setTimeout(() => btn.style.transform = '', 120);

                const newKIM = computeKIMForMode(mode);
                manualOverride = true;
                clearTimeout(manualOverrideTimer);
                manualOverrideTimer = setTimeout(() => { manualOverride = false; }, MANUAL_LOCK_MS);
                window.currentKIM = newKIM;
                updateKIMDisplay(newKIM);
                window.applyAdaptation(newKIM, true);
            });
            panel.appendChild(btn);
        });

        document.body.appendChild(panel);
    }

    function updateKIMDisplay(kim) {
        const display = document.getElementById('kim-display');
        if (!display) return;
        display.textContent = `КИМ: ${Math.round(kim)}`;
        const colors = { focus: '#4FC3F7', normal: '#81C784', tired: '#c49a6c' };
        display.style.borderLeft = `3px solid ${colors[getZone(kim)]}`;
    }

    function getZone(kim) {
        return kim > 70 ? 'focus' : kim >= 40 ? 'normal' : 'tired';
    }

    // ─── ПЕРЕКЛЮЧАТЕЛЬ ТЕМЫ ───────────────────────────────────────────────────
    function initThemeToggle() {
        const btn = document.createElement('button');
        btn.id = 'cognee-theme-toggle';
        btn.textContent = '☀';
        btn.title = 'Переключить тему';
        btn.style.cssText = `
            position:fixed; top:20px; right:170px;
            background:transparent; border:1px solid rgba(255,255,255,0.15);
            color:#a0b8d0; font-size:16px; width:36px; height:36px;
            border-radius:50%; cursor:pointer; z-index:10001;
            transition:background 0.2s, color 0.2s, border-color 0.2s;
            display:flex; align-items:center; justify-content:center;
        `;
        btn.addEventListener('click', toggleTheme);
        document.body.appendChild(btn);
    }

    function toggleTheme() {
        currentTheme = currentTheme === 'dark' ? 'light' : 'dark';
        document.body.dataset.theme = currentTheme;
        const btn = document.getElementById('cognee-theme-toggle');
        if (btn) btn.textContent = currentTheme === 'dark' ? '☀' : '🌙';
    }

    // ─── НАБЛЮДАТЕЛЬ ЗА ПРОКРУТКОЙ ────────────────────────────────────────────
    function setupScrollWatcher() {
        window.addEventListener('scroll', () => {
            if (scrollRAF) return;
            scrollRAF = requestAnimationFrame(() => {
                scrollRAF = null;
                updateProgressBar();
                if (lastMode) updateContentByScroll(lastMode);
                if (document.body.classList.contains('mode-tired')) {
                    highlightClosestParagraph();
                }
            });
        }, { passive: true });
    }

    // ─── ГЛАВНАЯ ФУНКЦИЯ АДАПТАЦИИ ────────────────────────────────────────────
    function _applyAdaptation(kim) {
        let newMode;
        if (kim > 70)       newMode = 'focus';
        else if (kim >= 40) newMode = 'normal';
        else                newMode = 'tired';

        document.body.classList.remove('mode-focus', 'mode-normal', 'mode-tired');
        document.body.classList.add('mode-' + newMode);

        updateContentByMode(newMode);

        if (newMode !== lastMode) {
            showModeHint(newMode, kim);

            if (newMode === 'tired') {
                triggerAISimplification();
            }
            if ((newMode === 'normal' || newMode === 'tired') && !_keywordsApplied) {
                triggerAIKeywords();
            }
        }

        if (newMode === 'tired') handleTiredMode();
        else clearTiredMode();

        lastMode = newMode;

        updateKIMDisplay(kim);

        // Задача 2.4: обновляем КИМ в умных закладках при каждой смене
        _refreshBookmarkKIMHint();
    }

    // ─── ЛОГИКА ВЕРСИЙ АБЗАЦЕВ ────────────────────────────────────────────────
    function isAtTop() { return window.scrollY < AT_TOP_THRESHOLD; }

    function updateContentByMode(mode) {
        const showSimple = (mode === 'tired');

        if (isAtTop()) {
            allBlocks.forEach(block => {
                blockFixed.delete(block);
                applyBlockVersion(block, showSimple);
            });
            return;
        }

        const lowerBound = LOWER_THIRD();
        allBlocks.forEach(block => {
            const rect = block.getBoundingClientRect();
            if (rect.top < lowerBound) {
                if (!blockFixed.has(block)) {
                    blockFixed.set(block, true);
                    applyBlockVersion(block, showSimple);
                }
            } else {
                blockFixed.delete(block);
                applyBlockVersion(block, showSimple);
            }
        });
    }

    function updateContentByScroll(mode) {
        const showSimple = (mode === 'tired');
        if (isAtTop()) {
            allBlocks.forEach(block => { blockFixed.delete(block); applyBlockVersion(block, showSimple); });
            return;
        }
        const lowerBound = LOWER_THIRD();
        allBlocks.forEach(block => {
            const rect = block.getBoundingClientRect();
            if (rect.top >= lowerBound) {
                blockFixed.delete(block);
                applyBlockVersion(block, showSimple);
            } else {
                if (!blockFixed.has(block)) blockFixed.set(block, true);
            }
        });
    }

    function applyBlockVersion(block, showSimple) {
        const currentlySimple = block.dataset.showing === 'simple';
        if (showSimple === currentlySimple) return;
        const full   = block.querySelector('.para-full');
        const simple = block.querySelector('.para-simple');
        if (!full && !simple) return;
        animateContentSwap(block, full, simple, showSimple);
    }

    function animateContentSwap(block, full, simple, showSimple) {
        const outgoing = showSimple ? full   : simple;
        const incoming = showSimple ? simple : full;
        if (!incoming) return;

        if (outgoing) {
            outgoing.style.transition = 'opacity 0.25s ease';
            outgoing.style.opacity    = '0';
        }

        setTimeout(() => {
            if (outgoing) {
                outgoing.style.display    = 'none';
                outgoing.style.opacity    = '';
                outgoing.style.transition = '';
            }
            incoming.style.display    = 'block';
            incoming.style.opacity    = '0';
            incoming.style.transition = '';
            block.dataset.showing     = showSimple ? 'simple' : 'full';

            requestAnimationFrame(() => requestAnimationFrame(() => {
                incoming.style.transition = 'opacity 0.4s ease';
                incoming.style.opacity    = '1';
                setTimeout(() => {
                    incoming.style.transition = '';
                    incoming.style.opacity    = '';
                }, 420);
            }));
        }, 260);
    }

    // ─── ПОДСКАЗКА О СМЕНЕ РЕЖИМА ─────────────────────────────────────────────
    const modeLabels = {
        focus:  { text: '⚡ Режим концентрации', color: '#4FC3F7' },
        normal: { text: '☁ Обычный режим',       color: '#81C784' },
        tired:  { text: '🌙 Щадящий режим',      color: '#E8A87C' },
    };

    function showModeHint(mode, kim) {
        let hint = document.getElementById('cognee-mode-hint');
        if (!hint) {
            hint = document.createElement('div');
            hint.id = 'cognee-mode-hint';
            hint.style.cssText = `
                position:fixed; top:64px; left:50%;
                transform:translateX(-50%) translateY(-10px);
                padding:8px 18px; border-radius:20px;
                font-size:13px; font-weight:600; letter-spacing:0.02em;
                color:#fff; pointer-events:none; opacity:0;
                transition:opacity 0.3s ease, transform 0.3s ease;
                z-index:10000; white-space:nowrap;
                font-family:'Courier New',monospace;
            `;
            document.body.appendChild(hint);
        }

        const info = modeLabels[mode] || modeLabels.normal;
        hint.textContent       = `${info.text} · КИМ ${Math.round(kim)}`;
        hint.style.background  = info.color + 'CC';
        hint.style.boxShadow   = `0 4px 20px ${info.color}55`;
        hint.style.opacity     = '1';
        hint.style.transform   = 'translateX(-50%) translateY(0)';

        clearTimeout(hint._timer);
        hint._timer = setTimeout(() => {
            hint.style.opacity   = '0';
            hint.style.transform = 'translateX(-50%) translateY(-10px)';
        }, 2500);
    }

    // ─── РЕЖИМ TIRED ──────────────────────────────────────────────────────────
    function handleTiredMode() {
        highlightClosestParagraph();
        const triggerBtn = document.getElementById('pause-trigger-btn');
        if (triggerBtn) triggerBtn.style.display = 'block';
    }

    function clearTiredMode() {
        if (!pauseActive) {
            const triggerBtn = document.getElementById('pause-trigger-btn');
            if (triggerBtn) triggerBtn.style.display = 'none';
        }
        document.querySelectorAll('p').forEach(p => p.classList.remove('active-para'));
    }

    function highlightClosestParagraph() {
        const target     = UPPER_THIRD();
        const candidates = [];

        allBlocks.forEach(block => {
            const full    = block.querySelector('.para-full');
            const simple  = block.querySelector('.para-simple');
            const showing = block.dataset.showing === 'simple' ? simple : full;
            if (showing && showing.offsetHeight > 0) candidates.push(showing);
        });

        if (candidates.length === 0) return;

        let activePara = null;
        let minDist    = Infinity;

        candidates.forEach(p => {
            const rect = p.getBoundingClientRect();
            const dist = Math.abs(rect.top - target);
            if (dist < minDist) { minDist = dist; activePara = p; }
        });

        document.querySelectorAll('p').forEach(p => p.classList.remove('active-para'));
        if (activePara) activePara.classList.add('active-para');
    }

    // ─── ПОДСВЕТКА КЛЮЧЕВЫХ СЛОВ (локальный fallback) ────────────────────────
    function highlightKeywords() {
        const wordRe = /[\u0400-\u04FFa-zA-Z]{9,}/g;
        const paras  = document.querySelectorAll('.para-full');
        let count    = 0;
        const max    = 5;

        paras.forEach(p => {
            if (count >= max) return;
            const walker    = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
            const textNodes = [];
            let node;
            while ((node = walker.nextNode())) textNodes.push(node);

            textNodes.forEach(textNode => {
                if (count >= max) return;
                const text = textNode.nodeValue;
                const matches = [...text.matchAll(wordRe)];
                if (matches.length === 0) return;

                const match = matches[0];
                count++;

                const before = text.slice(0, match.index);
                const after  = text.slice(match.index + match[0].length);

                const span = document.createElement('span');
                span.className   = 'keyword';
                span.textContent = match[0];

                const frag = document.createDocumentFragment();
                if (before) frag.appendChild(document.createTextNode(before));
                frag.appendChild(span);
                if (after) frag.appendChild(document.createTextNode(after));

                textNode.parentNode.replaceChild(frag, textNode);
            });
        });
    }

    // ─── AI-УПРОЩЕНИЕ АБЗАЦЕВ ────────────────────────────────────────────────
    async function triggerAISimplification() {
        if (!window.CogneeAI) return;

        const blocks = Array.from(document.querySelectorAll('.para-block'));
        const needAI = blocks.filter(block => {
            const simple = block.querySelector('.para-simple');
            return !simple || simple.textContent.trim().length < 10;
        });

        if (needAI.length === 0) return;

        showAIStatus(`⚡ CogneeAI упрощает ${needAI.length} абзац(ев)…`);

        let done = 0;
        for (const block of needAI) {
            const full = block.querySelector('.para-full');
            if (!full) continue;

            showAISpinner(block);

            try {
                const simplified = await window.CogneeAI.simplifyParagraph(full.textContent);
                injectSimplified(block, simplified);
            } catch (e) {
                console.warn('[adapter.js] AI-упрощение не удалось:', e);
            }

            hideAISpinner(block);
            done++;
            showAIStatus(`⚡ CogneeAI: ${done}/${needAI.length} абзацев обработано`);
        }

        hideAIStatus(2000);
    }

    function injectSimplified(block, text) {
        let simple = block.querySelector('.para-simple');
        if (!simple) {
            simple = document.createElement('p');
            simple.className = 'para-simple';
            block.appendChild(simple);
        }
        simple.textContent = text;

        if (lastMode === 'tired') {
            const full = block.querySelector('.para-full');
            if (full && block.dataset.showing !== 'simple') {
                animateContentSwap(block, full, simple, true);
            }
        }
    }

    // ─── AI-КЛЮЧЕВЫЕ СЛОВА ────────────────────────────────────────────────────
    // Пропускаем параграфы внутри элементов с data-no-keywords="true"
    // (на лендинге ставится на .steps-grid, чтобы не выделять слова в карточках)
    function _isKeywordsForbidden(el) {
        let node = el;
        while (node && node !== document.body) {
            if (node.dataset && node.dataset.noKeywords === 'true') return true;
            node = node.parentElement;
        }
        return false;
    }

    async function triggerAIKeywords() {
        if (_keywordsApplied) return;

        const allParas      = Array.from(document.querySelectorAll('.para-full'));
        const eligibleParas = allParas.filter(p => !_isKeywordsForbidden(p));

        if (!window.CogneeAI) {
            highlightKeywordsLocalInList(eligibleParas);
            _keywordsApplied = true;
            return;
        }

        for (const para of eligibleParas) {
            try {
                const keywords = await window.CogneeAI.extractKeywords(para.textContent);
                if (keywords.length > 0) {
                    highlightWordsInPara(para, keywords);
                }
            } catch (e) {}
        }

        _keywordsApplied = true;
    }

    // Локальный fallback: выделяем длинные слова в списке параграфов
    function highlightKeywordsLocalInList(paraList) {
        const wordRe = /[\u0400-\u04FFa-zA-Z]{9,}/g;
        let count = 0;
        const max = 5;
        for (const p of paraList) {
            if (count >= max) break;
            const walker    = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
            const textNodes = [];
            let node;
            while ((node = walker.nextNode())) textNodes.push(node);
            for (const textNode of textNodes) {
                if (count >= max) break;
                const text = textNode.nodeValue;
                const matches = [...text.matchAll(wordRe)];
                if (!matches.length) continue;
                const match = matches[0];
                count++;
                const before = text.slice(0, match.index);
                const after  = text.slice(match.index + match[0].length);
                const span = document.createElement('span');
                span.className   = 'keyword';
                span.textContent = match[0];
                const frag = document.createDocumentFragment();
                if (before) frag.appendChild(document.createTextNode(before));
                frag.appendChild(span);
                if (after) frag.appendChild(document.createTextNode(after));
                textNode.parentNode.replaceChild(frag, textNode);
            }
        }
    }

    function highlightWordsInPara(para, keywords) {
        const walker = document.createTreeWalker(para, NodeFilter.SHOW_TEXT);
        const textNodes = [];
        let node;
        while ((node = walker.nextNode())) textNodes.push(node);

        textNodes.forEach(textNode => {
            let remaining = textNode.nodeValue;
            let modified  = false;
            const frag    = document.createDocumentFragment();

            keywords.forEach(kw => {
                if (kw.length < 3) return;
                const re  = new RegExp(kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
                const hit = re.exec(remaining);
                if (hit) {
                    const before = remaining.slice(0, hit.index);
                    const after  = remaining.slice(hit.index + hit[0].length);

                    if (before) frag.appendChild(document.createTextNode(before));
                    const span = document.createElement('span');
                    span.className   = 'keyword keyword-ai';
                    span.textContent = hit[0];
                    frag.appendChild(span);

                    remaining = after;
                    modified  = true;
                }
            });

            if (modified) {
                if (remaining) frag.appendChild(document.createTextNode(remaining));
                textNode.parentNode.replaceChild(frag, textNode);
            }
        });
    }

    // ═══════════════════════════════════════════════════════════
    // ЗАДАЧА 2.1: "Объясни иначе"
    // ═══════════════════════════════════════════════════════════

    // Множество блоков, на которых кнопка уже показана
    const _explainBtnShown = new WeakSet();

    function onParagraphStruggle(e) {
        const block = e.detail?.block;
        if (!block || _explainBtnShown.has(block)) return;
        if (!document.body.contains(block)) return;

        _explainBtnShown.add(block);

        const existingBtn = block.querySelector('.explain-btn');
        if (existingBtn) return;

        const btn = document.createElement('button');
        btn.className   = 'explain-btn';
        btn.textContent = '🔄 Объясни иначе';

        btn.addEventListener('click', async () => {
            btn.disabled    = true;
            btn.textContent = '⏳ Думаю…';

            const paraFull = block.querySelector('.para-full');
            if (!paraFull) { btn.textContent = '🔄 Объясни иначе'; btn.disabled = false; return; }

            try {
                const rephrased = window.CogneeAI
                    ? await window.CogneeAI.rephraseText(paraFull.textContent)
                    : '';

                if (!rephrased) throw new Error('Пустой ответ');

                // Показываем результат в collapsible div
                let resultDiv = block.querySelector('.explain-result');
                if (!resultDiv) {
                    resultDiv = document.createElement('div');
                    resultDiv.className = 'explain-result';
                    block.appendChild(resultDiv);
                }

                resultDiv.innerHTML = `
                    <div class="explain-result-label">💡 Другой способ понять это:</div>
                    <div class="explain-result-text">${_esc(rephrased)}</div>
                    <button class="explain-close">× Закрыть</button>
                `;
                resultDiv.classList.add('visible');

                resultDiv.querySelector('.explain-close').addEventListener('click', () => {
                    resultDiv.classList.remove('visible');
                    setTimeout(() => resultDiv.remove(), 300);
                    btn.textContent = '🔄 Объясни иначе';
                    btn.disabled    = false;
                    _explainBtnShown.delete(block);
                });

                btn.textContent = '✓ Готово';
                setTimeout(() => {
                    btn.textContent = '🔄 Объясни иначе';
                    btn.disabled    = false;
                }, 3000);

            } catch (err) {
                console.warn('[adapter.js] rephraseText error:', err);
                btn.textContent = '⚠ Ошибка';
                setTimeout(() => {
                    btn.textContent = '🔄 Объясни иначе';
                    btn.disabled    = false;
                }, 2000);
            }
        });

        // Добавляем кнопку после активного абзаца
        const paraFull = block.querySelector('.para-full');
        if (paraFull) {
            paraFull.insertAdjacentElement('afterend', btn);
        } else {
            block.appendChild(btn);
        }

        // Анимированное появление
        requestAnimationFrame(() => {
            btn.style.animation = 'explain-btn-appear 0.4s ease';
        });
    }

    function _esc(s) {
        return String(s)
            .replace(/&/g,'&amp;').replace(/</g,'&lt;')
            .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    // ═══════════════════════════════════════════════════════════
    // ЗАДАЧА 2.4: Умные закладки с КИМ-снапшотом
    // ═══════════════════════════════════════════════════════════

    const BOOKMARKS_KEY = 'cognee_bookmarks';

    function initBookmarks() {
        // Только на reader.html — проверяем наличие article-meta
        if (!document.getElementById('article-meta') && !document.querySelector('.para-block')) return;

        // Добавляем кнопку закладки в интерфейс
        const btn = document.createElement('button');
        btn.id    = 'cognee-bookmark-btn';
        btn.title = 'Добавить умную закладку (запомнит КИМ и позицию)';
        btn.style.cssText = `
            position:fixed; top:192px; right:20px;
            background:var(--kim-bg,#0a1020);
            border:1px solid rgba(255,255,255,0.08);
            border-radius:8px; width:36px; height:36px;
            display:flex; align-items:center; justify-content:center;
            font-size:17px; cursor:pointer; z-index:9999;
            box-shadow:0 2px 16px rgba(0,0,0,0.3);
            transition:background 0.2s, border-color 0.2s;
        `;
        btn.textContent = '🔖';
        btn.addEventListener('click', addBookmark);
        btn.addEventListener('mouseenter', () => {
            btn.style.background = 'rgba(79,195,247,0.15)';
            btn.style.borderColor = 'rgba(79,195,247,0.3)';
        });
        btn.addEventListener('mouseleave', () => {
            btn.style.background = '';
            btn.style.borderColor = '';
        });
        document.body.appendChild(btn);

        // Инициализируем тултип закладок
        _renderBookmarkTooltip();
    }

    function addBookmark() {
        const snapshot = window.CogneeBookmarks?.getKIMSnapshot?.() || {
            kim: Math.round(window.currentKIM || 70),
            zone: 'normal',
            ts: Date.now(),
        };

        // Определяем позицию и контекст
        const scrollPct = document.documentElement.scrollHeight > 0
            ? Math.round(window.scrollY / (document.documentElement.scrollHeight - window.innerHeight) * 100)
            : 0;

        // Пробуем взять заголовок ближайшего раздела
        let context = '';
        const headings = document.querySelectorAll('h2, h3');
        headings.forEach(h => {
            const rect = h.getBoundingClientRect();
            if (rect.top < window.innerHeight / 2) context = h.textContent.trim().slice(0, 60);
        });

        const bookmark = {
            id:        Date.now(),
            url:       location.href,
            title:     document.title,
            scrollPct,
            context,
            kim:       snapshot.kim,
            zone:      snapshot.zone,
            ts:        snapshot.ts,
        };

        try {
            const bookmarks = _loadBookmarks();
            bookmarks.unshift(bookmark);
            if (bookmarks.length > 50) bookmarks.pop();
            localStorage.setItem(BOOKMARKS_KEY, JSON.stringify(bookmarks));
        } catch (e) {}

        showAIStatus('🔖 Закладка сохранена · КИМ ' + snapshot.kim + ' · ' + scrollPct + '%');
        hideAIStatus(2500);
        _renderBookmarkTooltip();
    }

    function _loadBookmarks() {
        try {
            const raw = localStorage.getItem(BOOKMARKS_KEY);
            return raw ? JSON.parse(raw) : [];
        } catch { return []; }
    }

    function _renderBookmarkTooltip() {
        // Убираем старый тултип
        const old = document.getElementById('cognee-bookmarks-panel');
        if (old) old.remove();
    }

    function _refreshBookmarkKIMHint() {
        // Обновляем подсказку на кнопке закладки
        const btn = document.getElementById('cognee-bookmark-btn');
        if (!btn) return;
        const zone  = getZone(window.currentKIM || 70);
        const color = zone === 'focus' ? '#4FC3F7' : zone === 'normal' ? '#81C784' : '#FFB74D';
        btn.style.borderColor = color + '55';
    }

    // ═══════════════════════════════════════════════════════════
    // ЗАДАЧА 2.5: Хронорежим — деликатные напоминания
    // ═══════════════════════════════════════════════════════════

    const CHRONO_KEY = 'cognee_chrono_dismissed';

    function initChronoMode() {
        // Проверяем время суток каждые 5 минут
        _checkChronoMode();
        setInterval(_checkChronoMode, 5 * 60 * 1000);
    }

    function _checkChronoMode() {
        const h = new Date().getHours();
        const dismissed = _getChronoDismissed();
        const key = `${h}_${new Date().toDateString()}`;

        if (dismissed.has(key)) return;

        let message = null;
        let icon    = '🕐';
        let color   = '#4FC3F7';

        if (h >= 23 || h < 5) {
            message = 'Сейчас глубокая ночь. КИМ снижен из-за усталости — это нормально. Можно сделать перерыв.';
            icon    = '🌙';
            color   = '#FFB74D';
        } else if (h >= 13 && h <= 15) {
            message = 'Послеобеденный спад концентрации — самое сложное время для чтения. КИМ может быть ниже обычного.';
            icon    = '😴';
            color   = '#81C784';
        }

        if (!message) return;

        // Показываем деликатное напоминание
        _showChronoNotice(message, icon, color, key);
    }

    function _showChronoNotice(message, icon, color, dismissKey) {
        // Не показываем если уже есть
        if (document.getElementById('cognee-chrono-notice')) return;

        const notice = document.createElement('div');
        notice.id = 'cognee-chrono-notice';
        notice.style.cssText = `
            position:fixed; bottom:100px; left:50%;
            transform:translateX(-50%);
            background:rgba(10,16,30,0.95);
            border:1px solid ${color}44;
            border-left:3px solid ${color};
            border-radius:10px;
            padding:12px 16px 12px 14px;
            font-family:'JetBrains Mono','Courier New',monospace;
            font-size:12px; color:#c0b8a8;
            max-width:340px; z-index:10003;
            box-shadow:0 8px 24px rgba(0,0,0,0.4);
            animation:chrono-slide-up 0.4s ease;
            line-height:1.5;
        `;

        notice.innerHTML = `
            <div style="display:flex;align-items:flex-start;gap:10px">
                <span style="font-size:18px;flex-shrink:0;margin-top:1px">${icon}</span>
                <div style="flex:1">
                    <div style="color:${color};font-size:10px;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:4px">Хронорежим</div>
                    <div>${_esc(message)}</div>
                </div>
                <button id="chrono-dismiss" style="
                    background:none;border:none;color:#5a7090;cursor:pointer;
                    font-size:16px;padding:0 0 0 8px;flex-shrink:0;line-height:1;
                " title="Закрыть">×</button>
            </div>
        `;

        if (!document.getElementById('cognee-chrono-styles')) {
            const style = document.createElement('style');
            style.id = 'cognee-chrono-styles';
            style.textContent = `
                @keyframes chrono-slide-up {
                    from { opacity:0; transform:translateX(-50%) translateY(12px); }
                    to   { opacity:1; transform:translateX(-50%) translateY(0); }
                }
            `;
            document.head.appendChild(style);
        }

        document.body.appendChild(notice);

        // Автоудаление через 15 секунд
        const autoRemove = setTimeout(() => {
            notice.style.opacity = '0';
            notice.style.transition = 'opacity 0.5s';
            setTimeout(() => notice.remove(), 500);
        }, 15000);

        // Кнопка закрытия
        const dismissBtn = notice.querySelector('#chrono-dismiss');
        if (dismissBtn) {
            dismissBtn.addEventListener('click', () => {
                clearTimeout(autoRemove);
                notice.style.opacity = '0';
                notice.style.transition = 'opacity 0.3s';
                setTimeout(() => notice.remove(), 300);
                _addChronoDismissed(dismissKey);
            });
        }
    }

    function _getChronoDismissed() {
        try {
            const raw = localStorage.getItem(CHRONO_KEY);
            return new Set(raw ? JSON.parse(raw) : []);
        } catch { return new Set(); }
    }

    function _addChronoDismissed(key) {
        try {
            const set = _getChronoDismissed();
            set.add(key);
            // Чистим старые (храним только за последние 7 дней)
            const arr = Array.from(set).slice(-50);
            localStorage.setItem(CHRONO_KEY, JSON.stringify(arr));
        } catch {}
    }

    // ─── UI: СПИННЕР И СТАТУС AI ──────────────────────────────────────────────
    let aiStatusTimer = null;

    function showAIStatus(text) {
        let el = document.getElementById('cognee-ai-status');
        if (!el) {
            el = document.createElement('div');
            el.id = 'cognee-ai-status';
            document.body.appendChild(el);
        }
        el.textContent = text;
        el.classList.add('visible');
        clearTimeout(aiStatusTimer);
    }

    function hideAIStatus(delay = 0) {
        aiStatusTimer = setTimeout(() => {
            const el = document.getElementById('cognee-ai-status');
            if (el) el.classList.remove('visible');
        }, delay);
    }

    function showAISpinner(block) {
        if (block.querySelector('.cognee-ai-spinner')) return;
        const spinner = document.createElement('div');
        spinner.className = 'cognee-ai-spinner';
        spinner.innerHTML = '<span></span><span></span><span></span>';
        block.appendChild(spinner);
    }

    function hideAISpinner(block) {
        const spinner = block.querySelector('.cognee-ai-spinner');
        if (spinner) spinner.remove();
    }

})();
