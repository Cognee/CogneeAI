// sensor.js – v3.1
// Изменение v3.1: версия синхронизирована с adapter.js v4.0.
// Логика КИМ без изменений. window.applyAdaptation вызывается без fromManual.

(function () {
    if (window.__sensorsInitialized) return;
    window.__sensorsInitialized = true;

    let scrollScore = 70;
    let clickScore  = 70;
    let returnScore = 80;
    let smoothedKIM = 70;

    const SMOOTH_ALPHA        = 0.3;
    const KIM_CHANGE_THRESHOLD = 8;

    const clamp   = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
    const getZone = kim => kim > 70 ? 'focus' : kim >= 40 ? 'normal' : 'tired';

    window.currentKIM = 70;

    // ─── ХРОНОБИОЛОГИЧЕСКИЙ БОНУС ─────────────────────────────────────────────
    function getChronoBonus() {
        const h = new Date().getHours();
        if ((h >= 9 && h <= 11) || (h >= 17 && h <= 19)) return 8;
        if (h >= 13 && h <= 15) return -10;
        if (h >= 0  && h <= 5)  return -15;
        return 0;
    }

    // ─── СЧЁТЧИК 1 — Ритм скроллинга ─────────────────────────────────────────
    const scrollTimestamps = [];

    window.addEventListener('scroll', () => {
        scrollTimestamps.push(Date.now());
        if (scrollTimestamps.length > 10) scrollTimestamps.shift();

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

        if (pause > 800)                    clickScore = clamp(clickScore - 3, 0, 100);
        else if (pause >= 200 && pause <= 500) clickScore = clamp(clickScore + 1, 0, 100);
    });

    // ─── СЧЁТЧИК 3 — Возврат назад ────────────────────────────────────────────
    const yHistory  = [];
    let timeAtBottom = null;

    setInterval(() => {
        const now = Date.now();
        yHistory.push({ time: now, y: window.scrollY });
        while (yHistory.length > 0 && yHistory[0].time < now - 3000) yHistory.shift();

        if (yHistory.length >= 2) {
            const oldest = yHistory[0];
            const newest = yHistory[yHistory.length - 1];

            if (newest.y > oldest.y) {
                if (!timeAtBottom) timeAtBottom = now;
            } else {
                timeAtBottom = null;
            }

            const delta = oldest.y - window.scrollY;
            const longEnough = timeAtBottom && (now - timeAtBottom >= 3000);
            if (delta > 300 && longEnough) {
                returnScore  = clamp(returnScore - 5, 0, 100);
                timeAtBottom = null;
            }
        }
    }, 1000);

    setInterval(() => { returnScore = clamp(returnScore + 1, 0, 100); }, 5000);

    // ─── ВЫЧИСЛЕНИЕ И ОБНОВЛЕНИЕ КИМ ─────────────────────────────────────────
    let lastKIM = null;

    const updateKIM = () => {
        const raw      = Math.round(((scrollScore * 0.4) + (clickScore * 0.3) + (returnScore * 0.3)) * 10) / 10;
        const adjusted = clamp(raw + getChronoBonus(), 0, 100);
        smoothedKIM    = Math.round((SMOOTH_ALPHA * adjusted + (1 - SMOOTH_ALPHA) * smoothedKIM) * 10) / 10;

        window.currentKIM = smoothedKIM;

        // Обновляем дисплей
        const display = document.getElementById('kim-display');
        if (display) {
            display.textContent = `КИМ: ${smoothedKIM}`;
            const colors = { focus: '#4FC3F7', normal: '#81C784', tired: '#c49a6c' };
            display.style.borderLeft = `3px solid ${colors[getZone(smoothedKIM)]}`;
        }

        console.log(
            `scroll:${scrollScore} click:${clickScore} return:${returnScore}` +
            ` | chrono:${getChronoBonus()} → КИМ:${smoothedKIM}`
        );

        const zoneChanged = lastKIM === null || getZone(smoothedKIM) !== getZone(lastKIM);
        const bigDelta    = lastKIM !== null && Math.abs(smoothedKIM - lastKIM) >= KIM_CHANGE_THRESHOLD;

        // Вызываем без fromManual — adapter сам решит, применять или нет
        if ((zoneChanged || bigDelta) && window.applyAdaptation) {
            window.applyAdaptation(smoothedKIM); // fromManual не передаём
        }

        lastKIM = smoothedKIM;
    };

    setTimeout(updateKIM, 800);
    setInterval(updateKIM, 20000);

})();