// sensor.js — v7.2
// Файл: sensor.js | Глобальная версия: 7.2
// Изменения v7.2 (веса вынесены в отдельный файл):
//   - Веса модели перенесены в weights.js — sensor.js стал компактным
//   - weights.js подключается в index.html ДО sensor.js
//   - const W берётся из глобального скоупа weights.js

(function () {
    if (window.__sensorsInitialized) return;
    window.__sensorsInitialized = true;

    // ─── КОНСТАНТЫ ────────────────────────────────────────────────────────────
    const SMOOTH_ALPHA_NEURAL    = 0.25; // нейросеть — плавнее
    const SMOOTH_ALPHA_HEURISTIC = 0.35; // эвристика — быстрее
    const KIM_CHANGE_THRESHOLD   = 8;
    const UPDATE_INTERVAL_MS     = 20000;
    const MODEL_PATH             = 'model/model.json';

    // ─── СОСТОЯНИЕ СЧЁТЧИКОВ ──────────────────────────────────────────────────
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

    // ─── СОСТОЯНИЕ НЕЙРОСЕТИ ─────────────────────────────────────────────────
    let tfModel              = null;
    let modelLoadAttempted   = false;
    let modelLoadSuccess     = false;
    let lastProbabilities    = null;
    let inferenceCount       = 0;
    let inferenceTimeTotal   = 0;

    const clamp   = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
    const getZone = kim => kim > 70 ? 'focus' : kim >= 40 ? 'normal' : 'tired';

    window.currentKIM = 70;

    // ─── ПУБЛИЧНЫЙ API ДЛЯ ОТЛАДКИ И SDK ─────────────────────────────────────
    window.CogneeSensorState = {
        get scrollScore()         { return scrollScore; },
        get clickScore()          { return clickScore; },
        get returnScore()         { return returnScore; },
        get consecutiveRereads()  { return consecutiveRereads; },
        get idleBursts()          { return idleBursts; },
        get smoothedKIM()         { return smoothedKIM; },
        get modelLoaded()         { return modelLoadSuccess; },
        get usingNeural()         { return modelLoadSuccess; },
        get lastProbabilities()   { return lastProbabilities; },
        get avgInferenceMs() {
            return inferenceCount > 0
                ? Math.round(inferenceTimeTotal / inferenceCount)
                : null;
        },
    };

    // Публичный API нейросети
    window.CogneeNeural = {
        get loaded()        { return modelLoadSuccess; },
        get probabilities() { return lastProbabilities; },
        get inferenceMs()   { return window.CogneeSensorState.avgInferenceMs; },
        getFeatures()       { return buildFeatureVector(); },
    };

    // ─── ХРОНОБИОЛОГИЧЕСКИЙ БОНУС ────────────────────────────────────────────
    function getChronoBonus() {
        const h = new Date().getHours();
        if ((h >= 9 && h <= 11) || (h >= 17 && h <= 19)) return 8;
        if (h >= 13 && h <= 15) return -10;
        if (h >= 0  && h <= 5)  return -15;
        return 0;
    }

    // ─── ВЫЧИСЛЕНИЕ МЕТРИК ДЛЯ ПРИЗНАКОВ ─────────────────────────────────────
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
        const variance = intervals.reduce((s, v) => s + (v - avg) ** 2, 0) / intervals.length;
        return Math.sqrt(variance);
    }

    // ─── ВЕКТОР 8 ПРИЗНАКОВ (нормализация = датасет Colab) ───────────────────
    function buildFeatureVector() {
        const f0 = clamp(computeScrollAvgInterval() / 500.0, 0, 1);             // scroll_avg_interval
        const f1 = clamp(computeScrollVariance() / 200.0, 0, 1);               // scroll_variance
        const f2 = clamp(recentClickPause / 1000.0, 0, 1);                     // click_pause_avg
        const f3 = clamp(returnEventsInWindow / 10.0, 0, 1);                   // return_scroll_count
        const f4 = clamp((Date.now() - sessionStart) / (60 * 60 * 1000), 0, 1); // session_duration_norm
        const f5 = clamp(new Date().getHours() / 24.0, 0, 1);                  // hour_norm
        const f6 = clamp(consecutiveRereads / 5.0, 0, 1);                      // consecutive_rereads
        const f7 = clamp(idleBursts / 5.0, 0, 1);                              // idle_bursts
        return [f0, f1, f2, f3, f4, f5, f6, f7];
    }

    // Веса модели загружаются из weights.js (подключается в index.html до sensor.js)
    // const W определена глобально в weights.js


    // Вспомогательные матричные операции
    // dot(M, v): M имеет shape (in, out), v имеет shape (in) → результат shape (out)
    // Это x @ W в нотации numpy (вектор строка умножается на матрицу)
    function dot(M, v) {
        const out_size = M[0].length;
        const result   = new Array(out_size).fill(0);
        for (let i = 0; i < v.length; i++) {
            for (let j = 0; j < out_size; j++) {
                result[j] += v[i] * M[i][j];
            }
        }
        return result;
    }

    function addvec(a, b) { return a.map((x, i) => x + b[i]); }

    // ─── КИМ ЧЕРЕЗ ВСТРОЕННЫЙ ИНФЕРЕНС ───────────────────────────────────────
    function computeKIMNeural() {
        try {
            const t0 = performance.now();
            const x  = buildFeatureVector(); // [8]

            // 1. SimpleRNN: h = tanh(x @ W_x + h_prev @ W_h + b)
            //    W_x: (8,48), W_h: (48,48), b: (48,)
            //    h_prev = 0 (один временной шаг, stateless)
            const h0     = new Array(48).fill(0);
            const rnn_in = addvec(addvec(dot(W.rnn_Wx, x), dot(W.rnn_Wh, h0)), W.rnn_b);
            let h        = rnn_in.map(v => Math.tanh(v));

            // 2. BatchNorm (inference): (x - mean) / sqrt(var + eps) * gamma + beta
            const eps = 1e-3;
            h = h.map((v, i) => (v - W.bn_mean[i]) / Math.sqrt(W.bn_var[i] + eps) * W.bn_gamma[i] + W.bn_beta[i]);

            // 3. Dense(24) + ReLU
            let d1 = addvec(dot(W.d1_W, h), W.d1_b);
            d1 = d1.map(v => Math.max(0, v));

            // 4. Dense(5) + Softmax
            let logits = addvec(dot(W.d2_W, d1), W.d2_b);
            const maxL = Math.max(...logits);
            const exps = logits.map(v => Math.exp(v - maxL));
            const sumE = exps.reduce((s, v) => s + v, 0);
            const proba = exps.map(v => v / sumE);

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
                `[CogneeAI 🧠] ` +
                `flow:${(proba[0]*100).toFixed(1)}% ` +
                `normal:${(proba[1]*100).toFixed(1)}% ` +
                `tired:${(proba[2]*100).toFixed(1)}% ` +
                `distracted:${(proba[3]*100).toFixed(1)}% ` +
                `overload:${(proba[4]*100).toFixed(1)}% ` +
                `→ КИМ:${kim.toFixed(1)} (${elapsed.toFixed(2)}мс)`
            );
            return kim;
        } catch (err) {
            console.warn('[CogneeAI] Ошибка инференса:', err.message);
            return null;
        }
    }

    // ─── КИМ ЧЕРЕЗ ЭВРИСТИКУ (fallback) ──────────────────────────────────────
    function computeKIMHeuristic() {
        const raw = (scrollScore * 0.4) + (clickScore * 0.3) + (returnScore * 0.3);
        return clamp(raw + getChronoBonus(), 0, 100);
    }

    // ─── UI: БЕЙДЖ СТАТУСА НЕЙРОСЕТИ ─────────────────────────────────────────
    function updateNeuralBadge(status) {
        let badge = document.getElementById('cognee-neural-badge');
        if (!badge) {
            badge = document.createElement('div');
            badge.id = 'cognee-neural-badge';
            badge.style.cssText = `
                position: fixed;
                top: 10px;
                left: 50%;
                transform: translateX(-50%);
                padding: 4px 14px;
                border-radius: 20px;
                font-size: 11px;
                font-family: 'Courier New', monospace;
                font-weight: 600;
                z-index: 9999;
                pointer-events: none;
                transition: opacity 0.6s ease, background 0.3s ease;
                letter-spacing: 0.04em;
                white-space: nowrap;
            `;
            document.body.appendChild(badge);
        }

        if (status === 'loading') {
            badge.textContent = '⏳ Загружаю нейросеть...';
            badge.style.background = '#33333388';
            badge.style.color      = '#aaaaaa';
            badge.style.border     = '1px solid #555555';
            badge.style.opacity    = '1';

        } else if (status === 'ready') {
            badge.textContent = '🧠 Нейросеть активна';
            badge.style.background = '#4FC3F722';
            badge.style.color      = '#4FC3F7';
            badge.style.border     = '1px solid #4FC3F755';
            badge.style.opacity    = '1';
            // Плавно скрыть через 5 сек
            setTimeout(() => { badge.style.opacity = '0'; }, 5000);

        } else if (status === 'fallback') {
            badge.textContent = '⚙ Эвристика (нет model/)';
            badge.style.background = '#FFB74D22';
            badge.style.color      = '#FFB74D';
            badge.style.border     = '1px solid #FFB74D55';
            badge.style.opacity    = '1';
            // Скрыть через 4 сек
            setTimeout(() => { badge.style.opacity = '0'; }, 4000);
        }
    }

    // ─── ИНИЦИАЛИЗАЦИЯ НЕЙРОСЕТИ ─────────────────────────────────────────────────
    // Веса встроены в файл — никакой загрузки не нужно
    async function tryLoadModel() {
        // Прогрев: один тестовый инференс чтобы прогреть JIT
        const t0     = performance.now();
        const warmup = computeKIMNeural();
        const ms     = Math.round(performance.now() - t0);

        if (warmup !== null) {
            modelLoadSuccess = true;
            console.log('[CogneeAI] ✅ Нейросеть инициализирована за ' + ms + 'мс (встроенный инференс)');
            updateNeuralBadge('ready');
        } else {
            modelLoadSuccess = false;
            console.warn('[CogneeAI] Ошибка инициализации → эвристика');
            updateNeuralBadge('fallback');
        }
    }

    // ─── СЧЁТЧИК 1 — Ритм скроллинга ─────────────────────────────────────────
    const scrollTimestamps = [];

    window.addEventListener('scroll', () => {
        const now = Date.now();
        scrollTimestamps.push(now);
        if (scrollTimestamps.length > 15) scrollTimestamps.shift();
        lastActivityTime = now;

        if (scrollTimestamps.length >= 2) {
            let sum = 0;
            for (let i = 1; i < scrollTimestamps.length; i++)
                sum += scrollTimestamps[i] - scrollTimestamps[i - 1];
            const avg = sum / (scrollTimestamps.length - 1);
            if (avg < 50)       scrollScore = clamp(scrollScore - 2, 0, 100);
            else if (avg > 200) scrollScore = clamp(scrollScore + 2, 0, 100);
        }
    }, { passive: true });

    // ─── СЧЁТЧИК 2 — Пауза перед кликом ──────────────────────────────────────
    const mouseEnterTimes = new WeakMap();

    document.addEventListener('mouseover', e => {
        const el = e.target.closest('p, h2, h3');
        if (el) mouseEnterTimes.set(el, Date.now());
    });

    document.addEventListener('click', e => {
        const el = e.target.closest('p, h2, h3');
        if (!el) return;
        const enterTime = mouseEnterTimes.get(el);
        if (!enterTime) return;
        const pause = Date.now() - enterTime;
        mouseEnterTimes.delete(el);
        lastActivityTime = Date.now();

        // Скользящее среднее паузы для вектора признаков
        recentClickPause = recentClickPause * 0.7 + pause * 0.3;

        if (pause > 800)                       clickScore = clamp(clickScore - 3, 0, 100);
        else if (pause >= 200 && pause <= 500) clickScore = clamp(clickScore + 1, 0, 100);
    });

    // ─── СЧЁТЧИК 3 — Возвраты и перечитывания ────────────────────────────────
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
                if (prevScrollDir === 'down') {
                    consecutiveRereads = clamp(consecutiveRereads + 1, 0, 20);
                }
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

        // Очистка событий возврата (окно 5 мин)
        if (now - lastReturnCleanup > 30000) {
            const cutoff = now - 5 * 60 * 1000;
            while (returnEvents.length > 0 && returnEvents[0].time < cutoff)
                returnEvents.shift();
            lastReturnCleanup = now;
        }
        returnEventsInWindow = returnEvents.length;

        // Idle-детектор: нет активности >45 сек → нарастает усталость
        const idleSec = (now - lastActivityTime) / 1000;
        if (idleSec > 45 && idleSec < 120) {
            idleBursts = clamp(idleBursts + 0.5, 0, 10);
        }
    }, 1000);

    // Постепенное восстановление метрик при активном чтении
    setInterval(() => {
        returnScore        = clamp(returnScore + 1, 0, 100);
        consecutiveRereads = clamp(consecutiveRereads - 0.1, 0, 20);
        idleBursts         = clamp(idleBursts - 0.2, 0, 10);
    }, 5000);

    // ─── ГЛАВНЫЙ ЦИКЛ ОБНОВЛЕНИЯ КИМ ─────────────────────────────────────────
    const updateKIM = async () => {
        let rawKIM;
        let alpha;

        if (modelLoadSuccess) {
            // ── Встроенный инференс ──────────────────────────────────────────
            const neuralKIM = computeKIMNeural();
            rawKIM = (neuralKIM !== null) ? neuralKIM : computeKIMHeuristic();
            alpha  = SMOOTH_ALPHA_NEURAL;
        } else {
            // ── Режим эвристики (fallback) ──────────────────────────────────
            rawKIM = computeKIMHeuristic();
            alpha  = SMOOTH_ALPHA_HEURISTIC;
            console.log(
                `[CogneeAI ⚙] scroll:${scrollScore} click:${clickScore}` +
                ` return:${returnScore} chrono:${getChronoBonus()} → КИМ:${rawKIM.toFixed(1)}`
            );
        }

        const adjusted  = clamp(rawKIM, 0, 100);
        smoothedKIM     = Math.round((alpha * adjusted + (1 - alpha) * smoothedKIM) * 10) / 10;
        window.currentKIM = smoothedKIM;

        // ── Обновляем КИМ-дисплей ────────────────────────────────────────
        const display = document.getElementById('kim-display');
        if (display) {
            const modeTag = modelLoadSuccess ? ' 🧠' : ' ⚙';
            display.textContent = `КИМ: ${smoothedKIM}${modeTag}`;
            const colors = { focus: '#4FC3F7', normal: '#81C784', tired: '#c49a6c' };
            display.style.borderLeft = `3px solid ${colors[getZone(smoothedKIM)]}`;
        }

        // ── Сохраняем в localStorage ──────────────────────────────────────
        if (window.CogneeStorage) {
            window.CogneeStorage.saveKIM(smoothedKIM, Date.now());
        }

        // ── Supabase аналитика (EchoAnalytics v7.1+, опционально) ────────
        if (window.EchoAnalytics) {
            window.EchoAnalytics.sendEvent(smoothedKIM, getZone(smoothedKIM));
        }

        // ── Адаптация при значимом изменении ─────────────────────────────
        const zoneChanged = lastKIM === null || getZone(smoothedKIM) !== getZone(lastKIM);
        const bigDelta    = lastKIM !== null && Math.abs(smoothedKIM - lastKIM) >= KIM_CHANGE_THRESHOLD;

        if ((zoneChanged || bigDelta) && window.applyAdaptation) {
            window.applyAdaptation(smoothedKIM);
        }

        lastKIM = smoothedKIM;
    };

    // ─── СТАРТ ────────────────────────────────────────────────────────────────
    (async () => {
        await tryLoadModel();
        setTimeout(updateKIM, 800);
        setInterval(updateKIM, UPDATE_INTERVAL_MS);
    })();

})();
