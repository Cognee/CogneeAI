// sensor.js — v8.3.1
// Файл: sensor.js | Глобальная версия: 8.3.1
// Исправления v8.3.1:
//   - БАГ #1: добавлен прямой вызов window.applyAdaptation(smoothedKIM) после dispatchEvent
//     Ранее sensor.js только диспатчил 'cognee:kim', но adapter.js его не слушал —
//     адаптация не срабатывала автоматически.

(function () {
    if (window.__sensorsInitialized) return;
    window.__sensorsInitialized = true;

    // ─── КОНСТАНТЫ ────────────────────────────────────────────────────────────
    const SMOOTH_ALPHA_NEURAL    = 0.25;
    const SMOOTH_ALPHA_HEURISTIC = 0.35;
    const KIM_CHANGE_THRESHOLD   = 8;
    const UPDATE_INTERVAL_MS     = 20000;
    const MODEL_PATH             = 'model/cognee_ai.onnx';
    const FEATURE_SIZE           = 16;

    // ─── БАЗОВЫЕ СЧЁТЧИКИ ─────────────────────────────────────────────────────
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
    const returnEvents       = [];

    // ─── НОВЫЕ СЕНСОРЫ (признаки 8–15) ───────────────────────────────────────

    let dwellWithoutProgressMs = 0;
    let lastForwardScrollTime  = Date.now();

    let microScrollCount     = 0;
    let lastMicroScrollReset = Date.now();

    const paragraphVisits    = new Map();
    let paragraphRereadsTotal = 0;
    let paragraphsTracked    = 0;

    let directionChangeCount  = 0;
    let lastScrollDirection   = 'none';
    let directionWindowReset  = Date.now();

    const speedSamples = [];
    const interactionTimes = [];

    let isTouchDevice = (('ontouchstart' in window) || (navigator.maxTouchPoints > 0)) ? 1.0 : 0.0;

    let viewportLockSec   = 0;
    let viewportLockStart = Date.now();
    let lastViewportY     = window.scrollY;

    // ─── СОСТОЯНИЕ ONNX ───────────────────────────────────────────────────────
    let onnxSession        = null;
    let modelLoadSuccess   = false;
    let lastProbabilities  = null;
    let inferenceCount     = 0;
    let inferenceTimeTotal = 0;

    const clamp   = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
    const getZone = kim => kim > 70 ? 'focus' : kim >= 40 ? 'normal' : 'tired';

    window.currentKIM = 70;

    // ─── ПУБЛИЧНЫЙ API ────────────────────────────────────────────────────────
    const FEATURE_NAMES = [
        'scroll_avg_interval', 'scroll_variance', 'click_pause_avg',
        'return_scroll_count', 'session_duration_norm', 'hour_norm',
        'consecutive_rereads', 'idle_bursts',
        'dwell_without_progress', 'micro_scroll_corrections',
        'paragraph_reread_rate', 'scroll_direction_changes',
        'reading_speed_variance', 'interaction_gap',
        'touch_input', 'viewport_lock_duration',
    ];

    window.CogneeSensorState = {
        get scrollScore()        { return scrollScore; },
        get clickScore()         { return clickScore; },
        get returnScore()        { return returnScore; },
        get consecutiveRereads() { return consecutiveRereads; },
        get idleBursts()         { return idleBursts; },
        get smoothedKIM()        { return smoothedKIM; },
        get modelLoaded()        { return modelLoadSuccess; },
        get usingNeural()        { return modelLoadSuccess; },
        get lastProbabilities()  { return lastProbabilities; },
        get isTouchDevice()      { return isTouchDevice === 1.0; },
        get avgInferenceMs() {
            return inferenceCount > 0 ? Math.round(inferenceTimeTotal / inferenceCount) : null;
        },
    };

    window.CogneeNeural = {
        get loaded()        { return modelLoadSuccess; },
        get probabilities() { return lastProbabilities; },
        get inferenceMs()   { return window.CogneeSensorState.avgInferenceMs; },
        getFeatures()       { return buildFeatureVector(); },
        getFeatureNames()   { return FEATURE_NAMES; },
    };

    // ─── ХРОНОБИОЛОГИЧЕСКИЙ БОНУС ─────────────────────────────────────────────
    function getChronoBonus() {
        const h = new Date().getHours();
        if ((h >= 9 && h <= 11) || (h >= 17 && h <= 19)) return 8;
        if (h >= 13 && h <= 15) return -10;
        if (h >= 0  && h <= 5)  return -15;
        return 0;
    }

    // ─── ВСПОМОГАТЕЛЬНЫЕ ВЫЧИСЛЕНИЯ ───────────────────────────────────────────
    function computeScrollAvgInterval() {
        if (scrollTimestamps.length < 2) return 250;
        let sum = 0;
        for (let i = 1; i < scrollTimestamps.length; i++)
            sum += scrollTimestamps[i] - scrollTimestamps[i - 1];
        return sum / (scrollTimestamps.length - 1);
    }

    function computeScrollVariance() {
        if (scrollTimestamps.length < 3) return 10;
        const intervals = [];
        for (let i = 1; i < scrollTimestamps.length; i++)
            intervals.push(scrollTimestamps[i] - scrollTimestamps[i - 1]);
        const avg = intervals.reduce((s, v) => s + v, 0) / intervals.length;
        return Math.sqrt(intervals.reduce((s, v) => s + (v - avg) ** 2, 0) / intervals.length);
    }

    function computeReadingSpeedVariance() {
        if (speedSamples.length < 3) return 0;
        const avg = speedSamples.reduce((s, v) => s + v, 0) / speedSamples.length;
        if (avg === 0) return 0;
        const sigma = Math.sqrt(speedSamples.reduce((s, v) => s + (v - avg) ** 2, 0) / speedSamples.length);
        return sigma / avg;
    }

    function computeInteractionGap() {
        if (interactionTimes.length < 2) return 5000;
        let sum = 0;
        for (let i = 1; i < interactionTimes.length; i++)
            sum += interactionTimes[i] - interactionTimes[i - 1];
        return sum / (interactionTimes.length - 1);
    }

    function recordInteraction() {
        const now = Date.now();
        interactionTimes.push(now);
        if (interactionTimes.length > 10) interactionTimes.shift();
        lastActivityTime = now;
    }

    // ─── ВЕКТОР 16 ПРИЗНАКОВ ─────────────────────────────────────────────────
    function buildFeatureVector() {
        const f0  = clamp(computeScrollAvgInterval() / 500.0, 0, 1);
        const f1  = clamp(computeScrollVariance() / 200.0, 0, 1);
        const f2  = clamp(recentClickPause / 1000.0, 0, 1);
        const f3  = clamp(returnEventsInWindow / 10.0, 0, 1);
        const f4  = clamp((Date.now() - sessionStart) / (60 * 60 * 1000), 0, 1);
        const f5  = clamp(new Date().getHours() / 24.0, 0, 1);
        const f6  = clamp(consecutiveRereads / 5.0, 0, 1);
        const f7  = clamp(idleBursts / 5.0, 0, 1);
        const f8  = clamp(dwellWithoutProgressMs / 60000, 0, 1);
        const f9  = clamp(microScrollCount / 20.0, 0, 1);
        const f10 = paragraphsTracked > 0 ? clamp(paragraphRereadsTotal / paragraphsTracked, 0, 1) : 0;
        const f11 = clamp(directionChangeCount / 15.0, 0, 1);
        const f12 = clamp(computeReadingSpeedVariance() / 2.0, 0, 1);
        const f13 = clamp(computeInteractionGap() / 30000, 0, 1);
        const f14 = isTouchDevice;
        const f15 = clamp(viewportLockSec / 120.0, 0, 1);
        return [f0, f1, f2, f3, f4, f5, f6, f7, f8, f9, f10, f11, f12, f13, f14, f15];
    }

    // ─── ONNX ИНФЕРЕНС ────────────────────────────────────────────────────────
    async function computeKIMNeural() {
        if (!onnxSession) return null;
        try {
            const t0       = performance.now();
            const features = buildFeatureVector();

            const inputTensor = new ort.Tensor(
                'float32',
                Float32Array.from(features),
                [1, 1, FEATURE_SIZE]
            );

            const results = await onnxSession.run({ [onnxSession.inputNames[0]]: inputTensor });
            const proba   = Array.from(results[onnxSession.outputNames[0]].data);

            const elapsed = performance.now() - t0;
            inferenceCount++;
            inferenceTimeTotal += elapsed;

            lastProbabilities = {
                flow:       +proba[0].toFixed(4),
                normal:     +proba[1].toFixed(4),
                tired:      +proba[2].toFixed(4),
                distracted: +proba[3].toFixed(4),
                overload:   +proba[4].toFixed(4),
            };

            const kim = proba[0]*95 + proba[1]*65 + proba[2]*25 + proba[3]*35 + proba[4]*10;
            console.log(
                `[CogneeAI 🧠] flow:${(proba[0]*100).toFixed(1)}%` +
                ` normal:${(proba[1]*100).toFixed(1)}%` +
                ` tired:${(proba[2]*100).toFixed(1)}%` +
                ` distracted:${(proba[3]*100).toFixed(1)}%` +
                ` overload:${(proba[4]*100).toFixed(1)}%` +
                ` → КИМ:${kim.toFixed(1)} (${elapsed.toFixed(2)}мс)`
            );
            return kim;
        } catch (err) {
            console.warn('[CogneeAI] Ошибка инференса:', err.message);
            return null;
        }
    }

    // ─── ЭВРИСТИКА (fallback) ─────────────────────────────────────────────────
    function computeKIMHeuristic() {
        const dwellPenalty = clamp(dwellWithoutProgressMs / 60000, 0, 1) * 20;
        const lockPenalty  = clamp(viewportLockSec / 120, 0, 1) * 15;
        const microMalus   = clamp(microScrollCount / 20, 0, 1) * 10;
        const raw = (scrollScore * 0.35) + (clickScore * 0.25) + (returnScore * 0.25)
                  - dwellPenalty - lockPenalty - microMalus;
        return clamp(raw + getChronoBonus(), 0, 100);
    }

    // ─── UI: БЕЙДЖ ───────────────────────────────────────────────────────────
    function updateNeuralBadge(status) {
        let badge = document.getElementById('cognee-neural-badge');
        if (!badge) {
            badge = document.createElement('div');
            badge.id = 'cognee-neural-badge';
            badge.style.cssText = `
                position:fixed; top:10px; left:50%;
                transform:translateX(-50%);
                padding:4px 14px; border-radius:20px;
                font-size:11px; font-family:'Courier New',monospace;
                font-weight:600; z-index:9999; pointer-events:none;
                transition:opacity 0.6s ease, background 0.3s ease;
                letter-spacing:0.04em; white-space:nowrap;
            `;
            document.body.appendChild(badge);
        }
        if (status === 'loading') {
            badge.textContent = '⏳ Загружаю CogneeAI...';
            badge.style.cssText += 'background:#33333388;color:#aaa;border:1px solid #555;opacity:1;';
        } else if (status === 'ready') {
            badge.textContent = '🧠 CogneeAI активна';
            badge.style.cssText += 'background:#4FC3F722;color:#4FC3F7;border:1px solid #4FC3F755;opacity:1;';
            setTimeout(() => { badge.style.opacity = '0'; }, 5000);
        } else if (status === 'fallback') {
            badge.textContent = '⚙ Эвристика (нет модели)';
            badge.style.cssText += 'background:#FFB74D22;color:#FFB74D;border:1px solid #FFB74D55;opacity:1;';
            setTimeout(() => { badge.style.opacity = '0'; }, 4000);
        }
    }

    // ─── ЗАГРУЗКА ONNX ───────────────────────────────────────────────────────
    async function tryLoadModel() {
        updateNeuralBadge('loading');
        if (typeof ort === 'undefined') {
            console.warn('[CogneeAI] onnxruntime-web не найден → эвристика');
            updateNeuralBadge('fallback');
            return;
        }
        try {
            const t0  = performance.now();
            const url = new URL(MODEL_PATH, window.location.href).href;
            console.log('[CogneeAI] Загружаю ONNX:', url);

            ort.env.wasm.numThreads = 1;
            onnxSession = await ort.InferenceSession.create(url, {
                executionProviders: ['wasm'],
                graphOptimizationLevel: 'all',
            });

            console.log('[CogneeAI] Входы:', onnxSession.inputNames, '| Выходы:', onnxSession.outputNames);

            const dummy = new ort.Tensor('float32', new Float32Array(FEATURE_SIZE), [1, 1, FEATURE_SIZE]);
            await onnxSession.run({ [onnxSession.inputNames[0]]: dummy });

            modelLoadSuccess = true;
            console.log(`[CogneeAI] ✅ ONNX загружена за ${Math.round(performance.now() - t0)}мс`);
            updateNeuralBadge('ready');
        } catch (err) {
            onnxSession      = null;
            modelLoadSuccess = false;
            console.warn('[CogneeAI] Ошибка загрузки ONNX:', err.message, '→ эвристика');
            updateNeuralBadge('fallback');
        }
    }

    // ─── СЕНСОР 1 — Скролл ───────────────────────────────────────────────────
    const scrollTimestamps     = [];
    let prevScrollYForSpeed    = window.scrollY;
    let prevScrollTimeForSpeed = Date.now();

    window.addEventListener('scroll', () => {
        const now  = Date.now();
        const curY = window.scrollY;
        const dy   = curY - prevScrollYForSpeed;
        const dt   = now - prevScrollTimeForSpeed;

        scrollTimestamps.push(now);
        if (scrollTimestamps.length > 15) scrollTimestamps.shift();
        recordInteraction();

        if (dt > 0) {
            speedSamples.push(Math.abs(dy) / dt);
            if (speedSamples.length > 10) speedSamples.shift();
        }

        if (Math.abs(dy) >= 10 && Math.abs(dy) <= 120) microScrollCount++;

        const dir = dy > 5 ? 'down' : dy < -5 ? 'up' : lastScrollDirection;
        if (dir !== lastScrollDirection && lastScrollDirection !== 'none') directionChangeCount++;
        lastScrollDirection = dir;

        if (dy > 30) { lastForwardScrollTime = now; dwellWithoutProgressMs = 0; }

        if (Math.abs(curY - lastViewportY) > 5) {
            viewportLockSec   = 0;
            viewportLockStart = now;
            lastViewportY     = curY;
        }

        if (scrollTimestamps.length >= 2) {
            let sum = 0;
            for (let i = 1; i < scrollTimestamps.length; i++)
                sum += scrollTimestamps[i] - scrollTimestamps[i - 1];
            const avg = sum / (scrollTimestamps.length - 1);
            if (avg < 50)       scrollScore = clamp(scrollScore - 2, 0, 100);
            else if (avg > 200) scrollScore = clamp(scrollScore + 2, 0, 100);
        }

        prevScrollYForSpeed    = curY;
        prevScrollTimeForSpeed = now;
    }, { passive: true });

    // ─── СЕНСОР 2 — Клики и тачи ─────────────────────────────────────────────
    const mouseEnterTimes = new WeakMap();

    document.addEventListener('mouseover', e => {
        const el = e.target.closest('p, h2, h3');
        if (el) mouseEnterTimes.set(el, Date.now());
    });

    document.addEventListener('click', e => {
        recordInteraction();
        const el = e.target.closest('p, h2, h3');
        if (!el) return;
        const enterTime = mouseEnterTimes.get(el);
        if (!enterTime) return;
        const pause = Date.now() - enterTime;
        mouseEnterTimes.delete(el);
        recentClickPause = recentClickPause * 0.7 + pause * 0.3;
        if (pause > 800)                       clickScore = clamp(clickScore - 3, 0, 100);
        else if (pause >= 200 && pause <= 500) clickScore = clamp(clickScore + 1, 0, 100);
    });

    document.addEventListener('touchstart', () => { isTouchDevice = 1.0; recordInteraction(); }, { passive: true });
    document.addEventListener('touchend',   () => { recordInteraction(); }, { passive: true });
    document.addEventListener('keydown',    () => { isTouchDevice = 0.0; recordInteraction(); });

    // ─── СЕНСОР 3 — Возвраты и idle ──────────────────────────────────────────
    const yHistory    = [];
    let timeAtBottom  = null;
    let prevScrollDir = 'down';

    setInterval(() => {
        const now = Date.now();
        yHistory.push({ time: now, y: window.scrollY });
        while (yHistory.length > 0 && yHistory[0].time < now - 3000) yHistory.shift();

        if (yHistory.length >= 2) {
            const oldest = yHistory[0];
            const newest = yHistory[yHistory.length - 1];
            if (newest.y > oldest.y) {
                if (!timeAtBottom) timeAtBottom = now;
                prevScrollDir = 'down';
            } else if (newest.y < oldest.y - 100) {
                timeAtBottom = null;
                if (prevScrollDir === 'down') consecutiveRereads = clamp(consecutiveRereads + 1, 0, 20);
                prevScrollDir = 'up';
            }
            const delta      = oldest.y - window.scrollY;
            const longEnough = timeAtBottom && (now - timeAtBottom >= 3000);
            if (delta > 300 && longEnough) {
                returnScore = clamp(returnScore - 5, 0, 100);
                timeAtBottom = null;
                returnEvents.push({ time: now });
            }
        }

        if (now - lastReturnCleanup > 30000) {
            const cutoff = now - 5 * 60 * 1000;
            while (returnEvents.length > 0 && returnEvents[0].time < cutoff) returnEvents.shift();
            lastReturnCleanup = now;
        }
        returnEventsInWindow = returnEvents.length;

        const idleSec = (now - lastActivityTime) / 1000;
        if (idleSec > 45 && idleSec < 120) idleBursts = clamp(idleBursts + 0.5, 0, 10);
    }, 1000);

    // ─── СЕНСОР 4 — Dwell, viewport lock, сброс окон ─────────────────────────
    setInterval(() => {
        const now  = Date.now();
        const curY = window.scrollY;

        if (now - lastForwardScrollTime > 3000) dwellWithoutProgressMs = now - lastForwardScrollTime;
        if (Math.abs(curY - lastViewportY) <= 5) viewportLockSec = (now - viewportLockStart) / 1000;

        if (now - directionWindowReset > 30000) { directionChangeCount = 0; directionWindowReset = now; }
        if (now - lastMicroScrollReset > 60000) { microScrollCount = 0; lastMicroScrollReset = now; }
    }, 1000);

    // ─── СЕНСОР 5 — Paragraph reread (IntersectionObserver) ──────────────────
    document.addEventListener('DOMContentLoaded', () => {
        const blocks = document.querySelectorAll('.para-block');
        paragraphsTracked = blocks.length;
        if ('IntersectionObserver' in window) {
            const observer = new IntersectionObserver(entries => {
                entries.forEach(entry => {
                    if (!entry.isIntersecting) return;
                    const idx    = Array.from(blocks).indexOf(entry.target);
                    if (idx === -1) return;
                    const visits = (paragraphVisits.get(idx) || 0) + 1;
                    paragraphVisits.set(idx, visits);
                    if (visits === 2) paragraphRereadsTotal++;
                });
            }, { threshold: 0.5 });
            blocks.forEach(b => observer.observe(b));
        }
    });

    // ─── ВОССТАНОВЛЕНИЕ ───────────────────────────────────────────────────────
    setInterval(() => {
        returnScore        = clamp(returnScore + 1, 0, 100);
        consecutiveRereads = clamp(consecutiveRereads - 0.1, 0, 20);
        idleBursts         = clamp(idleBursts - 0.2, 0, 10);
    }, 5000);

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
        window.currentKIM = smoothedKIM;

        const zone = getZone(smoothedKIM);

        // Обновляем КИМ-дисплей
        const kimEl = document.getElementById('kim-display');
        if (kimEl) {
            const badge = modelLoadSuccess ? '🧠' : '⚙';
            const label = zone === 'focus' ? 'Фокус' : zone === 'normal' ? 'Норма' : 'Устал';
            kimEl.textContent = `КИМ: ${Math.round(smoothedKIM)} · ${label} ${badge}`;
            kimEl.style.borderLeftColor =
                zone === 'focus'  ? '#4FC3F7' :
                zone === 'normal' ? '#81C784' : '#FFB74D';
        }

        // Сохраняем в storage
        if (window.CogneeStorage) {
            window.CogneeStorage.saveKIM(smoothedKIM, zone);
        }

        // Синхронизируем с облаком раз в 20 циклов (~7 минут)
        if (window.CogneeSupabase && window.CogneeSupabase.isAuthenticated()) {
            if (!window._kimSyncCounter) window._kimSyncCounter = 0;
            window._kimSyncCounter++;
            if (window._kimSyncCounter % 20 === 0) {
                window.CogneeSupabase.saveKIMRemote(
                    smoothedKIM, zone, buildFeatureVector()
                ).catch(() => {});
            }
        }

        // ─── ИСПРАВЛЕНИЕ БАГ #1 ───────────────────────────────────────────────
        // Прямой вызов adapter.js при значимом изменении КИМ.
        // Ранее sensor.js только диспатчил событие, но adapter.js его не слушал.
        const hasSignificantChange = Math.abs(smoothedKIM - (lastKIM ?? 70)) >= KIM_CHANGE_THRESHOLD;
        const isFirstTick          = lastKIM === null;

        if (hasSignificantChange || isFirstTick) {
            lastKIM = smoothedKIM;

            // Диспатч события для внешних слушателей
            window.dispatchEvent(new CustomEvent('cognee:kim', {
                detail: { kim: smoothedKIM, zone, features: buildFeatureVector() }
            }));

            // Прямой вызов adapter.js (основной путь адаптации)
            if (typeof window.applyAdaptation === 'function') {
                window.applyAdaptation(smoothedKIM);
            }
        }

        // Analytics hook
        if (window.CogneeAnalytics) {
            window.CogneeAnalytics.sendEvent(smoothedKIM, zone);
        }
    };

    setInterval(updateKIM, UPDATE_INTERVAL_MS);
    updateKIM();
    tryLoadModel();

})();
