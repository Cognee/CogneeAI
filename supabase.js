// supabase.js — v8.5
// Файл: supabase.js | Глобальная версия: 8.5
// Изменения v8.5:
//   • Экспортированы _dbFetch, _rpc, getCurrentUser (нужны для favorites/reports/moderation)
//   • addFavorite, removeFavorite, isFavorited — удобные хелперы для избранного
//   • submitReport — хелпер для жалобы
//   • isModerator — проверка статуса модератора (кеш на сессию)
// ВАЖНО: подключать ПОСЛЕ storage.js, ДО adapter.js

(function () {
    'use strict';

    let supabaseUrl     = null;
    let supabaseKey     = null;
    let currentSession  = null;
    let currentUser     = null;
    let _refreshPromise = null;
    let _isModeratorCache = null; // null = не проверялось

    // ─── ИНИЦИАЛИЗАЦИЯ ───────────────────────────────────────────────────────
    async function init() {
        supabaseUrl = window.COGNEE_SUPABASE_URL || null;
        supabaseKey = window.COGNEE_SUPABASE_KEY || null;

        if (!supabaseUrl || !supabaseKey) {
            console.warn('[CogneeSupabase v8.5] URL или ключ не заданы — работаем офлайн.');
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
                        console.log('[CogneeSupabase v8.5] Сессия восстановлена:', currentUser.email);
                        _dispatchAuthEvent('signed_in', currentUser);
                        // Запускаем авто-обновление токена через 50 минут
                        setTimeout(() => _refreshToken(), 50 * 60 * 1000);
                        return true;
                    }
                }
            }
        } catch (e) {
            localStorage.removeItem('cognee_session');
        }

        console.log('[CogneeSupabase v8.5] Инициализирован. Не авторизован.');
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
            _upsertProfile().catch(e => console.warn('[CogneeSupabase v8.5] upsert on signup:', e.message));
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
        _isModeratorCache = null; // сброс кеша при новом входе
        _dispatchAuthEvent('signed_in', currentUser);
        setTimeout(() => _refreshToken(), 50 * 60 * 1000);
        syncKIMHistory().catch(err => console.warn('[CogneeSupabase v8.5] Sync KIM error:', err));
        return currentUser;
    }

    // ─── ВЫХОД ───────────────────────────────────────────────────────────────
    async function signOut() {
        if (!currentSession) return;
        try { await _fetch('/auth/v1/logout', 'POST', {}, true); } catch (e) {}
        _clearSession();
        _isModeratorCache = null;
        _dispatchAuthEvent('signed_out', null);
    }

    function getUser()         { return currentUser; }
    function getCurrentUser()  { return currentUser; }  // алиас (удобен в reader/moderation)
    function isAuthenticated() { return !!(currentSession && currentUser); }

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
        const res = await _dbFetch('PATCH',
            '/rest/v1/users?id=eq.' + currentUser.id, patch,
            { 'Prefer': 'return=representation' });
        if (res && res[0]) {
            currentUser.display_name = res[0].display_name || currentUser.display_name;
        }
        return res?.[0] || null;
    }

    // ─── КИМ ─────────────────────────────────────────────────────────────────
    async function syncKIMHistory() {
        if (!isAuthenticated()) return;
        const local = (window.CogneeStorage?.getHistory?.() || []).slice(-100);
        if (!local.length) return;
        const rows = local.map(h => ({
            user_id:   currentUser.id,
            kim:       h.kim,
            zone:      h.zone || 'normal',
            timestamp: h.timestamp || new Date().toISOString(),
        }));
        await _dbFetch('POST', '/rest/v1/kim_history', rows,
            { 'Prefer': 'resolution=ignore-duplicates,return=minimal' });
    }

    async function saveKIMRemote(kim, zone, ts) {
        if (!isAuthenticated()) return;
        const row = {
            user_id:   currentUser.id,
            kim:       parseFloat(kim.toFixed(1)),
            zone:      zone || 'normal',
            timestamp: ts  || new Date().toISOString(),
        };
        await _dbFetch('POST', '/rest/v1/kim_history', [row],
            { 'Prefer': 'resolution=ignore-duplicates,return=minimal' });
    }

    // ─── ИЗБРАННОЕ (v8.5) ────────────────────────────────────────────────────
    async function addFavorite(articleId) {
        if (!isAuthenticated()) throw new Error('Не авторизован');
        await _dbFetch('POST', '/rest/v1/favorites',
            [{ user_id: currentUser.id, article_id: articleId }]);
    }

    async function removeFavorite(articleId) {
        if (!isAuthenticated()) throw new Error('Не авторизован');
        await _dbFetch('DELETE',
            '/rest/v1/favorites?article_id=eq.' + articleId +
            '&user_id=eq.' + currentUser.id);
    }

    async function isFavorited(articleId) {
        if (!isAuthenticated()) return false;
        const res = await _dbFetch('GET',
            '/rest/v1/favorites?article_id=eq.' + articleId +
            '&user_id=eq.' + currentUser.id + '&select=id');
        return Array.isArray(res) && res.length > 0;
    }

    async function getFavorites() {
        if (!isAuthenticated()) return [];
        const res = await _dbFetch('GET',
            '/rest/v1/favorites?user_id=eq.' + currentUser.id +
            '&select=id,article_id,created_at,articles(id,title,annotation,published_at)' +
            '&order=created_at.desc');
        return Array.isArray(res) ? res : [];
    }

    // ─── ЖАЛОБЫ (v8.5) ───────────────────────────────────────────────────────
    async function submitReport(articleId, reason, comment) {
        if (!isAuthenticated()) throw new Error('Не авторизован');
        await _dbFetch('POST', '/rest/v1/reports', [{
            article_id:  articleId,
            reporter_id: currentUser.id,
            reason:      reason,
            comment:     comment || null,
            status:      'pending',
        }]);
    }

    // ─── МОДЕРАЦИЯ (v8.5) ────────────────────────────────────────────────────
    async function isModerator() {
        if (!isAuthenticated()) return false;
        if (_isModeratorCache !== null) return _isModeratorCache;
        const res = await _dbFetch('GET',
            '/rest/v1/moderators?user_id=eq.' + currentUser.id +
            '&is_active=eq.true&select=user_id');
        _isModeratorCache = Array.isArray(res) && res.length > 0;
        return _isModeratorCache;
    }

    async function getPendingReports(limit, offset) {
        const res = await _rpc('get_pending_reports', {
            p_limit:  limit  || 50,
            p_offset: offset || 0,
        });
        return Array.isArray(res) ? res : [];
    }

    async function resolveReport(reportId, status, hideArticle) {
        await _rpc('resolve_report', {
            p_report_id:    reportId,
            p_status:       status,
            p_hide_article: !!hideArticle,
        });
    }

    // ─── СТАТЬИ ──────────────────────────────────────────────────────────────
    async function publishArticle(data) {
        _requireConfig();
        if (!isAuthenticated()) throw new Error('Не авторизован');

        await _upsertProfile().catch(e => {
            console.warn('[CogneeSupabase v8.5] upsert before publish:', e.message);
        });

        function _makeSlug(n) {
            const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
            let s = '';
            for (let i = 0; i < n; i++) s += chars[Math.floor(Math.random() * chars.length)];
            return s;
        }

        const slug       = _makeSlug(8);
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
        console.log('[CogneeSupabase v8.5] Статья сохранена. id=' + id + ' slug=' + slug);
        return { id, slug };
    }

    async function updateArticle(id, data) {
        _requireConfig();
        if (!isAuthenticated()) throw new Error('Не авторизован');
        const patch = {};
        ['title','content','content_simple','keywords','annotation','visibility','is_draft']
            .forEach(k => { if (data[k] !== undefined) patch[k] = data[k]; });
        if (patch.is_draft === false) patch.published_at = new Date().toISOString();
        await _dbFetch('PATCH',
            '/rest/v1/articles?id=eq.' + id + '&user_id=eq.' + currentUser.id, patch);
        console.log('[CogneeSupabase v8.5] Статья ' + id + ' обновлена.');
    }

    async function deleteArticle(id) {
        _requireConfig();
        if (!isAuthenticated()) throw new Error('Не авторизован');
        await _dbFetch('DELETE',
            '/rest/v1/articles?id=eq.' + id + '&user_id=eq.' + currentUser.id);
        console.log('[CogneeSupabase v8.5] Статья ' + id + ' удалена.');
    }

    async function getArticleById(id) {
        _requireConfig();
        const strId = String(id);

        if (/^\d+$/.test(strId)) {
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

            const pub = await _dbFetch('GET',
                '/rest/v1/articles?id=eq.' + strId +
                '&visibility=eq.public&is_draft=eq.false' +
                '&select=id,title,content,content_simple,keywords,annotation,' +
                'published_at,user_id,visibility,slug,is_draft,users(display_name)');
            if (pub && pub[0]) {
                const a = pub[0];
                return { ...a, author_name: a.users?.display_name || 'Автор' };
            }

            return { _private: true };
        }

        if (/^[a-z0-9]{6,16}$/.test(strId)) {
            const res = await _rpc('get_article_by_slug', { p_slug: strId });
            if (res && res[0]) return { ...res[0], author_name: res[0].author_name || 'Автор' };
            return null;
        }

        return null;
    }

    async function getUserArticles() {
        if (!isAuthenticated()) return [];
        const res = await _dbFetch('GET',
            '/rest/v1/articles?user_id=eq.' + currentUser.id +
            '&select=id,title,annotation,published_at&order=published_at.desc');
        return Array.isArray(res) ? res : [];
    }

    async function getUserArticlesFull() {
        if (!isAuthenticated()) return [];
        const res = await _dbFetch('GET',
            '/rest/v1/articles?user_id=eq.' + currentUser.id +
            '&select=id,title,annotation,published_at,visibility,is_draft,slug' +
            '&order=published_at.desc');
        if (Array.isArray(res)) return res;

        console.warn('[CogneeSupabase v8.5] Fallback getUserArticlesFull. Примените supabase_migration_v8_4.sql!');
        const fallback = await _dbFetch('GET',
            '/rest/v1/articles?user_id=eq.' + currentUser.id +
            '&select=id,title,annotation,published_at&order=published_at.desc');
        if (!Array.isArray(fallback)) return [];
        return fallback.map(a => ({ ...a, visibility: 'public', is_draft: false, slug: null }));
    }

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
        if (!supabaseUrl || !supabaseKey)
            throw new Error('[CogneeSupabase v8.5] Supabase не настроен. Добавь ключи в config.js');
    }

    async function _fetch(path, method, body, withAuth) {
        const headers = { 'Content-Type': 'application/json', 'apikey': supabaseKey };
        if (withAuth && currentSession)
            headers['Authorization'] = 'Bearer ' + currentSession.access_token;
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
        if (currentSession?.access_token)
            headers['Authorization'] = 'Bearer ' + currentSession.access_token;
        if (extraHeaders) Object.assign(headers, extraHeaders);

        const res = await fetch(supabaseUrl + path, {
            method, headers,
            body: body ? JSON.stringify(body) : undefined,
        });

        if (res.status === 401 && currentSession?.refresh_token) {
            const ok = await _refreshToken();
            if (ok) return _dbFetch(method, path, body, extraHeaders);
            return null;
        }

        if (!res.ok && res.status !== 204) {
            const err = await res.json().catch(() => ({}));
            console.warn('[CogneeSupabase v8.5] DB error ' + res.status,
                method, path.split('?')[0], err?.message || err?.hint || JSON.stringify(err));
            // Бросаем ошибку с кодом — нужно для обработки duplicate в submitReport
            const e = new Error(err?.message || 'DB error ' + res.status);
            e.code  = err?.code || String(res.status);
            throw e;
        }

        const text = await res.text();
        return text ? JSON.parse(text) : {};
    }

    async function _rpc(fnName, params) {
        if (!supabaseUrl || !supabaseKey) return null;
        const headers = { 'Content-Type': 'application/json', 'apikey': supabaseKey };
        if (currentSession?.access_token)
            headers['Authorization'] = 'Bearer ' + currentSession.access_token;
        const res = await fetch(supabaseUrl + '/rest/v1/rpc/' + fnName, {
            method: 'POST', headers,
            body: JSON.stringify(params || {}),
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            console.warn('[CogneeSupabase v8.5] RPC ' + fnName + ' error ' + res.status,
                err?.message || err?.hint || JSON.stringify(err));
            const e = new Error(err?.message || 'RPC error ' + res.status);
            e.code  = err?.code || String(res.status);
            throw e;
        }
        const text = await res.text();
        return text ? JSON.parse(text) : {};
    }

    // ─── ТОКЕНЫ ──────────────────────────────────────────────────────────────
    async function _verifyToken(token) {
        const res = await _fetch('/auth/v1/user', 'GET', null, false);
        // _fetch не передаёт токен без withAuth — делаем вручную
        const headers = { 'Content-Type': 'application/json', 'apikey': supabaseKey,
            'Authorization': 'Bearer ' + token };
        const r = await fetch(supabaseUrl + '/auth/v1/user', { headers });
        if (!r.ok) return null;
        const data = await r.json();
        return data?.id ? _extractUser({ user: data }) : null;
    }

    let _refreshPromise2 = null; // отдельный промис чтобы не конфликтовать с полем модуля
    async function _refreshToken() {
        if (_refreshPromise2) return _refreshPromise2;
        _refreshPromise2 = (async () => {
            try {
                const res = await _fetch('/auth/v1/token?grant_type=refresh_token', 'POST',
                    { refresh_token: currentSession.refresh_token });
                if (res.error || !res.access_token) { _clearSession(); return false; }
                _saveSession(res);
                currentUser = _extractUser(res);
                console.log('[CogneeSupabase v8.5] Токен обновлён');
                setTimeout(() => _refreshToken(), 50 * 60 * 1000);
                return true;
            } catch (e) {
                console.warn('[CogneeSupabase v8.5] Refresh error:', e.message);
                _clearSession();
                return false;
            } finally {
                _refreshPromise2 = null;
            }
        })();
        return _refreshPromise2;
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
        return profile;
    }

    function _dispatchAuthEvent(type, user) {
        window.dispatchEvent(new CustomEvent('cognee:auth', { detail: { type, user } }));
    }

    // ─── ЭКСПОРТ ─────────────────────────────────────────────────────────────
    window.CogneeSupabase = {
        // Auth
        init, signUp, signIn, signOut, getUser, getCurrentUser, isAuthenticated,
        // КИМ
        syncKIMHistory, saveKIMRemote,
        // Профиль
        getUserProfile, updateProfile,
        // Статьи
        publishArticle, getArticleById, getUserArticles, getUserArticlesFull,
        updateArticle, deleteArticle, getPublicArticles,
        // Избранное (v8.5)
        addFavorite, removeFavorite, isFavorited, getFavorites,
        // Жалобы (v8.5)
        submitReport,
        // Модерация (v8.5)
        isModerator, getPendingReports, resolveReport,
        // Низкоуровневые (используются в reader/moderation inline-скриптах)
        _dbFetch, _rpc,
    };

    console.log('[CogneeSupabase v8.5] Загружен. Ожидает init().');
})();
