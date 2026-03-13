
// storage.js — v8.3
// Файл: storage.js | Глобальная версия: 8.3
// Хранение истории КИМ в localStorage между сессиями.
// Блок 1 (v8.1): добавлен кэш AI-упрощений и AI-ключевых слов (экономия лимитов Gemini Flash).
// Экспортирует window.CogneeStorage = { saveKIM, getHistory, getHourlyStats, getDailyStats, getBestHour, getWorstHour, saveSimplified, getSimplified, saveKeywords, getKeywords }

(function () {
    const STORAGE_KEY = 'cognee_kim_history';
    const MAX_RECORDS = 500;

    /**
     * Сохраняет одну запись КИМ в localStorage.
     * @param {number} kim    — значение КИМ (0–100)
     * @param {string} [zone] — 'focus'|'normal'|'tired' (опционально, вычисляется автоматически)
     * @param {number} [ts]   — Unix timestamp в мс (Date.now() по умолчанию)
     */
    function saveKIM(kim, zone, ts) {
        // Обратная совместимость: если zone — число, это старый вызов saveKIM(kim, timestamp)
        if (typeof zone === 'number') { ts = zone; zone = undefined; }
        try {
            const history  = _load();
            const safeZone = (typeof zone === 'string' && zone) ? zone : _getZone(kim);
            const safeTs   = (typeof ts === 'number' && ts > 0) ? ts : Date.now();
            history.push({ kim: Math.round(kim * 10) / 10, timestamp: safeTs, zone: safeZone });
            // Храним не более MAX_RECORDS записей (удаляем старые)
            if (history.length > MAX_RECORDS) {
                history.splice(0, history.length - MAX_RECORDS);
            }
            localStorage.setItem(STORAGE_KEY, JSON.stringify(history));
        } catch (e) {
            // localStorage может быть заблокирован (приватный режим и т.д.)
            console.warn('[CogneeStorage] Не удалось сохранить КИМ:', e);
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
            if (typeof kim !== 'number' || isNaN(kim)) return;
            const ts   = typeof timestamp === 'number' ? timestamp : Date.parse(timestamp);
            const hour = new Date(ts).getHours();
            if (hour < 0 || hour > 23 || isNaN(hour)) return;
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
            if (typeof kim !== 'number' || isNaN(kim)) return;
            const ts  = typeof timestamp === 'number' ? timestamp : Date.parse(timestamp);
            const day = new Date(ts).getDay();
            if (day < 0 || day > 6 || isNaN(day)) return;
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

    // ─── КЭШ AI-УПРОЩЕНИЙ ────────────────────────────────────────────────────
    const SIMPLIFIED_KEY = 'cognee_ai_simplified';
    const KEYWORDS_KEY   = 'cognee_ai_keywords';
    const MAX_CACHE      = 200; // максимум кэшированных абзацев

    /**
     * Сохраняет AI-упрощённую версию абзаца по его хэшу.
     * @param {string} hash — идентификатор текста (первые 80 символов)
     * @param {string} simplified — упрощённый текст от Gemini
     */
    function saveSimplified(hash, simplified) {
        try {
            const cache = _loadCache(SIMPLIFIED_KEY);
            cache[hash] = simplified;
            const keys = Object.keys(cache);
            // Удаляем самые старые если превысили лимит
            if (keys.length > MAX_CACHE) {
                const toDelete = keys.slice(0, keys.length - MAX_CACHE);
                toDelete.forEach(k => delete cache[k]);
            }
            localStorage.setItem(SIMPLIFIED_KEY, JSON.stringify(cache));
        } catch (e) {
            console.warn('[CogneeStorage] Не удалось сохранить AI-упрощение:', e);
        }
    }

    /**
     * Возвращает кэшированное AI-упрощение абзаца.
     * @param {string} hash — идентификатор текста
     * @returns {string|null} — упрощённый текст или null если нет в кэше
     */
    function getSimplified(hash) {
        const cache = _loadCache(SIMPLIFIED_KEY);
        return cache[hash] || null;
    }

    /**
     * Сохраняет AI-ключевые слова для абзаца.
     * @param {string} hash — идентификатор текста
     * @param {string[]} keywords — массив ключевых слов
     */
    function saveKeywords(hash, keywords) {
        try {
            const cache = _loadCache(KEYWORDS_KEY);
            cache[hash] = keywords;
            const keys = Object.keys(cache);
            if (keys.length > MAX_CACHE) {
                const toDelete = keys.slice(0, keys.length - MAX_CACHE);
                toDelete.forEach(k => delete cache[k]);
            }
            localStorage.setItem(KEYWORDS_KEY, JSON.stringify(cache));
        } catch (e) {
            console.warn('[CogneeStorage] Не удалось сохранить ключевые слова:', e);
        }
    }

    /**
     * Возвращает кэшированные ключевые слова для абзаца.
     * @param {string} hash — идентификатор текста
     * @returns {string[]|null}
     */
    function getKeywords(hash) {
        const cache = _loadCache(KEYWORDS_KEY);
        return cache[hash] || null;
    }

    function _loadCache(key) {
        try {
            const raw = localStorage.getItem(key);
            if (!raw) return {};
            const parsed = JSON.parse(raw);
            return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
        } catch (e) {
            return {};
        }
    }

    // ─── ЭКСПОРТ ─────────────────────────────────────────────────────────────
    window.CogneeStorage = {
        saveKIM,
        getHistory,
        getHourlyStats,
        getDailyStats,
        getBestHour,
        getWorstHour,
        saveSimplified,
        getSimplified,
        saveKeywords,
        getKeywords,
    };

    console.log('[CogneeStorage v8.1] Загружен. Записей в истории:', _load().length);
})();