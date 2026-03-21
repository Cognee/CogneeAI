// gemini.js — v9.1
// Файл: gemini.js | Глобальная версия: 9.1
// Блок 2:
//   - Задача 2.1: добавлена функция rephraseText(text) — "Объясни иначе"
//   - Задача 2.3: добавлена функция generateTags(text) — AI-теги и рекомендуемый КИМ

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
            if (task === 'rephrase')   return data.rephrased   || '';
            if (task === 'tags')       return data;  // возвращаем весь объект {tags, recommended_kim}
            return data;
        }

        if (transport.type === 'direct') return await _callGeminiDirect(task, text, transport.key);
    }

    async function _callGeminiDirect(task, text, apiKey) {
        let prompt;
        if      (task === 'simplify')   prompt = _simplifyPrompt(text);
        else if (task === 'keywords')   prompt = _keywordsPrompt(text);
        else if (task === 'annotation') prompt = _annotationPrompt(text);
        else if (task === 'rephrase')   prompt = _rephrasePrompt(text);
        else if (task === 'tags')       prompt = _tagsPrompt(text);
        else throw new Error('Неизвестный task: ' + task);

        const temperature = task === 'rephrase' ? 0.7 : 0.3;
        const maxTokens   = task === 'rephrase' ? 350 : task === 'tags' ? 200 : task === 'simplify' ? 300 : 250;

        const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=' + apiKey;
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: { temperature, maxOutputTokens: maxTokens }
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
        if (task === 'rephrase')   return raw.trim();

        if (task === 'tags') {
            try {
                const cleaned = raw.trim().replace(/^```json\s*/,'').replace(/```\s*$/,'');
                const parsed  = JSON.parse(cleaned);
                return {
                    tags: Array.isArray(parsed.tags) ? parsed.tags.slice(0, 5) : [],
                    recommended_kim: typeof parsed.recommended_kim === 'number'
                        ? Math.min(100, Math.max(40, parsed.recommended_kim)) : null,
                };
            } catch {
                return { tags: [], recommended_kim: null };
            }
        }

        // keywords
        try {
            const clean = raw.trim().replace(/^```json\s*/,'').replace(/```\s*$/,'');
            const arr   = JSON.parse(clean);
            if (Array.isArray(arr)) return arr.slice(0, 10).map(String);
        } catch {}
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

    function _rephrasePrompt(text) {
        return 'Объясни следующий абзац ДРУГИМ способом, используя аналогию из повседневной жизни.\n' +
               'Язык: русский.\n' +
               'Правила: используй сравнение или бытовой пример, 2–4 предложения, живо и понятно.\n' +
               'Ответь ТОЛЬКО перефразированным текстом, без предисловий.\n\nАбзац:\n' + text;
    }

    function _tagsPrompt(text) {
        return 'Определи 3–5 тегов для этого текста и оптимальный КИМ читателя (число 40-100).\n' +
               'Теги: технологии, история, наука, бизнес, образование, психология, медицина, философия, искусство, спорт, политика, экономика, экология, культура, юмор.\n' +
               'Верни СТРОГО JSON без пояснений: {"tags": ["тег1", "тег2"], "recommended_kim": 65}\n\nТекст:\n' +
               text.slice(0, 2000);
    }

    // ─── ОЧЕРЕДЬ ЗАПРОСОВ ────────────────────────────────────────────────────
    function enqueue(fn, dedupeKey) {
        if (dedupeKey && _inFlight.has(dedupeKey)) {
            return new Promise((resolve, reject) => {
                requestQueue.push({ fn, resolve, reject, dedupeKey: null });
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

    // ─── Задача 2.1: "Объясни иначе" ─────────────────────────────────────────
    async function rephraseText(text) {
        const hash   = textHash('rephrase_' + text);
        const cached = window.CogneeStorage?.getSimplified('reph_' + hash);
        if (cached) return cached;

        try {
            const result = await enqueue(
                () => callViaProxy('rephrase', text),
                'rephrase_' + hash
            );
            const rephrased = typeof result === 'string' ? result : '';
            if (rephrased) window.CogneeStorage?.saveSimplified('reph_' + hash, rephrased);
            return rephrased;
        } catch (e) {
            console.warn('[CogneeAI] Перефраз fallback:', e.message);
            return '';
        }
    }

    // ─── Задача 2.3: AI-теги и рекомендуемый КИМ ─────────────────────────────
    async function generateTags(text) {
        const hash = textHash('tags_' + text.slice(0, 200));
        try {
            const result = await enqueue(
                () => callViaProxy('tags', text),
                'tags_' + hash
            );
            if (result && typeof result === 'object') {
                return {
                    tags:            Array.isArray(result.tags) ? result.tags : [],
                    recommended_kim: result.recommended_kim || null,
                };
            }
            return { tags: [], recommended_kim: null };
        } catch (e) {
            console.warn('[CogneeAI] Теги fallback:', e.message);
            return { tags: [], recommended_kim: null };
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
        rephraseText,
        generateTags,
    };

    console.log('[CogneeAI gemini.js v9.1] Загружен. Транспорт:', _getStatusLabel());
})();
