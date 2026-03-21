// sensor.js — v9.1
// Файл: sensor.js | Глобальная версия: 9.1
// Блок 2:
//   - Задача 2.1: детекция застревания на абзаце (>35 сек без скролла вперёд)
//     → диспатч события cognee:paragraph_struggle
//   - Задача 2.4: КИМ-снапшоты для умных закладок (window.CogneeBookmarks.snapshot)

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

    // Задача 2.1: порог застревания (мс)
    const STRUGGLE_THRESHOLD_MS  = 35000;

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

    // ─── ПРИЗНАК 0-1: scroll ──────────────────────────────────────────────────
    const scrollTimestamps      = [];
    let prevScrollYForSpeed     = window.scrollY;
    let prevScrollTimeForSpeed  = Date.now();

    // ─── ПРИЗНАК 8: paragraph_dwell ──────────────────────────────────────────
    let paragraphDwellSec     = 0;
    let lastForwardScrollTime = Date.now();

    // ─── ПРИЗНАК 9: scroll_direction_changes ─────────────────────────────────
    let directionChangeCount = 0;
    let lastScrollDirection  = 'none';
    let directionWindowReset = Date.now();

    // ─── ПРИЗНАК 10: viewport_revisit_count ──────────────────────────────────
    const paragraphVisits    = new Map();
    let viewportRevisitCount = 0;
    let paragraphsTracked    = 0;

    // ─── ПРИЗНАК 11: micro_pause_density ─────────────────────────────────────
    let microPauseCount      = 0;
    let totalMovementEvents  = 0;
    let microPauseWindowReset = Date.now();
    let lastMouseMoveTime    = Date.now();

    // ─── ПРИЗНАК 12-13: speed / mouse ────────────────────────────────────────
    const speedSamples       = [];
    const AVG_WORDS_PER_PX   = 0.05;
    const mouseVelocitySamples = [];
    let lastMouseX = 0, lastMouseY = 0, lastMouseTime = Date.now();

    // ─── ПРИЗНАК 14: focus_loss_count ────────────────────────────────────────
    let focusLossCount       = 0;

    // ─── ПРИЗНАК 15: touch_pressure ──────────────────────────────────────────
    let isTouchDevice = (('ontouchstart' in window) || (navigator.maxTouchPoints > 0)) ? 1.0 : 0.5;

    // ─── ONNX ─────────────────────────────────────────────────────────────────
    let onnxSession        = null;
    let modelLoadSuccess   = false;
    let lastProbabilities  = null;
    let inferenceCount     = 0;
    let inferenceTimeTotal = 0;

    const clamp   = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
    const getZone = kim => kim > 70 ? 'focus' : kim >= 40 ? 'normal' : 'tired';

    window.currentKIM = 70;

    // ─── ЗАДАЧА 2.1: Детекция застревания ────────────────────────────────────
    // Диспатчим событие если dwell > 35 сек и пользователь не скроллит
    let _lastStruggleDispatch    = 0;
    const STRUGGLE_COOLDOWN_MS   = 60000; // повторно не более раза в минуту

    function _detectStruggle() {
        const now = Date.now();
        if (paragraphDwellSec < STRUGGLE_THRESHOLD_MS / 1000) return;
        if (now - _lastStruggleDispatch < STRUGGLE_COOLDOWN_MS) return;

        // Находим активный абзац в центре viewport
        const blocks = document.querySelectorAll('.para-block');
        if (!blocks.length) return;

        const viewportCenter = window.innerHeight / 2;
        let closestBlock = null;
        let minDist = Infinity;

        blocks.forEach(block => {
            const rect = block.getBoundingClientRect();
            const blockCenter = rect.top + rect.height / 2;
            const dist = Math.abs(blockCenter - viewportCenter);
            if (dist < minDist && rect.top > -50 && rect.bottom < window.innerHeight + 50) {
                minDist = dist;
                closestBlock = block;
            }
        });

        if (!closestBlock) return;

        _lastStruggleDispatch = now;
        document.dispatchEvent(new CustomEvent('cognee:paragraph_struggle', {
            detail: { block: closestBlock, dwellSec: paragraphDwellSec }
        }));

        console.log('[CogneeAI sensor] Застревание на абзаце:', paragraphDwellSec.toFixed(1), 'сек');
    }

    // ─── ЗАДАЧА 2.4: КИМ-снапшот для умных закладок ──────────────────────────
    // Публичный API для bookmarks модуля в adapter.js
    window.CogneeBookmarks = {
        getKIMSnapshot() {
            return {
                kim:  Math.round(smoothedKIM),
                zone: getZone(smoothedKIM),
                ts:   Date.now(),
            };
        },
    };

    // ─── ПУБЛИЧНЫЙ API ────────────────────────────────────────────────────────
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
        get paragraphDwellSec()  { return paragraphDwellSec; },
    };

    window.CogneeNeural = {
        get loaded()        { return modelLoadSuccess; },
        get probabilities() { return lastProbabilities; },
        get inferenceMs()   { return window.CogneeSensorState.avgInferenceMs; },
        getFeatures()       { return buildFeatureVector(); },
    };

    // ─── ХРОНОБИОЛОГИЧЕСКИЙ БОНУС ─────────────────────────────────────────────
    function getChronoBonus() {
        const h = new Date().getHours();
        if ((h >= 9 && h <= 11) || (h >= 17 && h <= 19)) return 8;
        if (h >= 13 && h <= 15) return -10;
        if (h >= 0  && h <= 5)  return -15;
        return 0;
    }

    // ─── ВСПОМОГАТЕЛЬНЫЕ ─────────────────────────────────────────────────────
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
        return Math.sqrt(
            intervals.reduce((s, v) => s + (v - avg) ** 2, 0) / intervals.length
        );
    }

    function computeReadingSpeedWPM() {
        if (speedSamples.length < 2) return 200;
        const avgPxPerMs = speedSamples.reduce((s, v) => s + v, 0) / speedSamples.length;
        return clamp(avgPxPerMs * 60000 * AVG_WORDS_PER_PX, 0, 600);
    }

    function computeMouseVelocity() {
        if (mouseVelocitySamples.length < 2) return 200;
        return mouseVelocitySamples.reduce((s, v) => s + v, 0) / mouseVelocitySamples.length;
    }

    function computeMicroPauseDensity() {
        if (totalMovementEvents === 0) return 0;
        return clamp(microPauseCount / totalMovementEvents, 0, 1);
    }

    function recordInteraction() { lastActivityTime = Date.now(); }

    // ─── ВЕКТОР 16 ПРИЗНАКОВ ─────────────────────────────────────────────────
    function buildFeatureVector() {
        const f0  = clamp(computeScrollAvgInterval() / 500.0, 0, 1);
        const f1  = clamp(computeScrollVariance() / 200.0, 0, 1);
        const f2  = clamp(recentClickPause / 1000.0, 0, 1);
        const f3  = clamp(returnEventsInWindow / 10.0, 0, 1);
        const f4  = clamp((Date.now() - sessionStart) / 3600000, 0, 1);
        const f5  = clamp(new Date().getHours() / 24.0, 0, 1);
        const f6  = clamp(consecutiveRereads / 5.0, 0, 1);
        const f7  = clamp(idleBursts / 5.0, 0, 1);
        const f8  = clamp(paragraphDwellSec / 120.0, 0, 1);
        const f9  = clamp(directionChangeCount / 10.0, 0, 1);
        const f10 = clamp(viewportRevisitCount / 8.0, 0, 1);
        const f11 = computeMicroPauseDensity();
        const f12 = clamp(computeReadingSpeedWPM() / 400.0, 0, 1);
        const f13 = clamp(computeMouseVelocity() / 1000.0, 0, 1);
        const f14 = clamp(focusLossCount / 5.0, 0, 1);
        const f15 = isTouchDevice;
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
                [1, FEATURE_SIZE]
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
        const dwellPenalty    = clamp(paragraphDwellSec / 120, 0, 1) * 20;
        const dirPenalty      = clamp(directionChangeCount / 10, 0, 1) * 15;
        const revisitPenalty  = clamp(viewportRevisitCount / 8, 0, 1) * 15;
        const microPausPenalty = computeMicroPauseDensity() * 10;
        const raw = (scrollScore * 0.35) + (clickScore * 0.25) + (returnScore * 0.25)
                  - dwellPenalty - dirPenalty - revisitPenalty - microPausPenalty;
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
            ort.env.wasm.numThreads = 1;
            onnxSession = await ort.InferenceSession.create(url, {
                executionProviders: ['wasm'],
                graphOptimizationLevel: 'all',
            });
            const dummy = new ort.Tensor(
                'float32', new Float32Array(FEATURE_SIZE), [1, FEATURE_SIZE]
            );
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

        const dir = dy > 5 ? 'down' : dy < -5 ? 'up' : lastScrollDirection;
        if (dir !== lastScrollDirection && lastScrollDirection !== 'none') {
            directionChangeCount++;
        }
        lastScrollDirection = dir;

        if (dy > 30) {
            lastForwardScrollTime = now;
            paragraphDwellSec     = 0;
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

    // ─── СЕНСОР 2 — Клики ────────────────────────────────────────────────────
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

    // ─── СЕНСОР 3 — Тач ──────────────────────────────────────────────────────
    document.addEventListener('touchstart', () => { isTouchDevice = 1.0; recordInteraction(); }, { passive: true });
    document.addEventListener('touchend', () => { recordInteraction(); }, { passive: true });
    document.addEventListener('keydown',  () => { recordInteraction(); });

    // ─── СЕНСОР 4 — Движение мыши ─────────────────────────────────────────────
    document.addEventListener('mousemove', e => {
        const now = Date.now();
        const dx  = e.clientX - lastMouseX;
        const dy  = e.clientY - lastMouseY;
        const dt  = now - lastMouseTime;

        if (dt > 0 && dt < 500) {
            const velocity = Math.sqrt(dx*dx + dy*dy) / (dt / 1000);
            mouseVelocitySamples.push(velocity);
            if (mouseVelocitySamples.length > 15) mouseVelocitySamples.shift();

            totalMovementEvents++;
            if (dt < 200) microPauseCount++;
            if (totalMovementEvents > 100) {
                totalMovementEvents = Math.round(totalMovementEvents * 0.8);
                microPauseCount     = Math.round(microPauseCount * 0.8);
            }
        }

        lastMouseX    = e.clientX;
        lastMouseY    = e.clientY;
        lastMouseTime = now;
        recordInteraction();
    }, { passive: true });

    // ─── СЕНСОР 5 — Потеря фокуса ─────────────────────────────────────────────
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) focusLossCount = clamp(focusLossCount + 1, 0, 20);
    });
    window.addEventListener('blur', () => {
        focusLossCount = clamp(focusLossCount + 0.5, 0, 20);
    });

    // ─── СЕНСОР 6 — Возвраты скролла ──────────────────────────────────────────
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
                if (prevScrollDir === 'down')
                    consecutiveRereads = clamp(consecutiveRereads + 1, 0, 20);
                prevScrollDir = 'up';
            }
            const longEnough = timeAtBottom && (now - timeAtBottom >= 3000);
            if (oldest.y - window.scrollY > 300 && longEnough) {
                returnScore = clamp(returnScore - 5, 0, 100);
                timeAtBottom = null;
                returnEvents.push({ time: now });
            }
        }

        if (now - lastReturnCleanup > 30000) {
            const cutoff = now - 5 * 60 * 1000;
            while (returnEvents.length > 0 && returnEvents[0].time < cutoff)
                returnEvents.shift();
            lastReturnCleanup = now;
        }
        returnEventsInWindow = returnEvents.length;

        const idleSec = (now - lastActivityTime) / 1000;
        if (idleSec > 45 && idleSec < 120) idleBursts = clamp(idleBursts + 0.5, 0, 10);
    }, 1000);

    // ─── СЕНСОР 7 — Dwell и окна ──────────────────────────────────────────────
    setInterval(() => {
        const now = Date.now();

        if (now - lastForwardScrollTime > 3000) {
            paragraphDwellSec = (now - lastForwardScrollTime) / 1000;
        }

        if (now - directionWindowReset > 30000) {
            directionChangeCount = 0;
            directionWindowReset = now;
        }

        if (now - microPauseWindowReset > 30000) {
            microPauseCount      = Math.round(microPauseCount * 0.3);
            totalMovementEvents  = Math.round(totalMovementEvents * 0.3);
            microPauseWindowReset = now;
        }

        // Задача 2.1: проверяем застревание каждую секунду
        _detectStruggle();

    }, 1000);

    // ─── СЕНСОР 8 — Paragraph revisits ───────────────────────────────────────
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
                    if (visits >= 2) viewportRevisitCount++;
                });
            }, { threshold: 0.5 });
            blocks.forEach(b => observer.observe(b));
        }
    });

    // ─── ВОССТАНОВЛЕНИЕ ──────────────────────────────────────────────────────
    setInterval(() => {
        returnScore          = clamp(returnScore + 1, 0, 100);
        consecutiveRereads   = clamp(consecutiveRereads - 0.1, 0, 20);
        idleBursts           = clamp(idleBursts - 0.2, 0, 10);
        viewportRevisitCount = clamp(viewportRevisitCount - 0.05, 0, 50);
        focusLossCount       = clamp(focusLossCount - 0.02, 0, 20);
    }, 5000);

    // ─── ГЛАВНЫЙ ЦИКЛ КИМ ────────────────────────────────────────────────────
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

        const kimEl = document.getElementById('kim-display');
        if (kimEl) {
            const badge = modelLoadSuccess ? '🧠' : '⚙';
            const label = zone === 'focus' ? 'Фокус' : zone === 'normal' ? 'Норма' : 'Устал';
            kimEl.textContent = `КИМ: ${Math.round(smoothedKIM)} · ${label} ${badge}`;
            kimEl.style.borderLeftColor =
                zone === 'focus'  ? '#4FC3F7' :
                zone === 'normal' ? '#81C784' : '#FFB74D';
        }

        if (window.CogneeStorage) {
            window.CogneeStorage.saveKIM(smoothedKIM, zone);
        }

        if (window.CogneeSupabase && window.CogneeSupabase.isAuthenticated()) {
            if (!window._kimSyncCounter) window._kimSyncCounter = 0;
            window._kimSyncCounter++;
            if (window._kimSyncCounter % 20 === 0) {
                window.CogneeSupabase.saveKIMRemote(
                    smoothedKIM, zone, buildFeatureVector()
                ).catch(() => {});
            }
        }

        const hasSignificantChange = Math.abs(smoothedKIM - (lastKIM ?? 70)) >= KIM_CHANGE_THRESHOLD;
        const isFirstTick          = lastKIM === null;

        if (hasSignificantChange || isFirstTick) {
            lastKIM = smoothedKIM;

            window.dispatchEvent(new CustomEvent('cognee:kim', {
                detail: { kim: smoothedKIM, zone, features: buildFeatureVector() }
            }));

            if (typeof window.applyAdaptation === 'function') {
                window.applyAdaptation(smoothedKIM);
            }
        }

        if (window.CogneeAnalytics) {
            window.CogneeAnalytics.sendEvent(smoothedKIM, zone);
        }
    };

    setInterval(updateKIM, UPDATE_INTERVAL_MS);
    updateKIM();
    tryLoadModel();

})();
