// supabase.js — v9.3
// Файл: supabase.js | Глобальная версия: 9.3
// Исправления v9.3 (из аудита):
//   - БАГ: read_minutes не передавался в publishArticle payload → исправлено
//   - Добавлен saveFocusMinutes() — для лидерборда (Блок 3, Задача 3.2)
//   - Добавлен getLeaderboard() — топ по времени в focus
//   - Остальное: идентично v9.2

(function () {
    'use strict';

    let supabaseUrl       = null;
    let supabaseKey       = null;
    let currentSession    = null;
    let currentUser       = null;
    let _isModeratorCache = null;

    // ─── ЗАРЕЗЕРВИРОВАННЫЕ ИМЕНА ────────────────────────────────────────────
    const _RESERVED_NAMES = new Set([
        'admin', 'administrator', 'cognee', 'cogneeai', 'moderator',
        'system', 'support', 'root', 'superuser',
    ]);

    function _checkDisplayName(name) {
        if (!name) return null;
        const lower = (name || '').toLowerCase().trim();
        if (lower.length < 2)  return 'Имя слишком короткое — минимум 2 символа';
        if (lower.length > 30) return 'Имя слишком длинное — максимум 30 символов';
        if (_RESERVED_NAMES.has(lower)) {
            if (currentUser && (currentUser.display_name || '').toLowerCase().trim() === lower) return null;
            return 'Это имя зарезервировано и недоступно';
        }
        return null;
    }

    async function checkNameAvailable(name, userId) {
        const localErr = _checkDisplayName(name);
        if (localErr) return { available: false, error: localErr };
        if (!supabaseUrl || !supabaseKey) return { available: true, error: null };
        try {
            const uid = userId || currentUser?.id || null;
            const res = await _rpc('is_display_name_available', {
                p_name:    name.trim(),
                p_user_id: uid,
            });
            const available = res === true || res === 'true';
            return {
                available,
                error: available ? null : 'Это имя уже занято — попробуй другое',
            };
        } catch (e) {
            console.warn('[CogneeSupabase] checkNameAvailable error:', e.message);
            return { available: true, error: null };
        }
    }

    // ─── ИНИЦИАЛИЗАЦИЯ ───────────────────────────────────────────────────────
    async function init() {
        supabaseUrl = window.COGNEE_SUPABASE_URL || null;
        supabaseKey = window.COGNEE_SUPABASE_KEY || null;
        if (!supabaseUrl || !supabaseKey) {
            console.warn('[CogneeSupabase v9.3] URL или ключ не заданы — работаем офлайн.');
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
                        console.log('[CogneeSupabase v9.3] Сессия восстановлена:', currentUser.email);
                        _dispatchAuthEvent('signed_in', currentUser);
                        setTimeout(() => _refreshToken(), 50 * 60 * 1000);
                        return true;
                    }
                }
            }
        } catch (e) {
            localStorage.removeItem('cognee_session');
        }
        console.log('[CogneeSupabase v9.3] Инициализирован. Не авторизован.');
        return false;
    }

    // ─── AUTH ────────────────────────────────────────────────────────────────
    async function signUp(email, password, displayName) {
        _requireConfig();
        if (displayName) {
            const nameCheck = await checkNameAvailable(displayName, null);
            if (!nameCheck.available) throw new Error(nameCheck.error || 'Имя недоступно');
        }
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

    async function signIn(email, password) {
        _requireConfig();
        const res = await _fetch('/auth/v1/token?grant_type=password', 'POST', { email, password });
        if (res.error) throw new Error(res.error.message || 'Неверный email или пароль');
        _saveSession(res);
        currentUser = _extractUser(res);
        _isModeratorCache = null;
        _dispatchAuthEvent('signed_in', currentUser);
        setTimeout(() => _refreshToken(), 50 * 60 * 1000);
        syncKIMHistory().catch(err => console.warn('[CogneeSupabase] Sync KIM error:', err));
        return currentUser;
    }

    async function signOut() {
        if (!currentSession) return;
        try { await _fetch('/auth/v1/logout', 'POST', {}, true); } catch (e) {}
        _clearSession();
        _isModeratorCache = null;
        _dispatchAuthEvent('signed_out', null);
    }

    function getUser()         { return currentUser; }
    function getCurrentUser()  { return currentUser; }
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
        if (data.display_name) {
            const nameCheck = await checkNameAvailable(data.display_name, currentUser?.id);
            if (!nameCheck.available) throw new Error(nameCheck.error || 'Имя недоступно');
        }
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

    // ─── ЛИДЕРБОРД — FOCUS MINUTES (Блок 3, Задача 3.2) ─────────────────────

    /**
     * Сохраняет/добавляет минуты в focus-режиме для текущего пользователя.
     * Использует RPC add_focus_minutes из supabase_migration_v9_0.sql.
     */
    async function saveFocusMinutes(minutes) {
        if (!isAuthenticated() || !minutes || minutes <= 0) return;
        try {
            await _rpc('add_focus_minutes', {
                p_user_id: currentUser.id,
                p_minutes: Math.round(minutes),
            });
        } catch (e) {
            console.warn('[CogneeSupabase] saveFocusMinutes:', e.message);
        }
    }

    /**
     * Возвращает топ-20 пользователей по времени в focus-режиме за текущую неделю.
     */
    async function getLeaderboard() {
        _requireConfig();
        const monday = _getMonday();
        try {
            const res = await _dbFetch('GET',
                '/rest/v1/focus_log' +
                '?week_start=eq.' + monday +
                '&select=focus_minutes,user_id,users(display_name)' +
                '&order=focus_minutes.desc' +
                '&limit=20');
            if (!Array.isArray(res)) return [];
            return res.map(r => ({
                display_name:  r.users?.display_name || 'Аноним',
                focus_minutes: r.focus_minutes,
            }));
        } catch (e) {
            console.warn('[CogneeSupabase] getLeaderboard:', e.message);
            return [];
        }
    }

    /** Возвращает место текущего пользователя в лидерборде этой недели */
    async function getMyLeaderboardEntry() {
        if (!isAuthenticated()) return null;
        const monday = _getMonday();
        try {
            const res = await _dbFetch('GET',
                '/rest/v1/focus_log?user_id=eq.' + currentUser.id +
                '&week_start=eq.' + monday + '&select=focus_minutes');
            return (Array.isArray(res) && res[0]) ? res[0].focus_minutes : 0;
        } catch (e) {
            return 0;
        }
    }

    function _getMonday() {
        const d = new Date();
        const day = d.getDay();
        const diff = d.getDate() - day + (day === 0 ? -6 : 1);
        const monday = new Date(d.setDate(diff));
        return monday.toISOString().slice(0, 10);
    }

    // ─── ИЗБРАННОЕ ───────────────────────────────────────────────────────────
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

    // ─── ЖАЛОБЫ ──────────────────────────────────────────────────────────────
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

    // ─── МОДЕРАЦИЯ ───────────────────────────────────────────────────────────
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
            console.warn('[CogneeSupabase] upsert before publish:', e.message);
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

        // ── ИСПРАВЛЕНИЕ АУДИТА: read_minutes теперь передаётся в payload ──
        const payload = {
            user_id:         currentUser.id,
            title:           data.title,
            content:         data.content,
            content_simple:  data.content_simple || null,
            keywords:        Array.isArray(data.keywords) ? data.keywords : [],
            annotation:      data.annotation || null,
            tags:            Array.isArray(data.tags) ? data.tags : [],
            recommended_kim: data.recommended_kim || null,
            read_minutes:    data.read_minutes    || null,   // ← ИСПРАВЛЕНО: раньше не передавалось
            published_at:    new Date().toISOString(),
            visibility, is_draft, slug,
        };

        const res = await _dbFetch('POST', '/rest/v1/articles', [payload],
            { 'Prefer': 'return=representation' });

        if (!res || !res[0]) throw new Error('Supabase не вернул ID статьи');
        const id = String(res[0].id);
        console.log('[CogneeSupabase] Статья сохранена. id=' + id + ' slug=' + slug);
        return { id, slug };
    }

    async function updateArticle(id, data) {
        _requireConfig();
        if (!isAuthenticated()) throw new Error('Не авторизован');
        const patch = {};
        // read_minutes добавлен в список разрешённых полей
        ['title','content','content_simple','keywords','annotation','visibility',
         'is_draft','tags','recommended_kim','read_minutes']
            .forEach(k => { if (data[k] !== undefined) patch[k] = data[k]; });
        if (patch.is_draft === false) patch.published_at = new Date().toISOString();
        await _dbFetch('PATCH',
            '/rest/v1/articles?id=eq.' + id + '&user_id=eq.' + currentUser.id, patch);
        console.log('[CogneeSupabase] Статья ' + id + ' обновлена.');
    }

    async function deleteArticle(id) {
        _requireConfig();
        if (!isAuthenticated()) throw new Error('Не авторизован');
        await _dbFetch('DELETE',
            '/rest/v1/articles?id=eq.' + id + '&user_id=eq.' + currentUser.id);
        console.log('[CogneeSupabase] Статья ' + id + ' удалена.');
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
                    'tags,recommended_kim,read_minutes,published_at,user_id,visibility,slug,is_draft,users(display_name)');
                if (mine && mine[0]) {
                    const a = mine[0];
                    return { ...a, author_name: a.users?.display_name || 'Автор' };
                }
            }
            const pub = await _dbFetch('GET',
                '/rest/v1/articles?id=eq.' + strId +
                '&visibility=eq.public&is_draft=eq.false' +
                '&select=id,title,content,content_simple,keywords,annotation,' +
                'tags,recommended_kim,read_minutes,published_at,user_id,visibility,slug,is_draft,users(display_name)');
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

    // ─── HTTP ─────────────────────────────────────────────────────────────────
    function _requireConfig() {
        if (!supabaseUrl || !supabaseKey)
            throw new Error('[CogneeSupabase] Supabase не настроен. Добавь ключи в config.js');
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
            console.warn('[CogneeSupabase] DB error ' + res.status,
                method, path.split('?')[0], err?.message || err?.hint || JSON.stringify(err));
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
            console.warn('[CogneeSupabase] RPC ' + fnName + ' error ' + res.status,
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
        const headers = { 'Content-Type': 'application/json', 'apikey': supabaseKey,
            'Authorization': 'Bearer ' + token };
        const r = await fetch(supabaseUrl + '/auth/v1/user', { headers });
        if (!r.ok) return null;
        const data = await r.json();
        return data?.id ? _extractUser({ user: data }) : null;
    }

    let _refreshPromise = null;
    async function _refreshToken() {
        if (_refreshPromise) return _refreshPromise;
        _refreshPromise = (async () => {
            try {
                const res = await _fetch('/auth/v1/token?grant_type=refresh_token', 'POST',
                    { refresh_token: currentSession.refresh_token });
                if (res.error || !res.access_token) { _clearSession(); return false; }
                _saveSession(res);
                currentUser = _extractUser(res);
                console.log('[CogneeSupabase] Токен обновлён');
                setTimeout(() => _refreshToken(), 50 * 60 * 1000);
                return true;
            } catch (e) {
                console.warn('[CogneeSupabase] Refresh error:', e.message);
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
        await _dbFetch('POST', '/rest/v1/users', [profile],
            { 'Prefer': 'resolution=merge-duplicates,return=minimal' });
        return profile;
    }

    function _dispatchAuthEvent(type, user) {
        window.dispatchEvent(new CustomEvent('cognee:auth', { detail: { type, user } }));
    }

    // ─── ЭКСПОРТ ─────────────────────────────────────────────────────────────
    window.CogneeSupabase = {
        init, signUp, signIn, signOut, getUser, getCurrentUser, isAuthenticated,
        syncKIMHistory, saveKIMRemote,
        getUserProfile, updateProfile,
        publishArticle, getArticleById, getUserArticles, getUserArticlesFull,
        updateArticle, deleteArticle, getPublicArticles,
        addFavorite, removeFavorite, isFavorited, getFavorites,
        submitReport,
        isModerator, getPendingReports, resolveReport,
        saveFocusMinutes, getLeaderboard, getMyLeaderboardEntry,
        _dbFetch, _rpc,
        checkNameAvailable,
        checkDisplayName: _checkDisplayName,
    };

    console.log('[CogneeSupabase v9.3] Загружен. Ожидает init().');
})();
