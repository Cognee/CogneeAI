
// supabase.js — v8.3
// Файл: supabase.js | Глобальная версия: 8.3
// Блок 2+3: Авторизация и база данных через Supabase.
// Отвечает за: аутентификацию, синхронизацию КИМ-истории, профиль, публикацию статей.
// Изменения v8.3: добавлены publishArticle, getArticleById, getUserArticles
// ВАЖНО: подключать ПОСЛЕ storage.js, ДО adapter.js
// Экспортирует window.CogneeSupabase = { init, signUp, signIn, signOut, getUser,
//   syncKIMHistory, saveKIMRemote, getUserProfile, updateProfile,
//   publishArticle, getArticleById, getUserArticles }

(function () {
    'use strict';

    // ─── КОНФИГ (задаётся через config.js) ──────────────────────────────────
    // window.COGNEE_SUPABASE_URL  — URL проекта Supabase
    // window.COGNEE_SUPABASE_KEY  — anon/public key Supabase

    let supabaseUrl = null;
    let supabaseKey = null;
    let currentSession = null;   // { access_token, user: { id, email } }
    let currentUser = null;      // { id, email, display_name }

    // ─── ИНИЦИАЛИЗАЦИЯ ───────────────────────────────────────────────────────
    async function init() {
        supabaseUrl = window.COGNEE_SUPABASE_URL || null;
        supabaseKey = window.COGNEE_SUPABASE_KEY || null;

        if (!supabaseUrl || !supabaseKey) {
            console.warn('[CogneeSupabase] URL или ключ не заданы — работаем офлайн (localStorage only).');
            return false;
        }

        // Восстанавливаем сессию из localStorage
        try {
            const stored = localStorage.getItem('cognee_session');
            if (stored) {
                const parsed = JSON.parse(stored);
                if (parsed && parsed.access_token) {
                    const verified = await _verifyToken(parsed.access_token);
                    if (verified) {
                        currentSession = parsed;
                        currentUser = verified;
                        console.log('[CogneeSupabase v8.2] Сессия восстановлена:', currentUser.email);
                        _dispatchAuthEvent('signed_in', currentUser);
                        return true;
                    }
                }
            }
        } catch (e) {
            localStorage.removeItem('cognee_session');
        }

        console.log('[CogneeSupabase v8.2] Инициализирован. Пользователь не авторизован.');
        return false;
    }

    // ─── РЕГИСТРАЦИЯ ─────────────────────────────────────────────────────────
    async function signUp(email, password, displayName) {
        _requireConfig();
        const res = await _fetch('/auth/v1/signup', 'POST', {
            email,
            password,
            data: { display_name: displayName || email.split('@')[0] }
        });

        if (res.error) throw new Error(res.error.message || 'Ошибка регистрации');

        // Supabase может сразу вернуть сессию (если email confirm выключен)
        if (res.access_token) {
            _saveSession(res);
            currentUser = _extractUser(res);
            _dispatchAuthEvent('signed_up', currentUser);
        }

        return res;
    }

    // ─── ВХОД ────────────────────────────────────────────────────────────────
    async function signIn(email, password) {
        _requireConfig();
        const res = await _fetch('/auth/v1/token?grant_type=password', 'POST', { email, password });

        if (res.error) throw new Error(res.error.message || 'Неверный email или пароль');

        _saveSession(res);
        currentUser = _extractUser(res);
        _dispatchAuthEvent('signed_in', currentUser);

        // После входа — синхронизируем историю КИМ
        syncKIMHistory().catch(err => console.warn('[CogneeSupabase] Ошибка синхронизации КИМ:', err));

        return currentUser;
    }

    // ─── ВЫХОД ───────────────────────────────────────────────────────────────
    async function signOut() {
        if (!currentSession) return;

        try {
            await _fetch('/auth/v1/logout', 'POST', {}, true);
        } catch (e) {
            // Игнорируем ошибку выхода, всё равно очищаем локально
        }

        _clearSession();
        _dispatchAuthEvent('signed_out', null);
        console.log('[CogneeSupabase v8.2] Выход выполнен.');
    }

    // ─── ТЕКУЩИЙ ПОЛЬЗОВАТЕЛЬ ────────────────────────────────────────────────
    function getUser() {
        return currentUser;
    }

    function isAuthenticated() {
        return !!(currentSession && currentUser);
    }

    // ─── ПРОФИЛЬ ─────────────────────────────────────────────────────────────
    async function getUserProfile() {
        if (!isAuthenticated()) return null;

        const res = await _dbFetch('GET', `/rest/v1/users?id=eq.${currentUser.id}&select=*`);
        if (res && res.length > 0) return res[0];

        // Если профиля нет — создаём
        return await _upsertProfile();
    }

    async function updateProfile(data) {
        if (!isAuthenticated()) throw new Error('Не авторизован');
        const allowed = ['display_name'];
        const patch = {};
        allowed.forEach(k => { if (data[k] !== undefined) patch[k] = data[k]; });

        const res = await _dbFetch('PATCH',
            `/rest/v1/users?id=eq.${currentUser.id}`,
            patch
        );
        if (currentUser) Object.assign(currentUser, patch);
        return res;
    }

    // ─── СИНХРОНИЗАЦИЯ КИМ-ИСТОРИИ ───────────────────────────────────────────
    // Загружает локальную историю в облако (только новые записи за последние 7 дней)
    async function syncKIMHistory() {
        if (!isAuthenticated()) return;
        if (!window.CogneeStorage) return;

        const history = window.CogneeStorage.getHistory();
        if (!history || history.length === 0) return;

        // Берём только записи за последние 7 дней
        const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
        const recent = history.filter(r => r.timestamp > cutoff);
        if (recent.length === 0) return;

        // Загружаем пачками по 50 — не нагружаем Supabase
        const BATCH = 50;
        for (let i = 0; i < recent.length; i += BATCH) {
            const batch = recent.slice(i, i + BATCH).map(r => ({
                user_id:   currentUser.id,
                kim:       r.kim,
                zone:      r.zone,
                timestamp: new Date(r.timestamp).toISOString(),
                features_json: r.features ? JSON.stringify(r.features) : null
            }));

            await _dbFetch('POST', '/rest/v1/kim_history', batch, {
                'Prefer': 'resolution=ignore-duplicates,return=minimal'
            });
        }

        console.log(`[CogneeSupabase v8.2] Синхронизировано ${recent.length} записей КИМ.`);
    }

    // ─── СОХРАНЕНИЕ ОДНОЙ ЗАПИСИ КИМ В ОБЛАКО ────────────────────────────────
    async function saveKIMRemote(kim, zone, features) {
        if (!isAuthenticated()) return;

        await _dbFetch('POST', '/rest/v1/kim_history', [{
            user_id:   currentUser.id,
            kim:       Math.round(kim * 10) / 10,
            zone:      zone,
            timestamp: new Date().toISOString(),
            features_json: features ? JSON.stringify(features) : null
        }], {
            'Prefer': 'resolution=ignore-duplicates,return=minimal'
        });
    }

    // ─── ВСПОМОГАТЕЛЬНЫЕ: HTTP-запросы ───────────────────────────────────────
    function _requireConfig() {
        if (!supabaseUrl || !supabaseKey) {
            throw new Error('[CogneeSupabase] Supabase не настроен. Добавь COGNEE_SUPABASE_URL и COGNEE_SUPABASE_KEY в config.js');
        }
    }

    async function _fetch(path, method, body, withAuth) {
        const headers = {
            'Content-Type': 'application/json',
            'apikey': supabaseKey,
        };
        if (withAuth && currentSession) {
            headers['Authorization'] = 'Bearer ' + currentSession.access_token;
        }

        const res = await fetch(supabaseUrl + path, {
            method,
            headers,
            body: body ? JSON.stringify(body) : undefined,
        });

        if (!res.ok && res.status !== 200) {
            const err = await res.json().catch(() => ({}));
            return { error: err };
        }

        const text = await res.text();
        return text ? JSON.parse(text) : {};
    }

    async function _dbFetch(method, path, body, extraHeaders) {
        const headers = {
            'Content-Type': 'application/json',
            'apikey': supabaseKey,
            'Authorization': 'Bearer ' + (currentSession ? currentSession.access_token : supabaseKey),
        };
        if (extraHeaders) Object.assign(headers, extraHeaders);

        const res = await fetch(supabaseUrl + path, {
            method,
            headers,
            body: body ? JSON.stringify(body) : undefined,
        });

        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            console.warn('[CogneeSupabase] DB ошибка:', err);
            return null;
        }

        const text = await res.text();
        return text ? JSON.parse(text) : {};
    }

    async function _verifyToken(token) {
        try {
            const res = await fetch(supabaseUrl + '/auth/v1/user', {
                headers: {
                    'apikey': supabaseKey,
                    'Authorization': 'Bearer ' + token,
                }
            });
            if (!res.ok) return null;
            const data = await res.json();
            return data.id ? { id: data.id, email: data.email, display_name: data.user_metadata?.display_name } : null;
        } catch (e) {
            return null;
        }
    }

    function _saveSession(data) {
        currentSession = {
            access_token: data.access_token,
            refresh_token: data.refresh_token,
        };
        try {
            localStorage.setItem('cognee_session', JSON.stringify(currentSession));
        } catch (e) {}
    }

    function _clearSession() {
        currentSession = null;
        currentUser = null;
        try {
            localStorage.removeItem('cognee_session');
        } catch (e) {}
    }

    function _extractUser(data) {
        const u = data.user || {};
        return {
            id:           u.id,
            email:        u.email,
            display_name: u.user_metadata?.display_name || u.email?.split('@')[0] || 'Читатель',
        };
    }

    async function _upsertProfile() {
        const profile = {
            id:           currentUser.id,
            email:        currentUser.email,
            display_name: currentUser.display_name,
            created_at:   new Date().toISOString(),
        };
        await _dbFetch('POST', '/rest/v1/users', [profile], {
            'Prefer': 'resolution=ignore-duplicates,return=minimal'
        });
        return profile;
    }

    function _dispatchAuthEvent(type, user) {
        window.dispatchEvent(new CustomEvent('cognee:auth', { detail: { type, user } }));
    }

    // ─── СТАТЬИ ──────────────────────────────────────────────────────────────

    /**
     * Публикует статью в Supabase.
     * @param {object} data — { title, content, content_simple, keywords, annotation }
     * @returns {Promise<string>} — ID статьи (строка)
     */
    async function publishArticle(data) {
        _requireConfig();
        if (!isAuthenticated()) throw new Error('Не авторизован');

        const payload = {
            user_id:        currentUser.id,
            title:          data.title,
            content:        data.content,
            content_simple: data.content_simple || null,
            keywords:       Array.isArray(data.keywords) ? data.keywords : [],
            annotation:     data.annotation || null,
            published_at:   new Date().toISOString(),
        };

        const res = await _dbFetch('POST', '/rest/v1/articles', [payload], {
            'Prefer': 'return=representation'
        });

        if (!res || !res[0]) throw new Error('Supabase не вернул ID статьи');

        const id = String(res[0].id);
        console.log('[CogneeSupabase v8.3] Статья опубликована, id:', id);
        return id;
    }

    /**
     * Загружает статью по ID (доступна всем — публичная или своя).
     * @param {string} id
     * @returns {Promise<object|null>}
     */
    async function getArticleById(id) {
        _requireConfig();

        // Числовой ID — запрос к Supabase
        if (/^\d+$/.test(id)) {
            const res = await _dbFetch(
                'GET',
                `/rest/v1/articles?id=eq.${id}&select=id,title,content,content_simple,keywords,annotation,published_at,user_id,users(display_name)`
            );
            if (res && res[0]) {
                const a = res[0];
                return {
                    ...a,
                    author_name: a.users?.display_name || 'Автор',
                };
            }
            return null;
        }

        return null; // Локальные ID обрабатываются в reader.js
    }

    /**
     * Возвращает список статей текущего пользователя.
     * @returns {Promise<Array>}
     */
    async function getUserArticles() {
        if (!isAuthenticated()) return [];
        const res = await _dbFetch(
            'GET',
            `/rest/v1/articles?user_id=eq.${currentUser.id}&select=id,title,annotation,keywords,published_at&order=published_at.desc`
        );
        return Array.isArray(res) ? res : [];
    }

    // ─── ЭКСПОРТ ─────────────────────────────────────────────────────────────
    window.CogneeSupabase = {
        init,
        signUp,
        signIn,
        signOut,
        getUser,
        isAuthenticated,
        syncKIMHistory,
        saveKIMRemote,
        getUserProfile,
        updateProfile,
        publishArticle,
        getArticleById,
        getUserArticles,
    };

    console.log('[CogneeSupabase v8.3] Загружен. Ожидает init().');
})();