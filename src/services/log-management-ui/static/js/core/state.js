/**
 * LogPanel.state — minimal namespace + pub/sub.
 *
 * Mevcut dashboard.js'in kendi global'leri ile catismaz; sadece yeni
 * modullerin paylasilan veriyi (ornekte mevcut kullanici, secili tab)
 * birbirinden alabilmesi icin tasarlandi.
 */
(function attachLogPanelState(global) {
    'use strict';

    const NS = global.LogPanel = global.LogPanel || {};
    if (NS.state && NS.state.__sealed) return;

    const data = {
        currentUser: null,
        currentRole: null,
        currentTab: null,
        cache: {},
        flags: {}
    };

    const listeners = {};

    function emit(event, payload) {
        const arr = listeners[event];
        if (!arr || !arr.length) return;
        arr.slice().forEach(fn => {
            try { fn(payload); } catch (e) { /* listener hatasi yutulur */ }
        });
    }

    function on(event, fn) {
        if (typeof fn !== 'function') return () => {};
        if (!listeners[event]) listeners[event] = [];
        listeners[event].push(fn);
        return () => {
            const arr = listeners[event] || [];
            const i = arr.indexOf(fn);
            if (i !== -1) arr.splice(i, 1);
        };
    }

    function set(key, value) {
        data[key] = value;
        emit('change:' + key, value);
        emit('change', { key, value });
    }

    function get(key) {
        return data[key];
    }

    function setUser(user, role) {
        data.currentUser = user || null;
        data.currentRole = role || (user && user.role) || null;
        emit('change:currentUser', data.currentUser);
        emit('change:currentRole', data.currentRole);
    }

    function isAdmin() {
        const r = String(data.currentRole || '').toLowerCase();
        return r === 'admin' || r === 'administrator' || r === 'superuser';
    }

    function hasRole(...roles) {
        const r = String(data.currentRole || '').toLowerCase();
        return roles.some(x => String(x).toLowerCase() === r);
    }

    NS.state = {
        __sealed: true,
        data,
        get,
        set,
        on,
        emit,
        setUser,
        isAdmin,
        hasRole
    };
})(window);
