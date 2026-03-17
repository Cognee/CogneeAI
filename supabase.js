// supabase.js — v8.4
// Файл: supabase.js | Глобальная версия: 8.4
// Блок 4: Видимость статей, приватные slug-ссылки, черновики, каталог, удаление, редактирование.
// Изменения v8.4:
//   - publishArticle теперь принимает { ..., visibility, is_draft, slug }
//   - getArticleById поддерживает slug (через RPC get_article_by_slug)
//   - добавлены: deleteArticle, updateArticle, getUserArticlesFull, getPublicArticles
//   - _generateSlug() — генератор приватных ключей на клиенте
// ВАЖНО: подключать ПОСЛЕ storage.js, ДО adapter.js
// Экспортирует window.CogneeSupabase = { init, signUp, signIn, signOut, getUser,
//   isAuthenticated, syncKIMHistory, saveKIMRemote, getUserProfile, updateProfile,
//   publishArticle, getArticleById, getUserArticles, getUserArticlesFull,
//   deleteArticle, updateArticle, getPublicArticles }

(function () {
    'use strict';

    // ─── КОНФИГ (задаётся через config.js) ──────────────────────────────────
    let supabaseUrl = null;
    let supabaseKey = null;
    let currentSession = null;
    let currentUser = null;

    // ─── ИНИЦИАЛИЗАЦИЯ ───────────────────────────────────────────────────────
    async function init() {
        supabaseUrl = window.COGNEE_SUPABASE_URL || null;
        supabaseKey = window.COGNEE_SUPABASE_KEY || null;

        if (!supabaseUrl || !supabaseKey) {
            console.warn('[CogneeSupabase] URL или ключ не заданы — работаем офлайн (localStorage only).');
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
                        currentUser = verified;
                        console.log('[CogneeSupabase v8.4] Сессия восстановлена:', currentUser.email);
                        _dispatchAuthEvent('signed_in', currentUser);
                        return true;
                    }
                }
            }
        } catch (e) {
            localStorage.removeItem('cognee_session');
        }

        console.log('[CogneeSupabase v8.4] Инициализирован. Пользователь не авторизован.');
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

        if (res.access_token) {
            _saveSession(res);
            currentUser = _extractUser(res);
            _dispatchAuthEvent('signed_up', currentUser);
            _upsertProfile().catch(e => console.warn('[CogneeSupabase v8.4] upsert profile on signup:', e.message));
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

        syncKIMHistory().catch(err => console.warn('[CogneeSupabase v8.4] Ошибка синхронизации КИМ:', err));

        return currentUser;
    }

    // ─── ВЫХОД ───────────────────────────────────────────────────────────────
    async function signOut() {
        if (!currentSession) return;

        try {
            await _fetch('/auth/v1/logout', 'POST', {}, true);
        } catch (e) {}

        _clearSession();
        _dispatchAuthEvent('signed_out', null);
        console.log('[CogneeSupabase v8.4] Выход выполнен.');
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

        return await _upsertProfile();
    }

    async function updateProfile(data) {
        if (!isAuthenticated()) throw new Error('Не авторизован');
        const allowed = ['display_name'];
        const patch = {};
        allowed.forEach(k => { if (data[k] !== undefined) patch[k] = data[k]; });

        const res = await _dbFetch('PATCH', `/rest/v1/users?id=eq.${currentUser.id}`, patch);
        if (currentUser) Object.assign(currentUser, patch);
        return res;
    }

    // ─── СИНХРОНИЗАЦИЯ КИМ-ИСТОРИИ ───────────────────────────────────────────
    async function syncKIMHistory() {
        if (!isAuthenticated()) return;
        if (!window.CogneeStorage) return;

        const history = window.CogneeStorage.getHistory();
        if (!history || history.length === 0) return;

        const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
        const recent = history.filter(r => r.timestamp > cutoff);
        if (recent.length === 0) return;

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

        console.log(`[CogneeSupabase v8.4] Синхронизировано ${recent.length} записей КИМ.`);
    }

    // ─── СОХРАНЕНИЕ ОДНОЙ ЗАПИСИ КИМ ─────────────────────────────────────────
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

    // ─── СТАТЬИ ──────────────────────────────────────────────────────────────

    /**
     * Генерирует случайный 8-символьный slug для приватных статей.
     * Алфавит: строчные буквы + цифры (без 0, o, l, 1 для читаемости).
     */
    function _generateSlug() {
        const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
        let result = '';
        const arr = new Uint8Array(8);
        crypto.getRandomValues(arr);
        arr.forEach(b => { result += chars[b % chars.length]; });
        return result;
    }

    /**
     * Публикует статью в Supabase.
     * @param {object} data — {
     *   title, content, content_simple, keywords, annotation,
     *   visibility: 'public'|'private',  // по умолчанию 'public'
     *   is_draft: boolean                 // по умолчанию false
     * }
     * @returns {Promise<{id: string, slug: string}>}
     */
    async function publishArticle(data) {
        _requireConfig();
        if (!isAuthenticated()) throw new Error('Не авторизован');

        await _upsertProfile();

        const slug = _generateSlug();
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
            visibility,
            is_draft,
            slug,
        };

        const res = await _dbFetch('POST', '/rest/v1/articles', [payload], {
            'Prefer': 'return=representation'
        });

        if (!res || !res[0]) throw new Error('Supabase не вернул ID статьи');

        const id = String(res[0].id);
        console.log(`[CogneeSupabase v8.4] Статья сохранена. id=${id}, slug=${slug}, visibility=${visibility}, is_draft=${is_draft}`);
        return { id, slug };
    }

    /**
     * Обновляет существующую статью (только свою).
     * @param {string|number} id
     * @param {object} data — те же поля что в publishArticle, все опциональны
     * @returns {Promise<void>}
     */
    async function updateArticle(id, data) {
        _requireConfig();
        if (!isAuthenticated()) throw new Error('Не авторизован');

        const allowed = [
            'title', 'content', 'content_simple', 'keywords',
            'annotation', 'visibility', 'is_draft'
        ];
        const patch = {};
        allowed.forEach(k => { if (data[k] !== undefined) patch[k] = data[k]; });

        // Если публикуем черновик — обновляем published_at
        if (patch.is_draft === false) {
            patch.published_at = new Date().toISOString();
        }

        await _dbFetch(
            'PATCH',
            `/rest/v1/articles?id=eq.${id}&user_id=eq.${currentUser.id}`,
            patch
        );

        console.log(`[CogneeSupabase v8.4] Статья ${id} обновлена.`);
    }

    /**
     * Удаляет статью (только свою).
     * @param {string|number} id
     * @returns {Promise<void>}
     */
    async function deleteArticle(id) {
        _requireConfig();
        if (!isAuthenticated()) throw new Error('Не авторизован');

        await _dbFetch(
            'DELETE',
            `/rest/v1/articles?id=eq.${id}&user_id=eq.${currentUser.id}`
        );

        console.log(`[CogneeSupabase v8.4] Статья ${id} удалена.`);
    }

    /**
     * Загружает статью по числовому ID или slug.
     * - Числовой ID: возвращает только публичную опубликованную статью
     *   (для чужих) или любую (для автора).
     * - Slug: вызывает RPC get_article_by_slug — работает для всех.
     * @param {string} id — числовой id или slug
     * @returns {Promise<object|null>}
     */
    async function getArticleById(id) {
        _requireConfig();

        // Числовой ID
        if (/^\d+$/.test(id)) {
            // Для авторизованного пользователя — пробуем получить свою статью
            if (isAuthenticated()) {
                const mine = await _dbFetch(
                    'GET',
                    `/rest/v1/articles?id=eq.${id}&user_id=eq.${currentUser.id}&select=id,title,content,content_simple,keywords,annotation,published_at,user_id,visibility,slug,is_draft,users(display_name)`
                );
                if (mine && mine[0]) {
                    const a = mine[0];
                    return { ...a, author_name: a.users?.display_name || 'Автор' };
                }
            }

            // Публичная статья — для всех
            const pub = await _dbFetch(
                'GET',
                `/rest/v1/articles?id=eq.${id}&visibility=eq.public&is_draft=eq.false&select=id,title,content,content_simple,keywords,annotation,published_at,user_id,visibility,slug,is_draft,users(display_name)`
            );
            if (pub && pub[0]) {
                const a = pub[0];
                return { ...a, author_name: a.users?.display_name || 'Автор' };
            }

            // Статья существует но приватная — сигнал для заглушки
            // Проверяем: есть ли статья с таким id вообще?
            const exists = await _dbFetch(
                'GET',
                `/rest/v1/articles?id=eq.${id}&select=id,visibility`
            );
            if (exists && exists[0] && exists[0].visibility === 'private') {
                return { _private: true };
            }

            return null;
        }

        // Slug — вызываем RPC (обходит RLS через SECURITY DEFINER)
        if (/^[a-z0-9]{6,16}$/.test(id)) {
            const res = await _rpc('get_article_by_slug', { p_slug: id });
            if (res && res[0]) {
                return { ...res[0], author_name: res[0].author_name || 'Автор' };
            }
        }

        return null;
    }

    /**
     * Список статей текущего пользователя (краткий — для обратной совместимости).
     */
    async function getUserArticles() {
        if (!isAuthenticated()) return [];
        const res = await _dbFetch(
            'GET',
            `/rest/v1/articles?user_id=eq.${currentUser.id}&select=id,title,annotation,keywords,published_at&order=published_at.desc`
        );
        return Array.isArray(res) ? res : [];
    }

    /**
     * Полный список статей текущего пользователя (с is_draft, visibility, slug).
     * Используется в профиле для отображения всех статей и черновиков.
     * @returns {Promise<Array>}
     */
    async function getUserArticlesFull() {
        if (!isAuthenticated()) return [];
        const res = await _dbFetch(
            'GET',
            `/rest/v1/articles?user_id=eq.${currentUser.id}&select=id,title,annotation,keywords,published_at,visibility,is_draft,slug&order=published_at.desc`
        );
        return Array.isArray(res) ? res : [];
    }

    /**
     * Поиск публичных статей для каталога.
     * Вызывает RPC search_public_articles.
     * @param {string} query — строка поиска (пустая = все)
     * @param {number} limit
     * @param {number} offset
     * @returns {Promise<Array>}
     */
    async function getPublicArticles(query = '', limit = 20, offset = 0) {
        _requireConfig();
        const res = await _rpc('search_public_articles', {
            p_query:  query,
            p_limit:  limit,
            p_offset: offset,
        });
        return Array.isArray(res) ? res : [];
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
        if (!supabaseUrl || !supabaseKey) return null;

        const headers = {
            'Content-Type': 'application/json',
            'apikey': supabaseKey,
            'Prefer': 'return=minimal',
        };

        if (currentSession?.access_token) {
            headers['Authorization'] = 'Bearer ' + currentSession.access_token;
        }

        if (extraHeaders) Object.assign(headers, extraHeaders);

        // Если явно передан Prefer — не перезаписываем
        if (extraHeaders?.['Prefer']) headers['Prefer'] = extraHeaders['Prefer'];

        const res = await fetch(supabaseUrl + path, {
            method,
            headers,
            body: body ? JSON.stringify(body) : undefined,
        });

        // 401 → пробуем обновить токен и повторить один раз
        if (res.status === 401 && currentSession?.refresh_token) {
            const ok = await _refreshToken();
            if (ok) return _dbFetch(method, path, body, extraHeaders);
            return null;
        }

        if (!res.ok && res.status !== 204) {
            const err = await res.json().catch(() => ({}));
            console.warn('[CogneeSupabase v8.4] DB ошибка:', res.status, err);
            return null;
        }

        const text = await res.text();
        return text ? JSON.parse(text) : {};
    }

    /**
     * Вызов Supabase RPC-функции.
     */
    async function _rpc(fnName, params) {
        if (!supabaseUrl || !supabaseKey) return null;

        const headers = {
            'Content-Type': 'application/json',
            'apikey': supabaseKey,
        };

        if (currentSession?.access_token) {
            headers['Authorization'] = 'Bearer ' + currentSession.access_token;
        }

        const res = await fetch(`${supabaseUrl}/rest/v1/rpc/${fnName}`, {
            method: 'POST',
            headers,
            body: JSON.stringify(params || {}),
        });

        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            console.warn(`[CogneeSupabase v8.4] RPC ${fnName} ошибка:`, res.status, err);
            return null;
        }

        const text = await res.text();
        return text ? JSON.parse(text) : [];
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
            return data.id
                ? { id: data.id, email: data.email, display_name: data.user_metadata?.display_name }
                : null;
        } catch (e) {
            return null;
        }
    }

    // ─── ОБНОВЛЕНИЕ ТОКЕНА ───────────────────────────────────────────────────
    let _refreshPromise = null;

    async function _refreshToken() {
        if (!currentSession?.refresh_token) {
            _clearSession();
            return false;
        }

        if (_refreshPromise) return _refreshPromise;

        _refreshPromise = (async () => {
            try {
                const res = await fetch(supabaseUrl + '/auth/v1/token?grant_type=refresh_token', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'apikey': supabaseKey,
                    },
                    body: JSON.stringify({ refresh_token: currentSession.refresh_token }),
                });

                if (!res.ok) {
                    console.warn('[CogneeSupabase v8.4] Refresh failed:', res.status, '— выход');
                    _clearSession();
                    _dispatchAuthEvent('signed_out', null);
                    return false;
                }

                const data = await res.json();
                _saveSession(data);
                if (data.user) currentUser = _extractUser(data);
                console.log('[CogneeSupabase v8.4] Токен обновлён успешно');
                return true;
            } catch (e) {
                console.warn('[CogneeSupabase v8.4] Ошибка refresh:', e.message);
                _clearSession();
                return false;
            } finally {
                _refreshPromise = null;
            }
        })();

        return _refreshPromise;
    }

    function _saveSession(data) {
        currentSession = {
            access_token:  data.access_token,
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
        if (!currentUser?.id) return null;
        const profile = {
            id:           currentUser.id,
            email:        currentUser.email,
            display_name: currentUser.display_name,
            created_at:   new Date().toISOString(),
        };
        const res = await _dbFetch('POST', '/rest/v1/users', [profile], {
            'Prefer': 'resolution=merge-duplicates,return=minimal'
        });
        if (res === null) {
            await _dbFetch('POST', '/rest/v1/users', [profile], {
                'Prefer': 'resolution=ignore-duplicates,return=minimal'
            });
        }
        return profile;
    }

    function _dispatchAuthEvent(type, user) {
        window.dispatchEvent(new CustomEvent('cognee:auth', { detail: { type, user } }));
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
        getUserArticlesFull,
        deleteArticle,
        updateArticle,
        getPublicArticles,
    };

    console.log('[CogneeSupabase v8.4] Загружен. Ожидает init().');
})();
