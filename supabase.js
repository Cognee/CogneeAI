// supabase.js — v8.4.2
// Файл: supabase.js | Глобальная версия: 8.4
// Исправления v8.4.2:
//   • _dbFetch: улучшено логирование ошибок PostgREST для диагностики
//   • getUserArticlesFull: fallback-запрос без новых полей если миграция не применялась
//   • getArticleById: убрана лишняя ветка exists-запроса (было BUG 6)
//   • publishArticle: возвращает { id, slug }
// ВАЖНО: подключать ПОСЛЕ storage.js, ДО adapter.js

(function () {
    'use strict';

    let supabaseUrl     = null;
    let supabaseKey     = null;
    let currentSession  = null;
    let currentUser     = null;

    // ─── ИНИЦИАЛИЗАЦИЯ ───────────────────────────────────────────────────────
    async function init() {
        supabaseUrl = window.COGNEE_SUPABASE_URL || null;
        supabaseKey = window.COGNEE_SUPABASE_KEY || null;

        if (!supabaseUrl || !supabaseKey) {
            console.warn('[CogneeSupabase] URL или ключ не заданы — работаем офлайн.');
            return false;
        }

        try {
            const stored = localStorage.getItem('cognee_session');
            if (stored) {
                const parsed = JSON.parse(stored);
                if (parsed && parsed.access_token) {
                    const verified = await _verifyToken(parsed.access_token);
                    if (verified) {
                        currentSession = parsed;
                        currentUser    = verified;
                        console.log('[CogneeSupabase v8.4.2] Сессия восстановлена:', currentUser.email);
                        _dispatchAuthEvent('signed_in', currentUser);
                        return true;
                    }
                }
            }
        } catch (e) {
            localStorage.removeItem('cognee_session');
        }

        console.log('[CogneeSupabase v8.4.2] Инициализирован. Не авторизован.');
        return false;
    }

    // ─── РЕГИСТРАЦИЯ ─────────────────────────────────────────────────────────
    async function signUp(email, password, displayName) {
        _requireConfig();
        const res = await _fetch('/auth/v1/signup', 'POST', {
            email, password,
            data: { display_name: displayName || email.split('@')[0] }
        });
        if (res.error) throw new Error(res.error.message || 'Ошибка регистрации');
        if (res.access_token) {
            _saveSession(res);
            currentUser = _extractUser(res);
            _dispatchAuthEvent('signed_up', currentUser);
            _upsertProfile().catch(e => console.warn('[CogneeSupabase] upsert on signup:', e.message));
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
        setTimeout(() => _refreshToken(), 50 * 60 * 1000);
        syncKIMHistory().catch(err => console.warn('[CogneeSupabase] Sync KIM error:', err));
        return currentUser;
    }

    // ─── ВЫХОД ───────────────────────────────────────────────────────────────
    async function signOut() {
        if (!currentSession) return;
        try { await _fetch('/auth/v1/logout', 'POST', {}, true); } catch (e) {}
        _clearSession();
        _dispatchAuthEvent('signed_out', null);
    }

    function getUser()          { return currentUser; }
    function isAuthenticated()  { return !!(currentSession && currentUser); }

    // ─── ПРОФИЛЬ ─────────────────────────────────────────────────────────────
    async function getUserProfile() {
        if (!isAuthenticated()) return null;
        const res = await _dbFetch('GET', '/rest/v1/users?id=eq.' + currentUser.id + '&select=*');
        if (res && res.length > 0) return res[0];
        return await _upsertProfile();
    }

    async function updateProfile(data) {
        if (!isAuthenticated()) throw new Error('Не авторизован');
        const patch = {};
        ['display_name'].forEach(k => { if (data[k] !== undefined) patch[k] = data[k]; });
        const res = await _dbFetch('PATCH', '/rest/v1/users?id=eq.' + currentUser.id, patch);
        if (currentUser) Object.assign(currentUser, patch);
        return res;
    }

    // ─── СИНХРОНИЗАЦИЯ КИМ ───────────────────────────────────────────────────
    async function syncKIMHistory() {
        if (!isAuthenticated() || !window.CogneeStorage) return;
        const history = window.CogneeStorage.getHistory();
        if (!history || history.length === 0) return;
        const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
        const recent = history.filter(r => r.timestamp > cutoff);
        if (recent.length === 0) return;
        const BATCH = 50;
        for (let i = 0; i < recent.length; i += BATCH) {
            const batch = recent.slice(i, i + BATCH).map(r => ({
                user_id: currentUser.id, kim: r.kim, zone: r.zone,
                timestamp: new Date(r.timestamp).toISOString(),
                features_json: r.features ? JSON.stringify(r.features) : null
            }));
            await _dbFetch('POST', '/rest/v1/kim_history', batch,
                { 'Prefer': 'resolution=ignore-duplicates,return=minimal' });
        }
        console.log('[CogneeSupabase v8.4.2] Синхронизировано ' + recent.length + ' КИМ-записей.');
    }

    async function saveKIMRemote(kim, zone, features) {
        if (!isAuthenticated()) return;
        await _dbFetch('POST', '/rest/v1/kim_history', [{
            user_id: currentUser.id, kim: Math.round(kim * 10) / 10,
            zone, timestamp: new Date().toISOString(),
            features_json: features ? JSON.stringify(features) : null
        }], { 'Prefer': 'resolution=ignore-duplicates,return=minimal' });
    }

    // ─── ГЕНЕРАТОР SLUG ──────────────────────────────────────────────────────
    function _generateSlug() {
        const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
        const arr = new Uint8Array(8);
        crypto.getRandomValues(arr);
        return Array.from(arr, b => chars[b % chars.length]).join('');
    }

    // ─── ПУБЛИКАЦИЯ СТАТЬИ ───────────────────────────────────────────────────
    async function publishArticle(data) {
        _requireConfig();
        if (!isAuthenticated()) throw new Error('Не авторизован');
        await _upsertProfile();

        const slug       = _generateSlug();
        const visibility = data.visibility === 'private' ? 'private' : 'public';
        const is_draft   = data.is_draft === true;

        const payload = {
            user_id:        currentUser.id,
            title:          data.title,
            content:        data.content,
            content_simple: data.content_simple || null,
            keywords:       Array.isArray(data.keywords) ? data.keywords : [],
            annotation:     data.annotation || null,
            published_at:   new Date().toISOString(),
            visibility, is_draft, slug,
        };

        const res = await _dbFetch('POST', '/rest/v1/articles', [payload],
            { 'Prefer': 'return=representation' });

        if (!res || !res[0]) throw new Error('Supabase не вернул ID статьи');
        const id = String(res[0].id);
        console.log('[CogneeSupabase v8.4.2] Статья сохранена. id=' + id + ' slug=' + slug + ' visibility=' + visibility + ' is_draft=' + is_draft);
        return { id, slug };
    }

    // ─── ОБНОВЛЕНИЕ СТАТЬИ ───────────────────────────────────────────────────
    async function updateArticle(id, data) {
        _requireConfig();
        if (!isAuthenticated()) throw new Error('Не авторизован');
        const patch = {};
        ['title','content','content_simple','keywords','annotation','visibility','is_draft']
            .forEach(k => { if (data[k] !== undefined) patch[k] = data[k]; });
        if (patch.is_draft === false) patch.published_at = new Date().toISOString();
        await _dbFetch('PATCH',
            '/rest/v1/articles?id=eq.' + id + '&user_id=eq.' + currentUser.id, patch);
        console.log('[CogneeSupabase v8.4.2] Статья ' + id + ' обновлена.');
    }

    // ─── УДАЛЕНИЕ СТАТЬИ ─────────────────────────────────────────────────────
    async function deleteArticle(id) {
        _requireConfig();
        if (!isAuthenticated()) throw new Error('Не авторизован');
        await _dbFetch('DELETE',
            '/rest/v1/articles?id=eq.' + id + '&user_id=eq.' + currentUser.id);
        console.log('[CogneeSupabase v8.4.2] Статья ' + id + ' удалена.');
    }

    // ─── ПОЛУЧИТЬ СТАТЬЮ ПО ID / SLUG ────────────────────────────────────────
    // Числовой id: сначала пробуем как автор, потом как публичную.
    //   Если ни то ни другое — возвращаем { _private: true } как сигнал для заглушки.
    //   (Мы не раскрываем существование статьи анонимам, но заглушка лучше 404)
    // Slug: вызываем RPC get_article_by_slug (SECURITY DEFINER, обходит RLS).
    async function getArticleById(id) {
        _requireConfig();
        const strId = String(id);

        if (/^\d+$/.test(strId)) {
            // Авторизованный пользователь — пробуем получить свою статью
            if (isAuthenticated()) {
                const mine = await _dbFetch('GET',
                    '/rest/v1/articles?id=eq.' + strId +
                    '&user_id=eq.' + currentUser.id +
                    '&select=id,title,content,content_simple,keywords,annotation,' +
                    'published_at,user_id,visibility,slug,is_draft,users(display_name)');
                if (mine && mine[0]) {
                    const a = mine[0];
                    return { ...a, author_name: a.users?.display_name || 'Автор' };
                }
            }

            // Публичная статья — для всех
            const pub = await _dbFetch('GET',
                '/rest/v1/articles?id=eq.' + strId +
                '&visibility=eq.public&is_draft=eq.false' +
                '&select=id,title,content,content_simple,keywords,annotation,' +
                'published_at,user_id,visibility,slug,is_draft,users(display_name)');
            if (pub && pub[0]) {
                const a = pub[0];
                return { ...a, author_name: a.users?.display_name || 'Автор' };
            }

            // Ничего не нашли — возвращаем сигнал "приватная/недоступная"
            // (не раскрываем разницу между "не существует" и "приватная")
            return { _private: true };
        }

        // Slug — вызываем RPC
        if (/^[a-z0-9]{6,16}$/.test(strId)) {
            const res = await _rpc('get_article_by_slug', { p_slug: strId });
            if (res && res[0]) return { ...res[0], author_name: res[0].author_name || 'Автор' };
            return null;
        }

        return null;
    }

    // ─── СПИСОК СТАТЕЙ ПОЛЬЗОВАТЕЛЯ (краткий, обратная совместимость) ────────
    async function getUserArticles() {
        if (!isAuthenticated()) return [];
        const res = await _dbFetch('GET',
            '/rest/v1/articles?user_id=eq.' + currentUser.id +
            '&select=id,title,annotation,keywords,published_at&order=published_at.desc');
        return Array.isArray(res) ? res : [];
    }

    // ─── ПОЛНЫЙ СПИСОК СТАТЕЙ ДЛЯ ПРОФИЛЯ ───────────────────────────────────
    // Сначала пробуем с новыми полями (v8.4).
    // Если миграция не применялась — PostgREST вернёт ошибку.
    // Fallback: запрос без visibility/is_draft/slug, добавляем дефолты на клиенте.
    async function getUserArticlesFull() {
        if (!isAuthenticated()) return [];

        // Запрос с полями v8.4
        const res = await _dbFetch('GET',
            '/rest/v1/articles?user_id=eq.' + currentUser.id +
            '&select=id,title,annotation,keywords,published_at,visibility,is_draft,slug' +
            '&order=published_at.desc');

        if (Array.isArray(res)) return res;

        // Fallback: миграция ещё не применена — запрашиваем без новых полей
        console.warn('[CogneeSupabase v8.4.2] Поля v8.4 недоступны — используем fallback. Примените supabase_migration_v8_4.sql!');
        const fallback = await _dbFetch('GET',
            '/rest/v1/articles?user_id=eq.' + currentUser.id +
            '&select=id,title,annotation,keywords,published_at&order=published_at.desc');

        if (!Array.isArray(fallback)) return [];

        // Добавляем дефолтные поля чтобы профиль отобразился
        return fallback.map(a => ({
            ...a,
            visibility: 'public',
            is_draft:   false,
            slug:       null,
        }));
    }

    // ─── КАТАЛОГ ПУБЛИЧНЫХ СТАТЕЙ ─────────────────────────────────────────────
    async function getPublicArticles(query, limit, offset) {
        _requireConfig();
        const res = await _rpc('search_public_articles', {
            p_query:  query  || '',
            p_limit:  limit  || 20,
            p_offset: offset || 0,
        });
        return Array.isArray(res) ? res : [];
    }

    // ─── HTTP-УТИЛИТЫ ────────────────────────────────────────────────────────
    function _requireConfig() {
        if (!supabaseUrl || !supabaseKey) {
            throw new Error('[CogneeSupabase] Supabase не настроен. Добавь ключи в config.js');
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
            method, headers,
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
        if (!supabaseUrl || !supabaseKey) return null;

        const headers = {
            'Content-Type': 'application/json',
            'apikey':  supabaseKey,
            'Prefer':  'return=minimal',
        };
        if (method === 'GET') headers['Accept'] = 'application/json';
        if (currentSession?.access_token) {
            headers['Authorization'] = 'Bearer ' + currentSession.access_token;
        }
        // extraHeaders перезаписывает дефолты (в т.ч. Prefer)
        if (extraHeaders) Object.assign(headers, extraHeaders);

        const res = await fetch(supabaseUrl + path, {
            method, headers,
            body: body ? JSON.stringify(body) : undefined,
        });

        // 401 → обновляем токен и повторяем один раз
        if (res.status === 401 && currentSession?.refresh_token) {
            const ok = await _refreshToken();
            if (ok) return _dbFetch(method, path, body, extraHeaders);
            return null;
        }

        if (!res.ok && res.status !== 204) {
            const err = await res.json().catch(() => ({}));
            // Подробное логирование для диагностики (видно в консоли браузера)
            console.warn('[CogneeSupabase v8.4.2] DB error ' + res.status,
                method, path.split('?')[0], err?.message || err?.hint || JSON.stringify(err));
            return null;
        }

        const text = await res.text();
        return text ? JSON.parse(text) : {};
    }

    async function _rpc(fnName, params) {
        if (!supabaseUrl || !supabaseKey) return null;
        const headers = {
            'Content-Type': 'application/json',
            'apikey': supabaseKey,
        };
        if (currentSession?.access_token) {
            headers['Authorization'] = 'Bearer ' + currentSession.access_token;
        }
        const res = await fetch(supabaseUrl + '/rest/v1/rpc/' + fnName, {
            method: 'POST', headers,
            body: JSON.stringify(params || {}),
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            console.warn('[CogneeSupabase v8.4.2] RPC ' + fnName + ' error ' + res.status,
                err?.message || err?.hint || JSON.stringify(err));
            return null;
        }
        const text = await res.text();
        return text ? JSON.parse(text) : [];
    }

    async function _verifyToken(token) {
        try {
            const res = await fetch(supabaseUrl + '/auth/v1/user', {
                headers: { 'apikey': supabaseKey, 'Authorization': 'Bearer ' + token }
            });
            if (!res.ok) return null;
            const data = await res.json();
            return data.id
                ? { id: data.id, email: data.email, display_name: data.user_metadata?.display_name }
                : null;
        } catch (e) { return null; }
    }

    // ─── ОБНОВЛЕНИЕ ТОКЕНА ───────────────────────────────────────────────────
    let _refreshPromise = null;

    async function _refreshToken() {
        if (!currentSession?.refresh_token) { _clearSession(); return false; }
        if (_refreshPromise) return _refreshPromise;

        _refreshPromise = (async () => {
            try {
                const res = await fetch(supabaseUrl + '/auth/v1/token?grant_type=refresh_token', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'apikey': supabaseKey },
                    body: JSON.stringify({ refresh_token: currentSession.refresh_token }),
                });
                if (!res.ok) {
                    console.warn('[CogneeSupabase v8.4.2] Refresh failed ' + res.status + ' — выход');
                    _clearSession();
                    _dispatchAuthEvent('signed_out', null);
                    return false;
                }
                const data = await res.json();
                _saveSession(data);
                if (data.user) currentUser = _extractUser(data);
                console.log('[CogneeSupabase v8.4.2] Токен обновлён.');
                return true;
            } catch (e) {
                console.warn('[CogneeSupabase v8.4.2] Refresh error:', e.message);
                _clearSession();
                return false;
            } finally {
                _refreshPromise = null;
            }
        })();

        return _refreshPromise;
    }

    function _saveSession(data) {
        currentSession = { access_token: data.access_token, refresh_token: data.refresh_token };
        try { localStorage.setItem('cognee_session', JSON.stringify(currentSession)); } catch (e) {}
    }

    function _clearSession() {
        currentSession = null; currentUser = null;
        try { localStorage.removeItem('cognee_session'); } catch (e) {}
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
        if (!currentUser?.id) return null;
        const profile = {
            id: currentUser.id, email: currentUser.email,
            display_name: currentUser.display_name, created_at: new Date().toISOString(),
        };
        const res = await _dbFetch('POST', '/rest/v1/users', [profile],
            { 'Prefer': 'resolution=merge-duplicates,return=minimal' });
        if (res === null) {
            await _dbFetch('POST', '/rest/v1/users', [profile],
                { 'Prefer': 'resolution=ignore-duplicates,return=minimal' });
        }
        return profile;
    }

    function _dispatchAuthEvent(type, user) {
        window.dispatchEvent(new CustomEvent('cognee:auth', { detail: { type, user } }));
    }

    // ─── ЭКСПОРТ ─────────────────────────────────────────────────────────────
    window.CogneeSupabase = {
        init, signUp, signIn, signOut, getUser, isAuthenticated,
        syncKIMHistory, saveKIMRemote, getUserProfile, updateProfile,
        publishArticle, getArticleById, getUserArticles, getUserArticlesFull,
        updateArticle, deleteArticle, getPublicArticles,
    };

    console.log('[CogneeSupabase v8.4.2] Загружен. Ожидает init().');
})();
