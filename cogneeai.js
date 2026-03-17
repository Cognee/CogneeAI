// cogneeai.js — v8.4
// Файл: cogneeai.js | Глобальная версия: 8.4
// CogneeAI Universal SDK
//
// Встройте Cognee на любой сайт одной строкой:
//
//   <script src="cogneeai.js"
//     data-model="https://yoursite.com/model/cognee_ai.onnx"
//     data-proxy="https://yourproject.supabase.co/functions/v1/gemini-proxy"
//     data-lang="ru"
//     data-theme="auto">
//   </script>
//
// Атрибуты:
//   data-model   — URL к .onnx модели (обязателен для нейросети; без него — эвристика)
//   data-proxy   — URL Supabase Edge Function для Gemini AI (без него — только подсветка)
//   data-lang    — язык UI: "ru" | "en" (по умолчанию: "ru")
//   data-theme   — тема индикатора: "auto" | "dark" | "light" (по умолчанию: "auto")
//   data-min-len — минимальная длина абзаца для обработки (по умолчанию: 80)
//   data-debug   — "true" для вывода диагностики в консоль

(function () {
    'use strict';

    // ─── ЗАЩИТА ОТ ДВОЙНОЙ ИНИЦИАЛИЗАЦИИ ─────────────────────────────────────
    if (window.__cogneeSDKInitialized) return;
    window.__cogneeSDKInitialized = true;

    // ─── КОНСТАНТЫ ────────────────────────────────────────────────────────────
    const SDK_VERSION          = '8.4';
    const UPDATE_INTERVAL_MS   = 20000;
    const KIM_CHANGE_THRESHOLD = 8;
    const SMOOTH_ALPHA_NEURAL  = 0.25;
    const SMOOTH_ALPHA_HEURISTIC = 0.35;
    const FEATURE_SIZE         = 16;
    const CACHE_PREFIX         = 'cognee_sdk_';

    // ─── ЧТЕНИЕ КОНФИГА ИЗ АТРИБУТОВ ТЕГА <script> ───────────────────────────
    const scriptTag = document.currentScript || (function () {
        const scripts = document.getElementsByTagName('script');
        return scripts[scripts.length - 1];
    })();

    const CFG = {
        modelUrl : scriptTag.getAttribute('data-model')   || null,
        proxyUrl : scriptTag.getAttribute('data-proxy')   || null,
        lang     : scriptTag.getAttribute('data-lang')    || 'ru',
        theme    : scriptTag.getAttribute('data-theme')   || 'auto',
        minLen   : parseInt(scriptTag.getAttribute('data-min-len') || '80', 10),
        debug    : scriptTag.getAttribute('data-debug') === 'true',
    };

    // ─── ТЕКСТЫ ЛОКАЛИЗАЦИИ ───────────────────────────────────────────────────
    const I18N = {
        ru: {
            badge     : 'CogneeAI',
            focus     : 'Фокус',
            normal    : 'Норма',
            tired     : 'Устал',
            neural    : '🧠',
            heuristic : '⚙',
            powered   : 'Адаптация текста активна',
            aiLoading : 'AI упрощает...',
        },
        en: {
            badge     : 'CogneeAI',
            focus     : 'Focus',
            normal    : 'Normal',
            tired     : 'Tired',
            neural    : '🧠',
            heuristic : '⚙',
            powered   : 'Text adaptation active',
            aiLoading : 'AI simplifying...',
        },
    };
    const T = I18N[CFG.lang] || I18N.ru;

    // ─── УТИЛИТЫ ──────────────────────────────────────────────────────────────
    const clamp   = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
    const getZone = kim => kim > 70 ? 'focus' : kim > 40 ? 'normal' : 'tired';
    const log     = (...args) => { if (CFG.debug) console.log('[CogneeAI SDK]', ...args); };

    // ─── КЭШ ──────────────────────────────────────────────────────────────────
    const Cache = {
        key : text => CACHE_PREFIX + btoa(encodeURIComponent(text.slice(0, 80))).slice(0, 40),
        get : text => {
            try { return JSON.parse(localStorage.getItem(Cache.key(text))); } catch { return null; }
        },
        set : (text, data) => {
            try { localStorage.setItem(Cache.key(text), JSON.stringify(data)); } catch {}
        },
    };

    // ─── ONNX RUNTIME ─────────────────────────────────────────────────────────
    let onnxSession      = null;
    let modelLoadSuccess = false;
    let lastProbabilities = null;

    async function loadONNXRuntime() {
        if (typeof ort !== 'undefined') return true;
        return new Promise(resolve => {
            const s = document.createElement('script');
            s.src = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.18.0/dist/ort.min.js';
            s.onload  = () => resolve(true);
            s.onerror = () => resolve(false);
            document.head.appendChild(s);
        });
    }

    async function tryLoadModel() {
        if (!CFG.modelUrl) { log('data-model не задан → эвристика'); return; }
        const ok = await loadONNXRuntime();
        if (!ok) { log('ONNX Runtime не загрузился → эвристика'); return; }
        try {
            ort.env.wasm.numThreads = 1; // совместимость с GitHub Pages
            onnxSession      = await ort.InferenceSession.create(CFG.modelUrl);
            modelLoadSuccess = true;
            log(`Модель загружена: ${CFG.modelUrl}`);
        } catch (e) {
            log('Ошибка загрузки модели:', e.message, '→ эвристика');
        }
    }

    // ─── СЕНСОРЫ ──────────────────────────────────────────────────────────────
    let scrollScore          = 70;
    let clickScore           = 70;
    let returnScore          = 80;
    let smoothedKIM          = 70;
    let lastKIM              = null;
    let sessionStart         = Date.now();
    let consecutiveRereads   = 0;
    let idleBursts           = 0;
    let lastActivityTime     = Date.now();
    let recentClickPause     = 300;
    let returnEventsInWindow = 0;
    let lastReturnCleanup    = Date.now();

    // Сенсоры f8–f15
    let dwellWithoutProgressMs = 0;
    let lastForwardScrollTime  = Date.now();
    let microScrollCount       = 0;
    let lastMicroScrollReset   = Date.now();
    const paragraphVisits      = new Map();
    let paragraphRereadsTotal  = 0;
    let paragraphsTracked      = 0;
    let directionChangeCount   = 0;
    let lastScrollDirection    = 'none';
    let directionWindowReset   = Date.now();
    const speedSamples         = [];
    const interactionTimes     = [];
    let isTouchDevice = (('ontouchstart' in window) || navigator.maxTouchPoints > 0) ? 1.0 : 0.0;
    let viewportLockSec        = 0;
    let viewportLockStart      = Date.now();
    let lastViewportY          = window.scrollY;

    // Скролл
    let lastScrollY    = window.scrollY;
    let lastScrollTime = Date.now();
    const scrollIntervals = [];

    function onScroll() {
        const now   = Date.now();
        const dy    = window.scrollY - lastScrollY;
        const dt    = now - lastScrollTime;

        // f0–f1: скоростные паттерны
        if (dt > 0 && dt < 2000) {
            scrollIntervals.push(dt);
            if (scrollIntervals.length > 30) scrollIntervals.shift();
        }
        if (Math.abs(dy) > 5) {
            const dir = dy > 0 ? 'down' : 'up';
            if (dir !== lastScrollDirection && lastScrollDirection !== 'none') {
                directionChangeCount++;
            }
            lastScrollDirection = dir;
            lastForwardScrollTime = now;
            dwellWithoutProgressMs = 0;

            // f9: микро-скролл
            if (Math.abs(dy) < 20) microScrollCount++;
        }

        // f3: возвраты вверх
        if (dy < -window.innerHeight * 0.3) {
            returnEventsInWindow++;
            consecutiveRereads++;
            returnScore = clamp(returnScore - 8, 0, 100);
        }
        if (now - lastReturnCleanup > 30000) {
            returnEventsInWindow = 0;
            lastReturnCleanup    = now;
        }
        // f11: сброс окна направлений раз в 30 сек
        if (now - directionWindowReset > 30000) {
            directionChangeCount = 0;
            directionWindowReset = now;
        }

        scrollScore = clamp(
            60 + (scrollIntervals.length ? Math.min(20, scrollIntervals.reduce((a, b) => a + b, 0) / scrollIntervals.length / 50) : 0),
            0, 100
        );

        lastScrollY    = window.scrollY;
        lastScrollTime = now;
        lastActivityTime = now;
    }

    function onMouseMove() { lastActivityTime = Date.now(); }

    function onMouseEnter(e) { e._enterTime = Date.now(); }

    function onMouseLeave() {}

    function onClick(e) {
        const now    = Date.now();
        const tgt    = e.target;
        const enter  = tgt._enterTime || now;
        const pause  = now - enter;
        recentClickPause = clamp(pause, 0, 3000);
        clickScore = clamp(100 - pause / 30, 30, 100);
        interactionTimes.push(now);
        if (interactionTimes.length > 20) interactionTimes.shift();
        lastActivityTime = now;
    }

    // Прикрепляем глобальные сенсоры
    document.addEventListener('scroll',     onScroll,    { passive: true });
    document.addEventListener('mousemove',  onMouseMove, { passive: true });
    document.addEventListener('click',      onClick,     { passive: true });
    document.querySelectorAll('a, button, [role="button"]').forEach(el => {
        el.addEventListener('mouseenter', onMouseEnter, { passive: true });
    });

    // f8: dwell without progress (каждую секунду)
    setInterval(() => {
        const now = Date.now();
        if (now - lastForwardScrollTime > 1000) dwellWithoutProgressMs += 1000;
        // f15: viewport lock
        if (Math.abs(window.scrollY - lastViewportY) < 10) {
            viewportLockSec += 1;
        } else {
            viewportLockSec = 0;
        }
        lastViewportY = window.scrollY;
        // f9: сброс микро-скроллов раз в 30 сек
        if (now - lastMicroScrollReset > 30000) {
            microScrollCount = 0;
            lastMicroScrollReset = now;
        }
        // Idle burst
        if (now - lastActivityTime > 10000) {
            idleBursts = clamp(idleBursts + 0.5, 0, 10);
        }
    }, 1000);

    // Восстановление счётчиков
    setInterval(() => {
        returnScore        = clamp(returnScore + 1, 0, 100);
        consecutiveRereads = clamp(consecutiveRereads - 0.1, 0, 20);
        idleBursts         = clamp(idleBursts - 0.2, 0, 10);
    }, 5000);

    // ─── ХРОНОБИОЛОГИЧЕСКИЙ БОНУС ─────────────────────────────────────────────
    function getChronoBonus() {
        const h = new Date().getHours();
        if (h >= 9  && h <= 11) return 8;
        if (h >= 14 && h <= 16) return 5;
        if (h >= 20 || h <= 6)  return -12;
        return 0;
    }

    // ─── ВСПОМОГАТЕЛЬНЫЕ ВЫЧИСЛЕНИЯ ───────────────────────────────────────────
    function computeReadingSpeedVariance() {
        if (speedSamples.length < 3) return 0;
        const mean = speedSamples.reduce((a, b) => a + b, 0) / speedSamples.length;
        const variance = speedSamples.reduce((s, x) => s + (x - mean) ** 2, 0) / speedSamples.length;
        return Math.sqrt(variance);
    }

    function computeInteractionGap() {
        if (interactionTimes.length < 2) return 0;
        const gaps = [];
        for (let i = 1; i < interactionTimes.length; i++) {
            gaps.push(interactionTimes[i] - interactionTimes[i - 1]);
        }
        return gaps.reduce((a, b) => a + b, 0) / gaps.length;
    }

    // ─── ВЕКТОР ПРИЗНАКОВ (16) ────────────────────────────────────────────────
    function buildFeatureVector() {
        const avgInterval = scrollIntervals.length
            ? scrollIntervals.reduce((a, b) => a + b, 0) / scrollIntervals.length : 500;
        const variance = scrollIntervals.length > 1
            ? (() => {
                const m = avgInterval;
                return scrollIntervals.reduce((s, x) => s + (x - m) ** 2, 0) / scrollIntervals.length;
              })()
            : 100;

        const sessionNorm = clamp((Date.now() - sessionStart) / 3600000, 0, 1);
        const hourNorm    = new Date().getHours() / 24;

        const f0  = clamp(avgInterval / 500, 0, 1);
        const f1  = clamp(Math.sqrt(variance) / 200, 0, 1);
        const f2  = clamp(recentClickPause / 1000, 0, 1);
        const f3  = clamp(returnEventsInWindow / 10, 0, 1);
        const f4  = sessionNorm;
        const f5  = hourNorm;
        const f6  = clamp(consecutiveRereads / 5, 0, 1);
        const f7  = clamp(idleBursts / 5, 0, 1);
        const f8  = clamp(dwellWithoutProgressMs / 60000, 0, 1);
        const f9  = clamp(microScrollCount / 20, 0, 1);
        const f10 = paragraphsTracked > 0
            ? clamp(paragraphRereadsTotal / paragraphsTracked, 0, 1) : 0;
        const f11 = clamp(directionChangeCount / 15, 0, 1);
        const f12 = clamp(computeReadingSpeedVariance() / 2, 0, 1);
        const f13 = clamp(computeInteractionGap() / 30000, 0, 1);
        const f14 = isTouchDevice;
        const f15 = clamp(viewportLockSec / 120, 0, 1);

        return [f0, f1, f2, f3, f4, f5, f6, f7, f8, f9, f10, f11, f12, f13, f14, f15];
    }

    // ─── ONNX ИНФЕРЕНС ────────────────────────────────────────────────────────
    async function computeKIMNeural() {
        if (!onnxSession) return null;
        try {
            const features = buildFeatureVector();
            const tensor   = new ort.Tensor('float32', Float32Array.from(features), [1, 1, FEATURE_SIZE]);
            const results  = await onnxSession.run({ [onnxSession.inputNames[0]]: tensor });
            const proba    = Array.from(results[onnxSession.outputNames[0]].data);

            lastProbabilities = {
                flow: +proba[0].toFixed(4), normal: +proba[1].toFixed(4),
                tired: +proba[2].toFixed(4), distracted: +proba[3].toFixed(4), overload: +proba[4].toFixed(4),
            };
            log('Вероятности:', lastProbabilities);

            return proba[0] * 95 + proba[1] * 65 + proba[2] * 25 + proba[3] * 35 + proba[4] * 10;
        } catch (e) {
            log('Ошибка инференса:', e.message);
            return null;
        }
    }

    // ─── ЭВРИСТИКА (fallback) ─────────────────────────────────────────────────
    function computeKIMHeuristic() {
        return clamp(
            scrollScore * 0.4 + clickScore * 0.3 + returnScore * 0.3 + getChronoBonus(),
            0, 100
        );
    }

    // ─── GEMINI AI (упрощение + ключевые слова) ───────────────────────────────
    async function callGeminiProxy(prompt) {
        if (!CFG.proxyUrl) return null;
        try {
            const resp = await fetch(CFG.proxyUrl, {
                method : 'POST',
                headers: { 'Content-Type': 'application/json' },
                body   : JSON.stringify({ prompt }),
            });
            if (!resp.ok) return null;
            const data = await resp.json();
            return data.result || data.text || null;
        } catch { return null; }
    }

    async function simplifyParagraph(text) {
        const cached = Cache.get('simp_' + text);
        if (cached) return cached;

        const prompt =
            `Упрости следующий абзац: сохрани главную мысль, убери сложные термины, ` +
            `сделай предложения короткими. Ответь ТОЛЬКО упрощённым текстом, без предисловий.\n\n${text}`;

        const result = await callGeminiProxy(prompt);
        if (result) {
            Cache.set('simp_' + text, result);
            return result;
        }
        // Fallback: первые 2 предложения
        const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];
        return sentences.slice(0, 2).join(' ').trim();
    }

    async function extractKeywords(text) {
        const cached = Cache.get('kw_' + text);
        if (cached) return cached;

        const prompt =
            `Выдели 3–5 ключевых слов из абзаца. ` +
            `Ответь ТОЛЬКО массивом JSON, без markdown, например: ["слово1","слово2"]\n\n${text}`;

        const result = await callGeminiProxy(prompt);
        if (result) {
            try {
                const kw = JSON.parse(result.replace(/```json|```/g, '').trim());
                Cache.set('kw_' + text, kw);
                return kw;
            } catch {}
        }
        // Fallback: слова длиннее 6 символов
        const words = [...new Set(text.split(/\s+/).filter(w => w.length > 6).slice(0, 5))];
        return words;
    }

    // ─── ИНЪЕКЦИЯ СТИЛЕЙ (изолированные) ─────────────────────────────────────
    function injectStyles() {
        if (document.getElementById('cogneeai-styles')) return;
        const style = document.createElement('style');
        style.id = 'cogneeai-styles';
        style.textContent = `
/* CogneeAI SDK v8.4 — изолированные стили */
.cognee-block {
    position: relative;
    transition: opacity 0.4s ease;
}
.cognee-block .cognee-simple {
    display: none;
}
.cognee-block .cognee-keyword {
    background: rgba(255, 213, 79, 0.35);
    border-radius: 2px;
    padding: 0 2px;
    transition: background 0.3s;
}
.cognee-block[data-cognee-mode="tired"] .cognee-full {
    display: none;
}
.cognee-block[data-cognee-mode="tired"] .cognee-simple {
    display: block;
    opacity: 1;
    animation: cognee-fadein 0.5s ease;
}
.cognee-block[data-cognee-mode="tired"] .cognee-ai-loading {
    display: block;
}
.cognee-ai-loading {
    display: none;
    font-size: 0.8em;
    color: #888;
    padding: 4px 0;
    font-style: italic;
}
@keyframes cognee-fadein {
    from { opacity: 0; transform: translateY(4px); }
    to   { opacity: 1; transform: translateY(0); }
}

/* ── Плавающий индикатор КИМ ─────────────────────────────────────── */
#cogneeai-badge {
    position: fixed;
    right: 20px;
    bottom: 80px;
    z-index: 2147483647;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    font-size: 12px;
    line-height: 1;
    padding: 8px 14px;
    border-radius: 20px;
    border-left: 3px solid #4FC3F7;
    cursor: pointer;
    user-select: none;
    transition: border-color 0.5s, background 0.5s, opacity 0.3s;
    white-space: nowrap;
    box-shadow: 0 2px 12px rgba(0,0,0,0.18);
}
#cogneeai-badge.theme-dark,
#cogneeai-badge.theme-auto-dark {
    background: rgba(22, 22, 30, 0.92);
    color: #e0e0e0;
}
#cogneeai-badge.theme-light,
#cogneeai-badge.theme-auto-light {
    background: rgba(255, 255, 255, 0.94);
    color: #333;
}
#cogneeai-badge:hover {
    opacity: 0.85;
}
#cogneeai-badge.zone-focus  { border-left-color: #4FC3F7; }
#cogneeai-badge.zone-normal { border-left-color: #81C784; }
#cogneeai-badge.zone-tired  { border-left-color: #FFB74D; }
        `;
        document.head.appendChild(style);
    }

    // ─── ПЛАВАЮЩИЙ ИНДИКАТОР ──────────────────────────────────────────────────
    let badge = null;

    function createBadge() {
        badge = document.createElement('div');
        badge.id = 'cogneeai-badge';
        badge.title = T.powered;
        badge.addEventListener('click', () => {
            badge.style.opacity = badge.style.opacity === '0.3' ? '1' : '0.3';
        });
        updateBadgeTheme();
        document.body.appendChild(badge);
        updateBadge(smoothedKIM);
    }

    function updateBadgeTheme() {
        if (!badge) return;
        badge.className = 'zone-' + getZone(smoothedKIM);
        if (CFG.theme === 'dark') {
            badge.classList.add('theme-dark');
        } else if (CFG.theme === 'light') {
            badge.classList.add('theme-light');
        } else {
            // auto
            const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
            badge.classList.add(dark ? 'theme-auto-dark' : 'theme-auto-light');
        }
    }

    function updateBadge(kim) {
        if (!badge) return;
        const zone  = getZone(kim);
        const label = T[zone];
        const icon  = modelLoadSuccess ? T.neural : T.heuristic;
        badge.className = `zone-${zone}`;
        updateBadgeTheme();
        badge.textContent = `${T.badge} · КИМ: ${Math.round(kim)} · ${label} ${icon}`;
    }

    // ─── ОБРАБОТКА АБЗАЦЕВ ────────────────────────────────────────────────────
    const managedBlocks = [];
    const processedEls  = new WeakSet();

    function wrapParagraphs() {
        const paras = document.querySelectorAll('p');
        paras.forEach((p, idx) => {
            if (processedEls.has(p)) return;
            if (p.textContent.trim().length < CFG.minLen) return;
            processedEls.add(p);

            const originalText = p.innerHTML;

            // Создаём обёртку
            const block = document.createElement('div');
            block.className = 'cognee-block';
            block.dataset.cogneeIdx = idx;

            // Версия full
            const full = document.createElement('p');
            full.className = 'cognee-full';
            full.innerHTML  = originalText;
            // Копируем атрибуты оригинального <p>
            for (const attr of p.attributes) {
                if (attr.name !== 'class') full.setAttribute(attr.name, attr.value);
            }
            if (p.className) full.className += ' ' + p.className;

            // Версия simple (пустая до получения от AI)
            const simple = document.createElement('p');
            simple.className = 'cognee-simple';

            // Лоадер
            const loader = document.createElement('div');
            loader.className = 'cognee-ai-loading';
            loader.textContent = T.aiLoading;

            block.appendChild(full);
            block.appendChild(simple);
            block.appendChild(loader);

            p.replaceWith(block);
            managedBlocks.push({ block, full, simple, text: p.textContent.trim() });
        });

        log(`Обёрнуто абзацев: ${managedBlocks.length}`);
        setupParagraphObserver();
    }

    function setupParagraphObserver() {
        if (!('IntersectionObserver' in window)) return;
        const obs = new IntersectionObserver(entries => {
            entries.forEach(entry => {
                const idx = parseInt(entry.target.dataset.cogneeIdx, 10);
                if (isNaN(idx) || idx === -1) return;
                const blockObj = managedBlocks.find(b => parseInt(b.block.dataset.cogneeIdx, 10) === idx);
                if (!blockObj) return;

                const key    = 'obs_' + idx;
                const visits = (paragraphVisits.get(key) || 0) + (entry.isIntersecting ? 1 : 0);
                if (entry.isIntersecting) {
                    paragraphVisits.set(key, visits);
                    paragraphsTracked = Math.max(paragraphsTracked, idx + 1);
                    if (visits === 2) paragraphRereadsTotal++;
                }
            });
        }, { threshold: 0.5 });

        managedBlocks.forEach(({ block }) => obs.observe(block));
    }

    // ─── ПРИМЕНЕНИЕ РЕЖИМА К БЛОКАМ ───────────────────────────────────────────
    const LOWER_THIRD = () => window.innerHeight * (2 / 3);
    const fixedBlocks = new WeakMap();

    function applyModeToBlock(blockObj, mode) {
        const { block } = blockObj;
        const current   = block.dataset.cogneeMode;
        if (current === mode) return;
        block.dataset.cogneeMode = mode;
    }

    function applyAdaptation(mode) {
        const atTop      = window.scrollY < 100;
        const lowerBound = LOWER_THIRD();

        managedBlocks.forEach(blockObj => {
            const { block } = blockObj;
            const rect = block.getBoundingClientRect();

            if (atTop) {
                fixedBlocks.delete(block);
                applyModeToBlock(blockObj, mode);
                return;
            }

            if (rect.top < lowerBound) {
                if (!fixedBlocks.has(block)) {
                    fixedBlocks.set(block, true);
                    applyModeToBlock(blockObj, mode);
                }
            } else {
                fixedBlocks.delete(block);
                applyModeToBlock(blockObj, mode);
            }
        });

        // При режиме tired — инициируем упрощение тех блоков, где ещё нет simple
        if (mode === 'tired') {
            triggerSimplification();
        }
        // При normal/tired — инициируем подсветку ключевых слов
        if (mode === 'normal' || mode === 'tired') {
            triggerKeywords();
        }
    }

    // ─── ОБНОВЛЕНИЕ ПРИ СКРОЛЛЕ ───────────────────────────────────────────────
    document.addEventListener('scroll', () => {
        if (lastKIM !== null) {
            const mode = getZone(smoothedKIM);
            const lowerBound = LOWER_THIRD();
            managedBlocks.forEach(blockObj => {
                const { block } = blockObj;
                const rect = block.getBoundingClientRect();
                if (rect.top >= lowerBound) {
                    fixedBlocks.delete(block);
                    applyModeToBlock(blockObj, mode);
                }
            });
        }
    }, { passive: true });

    // ─── AI УПРОЩЕНИЕ ─────────────────────────────────────────────────────────
    let simplificationInProgress = false;

    async function triggerSimplification() {
        if (simplificationInProgress) return;
        simplificationInProgress = true;

        const toProcess = managedBlocks.filter(b => !b.simple.textContent.trim());
        for (const blockObj of toProcess) {
            const { simple, text, block } = blockObj;
            if (simple.textContent.trim()) continue;

            const loader = block.querySelector('.cognee-ai-loading');
            if (loader) loader.style.display = 'block';

            const result = await simplifyParagraph(text);

            simple.textContent = result;
            if (loader) loader.style.display = 'none';
            log('Упрощён абзац:', text.slice(0, 40) + '…');
        }

        simplificationInProgress = false;
    }

    // ─── AI КЛЮЧЕВЫЕ СЛОВА ────────────────────────────────────────────────────
    const keywordsDoneBlocks = new WeakSet();

    async function triggerKeywords() {
        for (const blockObj of managedBlocks) {
            const { full, text, block } = blockObj;
            if (keywordsDoneBlocks.has(block)) continue;
            keywordsDoneBlocks.add(block);

            const kw = await extractKeywords(text);
            if (!kw || !kw.length) continue;

            let html = full.innerHTML;
            kw.forEach(word => {
                const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const regex   = new RegExp(`\\b(${escaped})\\b`, 'gi');
                html = html.replace(regex, '<mark class="cognee-keyword">$1</mark>');
            });
            full.innerHTML = html;
        }
    }

    // ─── ГЛАВНЫЙ ЦИКЛ КИМ ─────────────────────────────────────────────────────
    const updateKIM = async () => {
        let rawKIM, alpha;

        if (modelLoadSuccess && onnxSession) {
            const neuralKIM = await computeKIMNeural();
            if (typeof neuralKIM === 'number' && !isNaN(neuralKIM)) {
                rawKIM = neuralKIM;
                alpha  = SMOOTH_ALPHA_NEURAL;
            } else {
                rawKIM = computeKIMHeuristic();
                alpha  = SMOOTH_ALPHA_HEURISTIC;
            }
        } else {
            rawKIM = computeKIMHeuristic();
            alpha  = SMOOTH_ALPHA_HEURISTIC;
        }

        const prevKIM = smoothedKIM;
        smoothedKIM   = clamp(alpha * rawKIM + (1 - alpha) * smoothedKIM, 0, 100);
        window.__cogneeCurrentKIM = smoothedKIM;

        const zone = getZone(smoothedKIM);
        updateBadge(smoothedKIM);

        const crossed = Math.floor(prevKIM / 30) !== Math.floor(smoothedKIM / 30);
        if (Math.abs(smoothedKIM - (lastKIM || 70)) >= KIM_CHANGE_THRESHOLD || lastKIM === null || crossed) {
            lastKIM = smoothedKIM;
            applyAdaptation(zone);

            // Публичное событие для разработчиков сайта-хоста
            window.dispatchEvent(new CustomEvent('cogneeai:kim', {
                detail: {
                    kim      : Math.round(smoothedKIM),
                    zone,
                    features : buildFeatureVector(),
                    proba    : lastProbabilities,
                    neural   : modelLoadSuccess,
                },
            }));
        }

        log(`КИМ: ${Math.round(smoothedKIM)} (${zone}) | neural: ${modelLoadSuccess}`);
    };

    setInterval(updateKIM, UPDATE_INTERVAL_MS);

    // ─── ИНИЦИАЛИЗАЦИЯ ────────────────────────────────────────────────────────
    function init() {
        log(`CogneeAI SDK v${SDK_VERSION} инициализация...`);
        injectStyles();

        const doStart = () => {
            wrapParagraphs();
            createBadge();
            tryLoadModel().then(() => {
                updateKIM();
            });
            log('Готово.');
        };

        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', doStart);
        } else {
            doStart();
        }

        // Подстройка темы при системном переключении
        window.matchMedia('(prefers-color-scheme: dark)')
            .addEventListener('change', updateBadgeTheme);
    }

    init();

    // ─── ПУБЛИЧНОЕ API ────────────────────────────────────────────────────────
    window.CogneeAI = {
        version : SDK_VERSION,

        /** Текущий КИМ (0–100) */
        getKIM  : () => Math.round(smoothedKIM),

        /** Текущая зона: 'focus' | 'normal' | 'tired' */
        getZone : () => getZone(smoothedKIM),

        /** Последние вероятности классов от нейросети */
        getProba : () => lastProbabilities,

        /** Вектор 16 признаков */
        getFeatures : () => buildFeatureVector(),

        /** Принудительно пересчитать КИМ */
        update  : updateKIM,

        /** Принудительно применить режим */
        setMode : (zone) => applyAdaptation(zone),

        /** Показать/скрыть индикатор */
        showBadge : () => { if (badge) badge.style.display = ''; },
        hideBadge : () => { if (badge) badge.style.display = 'none'; },

        /** Очистить кэш AI */
        clearCache : () => {
            Object.keys(localStorage).forEach(k => {
                if (k.startsWith(CACHE_PREFIX)) localStorage.removeItem(k);
            });
        },
    };

})();
