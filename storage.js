
// storage.js — v5.0
// Файл: storage.js | Глобальная версия: 5.0
// Хранение истории КИМ в localStorage между сессиями.
// Экспортирует window.EchoStorage = { saveKIM, getHistory, getHourlyStats, getDailyStats, getBestHour, getWorstHour }

(function () {
    const STORAGE_KEY = 'echo_kim_history';
    const MAX_RECORDS = 500;

    /**
     * Сохраняет одну запись КИМ в localStorage.
     * @param {number} kim — значение КИМ (0–100)
     * @param {number} timestamp — Unix timestamp в мс (Date.now())
     */
    function saveKIM(kim, timestamp) {
        try {
            const history = _load();
            const zone = _getZone(kim);
            history.push({ kim: Math.round(kim * 10) / 10, timestamp, zone });
            // Храним не более MAX_RECORDS записей (удаляем старые)
            if (history.length > MAX_RECORDS) {
                history.splice(0, history.length - MAX_RECORDS);
            }
            localStorage.setItem(STORAGE_KEY, JSON.stringify(history));
        } catch (e) {
            // localStorage может быть заблокирован (приватный режим и т.д.)
            console.warn('[EchoStorage] Не удалось сохранить КИМ:', e);
        }
    }

    /**
     * Возвращает всю историю КИМ.
     * @returns {Array<{kim: number, timestamp: number, zone: string}>}
     */
    function getHistory() {
        return _load();
    }

    /**
     * Группирует историю по часам суток (0–23).
     * @returns {number[]} — массив из 24 средних КИМ (0 если нет данных)
     */
    function getHourlyStats() {
        const history = _load();
        const buckets = Array.from({ length: 24 }, () => ({ sum: 0, count: 0 }));
        history.forEach(({ kim, timestamp }) => {
            const hour = new Date(timestamp).getHours();
            buckets[hour].sum += kim;
            buckets[hour].count += 1;
        });
        return buckets.map(b => b.count > 0 ? Math.round((b.sum / b.count) * 10) / 10 : 0);
    }

    /**
     * Группирует историю по дням недели (0=вс … 6=сб).
     * @returns {number[]} — массив из 7 средних КИМ
     */
    function getDailyStats() {
        const history = _load();
        const buckets = Array.from({ length: 7 }, () => ({ sum: 0, count: 0 }));
        history.forEach(({ kim, timestamp }) => {
            const day = new Date(timestamp).getDay(); // 0=вс, 6=сб
            buckets[day].sum += kim;
            buckets[day].count += 1;
        });
        return buckets.map(b => b.count > 0 ? Math.round((b.sum / b.count) * 10) / 10 : 0);
    }

    /**
     * Возвращает час суток с максимальным средним КИМ.
     * @returns {number} час (0–23), или -1 если данных нет
     */
    function getBestHour() {
        const stats = getHourlyStats();
        let best = -1, bestVal = -1;
        stats.forEach((val, h) => {
            if (val > bestVal) { bestVal = val; best = h; }
        });
        return best;
    }

    /**
     * Возвращает час суток с минимальным средним КИМ (только среди часов с данными).
     * @returns {number} час (0–23), или -1 если данных нет
     */
    function getWorstHour() {
        const stats = getHourlyStats();
        let worst = -1, worstVal = Infinity;
        stats.forEach((val, h) => {
            // val > 0 — не считаем «худшим» тот час, в который просто не было записей
            if (val > 0 && val < worstVal) { worstVal = val; worst = h; }
        });
        return worst;
    }

    // ─── ВСПОМОГАТЕЛЬНЫЕ ─────────────────────────────────────────────────────

    function _load() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) return [];
            const parsed = JSON.parse(raw);
            return Array.isArray(parsed) ? parsed : [];
        } catch (e) {
            return [];
        }
    }

    function _getZone(kim) {
        if (kim > 70) return 'focus';
        if (kim >= 40) return 'normal';
        return 'tired';
    }

    // ─── ЭКСПОРТ ─────────────────────────────────────────────────────────────
    window.EchoStorage = {
        saveKIM,
        getHistory,
        getHourlyStats,
        getDailyStats,
        getBestHour,
        getWorstHour,
    };

    console.log('[EchoStorage v5.0] Загружен. Записей в истории:', _load().length);
})();