
// adapter.js — v4.0
// Файл: adapter.js | Глобальная версия: 5.0 (файл не изменялся с v4.0)
// Исправления v4.0:
// 1. КИМ-дисплей и кнопка темы больше не перекрываются (кнопка сдвинута)
// 2. Пауза — полноэкранный оверлей с обратным отсчётом и кнопкой «Вернуться»
//    Нажатие «Вернуться» = ручное переключение на норму (КИМ = нижняя граница нормы)
// 3. Логика версий абзацев: прочитанные выше нижней трети фиксируются.
//    При скролле вверх абзацы ниже нижней трети меняются по режиму.
//    Исключение: пользователь у самого верха — весь текст в текущем режиме.
// 4. КИМ зависит от ручного переключения:
//    КИМ = нижняя_граница_режима + (текущий_КИМ / 100) * ширина_диапазона.
//    Авто-КИМ заблокирован на 3 минуты после ручного переключения.

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

    // Хранит зафиксированную версию каждого блока после его прочтения
    const blockFixed = new WeakMap();

    const LOWER_THIRD     = () => window.innerHeight * (2 / 3);
    const UPPER_THIRD     = () => window.innerHeight * (1 / 3);
    const AT_TOP_THRESHOLD = 50; // пикселей — считается «у самого верха»

    // ─── ИНИЦИАЛИЗАЦИЯ ────────────────────────────────────────────────────────
    document.addEventListener('DOMContentLoaded', () => {
        allBlocks = Array.from(document.querySelectorAll('.para-block'));

        // Убираем старую кнопку #pause-btn из HTML (если есть)
        const oldBtn = document.getElementById('pause-btn');
        if (oldBtn) oldBtn.remove();

        initProgressBar();
        initPauseOverlay();
        initModeSwitcher();
        initThemeToggle();
        highlightKeywords();
        setupScrollWatcher();
        updateProgressBar();

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
        bar.id = 'echo-progress-bar';
        bar.style.cssText = `
            position:fixed; left:0; top:0; width:3px; height:0%;
            background:linear-gradient(180deg,#4FC3F7,#7C4DFF);
            z-index:9998; transition:height 0.4s ease;
            border-radius:0 2px 2px 0;
        `;
        document.body.appendChild(bar);
    }

    function updateProgressBar() {
        const bar = document.getElementById('echo-progress-bar');
        if (!bar) return;
        const docH = document.documentElement.scrollHeight - window.innerHeight;
        if (docH <= 0) { bar.style.height = '0%'; return; }
        bar.style.height = Math.min(100, (window.scrollY / docH) * 100) + '%';
    }

    // ─── ПОЛНОЭКРАННЫЙ ОВЕРЛЕЙ ПАУЗЫ ─────────────────────────────────────────
    function initPauseOverlay() {
        // Кнопка-триггер (показывается в режиме tired)
        const triggerBtn = document.createElement('button');
        triggerBtn.id = 'pause-trigger-btn';
        triggerBtn.textContent = '☕ Сделай паузу 5 минут';
        triggerBtn.style.display = 'none';
        triggerBtn.addEventListener('click', startPauseOverlay);
        document.body.appendChild(triggerBtn);

        // Полноэкранный оверлей
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

        // Нажатие «Вернуться» = ручное переключение на норму
        const normalKIM = computeKIMForMode('normal');
        manualOverride = true;
        clearTimeout(manualOverrideTimer);
        manualOverrideTimer = setTimeout(() => { manualOverride = false; }, MANUAL_LOCK_MS);
        window.currentKIM = normalKIM;
        _applyAdaptation(normalKIM);
    }

    // ─── ВЫЧИСЛЕНИЕ КИМ ДЛЯ РЕЖИМА ───────────────────────────────────────────
    function computeKIMForMode(mode) {
        const range   = MODE_RANGES[mode];
        const width   = range.max - range.min;
        const current = (window.currentKIM !== undefined) ? window.currentKIM : 70;
        return Math.round(range.min + (current / 100) * width);
    }

    // ─── РУЧНОЙ ПЕРЕКЛЮЧАТЕЛЬ РЕЖИМОВ ─────────────────────────────────────────
    function initModeSwitcher() {
        const panel = document.createElement('div');
        panel.id = 'echo-mode-switcher';
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
                font-family:'Courier New',monospace; cursor:pointer;
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

    // ─── ОБНОВЛЕНИЕ КИМ-ДИСПЛЕЯ ──────────────────────────────────────────────
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
        btn.id = 'echo-theme-toggle';
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
        const btn = document.getElementById('echo-theme-toggle');
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

        if (newMode !== lastMode) showModeHint(newMode, kim);

        if (newMode === 'tired') handleTiredMode();
        else clearTiredMode();

        lastMode = newMode;

        updateKIMDisplay(kim);
    }

    // ─── ЛОГИКА ВЕРСИЙ АБЗАЦЕВ ────────────────────────────────────────────────
    function isAtTop() {
        return window.scrollY < AT_TOP_THRESHOLD;
    }

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
            allBlocks.forEach(block => {
                blockFixed.delete(block);
                applyBlockVersion(block, showSimple);
            });
            return;
        }

        const lowerBound = LOWER_THIRD();

        allBlocks.forEach(block => {
            const rect = block.getBoundingClientRect();

            if (rect.top >= lowerBound) {
                blockFixed.delete(block);
                applyBlockVersion(block, showSimple);
            } else {
                if (!blockFixed.has(block)) {
                    blockFixed.set(block, true);
                }
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
        let hint = document.getElementById('echo-mode-hint');
        if (!hint) {
            hint = document.createElement('div');
            hint.id = 'echo-mode-hint';
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

    // ─── ПОДСВЕТКА БЛИЖАЙШЕГО АБЗАЦА ─────────────────────────────────────────
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

    // ─── ПОДСВЕТКА КЛЮЧЕВЫХ СЛОВ ──────────────────────────────────────────────
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

})();