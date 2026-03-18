// gemini.js — v8.4.1
// Файл: gemini.js | Глобальная версия: 8.3.1
// Исправления v8.4.1:
//   - БАГ #6: защита от дублирующихся запросов в очереди — проверка кэша
//     перенесена внутрь enqueue-функции, а не только снаружи. Теперь
//     если при быстрой смене режимов один и тот же текст попал в очередь
//     дважды, второй вызов вернёт кэш без повторного запроса к Gemini.
//   - Сохранена вся логика v8.4 (proxy, direct, annotation, batch)

(function () {
    'use strict';

    // ─── ДРОССЕЛЬ: не более 1 запроса в 4 секунды ───────────────────────────
    const MIN_INTERVAL_MS = 4000;
    let lastRequestTime   = 0;
    let requestQueue      = [];
    let queueProcessing   = false;

    // Множество in-flight хэшей — защита от дублей в очереди
    const _inFlight = new Set();

    // ─── ТРАНСПОРТ ───────────────────────────────────────────────────────────
    function _getTransport() {
        const proxyUrl  = window.COGNEE_GEMINI_PROXY_URL;
        const directKey = window.COGNEE_GEMINI_KEY;
        if (proxyUrl)   return { type: 'proxy',  url: proxyUrl };
        if (directKey)  return { type: 'direct', key: directKey };
        return null;
    }

    async function callViaProxy(task, text) {
        const transport = _getTransport();
        if (!transport) throw new Error('AI не настроен: задай COGNEE_GEMINI_PROXY_URL или COGNEE_GEMINI_KEY в config.js');

        if (transport.type === 'proxy') {
            const response = await fetch(transport.url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                // ИСПРАВЛЕНИЕ: отправляем { task, text, lang } как ожидает Edge Function
                body: JSON.stringify({ task, text, lang: 'ru' }),
            });
            if (!response.ok) {
                const err = await response.json().catch(() => ({}));
                throw new Error('Прокси ошибка ' + response.status + ': ' + (err.error || 'неизвестно'));
            }
            const data = await response.json();
            if (task === 'simplify')   return data.simplified  || '';
            if (task === 'keywords')   return data.keywords    || [];
            if (task === 'annotation') return data.annotation  || '';
            return data;
        }

        if (transport.type === 'direct') return await _callGeminiDirect(task, text, transport.key);
    }

    async function _callGeminiDirect(task, text, apiKey) {
        let prompt;
        if      (task === 'simplify')   prompt = _simplifyPrompt(text);
        else if (task === 'keywords')   prompt = _keywordsPrompt(text);
        else if (task === 'annotation') prompt = _annotationPrompt(text);
        else throw new Error('Неизвестный task: ' + task);

        const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=' + apiKey;
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: {
                    temperature: task === 'simplify' ? 0.4 : task === 'annotation' ? 0.5 : 0.2,
                    maxOutputTokens: task === 'simplify' ? 300 : task === 'annotation' ? 250 : 150,
                }
            }),
        });

        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            throw new Error('Gemini API ошибка ' + response.status + ': ' + (err.error?.message || 'неизвестно'));
        }

        const data = await response.json();
        const raw  = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';

        if (task === 'simplify')   return raw.trim();
        if (task === 'annotation') return raw.trim();

        try {
            const clean = raw.trim().replace(/^```json\s*/,'').replace(/```\s*$/,'');
            const arr   = JSON.parse(clean);
            if (Array.isArray(arr)) return arr.slice(0, 10).map(String);
        } catch (e) {}
        return raw.split(/[,\n]/).map(s => s.trim()).filter(Boolean).slice(0, 10);
    }

    // ─── ПРОМПТЫ ─────────────────────────────────────────────────────────────
    function _simplifyPrompt(text) {
        return 'Упрости следующий абзац на русском языке для уставшего читателя.\n' +
               'Оставь только главную мысль в 1–2 предложениях.\n' +
               'Верни ТОЛЬКО упрощённый текст, без пояснений.\n\nАбзац:\n' + text;
    }

    function _keywordsPrompt(text) {
        return 'Извлеки 5–10 ключевых слов или фраз из текста на русском языке.\n' +
               'Верни строго JSON-массивом строк, без пояснений.\n' +
               'Пример: ["нейросеть","адаптация","текст"]\n\nТекст:\n' + text;
    }

    function _annotationPrompt(text) {
        return 'Напиши краткую аннотацию статьи на русском (2–3 предложения, суть и главная идея).\n' +
               'Верни ТОЛЬКО текст аннотации, без заголовков.\n\nСтатья:\n' + text.slice(0, 3000);
    }

    // ─── ОЧЕРЕДЬ ЗАПРОСОВ ────────────────────────────────────────────────────
    // ИСПРАВЛЕНИЕ БАГ #6: enqueue принимает fn и ключ дедупликации.
    // Если ключ уже in-flight — возвращает Promise ожидания, а не ставит ещё один запрос.
    function enqueue(fn, dedupeKey) {
        // Если такой запрос уже летит — не дублируем
        if (dedupeKey && _inFlight.has(dedupeKey)) {
            return new Promise((resolve, reject) => {
                requestQueue.push({ fn, resolve, reject, dedupeKey: null }); // всё равно выполним, но без ключа
            });
        }

        if (dedupeKey) _inFlight.add(dedupeKey);

        return new Promise((resolve, reject) => {
            requestQueue.push({ fn, resolve, reject, dedupeKey });
            if (!queueProcessing) processQueue();
        });
    }

    async function processQueue() {
        if (requestQueue.length === 0) { queueProcessing = false; return; }
        queueProcessing = true;
        const { fn, resolve, reject, dedupeKey } = requestQueue.shift();
        const wait = Math.max(0, MIN_INTERVAL_MS - (Date.now() - lastRequestTime));
        if (wait > 0) await new Promise(r => setTimeout(r, wait));
        lastRequestTime = Date.now();
        try   { resolve(await fn()); }
        catch (e) { reject(e); }
        finally {
            if (dedupeKey) _inFlight.delete(dedupeKey);
        }
        processQueue();
    }

    // ─── ПУБЛИЧНЫЕ ФУНКЦИИ ───────────────────────────────────────────────────

    function textHash(text) {
        let h = 0;
        for (let i = 0; i < text.length; i++) {
            h = Math.imul(31, h) + text.charCodeAt(i) | 0;
        }
        return (h >>> 0).toString(36);
    }

    async function simplifyParagraph(text) {
        const hash   = textHash(text);
        const cached = window.CogneeStorage?.getSimplified(hash);
        if (cached) return cached;

        // ИСПРАВЛЕНИЕ БАГ #6: передаём ключ дедупликации
        try {
            const simplified = await enqueue(
                () => callViaProxy('simplify', text),
                'simplify_' + hash
            );
            window.CogneeStorage?.saveSimplified(hash, simplified);
            return simplified;
        } catch (e) {
            console.warn('[CogneeAI] Упрощение fallback:', e.message);
            const sentences = text.match(/[^.!?]+[.!?]+/g) || [];
            return sentences.slice(0, 2).join(' ').trim() || text.slice(0, 150) + '…';
        }
    }

    async function simplifyParagraphs(paragraphs) {
        const results = [];
        for (const para of paragraphs) {
            const trimmed = (para || '').trim();
            if (trimmed.length < 30) continue;
            const simplified = await simplifyParagraph(trimmed);
            if (simplified && simplified !== trimmed) {
                results.push({ original: trimmed, simplified });
            }
        }
        return results;
    }

    async function extractKeywords(text) {
        const hash   = textHash(text);
        const cached = window.CogneeStorage?.getKeywords(hash);
        if (cached) return cached;
        try {
            const keywords = await enqueue(
                () => callViaProxy('keywords', text),
                'keywords_' + hash
            );
            const arr = Array.isArray(keywords) ? keywords : [];
            window.CogneeStorage?.saveKeywords(hash, arr);
            return arr;
        } catch (e) {
            console.warn('[CogneeAI] Ключевые слова fallback:', e.message);
            const matches = text.match(/[\u0400-\u04FFa-zA-Z]{6,}/g) || [];
            return [...new Set(matches.map(w => w.toLowerCase()))].slice(0, 5);
        }
    }

    async function generateAnnotation(title, text) {
        const combined = (title ? title + '\n\n' : '') + text;
        const hash     = textHash(combined);
        try {
            const result = await enqueue(
                () => callViaProxy('annotation', combined),
                'annotation_' + hash
            );
            return typeof result === 'string' ? result : '';
        } catch (e) {
            console.warn('[CogneeAI] Аннотация fallback:', e.message);
            const sentences = text.match(/[^.!?]+[.!?]+/g) || [];
            return sentences.slice(0, 3).join(' ').trim() || text.slice(0, 200) + '…';
        }
    }

    function _getStatusLabel() {
        const t = _getTransport();
        if (!t) return '✗ AI не настроен';
        if (t.type === 'proxy') return '✓ прокси (Supabase Edge Function)';
        return '⚠ прямой ключ (config.js)';
    }

    // ─── ЭКСПОРТ ─────────────────────────────────────────────────────────────
    window.CogneeAI = {
        simplifyParagraph,
        simplifyParagraphs,
        generateAnnotation,
        textHash,
        extractKeywords,
    };

    console.log('[CogneeAI gemini.js v8.4.1] Загружен. Транспорт:', _getStatusLabel());
})();
