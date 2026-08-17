'use strict';

// ═══ TOM SELECT INSTANCES REGISTRY ═══
const tsInstances = {};
function initTS(id, opts = {}) {
    if (tsInstances[id]) { try { tsInstances[id].destroy(); } catch (e) { } }
    const el = document.getElementById(id);
    if (!el) return;
    tsInstances[id] = new TomSelect(el, {
        placeholder: el.options[0]?.text || '— Select —',
        allowEmptyOption: true,
        maxOptions: 500,
        ...opts
    });
}
function tsSetValue(id, val) { if (tsInstances[id]) tsInstances[id].setValue(val, true); }
function tsGetValue(id) { const el = document.getElementById(id); return el ? el.value : ''; }
function tsRefresh(id) { if (tsInstances[id]) tsInstances[id].sync(); }
function tsClearOptions(id) {
    if (tsInstances[id]) { tsInstances[id].clearOptions(); tsInstances[id].clear(true); }
    else { const el = document.getElementById(id); if (el) { while (el.options.length > 1) el.remove(1); } }
}
function tsAddOptions(id, opts) {
    if (tsInstances[id]) {
        tsInstances[id].clearOptions();
        tsInstances[id].addOption({ value: '', text: tsInstances[id].settings.placeholder || '— Select —' });
        opts.forEach(o => tsInstances[id].addOption({ value: o.value || o, text: o.text || o.value || o }));
        tsInstances[id].refreshOptions(false);
    } else {
        const el = document.getElementById(id);
        if (!el) return;
        while (el.options.length > 1) el.remove(1);
        opts.forEach(o => { const opt = document.createElement('option'); opt.value = o.value || o; opt.text = o.text || o.value || o; el.appendChild(opt); });
    }
}

// ═══ AUTH — Supabase Auth (email/password, looked up via username) ═══
let currentUser = null;
let currentProfile = null;

function enterApp(profile) {
    currentProfile = profile;
    currentUser = profile.full_name || profile.username || profile.email;
    document.getElementById('loginScreen').classList.add('hidden');
    document.getElementById('appShell').style.display = 'grid';
    document.getElementById('sbUserName').textContent = currentUser;
    document.getElementById('sbAvatar').textContent = currentUser[0].toUpperCase();
    loadAll();
    toast(`👋 Welcome, ${currentUser}! Mombasa MCT Terminal TMS`, 'success');
    document.getElementById('loginError').style.display = 'none';
    initAllSearchableDropdowns();
}

async function fetchOwnProfile() {
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return null;
    const { data, error } = await sb.from('profiles').select('id, email, full_name, role, username').eq('id', user.id).single();
    if (error || !data) return null;
    return data;
}

async function doLogin() {
    const loginBtn = document.querySelector('.btn-login');
    const u = document.getElementById('loginUser').value.trim();
    const p = document.getElementById('loginPass').value.trim();
    const errEl = document.getElementById('loginError');
    if (!u || !p) { errEl.textContent = '⚠️ Enter username/email and password.'; errEl.style.display = 'block'; return; }
    if (loginBtn) { loginBtn.disabled = true; loginBtn.textContent = 'Signing in…'; }
    try {
        let email = u;
        if (!u.includes('@')) {
            const { data: lookedUpEmail, error: lookupErr } = await sb.rpc('get_email_for_username', { p_username: u.toLowerCase() });
            if (lookupErr || !lookedUpEmail) throw new Error('Invalid credentials');
            email = lookedUpEmail;
        }
        const { data: authData, error: authErr } = await sb.auth.signInWithPassword({ email, password: p });
        if (authErr || !authData?.user) throw new Error('Invalid credentials');
        const profile = await fetchOwnProfile();
        if (!profile) throw new Error('No profile found for this account');
        document.getElementById('loginPass').value = '';
        enterApp(profile);
    } catch (e) {
        errEl.textContent = '⚠️ Invalid credentials. Access denied.';
        errEl.style.display = 'block';
        document.getElementById('loginPass').value = '';
        document.getElementById('loginPass').focus();
    } finally {
        if (loginBtn) { loginBtn.disabled = false; loginBtn.textContent = 'Sign In to Terminal TMS'; }
    }
}

async function doLogout() {
    await sb.auth.signOut();
    currentUser = null;
    currentProfile = null;
    document.getElementById('appShell').style.display = 'none';
    document.getElementById('loginScreen').classList.remove('hidden');
    document.getElementById('loginUser').value = '';
    document.getElementById('loginPass').value = '';
    document.getElementById('loginError').style.display = 'none';
}

// Restore an existing Supabase session on page load (refresh without re-login).
// Called later, once `sb` (the Supabase client) has been initialized below.
async function restoreSession() {
    const { data: { session } } = await sb.auth.getSession();
    if (session) {
        const profile = await fetchOwnProfile();
        if (profile) enterApp(profile);
        else await sb.auth.signOut();
    }
}
document.getElementById('loginPass').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
document.getElementById('loginUser').addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('loginPass').focus(); });

// ═══ DATA LAYER — Supabase (source of truth) + localStorage (instant local cache / offline fallback) ═══
const SUPABASE_URL = 'https://ferxctlwemnxygacybku.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_bJ9D_4Npb8nOGleqIK2ICw_S6YS3D5a';
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
restoreSession();

const DB = { containers: [], logs: [], slips: [], shifts: [], shutouts: [], randomLoads: [] };
const ImportDB = { containers: [], logs: [] };
let charts = {}, bulkData = [];
const STORE_KEY = 'KPA_TMS_V10';
const IMP_STORAGE = 'KPA_TMS_IMP_V10';

// Explicit column maps for containers/import_containers — any object field not listed here is 
// preserved losslessly in the `extra` jsonb column, so the client model can evolve freely.
const CONTAINER_COL_MAP = { id: 'id', line: 'line', vessel: 'vessel', voyage: 'voyage', pod: 'pod', type: 'type', source: 'source', status: 'status', yard: 'yard', positionSlip: 'position_slip', wagon: 'wagon', bay: 'bay', ksBay: 'ks_bay', ksClerk: 'ks_clerk', loadedBy: 'loaded_by', weight: 'weight', height: 'height', shiftCount: 'shift_count', shutout: 'shutout', created: 'created_at', gatedAt: 'gated_at', loaded: 'loaded_at', movements: 'movements' };
const IMPORT_COL_MAP = { id: 'id', line: 'line', vessel: 'vessel', type: 'type', status: 'status', ttTag: 'tt_tag', yardBlock: 'yard_block', receivingClerk: 'receiving_clerk', rtgOperator: 'rtg_operator', releaseClerk: 'release_clerk', truckPlate: 'truck_plate', destination: 'destination', dischargedAt: 'discharged_at', releasedAt: 'released_at', movements: 'movements' };

function objToRow(obj, colMap) {
    const row = {}, extra = {};
    Object.keys(obj).forEach(k => { if (colMap[k]) row[colMap[k]] = obj[k] === undefined ? null : obj[k]; else extra[k] = obj[k]; });
    row.extra = extra; return row;
}
function rowToObj(row, colMap) {
    const rev = {}; Object.entries(colMap).forEach(([camel, snake]) => rev[snake] = camel);
    const obj = {};
    Object.keys(row).forEach(k => {
        if (k === 'extra') Object.assign(obj, row.extra || {});
        else if (k === 'updated_at') {/* internal only */ }
        else if (rev[k]) obj[rev[k]] = row[k];
    });
    return obj;
}
// Simple 1:1 field maps for the fully-modeled tables (no extra bucket needed).
const LOG_OUT = { id: r => r.id, container_id: r => r.containerId, action: r => r.action, detail: r => r.detail, user_name: r => r.user, time: r => r.time };
const LOG_IN = row => ({ id: row.id, containerId: row.container_id, action: row.action, detail: row.detail, user: row.user_name, time: row.time });
const ILOG_OUT = { id: r => r.id, container_id: r => r.containerId, action: r => r.action, detail: r => r.details, time: r => r.time };
const ILOG_IN = row => ({ id: row.id, containerId: row.container_id, action: row.action, details: row.detail, time: row.time });
const SLIP_OUT = s => ({ slip_no: s.slipNo, container_id: s.containerId, line: s.line, vessel: s.vessel, voyage: s.voyage, pod: s.pod, type: s.type, iso: s.iso, yard: s.yard, plate: s.plate, transco: s.transco, transtype: s.transtype, clerk: s.clerk, gate: s.gate, issued: s.issued, weight: s.weight, height: s.height, custom_inspection: s.customInspection, reference: s.reference });
const SLIP_IN = row => ({ slipNo: row.slip_no, containerId: row.container_id, line: row.line, vessel: row.vessel, voyage: row.voyage, pod: row.pod, type: row.type, iso: row.iso, yard: row.yard, plate: row.plate, transco: row.transco, transtype: row.transtype, clerk: row.clerk, gate: row.gate, issued: row.issued, weight: row.weight, height: row.height, customInspection: row.custom_inspection, reference: row.reference });
const SHIFT_OUT = s => ({ id: s.id, container_id: s.containerId, line: s.line, vessel: s.vessel, from_yard: s.from, to_yard: s.to, reason: s.reason, equipment: s.equipment, clerk: s.clerk, remarks: s.remarks, shifted_at: s.shiftedAt });
const SHIFT_IN = row => ({ id: row.id, containerId: row.container_id, line: row.line, vessel: row.vessel, from: row.from_yard, to: row.to_yard, reason: row.reason, equipment: row.equipment, clerk: row.clerk, remarks: row.remarks, shiftedAt: row.shifted_at });
const SHUTOUT_OUT = s => ({ id: s.id, container_id: s.containerId, line: s.line, vessel: s.vessel, voyage: s.voyage, source: s.source, reason: s.reason, clerk: s.clerk, next_action: s.nextAction, remarks: s.remarks, shutout_at: s.shutoutAt, current_status: s.currentStatus });
const SHUTOUT_IN = row => ({ id: row.id, containerId: row.container_id, line: row.line, vessel: row.vessel, voyage: row.voyage, source: row.source, reason: row.reason, clerk: row.clerk, nextAction: row.next_action, remarks: row.remarks, shutoutAt: row.shutout_at, currentStatus: row.current_status });
const RAND_OUT = r => ({ id: r.id, container_id: r.containerId, line: r.line, designated_vessel: r.designatedVessel, designated_voyage: r.designatedVoyage, actual_vessel: r.actualVessel, actual_voyage: r.actualVoyage, reason: r.reason, clerk: r.clerk, remarks: r.remarks, recorded_at: r.recordedAt, source: r.source });
const RAND_IN = row => ({ id: row.id, containerId: row.container_id, line: row.line, designatedVessel: row.designated_vessel, designatedVoyage: row.designated_voyage, actualVessel: row.actual_vessel, actualVoyage: row.actual_voyage, reason: row.reason, clerk: row.clerk, remarks: row.remarks, recordedAt: row.recorded_at, source: row.source });

function localCacheSave() { try { localStorage.setItem(STORE_KEY, JSON.stringify(DB)); } catch (e) { } }
function localCacheLoad() { try { const d = JSON.parse(localStorage.getItem(STORE_KEY) || '{}'); DB.containers = d.containers || []; DB.logs = d.logs || []; DB.slips = d.slips || []; DB.shifts = d.shifts || []; DB.shutouts = d.shutouts || []; DB.randomLoads = d.randomLoads || []; } catch (e) { } }
function impLocalCacheSave() { try { localStorage.setItem(IMP_STORAGE, JSON.stringify(ImportDB)); } catch (e) { } }
function impLocalCacheLoad() { try { const d = JSON.parse(localStorage.getItem(IMP_STORAGE) || '{}'); ImportDB.containers = d.containers || []; ImportDB.logs = d.logs || []; } catch (e) { } }

let _syncBadgeEl = null;
function syncStatus(state) { // 'ok' | 'syncing' | 'error'
    if (!_syncBadgeEl) _syncBadgeEl = document.getElementById('syncStatus');
    if (!_syncBadgeEl) return;
    const map = { ok: ['🟢 Synced', ''], syncing: ['🟡 Syncing…', ''], error: ['🔴 Offline — local cache', ''], };
    _syncBadgeEl.textContent = (map[state] || map.ok)[0];
}

// Only newly-added logs (beyond what's already been pushed) are inserted, since audit-trail
// entries are append-only and their client-side counter isn't a stable cross-session key.
let _logsSyncedCount = 0, _ilogsSyncedCount = 0;
let _syncTimer = null, _syncing = false, _syncQueued = false;
function scheduleSync() { clearTimeout(_syncTimer); _syncTimer = setTimeout(syncToSupabase, 600); }
async function syncToSupabase() {
    if (_syncing) { _syncQueued = true; return; }
    _syncing = true; syncStatus('syncing');
    try {
        const newLogs = DB.logs.slice(0, DB.logs.length - _logsSyncedCount).map(l => { const o = {}; Object.entries(LOG_OUT).forEach(([col, fn]) => o[col] = fn(l)); return o; });
        const newILogs = ImportDB.logs.slice(0, ImportDB.logs.length - _ilogsSyncedCount).map(l => { const o = {}; Object.entries(ILOG_OUT).forEach(([col, fn]) => o[col] = fn(l)); return o; });
        const results = await Promise.all([
            DB.containers.length ? sb.from('containers').upsert(DB.containers.map(c => objToRow(c, CONTAINER_COL_MAP)), { onConflict: 'id' }) : Promise.resolve({ error: null }),
            ImportDB.containers.length ? sb.from('import_containers').upsert(ImportDB.containers.map(c => objToRow(c, IMPORT_COL_MAP)), { onConflict: 'id' }) : Promise.resolve({ error: null }),
            DB.slips.length ? sb.from('slips').upsert(DB.slips.map(SLIP_OUT), { onConflict: 'slip_no' }) : Promise.resolve({ error: null }),
            DB.shifts.length ? sb.from('shifts').upsert(DB.shifts.map(SHIFT_OUT), { onConflict: 'id' }) : Promise.resolve({ error: null }),
            DB.shutouts.length ? sb.from('shutouts').upsert(DB.shutouts.map(SHUTOUT_OUT), { onConflict: 'id' }) : Promise.resolve({ error: null }),
            DB.randomLoads.length ? sb.from('random_loads').upsert(DB.randomLoads.map(RAND_OUT), { onConflict: 'id' }) : Promise.resolve({ error: null }),
            newLogs.length ? sb.from('logs').upsert(newLogs, { onConflict: 'id' }) : Promise.resolve({ error: null }),
            newILogs.length ? sb.from('import_logs').upsert(newILogs, { onConflict: 'id' }) : Promise.resolve({ error: null }),
        ]);
        const failed = results.find(r => r && r.error);
        if (failed) throw failed.error;
        _logsSyncedCount = DB.logs.length; _ilogsSyncedCount = ImportDB.logs.length;
        syncStatus('ok');
    } catch (e) {
        console.error('Supabase sync error:', e);
        syncStatus('error');
    } finally {
        _syncing = false;
        if (_syncQueued) { _syncQueued = false; scheduleSync(); }
    }
}
// Give each log entry a stable, session-unique ID (instead of an array-position counter) so
// syncing never collides across terminals/reloads.
function newLogId() { return `LG${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`.toUpperCase(); }

// save()/impSave() write to localStorage immediately (so the UI is instant and works offline),
// then push the change up to Supabase in the background, debounced to batch rapid bursts.
function save() { try { localStorage.setItem(STORE_KEY, JSON.stringify(DB)); } catch (e) { } scheduleSync(); }
function impSave() { try { localStorage.setItem(IMP_STORAGE, JSON.stringify(ImportDB)); } catch (e) { } scheduleSync(); }

async function fetchAllFromSupabase() {
    const [c, l, s, sh, so, rl, ic, il] = await Promise.all([
        sb.from('containers').select('*'),
        sb.from('logs').select('*').order('time', { ascending: false }).limit(2000),
        sb.from('slips').select('*'),
        sb.from('shifts').select('*'),
        sb.from('shutouts').select('*'),
        sb.from('random_loads').select('*'),
        sb.from('import_containers').select('*'),
        sb.from('import_logs').select('*').order('time', { ascending: false }).limit(1000),
    ]);
    const errs = [c, l, s, sh, so, rl, ic, il].map(r => r.error).filter(Boolean);
    if (errs.length) { console.error('Supabase fetch errors:', errs); return null; }
    return {
        containers: c.data.map(r => rowToObj(r, CONTAINER_COL_MAP)),
        logs: l.data.map(LOG_IN),
        slips: s.data.map(SLIP_IN),
        shifts: sh.data.map(SHIFT_IN),
        shutouts: so.data.map(SHUTOUT_IN),
        randomLoads: rl.data.map(RAND_IN),
        importContainers: ic.data.map(r => rowToObj(r, IMPORT_COL_MAP)),
        importLogs: il.data.map(ILOG_IN),
    };
}

async function loadAll() {
    syncStatus('syncing');
    const remote = await fetchAllFromSupabase();
    if (remote) {
        DB.containers = remote.containers; DB.logs = remote.logs; DB.slips = remote.slips; DB.shifts = remote.shifts; DB.shutouts = remote.shutouts; DB.randomLoads = remote.randomLoads;
        ImportDB.containers = remote.importContainers; ImportDB.logs = remote.importLogs;
        _logsSyncedCount = DB.logs.length; _ilogsSyncedCount = ImportDB.logs.length;
        localCacheSave(); impLocalCacheSave();
        syncStatus('ok');
        if (!DB.containers.length) { seedDemo(); await syncToSupabase(); }
        if (!ImportDB.containers.length) { seedImportContainers(true); await syncToSupabase(); }
    } else {
        toast('⚠️ Could not reach Supabase — working from local cache. Changes will sync once reconnected.', 'warn');
        syncStatus('error');
        localCacheLoad(); impLocalCacheLoad();
        if (!DB.containers.length) seedDemo();
        if (!ImportDB.containers.length) seedImportContainers(true);
    }
    renderAll(); updateNavBadges(); startClock();
}
function impLoad() {/* import data is loaded together with the rest in loadAll(); kept as a no-op for compatibility */ }

function getFreeTimeDays(source) { return (source === 'Gate18' || source === 'Gate24') ? 5 : 7; }
function getFreetimeHours(source) { return getFreeTimeDays(source) * 24; }
function dwellHours(c) { return ((c.loaded || Date.now()) - c.created) / 3600000; }
function freeDaysLeft(c) { return getFreetimeHours(c.source) - dwellHours(c); }
function dwellImport(c) { return ((c.releasedAt || Date.now()) - c.dischargedAt) / 3600000; }
function freeImport(c) { const left = 14 * 24 - dwellImport(c); const d = (left / 24).toFixed(1); return left > 48 ? `<span class="freetime-ok">${d}d left</span>` : left > 0 ? `<span class="freetime-warn">${d}d left</span>` : `<span class="freetime-over">${Math.abs(d)}d overdue</span>`; }

const STATUS_META = {
    PREADVISED: { label: 'Pre-Advised', badge: 'b-preadvised', icon: '📋' },
    GATED_IN: { label: 'Gated In', badge: 'b-gated', icon: '✅' },
    ON_WAGON: { label: 'On Wagon', badge: 'b-wagon', icon: '🚋' },
    RECEIVED_SGR: { label: 'Received SGR', badge: 'b-sgr', icon: '🏁' },
    VESSEL_TO_YARD: { label: 'Vessel→Yard', badge: 'b-vessel-yard', icon: '🚢' },
    KEY_SITE: { label: 'Key Site', badge: 'b-keysite', icon: '⚓' },
    LOADED_VESSEL: { label: 'Loaded Vessel', badge: 'b-loaded', icon: '🛳️' },
    SHUTOUT: { label: 'Shut Out', badge: 'b-shutout', icon: '🚫' },
    OUT_OF_PORT: { label: 'Out of Port', badge: 'b-out', icon: '🚪' },
};
const SOURCE_META = {
    Gate18: { label: 'Gate 18', badge: 'b-gate18', icon: '🚛' },
    Gate24: { label: 'Gate 24', badge: 'b-gate24', icon: '🚛' },
    ICD: { label: 'ICD / SGR', badge: 'b-sgr-entry', icon: '🚃' },
    Vessel: { label: 'Vessel', badge: 'b-vessel-entry', icon: '🛳️' },
};
const IMP_LABELS = { VESSEL_DISCHARGED: 'Discharged', AT_TAG_MASTER: 'Tag Master', RECEIVED_YARD: 'Yard Staged', OFFLOADED_RTG: 'RTG Offloaded', RELEASED_OUT: 'Released Out' };

function badge(s) { const m = STATUS_META[s] || { label: s, badge: 'b-out', icon: '○' }; return `<span class="badge ${m.badge}">${m.icon} ${m.label}</span>`; }
function sourceBadge(s) { const m = SOURCE_META[s] || { label: s, badge: 'b-gate18', icon: '○' }; return `<span class="badge ${m.badge}">${m.icon} ${m.label}</span>`; }
function impBadge(s) { const cls = { VESSEL_DISCHARGED: 'ib-vessel-discharged', AT_TAG_MASTER: 'ib-at-tag-master', RECEIVED_YARD: 'ib-received-yard', OFFLOADED_RTG: 'ib-offloaded-rtg', RELEASED_OUT: 'ib-released-out' }[s] || 'b-out'; return `<span class="badge ${cls}">${IMP_LABELS[s] || s}</span>`; }
function freeTimeDisplay(c) { const left = freeDaysLeft(c); const h = left; if (h > 48) return `<span class="freetime-ok">${(h / 24).toFixed(1)}d left</span>`; if (h > 0) return `<span class="freetime-warn">${h.toFixed(0)}h left</span>`; return `<span class="freetime-over">${Math.abs(h).toFixed(0)}h overdue</span>`; }

function save() { try { localStorage.setItem(STORE_KEY, JSON.stringify(DB)); } catch (e) { } scheduleSync(); }
function impSave() { try { localStorage.setItem(IMP_STORAGE, JSON.stringify(ImportDB)); } catch (e) { } scheduleSync(); }

let _slipCtr = parseInt(localStorage.getItem('KPA_SLIP_CTR') || '260477500');
let _shiftCtr = parseInt(localStorage.getItem('KPA_SHIFT_CTR') || '1');
let _shutCtr = parseInt(localStorage.getItem('KPA_SHUT_CTR') || '1');
let _randCtr = parseInt(localStorage.getItem('KPA_RAND_CTR') || '1');
// Remote atomic counters (Supabase RPC) keep IDs collision-free across multiple clients/terminals.
// Falls back to the old localStorage counter when offline, so the app still works without a connection.
async function nextCounterRemote(name) {
    try {
        const { data, error } = await sb.rpc('next_counter', { counter_name: name });
        if (error) throw error;
        return data;
    } catch (e) { return null; }
}
async function nextSlipNo() {
    const remote = await nextCounterRemote('slip');
    if (remote !== null) { _slipCtr = remote; localStorage.setItem('KPA_SLIP_CTR', _slipCtr); }
    else { _slipCtr++; localStorage.setItem('KPA_SLIP_CTR', _slipCtr); }
    return `PS${_slipCtr}/MCT`;
}
async function nextShiftId() {
    const remote = await nextCounterRemote('shift');
    if (remote !== null) { _shiftCtr = remote; localStorage.setItem('KPA_SHIFT_CTR', _shiftCtr); }
    else { _shiftCtr++; localStorage.setItem('KPA_SHIFT_CTR', _shiftCtr); }
    return `SH${String(_shiftCtr).padStart(5, '0')}`;
}
async function nextShutoutId() {
    const remote = await nextCounterRemote('shutout');
    if (remote !== null) { _shutCtr = remote; localStorage.setItem('KPA_SHUT_CTR', _shutCtr); }
    else { _shutCtr++; localStorage.setItem('KPA_SHUT_CTR', _shutCtr); }
    return `SO${String(_shutCtr).padStart(4, '0')}`;
}
async function nextRandomId() {
    const remote = await nextCounterRemote('random');
    if (remote !== null) { _randCtr = remote; localStorage.setItem('KPA_RAND_CTR', _randCtr); }
    else { _randCtr++; localStorage.setItem('KPA_RAND_CTR', _randCtr); }
    return `RL${String(_randCtr).padStart(4, '0')}`;
}
function genRef() { return `KPA${Date.now().toString(36).toUpperCase()}`; }
function log(id, action, detail) { DB.logs.unshift({ id: newLogId(), containerId: id, action, detail, user: currentUser || 'System', time: Date.now() }); if (DB.logs.length > 2000) DB.logs.splice(2000); save(); }
function impLog(id, action, details) { ImportDB.logs.unshift({ id: newLogId(), containerId: id, action, details, time: Date.now() }); if (ImportDB.logs.length > 1000) ImportDB.logs.splice(1000); impSave(); }
function addMov(c, status, note) { c.status = status; (c.movements = c.movements || []).push({ status, note, time: Date.now(), user: currentUser || 'System' }); }
function findIdx(id) { return DB.containers.findIndex(c => c.id === id); }
function findC(id) { return DB.containers.find(c => c.id === id); }
function findImport(id) { return ImportDB.containers.find(c => c.id === id); }

function toast(msg, type = 'info') {
    const el = document.createElement('div');
    el.className = `toast toast-${type[0]}`;
    el.innerHTML = msg;
    document.getElementById('toastBox').prepend(el);
    setTimeout(() => el.remove(), 4500);
}
function dlFile(data, mime, name) { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([data], { type: mime })); a.download = name; a.click(); }

// ═══ DEMO SEED ═══
function seedDemo() {
    const now = Date.now(), h = 3600000;
    const mk = (id, line, vessel, voyage, pod, type, source, status, yard, slip, created, loadedBy, wagon, bay, wt, ht) => ({
        id, line, vessel, voyage, pod: pod || 'CNNSA', type: type || '20G0', source, status, yard: yard || '', positionSlip: slip || '',
        created, loaded: status === 'LOADED_VESSEL' ? created + h * 2 : null, loadedBy: loadedBy || '', wagon: wagon || '', bay: bay || '',
        weight: wt || '4444.0', height: ht || "8'", movements: [], iso: type || '20G0', transco: '', plate: '', transtype: 'TRUCK',
        clerk: '', shiftCount: 0, shutout: false, preadviceTime: created, ksBay: '', ksClerk: ''
    });
    DB.containers = [
        mk('MSCU9000001', 'MSC', 'MSC FLORIANA VI', 'V.2412', 'CNSHA', '20G0', 'Gate18', 'PREADVISED', '', '', now - 3 * h),
        mk('MAEU8000002', 'MAERSK', 'MAERSK OHIO', 'V.503', 'CNYTN', '40G0', 'Gate24', 'PREADVISED', '', '', now - 7 * h),
        mk('CMAU7000003', 'CMA CGM', 'CMA TITAN', 'V.112', 'CNNBO', '20G0', 'Gate18', 'GATED_IN', 'BLOCK-B-03', 'PS260001/MCT', now - 18 * h),
        mk('TXGU7745354', 'EVG', 'X-PRESS ANTARES', '26016W/26016E', 'CNNSA', '40G0', 'Gate18', 'GATED_IN', 'G2203', 'PS260477513/MCT', now - 30 * h, '', '', '', '4444.0', "8'"),
        mk('MSCU9000004', 'MSC', 'MSC FLORIANA VI', 'V.2412', 'CNSHA', '20G0', 'ICD', 'ON_WAGON', '', '', now - 22 * h, '', 'WGN-2045'),
        mk('MAEU8000005', 'MAERSK', 'MAERSK OHIO', 'V.503', 'CNYTN', '20G0', 'ICD', 'RECEIVED_SGR', 'SGR-YARD', '', now - 36 * h),
        mk('CMAU7000006', 'CMA CGM', 'CMA TITAN', 'V.112', 'CNNBO', '40HC', 'Gate24', 'KEY_SITE', 'BLOCK-A-02', 'PS260002/MCT', now - 50 * h),
        mk('EVGU1234567', 'EVG', 'X-PRESS ANTARES', '26016W/26016E', 'CNNSA', '20G0', 'Gate18', 'LOADED_VESSEL', 'BLOCK-C-01', 'PS260003/MCT', now - 72 * h, 'John Mwangi', '', 'BAY-04-T02'),
        mk('FCIU3311686', 'MSC', 'MSC FLORIANA VI', 'V.2412', 'CNSHA', '20G0', 'ICD', 'PREADVISED', '', '', now - 5 * h),
        mk('CAAU2126050', 'MSC', 'MSC FLORIANA VI', 'V.2412', 'CNSHA', '20G0', 'ICD', 'PREADVISED', '', '', now - 5 * h),
        mk('HLCU1188774', 'HAPAG-LLOYD', 'BELLAVIA', 'V.09', 'SGSIN', '40HC', 'Gate18', 'GATED_IN', 'BLOCK-D-01', 'PS260004/MCT', now - 45 * h),
        mk('OOLU2255663', 'OOCL', 'OOCL HONG KONG', 'V.44N', 'HKHKG', '20G0', 'Gate24', 'KEY_SITE', 'BLOCK-A-01', 'PS260005/MCT', now - 60 * h),
        mk('YMLU3344551', 'ONE', 'ONE HARMONY', 'V.021W', 'JPYOK', '40G0', 'Vessel', 'VESSEL_TO_YARD', 'BLOCK-C-02', '', now - 15 * h),
        mk('COSU9988776', 'COSCO', 'COSCO SHIPPING STAR', 'V.036E', 'CNSHA', '20G0', 'Gate18', 'SHUTOUT', 'BLOCK-B-01', 'PS260006/MCT', now - 80 * h),
        mk('PILU5566443', 'PIL', 'KOTA LEGENDA', 'V.S05', 'PKKAR', '20G0', 'Gate24', 'LOADED_VESSEL', 'G2205', 'PS260007/MCT', now - 90 * h, 'Mary Wambui', '', 'BAY-02-T01'),
    ];
    DB.slips = [{ slipNo: 'PS260477513/MCT', containerId: 'TXGU7745354', line: 'EVG', vessel: 'X-PRESS ANTARES', voyage: '26016W/26016E', pod: 'CNNSA', type: '40G0', iso: '40G0', yard: 'G2203', plate: 'KTCB990N', transco: 'Logistic Solutions', transtype: 'TRUCK', clerk: 'James Odhiambo', gate: 'Gate18', issued: new Date(now - 30 * h).toISOString(), weight: '4444.0', height: "8'", customInspection: 'N', reference: genRef() }];
    DB.shifts = [{ id: 'SH00001', containerId: 'CMAU7000006', line: 'CMA CGM', vessel: 'CMA TITAN', from: 'BLOCK-B-02', to: 'BLOCK-A-02', reason: 'Vessel Planning', equipment: 'RTG-04', clerk: 'Peter Njeru', remarks: '', shiftedAt: now - 40 * h }];
    DB.shutouts = [{ id: 'SO0001', containerId: 'COSU9988776', line: 'COSCO', vessel: 'COSCO SHIPPING STAR', voyage: 'V.036E', source: 'Gate18', reason: 'Weight Discrepancy', clerk: 'Alice Kamau', nextAction: 'Next Vessel', remarks: 'VGM mismatch detected', shutoutAt: now - 65 * h, currentStatus: 'GATED_IN' }];
    save();
}

// ═══ INIT SEARCHABLE DROPDOWNS ═══
function initAllSearchableDropdowns() {
    const searchableIds = ['g-id', 'vy-id', 'y-id', 'sh-id', 'v-id', 'so-id', 'sgr-load', 'sgr-recv', 'sgr-out',
        'ks-move-id', 'ks-load-id', 'rl-id', 'imp-tag-id', 'imp-yard-id', 'imp-offload-id', 'imp-release-id',
        'g-yard', 'sh-to', 'fStatus', 'fSource', 'fLine', 'fVessel',
        'rpt-vessel', 'rpt-line', 'rpt-source', 'rpt-status', 'impStatusFilter', 'impLineFilter'];
    searchableIds.forEach(id => {
        if (document.getElementById(id)) {
            initTS(id, { maxOptions: 500, allowEmptyOption: true, create: false });
        }
    });
}

// ═══ POPULATE DROPDOWNS ═══
function populateAllDropdowns() {
    const preadvised = DB.containers.filter(c => c.status === 'PREADVISED').map(c => ({ value: c.id, text: `${c.id} · ${c.line} · ${c.vessel}` }));
    const preGateIn = DB.containers.filter(c => c.status === 'PREADVISED' && (c.source === 'Gate18' || c.source === 'Gate24')).map(c => ({ value: c.id, text: `${c.id} · ${c.line} · ${c.source}` }));
    const preVessel = DB.containers.filter(c => c.status === 'PREADVISED' && c.source === 'Vessel').map(c => ({ value: c.id, text: `${c.id} · ${c.line} · ${c.vessel}` }));
    const inYard = DB.containers.filter(c => ['GATED_IN', 'RECEIVED_SGR', 'VESSEL_TO_YARD'].includes(c.status)).map(c => ({ value: c.id, text: `${c.id} · ${c.line} · ${c.yard || 'No yard'}` }));
    const anyActive = DB.containers.filter(c => !['LOADED_VESSEL', 'OUT_OF_PORT'].includes(c.status)).map(c => ({ value: c.id, text: `${c.id} · ${c.line} · ${badge_text(c.status)}` }));
    const keysite = DB.containers.filter(c => c.status === 'KEY_SITE').map(c => ({ value: c.id, text: `${c.id} · ${c.line} · ${c.vessel}` }));
    const keysiteOrGated = DB.containers.filter(c => ['KEY_SITE', 'GATED_IN'].includes(c.status)).map(c => ({ value: c.id, text: `${c.id} · ${c.line} · ${badge_text(c.status)}` }));
    const eligibleKS = DB.containers.filter(c => ['GATED_IN', 'RECEIVED_SGR', 'VESSEL_TO_YARD'].includes(c.status)).map(c => ({ value: c.id, text: `${c.id} · ${c.line} · ${c.yard || '—'}` }));
    const icdPA = DB.containers.filter(c => c.source === 'ICD' && c.status === 'PREADVISED').map(c => ({ value: c.id, text: `${c.id} · ${c.line} · ${c.vessel}` }));
    const onWagon = DB.containers.filter(c => c.status === 'ON_WAGON').map(c => ({ value: c.id, text: `${c.id} · ${c.line} · Wagon:${c.wagon || '?'}` }));
    const sgrArr = DB.containers.filter(c => ['RECEIVED_SGR', 'ON_WAGON', 'GATED_IN'].includes(c.status) && c.source === 'ICD').map(c => ({ value: c.id, text: `${c.id} · ${c.line} · ${badge_text(c.status)}` }));

    tsAddOptions('g-id', preGateIn.length ? preGateIn : preadvised);
    tsAddOptions('vy-id', preVessel);
    tsAddOptions('y-id', inYard);
    tsAddOptions('sh-id', anyActive);
    tsAddOptions('v-id', keysiteOrGated);
    tsAddOptions('so-id', keysiteOrGated);
    tsAddOptions('ks-move-id', eligibleKS);
    tsAddOptions('ks-load-id', keysite);
    tsAddOptions('sgr-load', icdPA);
    tsAddOptions('sgr-recv', onWagon);
    tsAddOptions('sgr-out', sgrArr);

    const loadedCs = DB.containers.filter(c => c.status === 'LOADED_VESSEL').map(c => ({ value: c.id, text: `${c.id} · ${c.line} · ${c.vessel}` }));
    tsAddOptions('rl-id', loadedCs);

    const impDischarged = ImportDB.containers.filter(c => c.status === 'VESSEL_DISCHARGED').map(c => ({ value: c.id, text: `${c.id} · ${c.line}` }));
    const impTagMaster = ImportDB.containers.filter(c => c.status === 'AT_TAG_MASTER').map(c => ({ value: c.id, text: `${c.id} · ${c.line} · TT:${c.ttTag}` }));
    const impYardStaged = ImportDB.containers.filter(c => c.status === 'RECEIVED_YARD').map(c => ({ value: c.id, text: `${c.id} · ${c.line} · ${c.yardBlock}` }));
    const impOffloaded = ImportDB.containers.filter(c => c.status === 'OFFLOADED_RTG').map(c => ({ value: c.id, text: `${c.id} · ${c.line} · ${c.rtgOperator}` }));
    tsAddOptions('imp-tag-id', impDischarged);
    tsAddOptions('imp-yard-id', impTagMaster);
    tsAddOptions('imp-offload-id', impYardStaged);
    tsAddOptions('imp-release-id', impOffloaded);

    const lines = [...new Set(DB.containers.map(c => c.line))].filter(Boolean).sort();
    tsAddOptions('fLine', lines);
    tsAddOptions('rpt-line', lines);
    tsAddOptions('impLineFilter', [...new Set(ImportDB.containers.map(c => c.line))].filter(Boolean).sort());

    const vessels = [...new Set(DB.containers.map(c => c.vessel))].filter(Boolean).sort();
    tsAddOptions('fVessel', vessels);
    tsAddOptions('rpt-vessel', vessels);
}

function badge_text(s) { return STATUS_META[s]?.label || s; }

// ═══ AUTOFILL HELPERS ═══
function makeAutofill(c) {
    return `<div class="grid-2" style="gap:0.3rem">
    <div class="info-row"><span class="text-muted">Line</span><span>${c.line}</span></div>
    <div class="info-row"><span class="text-muted">Vessel</span><span>${c.vessel}</span></div>
    <div class="info-row"><span class="text-muted">Type</span><span>${c.type}</span></div>
    <div class="info-row"><span class="text-muted">Source</span>${sourceBadge(c.source)}</div>
    <div class="info-row"><span class="text-muted">Status</span>${badge(c.status)}</div>
    <div class="info-row"><span class="text-muted">Yard</span><span>${c.yard || '—'}</span></div>
  </div>`;
}
window.gateAutofill = () => { const id = tsGetValue('g-id'); const c = findC(id); const el = document.getElementById('g-autofill'); if (c) { el.innerHTML = makeAutofill(c); el.classList.remove('hidden'); } else el.classList.add('hidden'); };
window.vyAutofill = () => { const id = tsGetValue('vy-id'); const c = findC(id); const el = document.getElementById('vy-autofill'); if (c) { el.innerHTML = makeAutofill(c); el.classList.remove('hidden'); } else el.classList.add('hidden'); };
window.yardAutofill = () => { const id = tsGetValue('y-id'); const c = findC(id); const el = document.getElementById('y-autofill'); if (c) { el.innerHTML = makeAutofill(c); el.classList.remove('hidden'); } else el.classList.add('hidden'); };
window.shiftAutofill = () => { const id = tsGetValue('sh-id'); const c = findC(id); const el = document.getElementById('sh-autofill'); if (c) { el.innerHTML = makeAutofill(c); el.classList.remove('hidden'); document.getElementById('sh-from').value = c.yard || 'Unknown'; } else { el.classList.add('hidden'); document.getElementById('sh-from').value = ''; } };
window.vesselAutofill = () => { const id = tsGetValue('v-id'); const c = findC(id); const el = document.getElementById('v-autofill'); if (c) { el.innerHTML = makeAutofill(c); el.classList.remove('hidden'); } else el.classList.add('hidden'); };
window.shutoutAutofill = () => { const id = tsGetValue('so-id'); const c = findC(id); const el = document.getElementById('so-autofill'); if (c) { el.innerHTML = makeAutofill(c); el.classList.remove('hidden'); document.getElementById('so-vessel').value = c.vessel || ''; document.getElementById('so-voyage').value = c.voyage || ''; } else el.classList.add('hidden'); };
window.keysiteMoveAutofill = () => { const id = tsGetValue('ks-move-id'); const c = findC(id); const el = document.getElementById('ks-move-autofill'); if (c) { el.innerHTML = makeAutofill(c); el.classList.remove('hidden'); document.getElementById('ks-vessel').value = c.vessel || ''; document.getElementById('ks-voyage').value = c.voyage || ''; } else el.classList.add('hidden'); };
window.keysiteLoadAutofill = () => { const id = tsGetValue('ks-load-id'); const c = findC(id); const el = document.getElementById('ks-load-autofill'); if (c) { el.innerHTML = makeAutofill(c); el.classList.remove('hidden'); } else el.classList.add('hidden'); };

// ═══ VALIDATION HELPER ═══
window.validateContainerId = (inp) => { const v = inp.value; const ok = /^[A-Z]{4}[0-9]{7}$/.test(v); document.getElementById('pa-validation').textContent = v.length > 0 && !ok ? '⚠️ Container IDs must be 4 letters + 7 digits (e.g. MSCU1234567)' : ''; }

// ═══ PRE-ADVICE ═══
window.createContainer = () => {
    const id = document.getElementById('pa-id').value.trim().toUpperCase();
    const line = document.getElementById('pa-line').value.trim();
    const vessel = document.getElementById('pa-vessel').value.trim();
    const voyage = document.getElementById('pa-voyage').value.trim();
    const pod = document.getElementById('pa-pod').value.trim();
    const type = document.getElementById('pa-type').value;
    const source = document.getElementById('pa-source').value;
    const weight = document.getElementById('pa-weight').value.trim();
    const height = document.getElementById('pa-height').value.trim();
    if (!id) return toast('❌ Container ID is required', 'error');
    if (!line) return toast('❌ Shipping Line is required', 'error');
    if (!vessel) return toast('❌ Vessel Name is required', 'error');
    if (findIdx(id) !== -1) return toast(`❌ Container ${id} already exists in system`, 'error');
    if (id.length < 6) return toast('❌ Container ID too short — must be at least 6 characters', 'error');
    if (!/^[A-Z]{4}[0-9]{7}$/.test(id)) return toast('❌ Container ID must be 4 letters + 7 digits (e.g. MSCU1234567)', 'error');
    if (weight && isNaN(parseFloat(weight))) return toast('❌ Weight must be a valid number', 'error');
    const now = Date.now();
    const c = { id, line, vessel, voyage, pod, type, source, status: 'PREADVISED', yard: '', positionSlip: '', created: now, preadviceTime: now, loaded: null, loadedBy: '', wagon: '', bay: '', movements: [], iso: type, weight: weight || '4444.0', height: height || "8'", transco: '', plate: '', transtype: 'TRUCK', clerk: '', shiftCount: 0, shutout: false, ksBay: '', ksClerk: '' };
    addMov(c, 'PREADVISED', `Pre-advised — Entry: ${source} | Line: ${line} | Vessel: ${vessel}`);
    DB.containers.push(c);
    log(id, 'PREADVISED', `Line:${line} Vessel:${vessel} Source:${source} User:${currentUser}`);
    save(); renderAll(); updateNavBadges(); clearPAForm();
    toast(`✅ <strong>${id}</strong> pre-advised — ${source}`, 'success');
};
window.clearPAForm = () => { ['pa-id', 'pa-line', 'pa-vessel', 'pa-voyage', 'pa-pod', 'pa-iso', 'pa-weight', 'pa-height'].forEach(f => document.getElementById(f).value = ''); document.getElementById('pa-validation').textContent = ''; };

// ═══ BULK PRE-ADVICE ═══
window.handleBulkFile = (e) => { const f = e.target.files[0]; if (!f) return; const r = new FileReader(); r.onload = ev => parseBulkCSV(ev.target.result); r.readAsText(f); };
function parseBulkCSV(text) {
    const lines = text.split('\n').filter(l => l.trim()); if (lines.length < 2) return toast('CSV must have header + data rows', 'error');
    const h = lines[0].split(',').map(x => x.trim().toLowerCase().replace(/[^a-z]/g, ''));
    const ci = h.findIndex(x => x.includes('container') || x === 'id'); const li = h.findIndex(x => x.includes('line') || x.includes('shipping')); const vi = h.findIndex(x => x.includes('vessel')); const vyi = h.findIndex(x => x.includes('voyage')); const pi = h.findIndex(x => x.includes('pod')); const ti = h.findIndex(x => x.includes('type')); const si = h.findIndex(x => x.includes('source'));
    if (ci === -1 || li === -1 || vi === -1) return toast('❌ CSV must have: Container ID, Shipping Line, Vessel', 'error');
    bulkData = []; const errors = [];
    for (let i = 1; i < lines.length; i++) { const cols = lines[i].split(',').map(x => x.trim()); const id = (cols[ci] || '').toUpperCase(); const line = cols[li] || ''; const vessel = cols[vi] || ''; const voyage = vyi >= 0 ? cols[vyi] || '' : ''; const pod = pi >= 0 ? cols[pi] || '' : ''; const type = ti >= 0 ? cols[ti] || '20G0' : '20G0'; const sourceRaw = si >= 0 ? cols[si] || 'Gate18' : 'Gate18'; const vs = ['Gate18', 'Gate24', 'ICD', 'Vessel']; const source = vs.includes(sourceRaw) ? sourceRaw : 'Gate18'; const dup = findIdx(id) !== -1; const valid = !!(id && line && vessel && !dup); if (!valid && id) errors.push(`Row ${i}: ${id} — ${dup ? 'Duplicate' : 'Missing fields'}`); bulkData.push({ id, line, vessel, voyage, pod, type, source, valid, dup, row: i }); }
    renderBulkPreview(); document.getElementById('bErrors').innerHTML = errors.length ? `<strong>${errors.length} errors:</strong><br>` + errors.join('<br>') : ''; toast(`Parsed ${bulkData.length} containers — ${bulkData.filter(d => d.valid).length} valid`, 'info');
}
function renderBulkPreview() { document.getElementById('bulkPreview').classList.remove('hidden'); document.getElementById('bCount').textContent = bulkData.length; document.getElementById('bBody').innerHTML = bulkData.map(d => `<tr style="${d.valid ? '' : 'opacity:0.5;background:rgba(251,113,133,0.03)'}"><td>${d.row}</td><td class="tbl-id">${d.id || '—'}</td><td>${d.line || '—'}</td><td>${d.vessel || '—'}</td><td>${d.voyage || '—'}</td><td>${d.type || '—'}</td><td>${d.source}</td><td>${d.valid ? '<span class="text-success">✅ Valid</span>' : '<span class="text-danger">❌ ' + (d.dup ? 'Duplicate' : 'Missing') + '</span>'}</td></tr>`).join(''); }
window.commitBulk = () => { const valid = bulkData.filter(d => d.valid); if (!valid.length) return toast('No valid containers to commit', 'error'); let added = 0; const now = Date.now(); valid.forEach(d => { if (findIdx(d.id) !== -1) return; const c = { id: d.id, line: d.line, vessel: d.vessel, voyage: d.voyage, pod: d.pod, type: d.type, source: d.source, status: 'PREADVISED', yard: '', positionSlip: '', created: now, preadviceTime: now, loaded: null, loadedBy: '', wagon: '', bay: '', movements: [], iso: d.type, weight: '4444.0', height: "8'", transco: '', plate: '', transtype: 'TRUCK', clerk: '', shiftCount: 0, shutout: false, ksBay: '', ksClerk: '' }; addMov(c, 'PREADVISED', `Bulk pre-advised — ${d.source}`); DB.containers.push(c); log(d.id, 'PREADVISED_BULK', `Line:${d.line} Source:${d.source}`); added++; }); save(); renderAll(); updateNavBadges(); clearBulk(); toast(`✅ ${added} containers pre-advised via bulk upload`, 'success'); };
window.clearBulk = () => { bulkData = []; document.getElementById('bulkPreview').classList.add('hidden'); document.getElementById('bulkFile').value = ''; document.getElementById('bErrors').innerHTML = ''; };

// ═══ GATE IN ═══
let lastSlipData = null;
window.gateIn = async () => {
    const id = tsGetValue('g-id'); const yard = tsGetValue('g-yard'); const plate = document.getElementById('g-plate').value.trim().toUpperCase(); const transco = document.getElementById('g-transco').value.trim(); const clerk = document.getElementById('g-clerk').value.trim() || currentUser || 'Gate Clerk'; const transtype = document.getElementById('g-transtype').value; const gate = document.getElementById('g-gate').value;
    if (!id) return toast('❌ Please select a container', 'error');
    if (!yard) return toast('❌ Yard / Block selection is required for position slip', 'error');
    const idx = findIdx(id); if (idx === -1) return toast('❌ Container not found — pre-advise first', 'error');
    const c = DB.containers[idx];
    if (['GATED_IN', 'KEY_SITE', 'LOADED_VESSEL', 'VESSEL_TO_YARD'].includes(c.status)) return toast(`❌ Container already ${badge_text(c.status)} — cannot gate in again`, 'error');
    if (c.status !== 'PREADVISED') return toast(`❌ Container must be PREADVISED first. Current status: ${badge_text(c.status)}`, 'error');
    const slipNo = await nextSlipNo(); const ref = genRef();
    c.yard = yard; c.positionSlip = slipNo; c.plate = plate; c.transco = transco; c.transtype = transtype; c.clerk = clerk; c.gatedAt = Date.now();
    if (gate) c.source = gate;
    addMov(c, 'GATED_IN', `Gated in via ${gate || c.source} → ${yard} | Slip:${slipNo} | Plate:${plate || 'N/A'} | Clerk:${clerk}`);
    const slip = { slipNo, containerId: id, line: c.line, vessel: c.vessel, voyage: c.voyage, pod: c.pod, type: c.type, iso: c.iso || c.type, yard, plate, transco, transtype, clerk, gate, issued: new Date().toISOString(), weight: c.weight || '4444.0', height: c.height || "8'", customInspection: 'N', reference: ref };
    DB.slips.push(slip); log(id, 'GATED_IN', `Gate:${gate} Yard:${yard} Slip:${slipNo} Clerk:${clerk}`);
    save(); renderAll(); updateNavBadges();
    lastSlipData = { slip, c };
    document.getElementById('slipPreviewBox').innerHTML = buildSlipHTML(slip, c);
    document.getElementById('slipPreviewBtns').classList.remove('hidden');
    tsSetValue('g-id', ''); document.getElementById('g-plate').value = ''; document.getElementById('g-transco').value = ''; document.getElementById('g-clerk').value = ''; tsSetValue('g-yard', ''); document.getElementById('g-autofill').classList.add('hidden');
    toast(`✅ ${id} gated in via ${gate} — Slip: <strong>${slipNo}</strong>`, 'success');
};
window.printLastSlip = () => { if (lastSlipData) { document.getElementById('slipPrintContent').innerHTML = buildSlipHTML(lastSlipData.slip, lastSlipData.c); document.getElementById('slipModal').classList.remove('hidden'); } };
window.pdfLastSlip = () => { if (lastSlipData) generateSlipPDF(lastSlipData.slip, lastSlipData.c); };

// ═══ VESSEL TO YARD ═══
window.vesselToYard = () => {
    const id = tsGetValue('vy-id'); const yard = tsGetValue('vy-yard'); const bay = document.getElementById('vy-bay').value.trim(); const clerk = document.getElementById('vy-clerk').value.trim() || currentUser || 'Clerk'; const remark = document.getElementById('vy-remark').value.trim();
    if (!id) return toast('❌ Select a container', 'error'); if (!yard) return toast('❌ Yard / Block required', 'error');
    const idx = findIdx(id); if (idx === -1) return toast('❌ Container not found', 'error');
    const c = DB.containers[idx];
    if (c.status !== 'PREADVISED') return toast(`❌ Container must be PREADVISED. Current status: ${badge_text(c.status)}`, 'error');
    if (c.source !== 'Vessel') return toast('❌ Must be a Vessel pre-advised container. Use Gate In for other sources.', 'error');
    c.yard = yard; c.bay = bay; c.clerk = clerk; c.gatedAt = Date.now();
    addMov(c, 'VESSEL_TO_YARD', `Discharged from vessel → ${yard}${bay ? ` Bay:${bay}` : ''} | Clerk:${clerk}`); log(id, 'VESSEL_TO_YARD', `Yard:${yard} Clerk:${clerk}`);
    save(); renderAll(); updateNavBadges();
    tsSetValue('vy-id', ''); document.getElementById('vy-bay').value = ''; document.getElementById('vy-clerk').value = ''; document.getElementById('vy-remark').value = ''; tsSetValue('vy-yard', ''); document.getElementById('vy-autofill').classList.add('hidden');
    toast(`✅ ${id} received from vessel → ${yard}`, 'success');
};
function renderVesselYardTable() { const arr = DB.containers.filter(c => c.source === 'Vessel' && !['LOADED_VESSEL', 'OUT_OF_PORT', 'PREADVISED'].includes(c.status)); document.getElementById('vesselYardBody').innerHTML = arr.map(c => `<tr><td><span class="tbl-id" onclick="showDetail('${c.id}')">${c.id}</span></td><td>${c.line}</td><td>${c.vessel}</td><td>${c.yard || '—'}</td><td>${dwellHours(c).toFixed(1)}h</td><td>${freeTimeDisplay(c)}</td></tr>`).join('') || '<tr><td colspan="6" class="text-muted" style="text-align:center;padding:1.5rem">No vessel-sourced empties in yard</td></tr>'; }

// ═══ SHIFTING ═══
window.recordShift = async () => {
    const id = tsGetValue('sh-id'); const to = tsGetValue('sh-to'); const reason = document.getElementById('sh-reason').value; const equip = document.getElementById('sh-equip').value.trim(); const clerk = document.getElementById('sh-clerk').value.trim() || currentUser || 'Clerk'; const remark = document.getElementById('sh-remark').value.trim();
    if (!id) return toast('❌ Select a container', 'error'); if (!to) return toast('❌ Select destination yard', 'error');
    const idx = findIdx(id); if (idx === -1) return toast('❌ Container not found', 'error');
    const c = DB.containers[idx]; const from = c.yard || 'Unknown';
    if (from === to) return toast('❌ From and To yard cannot be the same', 'error');
    if (['LOADED_VESSEL', 'OUT_OF_PORT'].includes(c.status)) return toast('❌ Cannot shift a loaded or departed container', 'error');
    const shift = { id: await nextShiftId(), containerId: id, line: c.line, vessel: c.vessel, from, to, reason, equipment: equip, clerk, remarks: remark, shiftedAt: Date.now() };
    DB.shifts.push(shift); c.yard = to; c.shiftCount = (c.shiftCount || 0) + 1;
    addMov(c, c.status, `Shifted: ${from} → ${to} (${reason}) by ${clerk} — ${equip || 'no equipment noted'}`); log(id, 'SHIFT', `From:${from} To:${to} Reason:${reason} Clerk:${clerk}`);
    save(); renderAll(); updateNavBadges();
    tsSetValue('sh-id', ''); tsSetValue('sh-to', ''); document.getElementById('sh-equip').value = ''; document.getElementById('sh-clerk').value = ''; document.getElementById('sh-remark').value = ''; document.getElementById('sh-from').value = ''; document.getElementById('sh-autofill').classList.add('hidden');
    toast(`🔀 ${id} shifted: ${from} → ${to}`, 'success');
};
function renderShifting() {
    const srch = (document.getElementById('shiftSearch')?.value || '').toLowerCase();
    let arr = DB.shifts.slice().sort((a, b) => b.shiftedAt - a.shiftedAt);
    if (srch) arr = arr.filter(s => [s.containerId, s.from, s.to, s.reason, s.clerk].join(' ').toLowerCase().includes(srch));
    document.getElementById('shiftBody').innerHTML = arr.map(s => { const c = findC(s.containerId); return `<tr><td><span class="tbl-id" onclick="showDetail('${s.containerId}')">${s.containerId}</span></td><td>${s.line || '—'}</td><td>${s.vessel || '—'}</td><td>${s.from}</td><td><strong>${s.to}</strong></td><td>${s.reason}</td><td>${s.equipment || '—'}</td><td>${s.clerk || '—'}</td><td class="font-bold text-accent">${c ? c.shiftCount || 0 : '—'}</td><td style="font-size:0.7rem">${new Date(s.shiftedAt).toLocaleString()}</td></tr>`; }).join('');
    document.getElementById('shiftCount').textContent = `${arr.length} shift records`;
    const byReason = {}; DB.shifts.forEach(s => byReason[s.reason] = (byReason[s.reason] || 0) + 1);
    document.getElementById('shiftSummary').innerHTML = `
    <div class="info-row"><span>Total Shifts</span><span class="font-bold text-accent">${DB.shifts.length}</span></div>
    <div class="info-row"><span>Unique Containers</span><span class="font-bold">${new Set(DB.shifts.map(s => s.containerId)).size}</span></div>
    <div class="info-row"><span>Most Active Reason</span><span class="font-bold">${Object.entries(byReason).sort((a, b) => b[1] - a[1])[0]?.[0] || '—'}</span></div>
  `;
    const byContainer = {}; DB.shifts.forEach(s => byContainer[s.containerId] = (byContainer[s.containerId] || 0) + 1);
    document.getElementById('topShifted').innerHTML = Object.entries(byContainer).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([id, n]) => { const c = findC(id); return `<div class="info-row"><span class="tbl-id" onclick="showDetail('${id}')">${id}</span><span class="font-bold">${n} shifts${c ? ` · ${c.line}` : ''}</span></div>`; }).join('') || '<span class="text-muted">No shifts recorded</span>';
}

// ═══ KEY SITE / PRE-STAKE ═══
window.moveToKeysite = () => {
    const id = tsGetValue('ks-move-id'); const bay = document.getElementById('ks-bay').value.trim(); const vessel = document.getElementById('ks-vessel').value.trim(); const voyage = document.getElementById('ks-voyage').value.trim(); const equip = document.getElementById('ks-equip').value.trim(); const clerk = document.getElementById('ks-clerk').value.trim() || currentUser || 'Clerk'; const remark = document.getElementById('ks-remark').value.trim();
    if (!id) return toast('❌ Select a container', 'error');
    if (!clerk) return toast('❌ Pre-Stake Clerk name is required', 'error');
    const idx = findIdx(id); if (idx === -1) return toast('❌ Container not found', 'error');
    const c = DB.containers[idx];
    if (!['GATED_IN', 'RECEIVED_SGR', 'VESSEL_TO_YARD'].includes(c.status)) return toast(`❌ Container must be Gated In, Received SGR, or Vessel→Yard to pre-stake. Current: ${badge_text(c.status)}`, 'error');
    if (vessel && c.vessel && vessel.toUpperCase() !== c.vessel.toUpperCase() && !confirm(`Vessel mismatch: Container is for "${c.vessel}" but you entered "${vessel}". Proceed?`)) return;
    c.ksBay = bay || 'KEY-SITE'; c.ksClerk = clerk;
    if (vessel) c.vessel = vessel; if (voyage) c.voyage = voyage;
    addMov(c, 'KEY_SITE', `Pre-staked to Key Site${bay ? ` Bay:${bay}` : ''} by ${clerk}${equip ? ` — Equip:${equip}` : ''}${remark ? ` — ${remark}` : ''}`);
    log(id, 'KEY_SITE', `Bay:${bay || 'KEY-SITE'} Clerk:${clerk} Equip:${equip} Vessel:${vessel || c.vessel}`);
    save(); renderAll(); updateNavBadges();
    tsSetValue('ks-move-id', ''); document.getElementById('ks-bay').value = ''; document.getElementById('ks-vessel').value = ''; document.getElementById('ks-voyage').value = ''; document.getElementById('ks-equip').value = ''; document.getElementById('ks-clerk').value = ''; document.getElementById('ks-remark').value = ''; document.getElementById('ks-move-autofill').classList.add('hidden');
    toast(`⚓ ${id} pre-staked to Key Site${bay ? ` (${bay})` : ''} by ${clerk}`, 'success');
};
window.loadFromKeysite2 = async () => {
    const id = tsGetValue('ks-load-id'); const clerk = document.getElementById('ks-load-clerk').value.trim() || currentUser || 'Clerk'; const bay = document.getElementById('ks-load-bay').value.trim(); const crane = document.getElementById('ks-load-crane').value.trim(); const remark = document.getElementById('ks-load-remark').value.trim();
    if (!id) return toast('❌ Select a Key Site container', 'error');
    if (!clerk) return toast('❌ Loading Clerk name is required', 'error');
    const idx = findIdx(id); if (idx === -1) return toast('❌ Container not found', 'error');
    const c = DB.containers[idx];
    if (c.status !== 'KEY_SITE') return toast('❌ Container must be at KEY_SITE to load from here', 'error');
    const loadInfo = resolveLoadVessel('ks-load', c); if (!loadInfo) return;
    c.loaded = Date.now(); c.loadedBy = clerk; c.bay = bay;
    if (loadInfo.isRandom) {
        await recordRandomLoad({ containerId: id, line: c.line, designatedVessel: c.vessel, designatedVoyage: c.voyage, actualVessel: loadInfo.actualVessel, actualVoyage: loadInfo.actualVoyage, reason: loadInfo.reason, clerk, remarks: remark, source: 'Key Site Direct Load' });
    }
    addMov(c, 'LOADED_VESSEL', `Loaded to vessel by ${clerk}${bay ? ` Bay:${bay}` : ''}${crane ? ` Crane:${crane}` : ''}${remark ? ` — ${remark}` : ''}`);
    log(id, 'LOADED_VESSEL', `Clerk:${clerk} Bay:${bay} Crane:${crane} (from Key Site)`);
    save(); renderAll(); updateNavBadges();
    tsSetValue('ks-load-id', ''); document.getElementById('ks-load-clerk').value = ''; document.getElementById('ks-load-bay').value = ''; document.getElementById('ks-load-crane').value = ''; document.getElementById('ks-load-remark').value = ''; document.getElementById('ks-load-autofill').classList.add('hidden');
    document.getElementById('ks-load-actual-vessel') && (document.getElementById('ks-load-actual-vessel').value = '');
    document.getElementById('ks-load-actual-voyage') && (document.getElementById('ks-load-actual-voyage').value = '');
    document.getElementById('ks-load-random-block')?.classList.add('hidden');
    toast(`🛳️ ${id} loaded to vessel by ${clerk} from Key Site`, 'success');
};
function renderKeysite() {
    const srch = (document.getElementById('ksSearch')?.value || '').toLowerCase();
    let arr = DB.containers.filter(c => c.status === 'KEY_SITE');
    if (srch) arr = arr.filter(c => [c.id, c.line, c.vessel, c.ksBay, c.ksClerk].join(' ').toLowerCase().includes(srch));
    const el = document.getElementById('keysiteBody');
    el.innerHTML = arr.map(c => `<tr>
    <td><span class="tbl-id" onclick="showDetail('${c.id}')">${c.id}</span></td>
    <td>${c.line}</td><td>${c.type}</td><td>${c.vessel}</td><td>${c.voyage || '—'}</td>
    <td><span class="code">${c.ksBay || 'KEY-SITE'}</span></td>
    <td>${sourceBadge(c.source)}</td><td>${c.positionSlip ? `<span class="code">${c.positionSlip}</span>` : '—'}</td>
    <td class="${dwellHours(c) > 96 ? 'overdue' : ''}">${dwellHours(c).toFixed(1)}h</td>
    <td class="${(c.shiftCount || 0) > 2 ? 'text-gold' : ''}">${c.shiftCount || 0}</td>
    <td>${c.ksClerk || '—'}</td>
    <td><button class="btn btn-xs btn-primary" onclick="quickLoadVessel('${c.id}')">🛳️ Load</button></td>
  </tr>`).join('') || '<tr><td colspan="12" class="text-muted" style="text-align:center;padding:2rem">No containers at Key Site</td></tr>';
    document.getElementById('keysiteCount').textContent = `${arr.length} container${arr.length !== 1 ? 's' : ''}`;
}
window.quickLoadVessel = (id) => { tsSetValue('ks-load-id', id); keysiteLoadAutofill(); document.querySelector('#ks-load-clerk').focus(); };
window.exportKeysiteCSV = () => { const arr = DB.containers.filter(c => c.status === 'KEY_SITE'); let csv = 'Container ID,Line,Type,Vessel,Voyage,KS Bay,Source,Dwell(h),Shifts,Clerk\n'; arr.forEach(c => { csv += `${c.id},${c.line},${c.type},${c.vessel},${c.voyage || ''},${c.ksBay || 'KEY-SITE'},${c.source},${dwellHours(c).toFixed(1)},${c.shiftCount || 0},${c.ksClerk || ''}\n`; }); dlFile(csv, 'text/csv', 'kpa_keysite.csv'); toast('📥 Key Site CSV exported', 'success'); };
window.exportKeysitePDF = () => {
    const { jsPDF } = window.jspdf; const doc = new jsPDF('l', 'mm', 'a4');
    doc.setFontSize(14); doc.text('KPA Pre-Stake / Key Site Report — Mombasa MCT', 14, 18);
    doc.setFontSize(8); doc.text(`Generated: ${new Date().toLocaleString()} · info@kpa.go.ke`, 14, 24);
    const arr = DB.containers.filter(c => c.status === 'KEY_SITE');
    doc.autoTable({ head: [['Container ID', 'Line', 'Type', 'Vessel', 'Voyage', 'KS Bay', 'Source', 'Dwell(h)', 'Shifts', 'Clerk']], body: arr.map(c => [c.id, c.line, c.type, c.vessel, c.voyage || '', c.ksBay || 'KEY-SITE', c.source, dwellHours(c).toFixed(1), c.shiftCount || 0, c.ksClerk || '']), startY: 30, styles: { fontSize: 7 }, headStyles: { fillColor: [2, 132, 199] }, alternateRowStyles: { fillColor: [240, 249, 255] } });
    doc.save('kpa_keysite_report.pdf'); toast('📄 Key Site PDF exported', 'success');
};

// ═══ RANDOM LOADING — shared capture logic ═══
// A "random load" is when a container is loaded onto a vessel/voyage different from its
// designated (pre-advised) vessel. Captured automatically from Yard (direct-to-vessel),
// Key Site (direct load) and Vessel Loading, and can also be flagged retroactively.
async function recordRandomLoad({ containerId, line, designatedVessel, designatedVoyage, actualVessel, actualVoyage, reason, clerk, remarks, source }) {
    DB.randomLoads.unshift({
        id: await nextRandomId(), containerId, line: line || '',
        designatedVessel: designatedVessel || '', designatedVoyage: designatedVoyage || '',
        actualVessel: actualVessel || '', actualVoyage: actualVoyage || '',
        reason: reason || '', clerk: clerk || currentUser || 'Clerk', remarks: remarks || '',
        recordedAt: Date.now(), source: source || 'Manual'
    });
    save();
}
// Reads the "actual vessel loaded" input for a given form prefix, compares it against the
// container's designated vessel, and returns the resolved load info — or null (with a toast
// already shown) if a random load reason is required but missing.
function resolveLoadVessel(prefix, c) {
    const actualInput = document.getElementById(prefix + '-actual-vessel');
    const voyageInput = document.getElementById(prefix + '-actual-voyage');
    const reasonSel = document.getElementById(prefix + '-random-reason');
    const rawActual = (actualInput?.value || '').trim().toUpperCase();
    const designated = (c.vessel || '').trim().toUpperCase();
    const actualVessel = rawActual || c.vessel || '';
    const actualVoyage = (voyageInput?.value || '').trim() || c.voyage || '';
    const isRandom = !!(rawActual && designated && rawActual !== designated);
    if (isRandom) {
        const reason = reasonSel ? reasonSel.value : '';
        if (!reason) { toast('❌ Random Loading Reason is required — actual vessel differs from designated', 'error'); return null; }
        return { actualVessel, actualVoyage, isRandom: true, reason };
    }
    return { actualVessel, actualVoyage, isRandom: false, reason: '' };
}
// Shows/hides the orange "random loading detected" block for a form prefix as the actual-vessel
// input is typed, by comparing it live against the selected container's designated vessel.
window.checkRandomLoadUI = (prefix) => {
    const idField = prefix === 'ks-load' ? 'ks-load-id' : prefix + '-id';
    const c = findC(tsGetValue(idField));
    const actualInput = document.getElementById(prefix + '-actual-vessel');
    const block = document.getElementById(prefix + '-random-block');
    if (!actualInput || !block) return;
    const actual = actualInput.value.trim().toUpperCase();
    const designated = (c && c.vessel || '').trim().toUpperCase();
    const isRandom = !!(actual && designated && actual !== designated);
    block.classList.toggle('hidden', !isRandom);
    if (!isRandom) { const rSel = document.getElementById(prefix + '-random-reason'); if (rSel) rSel.value = ''; }
};
// Shows the actual-vessel/voyage/clerk fields on the Yard form only when the action chosen
// is a direct-to-vessel load; hides & clears the random-loading block otherwise.
window.toggleYardVesselFields = () => {
    const action = document.getElementById('y-action').value;
    const fields = document.getElementById('y-vessel-fields');
    const show = action === 'LOADED_VESSEL';
    if (fields) fields.classList.toggle('hidden', !show);
    if (!show) {
        document.getElementById('y-random-block')?.classList.add('hidden');
        const av = document.getElementById('y-actual-vessel'); if (av) av.value = '';
        const avo = document.getElementById('y-actual-voyage'); if (avo) avo.value = '';
    }
};
// Manual "flag / correct" panel — retroactively record a random load for a container that was
// already loaded but whose random-load status wasn't captured at load time.
window.randomLoadAutofill = () => {
    const id = tsGetValue('rl-id'); const c = findC(id); const el = document.getElementById('rl-autofill');
    if (c) {
        el.innerHTML = `<div class="grid-2" style="gap:0.3rem">
      <div class="info-row"><span class="text-muted">Line</span><span>${c.line}</span></div>
      <div class="info-row"><span class="text-muted">Designated Vessel</span><span>${c.vessel}</span></div>
      <div class="info-row"><span class="text-muted">Voyage</span><span>${c.voyage || '—'}</span></div>
      <div class="info-row"><span class="text-muted">Loaded By</span><span>${c.loadedBy || '—'}</span></div>
    </div>`;
        el.classList.remove('hidden');
    } else el.classList.add('hidden');
};
window.recordRandomLoadManual = async () => {
    const id = tsGetValue('rl-id'); const c = findC(id);
    if (!id || !c) return toast('❌ Select a loaded container', 'error');
    const actualVessel = (document.getElementById('rl-actual-vessel').value || '').trim().toUpperCase();
    const actualVoyage = (document.getElementById('rl-actual-voyage').value || '').trim();
    const reason = document.getElementById('rl-reason').value;
    const clerk = document.getElementById('rl-clerk').value.trim();
    const remark = document.getElementById('rl-remark').value.trim();
    if (!actualVessel) return toast('❌ Actual Vessel Loaded is required', 'error');
    if (!reason) return toast('❌ Reason is required', 'error');
    if (!clerk) return toast('❌ Clerk / officer name is required', 'error');
    await recordRandomLoad({ containerId: id, line: c.line, designatedVessel: c.vessel, designatedVoyage: c.voyage, actualVessel, actualVoyage, reason, clerk, remarks: remark, source: 'Manual Flag' });
    log(id, 'RANDOM_LOAD_FLAGGED', `Actual:${actualVessel} Reason:${reason} Clerk:${clerk}`);
    renderRandomLoading(); updateNavBadges();
    tsSetValue('rl-id', ''); document.getElementById('rl-actual-vessel').value = ''; document.getElementById('rl-actual-voyage').value = ''; document.getElementById('rl-reason').value = ''; document.getElementById('rl-clerk').value = ''; document.getElementById('rl-remark').value = ''; document.getElementById('rl-autofill').classList.add('hidden');
    toast(`🎲 Random load flagged for ${id}`, 'success');
};
function renderRandomLoading() {
    const srch = (document.getElementById('randomSearch')?.value || '').toLowerCase();
    let arr = DB.randomLoads.slice().sort((a, b) => b.recordedAt - a.recordedAt);
    if (srch) arr = arr.filter(r => [r.containerId, r.actualVessel, r.designatedVessel, r.reason, r.clerk].join(' ').toLowerCase().includes(srch));
    const body = document.getElementById('randomBody');
    if (body) body.innerHTML = arr.map(r => `<tr><td>${r.id}</td><td><span class="tbl-id" onclick="showDetail('${r.containerId}')">${r.containerId}</span></td><td>${r.line || '—'}</td><td>${r.designatedVessel || '—'}</td><td class="text-gold">${r.actualVessel || '—'}</td><td>${r.reason || '—'}</td><td>${r.clerk || '—'}</td><td style="font-size:0.7rem">${new Date(r.recordedAt).toLocaleString()}</td></tr>`).join('') || '<tr><td colspan="8" class="text-muted" style="text-align:center;padding:1.5rem">No random loading records</td></tr>';
    const countEl = document.getElementById('randomCount'); if (countEl) countEl.textContent = `${arr.length} records`;
    const all = DB.randomLoads;
    const summaryEl = document.getElementById('randomSummary');
    if (summaryEl) summaryEl.innerHTML = `
    <div class="info-row"><span>Total Random Loads</span><span class="font-bold text-gold">${all.length}</span></div>
    <div class="info-row"><span>Unique Containers</span><span class="font-bold">${new Set(all.map(r => r.containerId)).size}</span></div>
    <div class="info-row"><span>Vessels Involved</span><span class="font-bold">${new Set(all.map(r => r.actualVessel)).size}</span></div>`;
    const byReason = {}; all.forEach(r => byReason[r.reason] = (byReason[r.reason] || 0) + 1);
    const byReasonEl = document.getElementById('randomByReason');
    if (byReasonEl) byReasonEl.innerHTML = Object.entries(byReason).sort((a, b) => b[1] - a[1]).map(([r, n]) => `<div class="info-row"><span>${r}</span><span class="font-bold text-gold">${n}</span></div>`).join('') || '<span class="text-muted">No records</span>';
}
window.exportRandomLoadingCSV = () => {
    let csv = 'Record,Container ID,Line,Designated Vessel,Actual Vessel,Reason,Clerk,Recorded At\n';
    DB.randomLoads.forEach(r => { csv += `${r.id},${r.containerId},${r.line || ''},${r.designatedVessel || ''},${r.actualVessel || ''},${r.reason || ''},${r.clerk || ''},${new Date(r.recordedAt).toLocaleString()}\n`; });
    dlFile(csv, 'text/csv', 'kpa_random_loading.csv');
    toast('📥 Random Loading CSV exported', 'success');
};

// ═══ YARD MOVE ═══
window.yardMove = async () => {
    const id = tsGetValue('y-id'); const action = document.getElementById('y-action').value; const remark = document.getElementById('y-remark').value.trim();
    if (!id) return toast('❌ Select a container', 'error');
    const idx = findIdx(id); if (idx === -1) return toast('❌ Container not found', 'error');
    const c = DB.containers[idx];
    if (!['GATED_IN', 'RECEIVED_SGR', 'VESSEL_TO_YARD'].includes(c.status)) return toast(`❌ Container must be GATED_IN, RECEIVED_SGR, or VESSEL_TO_YARD. Current: ${badge_text(c.status)}`, 'error');
    let loadInfo = null;
    if (action === 'LOADED_VESSEL') { loadInfo = resolveLoadVessel('y', c); if (!loadInfo) return; }
    if (action === 'LOADED_VESSEL') {
        c.loaded = Date.now();
        if (loadInfo.isRandom) {
            const clerk = document.getElementById('y-clerk')?.value.trim();
            await recordRandomLoad({ containerId: id, line: c.line, designatedVessel: c.vessel, designatedVoyage: c.voyage, actualVessel: loadInfo.actualVessel, actualVoyage: loadInfo.actualVoyage, reason: loadInfo.reason, clerk, remarks: remark, source: 'Yard Direct-to-Vessel' });
        }
    }
    addMov(c, action, remark || `Moved to ${action.replace(/_/g, ' ')} from Yard`); log(id, action, remark || `Yard move to ${action}`);
    save(); renderAll(); updateNavBadges();
    tsSetValue('y-id', ''); document.getElementById('y-remark').value = ''; document.getElementById('y-autofill').classList.add('hidden');
    document.getElementById('y-actual-vessel') && (document.getElementById('y-actual-vessel').value = '');
    document.getElementById('y-actual-voyage') && (document.getElementById('y-actual-voyage').value = '');
    document.getElementById('y-clerk') && (document.getElementById('y-clerk').value = '');
    document.getElementById('y-random-block')?.classList.add('hidden');
    document.getElementById('y-vessel-fields')?.classList.add('hidden');
    toast(`✅ ${id} → ${action.replace(/_/g, ' ')}`, 'success');
};

// ═══ VESSEL LOADING ═══
window.loadVessel = async () => {
    const id = tsGetValue('v-id'); const clerk = document.getElementById('v-clerk').value.trim() || 'Unassigned'; const bay = document.getElementById('v-bay').value.trim(); const remark = document.getElementById('v-remark').value.trim();
    if (!id) return toast('❌ Select a container', 'error');
    if (!clerk || clerk === 'Unassigned') return toast('❌ Loading Clerk name is required', 'error');
    const idx = findIdx(id); if (idx === -1) return toast('❌ Container not found', 'error');
    const c = DB.containers[idx];
    if (!['KEY_SITE', 'GATED_IN', 'RECEIVED_SGR', 'VESSEL_TO_YARD'].includes(c.status)) return toast(`❌ Container status must be Key Site, Gated In, or Received SGR. Current: ${badge_text(c.status)}`, 'error');
    const loadInfo = resolveLoadVessel('v', c); if (!loadInfo) return;
    c.loaded = Date.now(); c.loadedBy = clerk; c.bay = bay;
    if (loadInfo.isRandom) {
        await recordRandomLoad({ containerId: id, line: c.line, designatedVessel: c.vessel, designatedVoyage: c.voyage, actualVessel: loadInfo.actualVessel, actualVoyage: loadInfo.actualVoyage, reason: loadInfo.reason, clerk, remarks: remark, source: 'Vessel Loading' });
    }
    addMov(c, 'LOADED_VESSEL', `Loaded by ${clerk}${bay ? ` Bay:${bay}` : ''}${remark ? ` — ${remark}` : ''}`); log(id, 'LOADED_VESSEL', `Clerk:${clerk} Bay:${bay}`);
    save(); renderAll(); updateNavBadges();
    tsSetValue('v-id', ''); document.getElementById('v-clerk').value = ''; document.getElementById('v-bay').value = ''; document.getElementById('v-remark').value = ''; document.getElementById('v-autofill').classList.add('hidden');
    document.getElementById('v-actual-vessel') && (document.getElementById('v-actual-vessel').value = '');
    document.getElementById('v-actual-voyage') && (document.getElementById('v-actual-voyage').value = '');
    document.getElementById('v-random-block')?.classList.add('hidden');
    toast(`🛳️ ${id} loaded by ${clerk}`, 'success');
};

// ═══ SHUTOUTS ═══
window.recordShutout = async () => {
    const id = tsGetValue('so-id'); const reason = document.getElementById('so-reason').value; const clerk = document.getElementById('so-clerk').value.trim() || currentUser || 'Clerk'; const action = document.getElementById('so-action').value; const remark = document.getElementById('so-remark').value.trim();
    if (!id) return toast('❌ Select a container', 'error'); if (!reason) return toast('❌ Shutout reason is required', 'error');
    const idx = findIdx(id); if (idx === -1) return toast('❌ Container not found', 'error');
    const c = DB.containers[idx];
    const so = { id: await nextShutoutId(), containerId: id, line: c.line, vessel: c.vessel, voyage: c.voyage, source: c.source, reason, clerk, nextAction: action, remarks: remark, shutoutAt: Date.now(), currentStatus: c.status };
    DB.shutouts.push(so); c.shutout = true;
    if (action === 'Return to Yard' && c.status === 'KEY_SITE') addMov(c, 'GATED_IN', `Shutout: ${reason} — returned to yard`);
    else addMov(c, c.status, `Shutout recorded: ${reason}. Next action: ${action}`);
    log(id, 'SHUTOUT', `Vessel:${c.vessel} Reason:${reason} Clerk:${clerk}`);
    save(); renderAll(); updateNavBadges();
    tsSetValue('so-id', ''); document.getElementById('so-clerk').value = ''; document.getElementById('so-remark').value = ''; document.getElementById('so-vessel').value = ''; document.getElementById('so-voyage').value = ''; document.getElementById('so-autofill').classList.add('hidden');
    toast(`🚫 Shutout recorded for ${id}. Next action: ${action}`, 'warn');
};
function renderShutouts() {
    const arr = DB.shutouts.slice().sort((a, b) => b.shutoutAt - a.shutoutAt);
    document.getElementById('shutoutBody').innerHTML = arr.map(so => `<tr><td><span class="tbl-id" onclick="showDetail('${so.containerId}')">${so.containerId}</span></td><td>${so.line || '—'}</td><td>${so.vessel || '—'}</td><td>${so.voyage || '—'}</td><td>${sourceBadge(so.source)}</td><td><span class="text-danger">${so.reason}</span></td><td>${so.nextAction}</td><td>${so.clerk || '—'}</td><td style="font-size:0.7rem">${new Date(so.shutoutAt).toLocaleString()}</td><td>${badge(so.currentStatus)}</td></tr>`).join('');
    document.getElementById('shutoutCount').textContent = `${arr.length} shutout records`;
    const byReason = {}; arr.forEach(s => byReason[s.reason] = (byReason[s.reason] || 0) + 1);
    document.getElementById('shutoutSummary').innerHTML = `
    <div class="info-row"><span>Total Shutouts</span><span class="font-bold text-danger">${arr.length}</span></div>
    <div class="info-row"><span>Unique Containers</span><span class="font-bold">${new Set(arr.map(s => s.containerId)).size}</span></div>
    <div class="info-row"><span>Pending Action</span><span class="font-bold">${arr.filter(s => s.nextAction !== 'Next Vessel').length}</span></div>
  `;
    document.getElementById('shutoutByReason').innerHTML = Object.entries(byReason).sort((a, b) => b[1] - a[1]).map(([r, n]) => `<div class="info-row"><span>${r}</span><span class="font-bold text-danger">${n}</span></div>`).join('') || '<span class="text-muted">No shutouts</span>';
}

// ═══ SGR ═══
window.sgrLoadWagon = () => { const id = tsGetValue('sgr-load'); const wagon = document.getElementById('sgr-wagon').value.trim(); if (!id) return toast('❌ Select a container', 'error'); const idx = findIdx(id); if (idx === -1) return toast('❌ Container not found', 'error'); const c = DB.containers[idx]; if (c.source !== 'ICD') return toast('❌ Must be ICD-sourced container', 'error'); if (c.status !== 'PREADVISED') return toast(`❌ Container must be PREADVISED. Current: ${badge_text(c.status)}`, 'error'); if (!wagon) return toast('❌ Wagon number is required', 'error'); c.wagon = wagon; addMov(c, 'ON_WAGON', `Loaded on wagon ${wagon}`); log(id, 'ON_WAGON', `Wagon:${wagon}`); save(); renderAll(); updateNavBadges(); tsSetValue('sgr-load', ''); document.getElementById('sgr-wagon').value = ''; toast(`🚋 ${id} loaded on wagon ${wagon}`, 'success'); };
window.sgrReceive = () => { const id = tsGetValue('sgr-recv'); const yard = document.getElementById('sgr-yard').value; if (!id) return toast('❌ Select a container', 'error'); const idx = findIdx(id); if (idx === -1) return toast('❌ Container not found', 'error'); const c = DB.containers[idx]; if (c.status !== 'ON_WAGON') return toast(`❌ Container must be ON_WAGON. Current: ${badge_text(c.status)}`, 'error'); c.yard = yard; c.gatedAt = Date.now(); addMov(c, 'RECEIVED_SGR', `Received at SGR port · ${yard}`); log(id, 'RECEIVED_SGR', `Yard:${yard}`); save(); renderAll(); updateNavBadges(); tsSetValue('sgr-recv', ''); toast(`🏁 ${id} received at SGR`, 'success'); };
window.sgrOut = () => { const id = tsGetValue('sgr-out'); const reason = document.getElementById('sgr-out-reason').value.trim(); if (!id) return toast('❌ Select a container', 'error'); const idx = findIdx(id); if (idx === -1) return toast('❌ Container not found', 'error'); const c = DB.containers[idx]; addMov(c, 'OUT_OF_PORT', reason || 'Moved out of port'); log(id, 'OUT_OF_PORT', reason); save(); renderAll(); updateNavBadges(); tsSetValue('sgr-out', ''); document.getElementById('sgr-out-reason').value = ''; toast(`🚪 ${id} moved out of port`, 'success'); };
function renderSGR() {
    const sgrCs = DB.containers.filter(c => c.source === 'ICD');
    const pa = sgrCs.filter(c => c.status === 'PREADVISED').length; const wag = sgrCs.filter(c => c.status === 'ON_WAGON').length; const rcv = sgrCs.filter(c => c.status === 'RECEIVED_SGR').length;
    document.getElementById('sgrPop').innerHTML = `<div class="grid-3" style="gap:0.5rem"><div class="info-row"><span>📋 Pre-Advised (ICD)</span><span class="font-bold text-accent">${pa}</span></div><div class="info-row"><span>🚋 On Wagon</span><span class="font-bold text-gold">${wag}</span></div><div class="info-row"><span>🏁 Received SGR</span><span class="font-bold text-success">${rcv}</span></div></div>`;
    document.getElementById('sgrBody').innerHTML = sgrCs.filter(c => c.status !== 'OUT_OF_PORT').map(c => `<tr><td><span class="tbl-id" onclick="showDetail('${c.id}')">${c.id}</span></td><td>${c.line}</td><td>${c.type}</td><td>${badge(c.status)}</td><td>${c.wagon || '—'}</td><td>${c.yard || '—'}</td><td>${dwellHours(c).toFixed(1)}h</td><td>${freeTimeDisplay(c)}</td></tr>`).join('') || '<tr><td colspan="8" class="text-muted" style="text-align:center;padding:1.5rem">No SGR containers</td></tr>';
}

// ═══ DETAIL MODAL ═══
window.showDetail = (id) => {
    const c = findC(id); if (!c) return;
    const fD = ['PREADVISED', 'GATED_IN', 'KEY_SITE', 'LOADED_VESSEL'];
    const fI = ['PREADVISED', 'ON_WAGON', 'RECEIVED_SGR', 'GATED_IN', 'KEY_SITE', 'LOADED_VESSEL'];
    const fV = ['PREADVISED', 'VESSEL_TO_YARD', 'KEY_SITE', 'LOADED_VESSEL'];
    const flow = c.source === 'ICD' ? fI : c.source === 'Vessel' ? fV : fD; const ci = flow.indexOf(c.status);
    const wfHTML = flow.map((s, i) => { const done = i < ci; const active = i === ci; return `<span class="wf-step ${done ? 'wf-done' : active ? 'wf-active' : 'wf-pending'}">${done ? '✅' : active ? '🔄' : '○'} ${s.replace(/_/g, ' ')}</span>${i < flow.length - 1 ? '<span class="wf-arrow">→</span>' : ''}` }).join('');
    const cShifts = DB.shifts.filter(s => s.containerId === id);
    const cShutouts = DB.shutouts.filter(s => s.containerId === id);
    document.getElementById('modalTitle').textContent = `${c.id} — ${c.line}`;
    document.getElementById('modalBody').innerHTML = `
    <div class="grid-2 mb-2">
      <div class="info-row"><span class="text-muted">Line</span><span>${c.line}</span></div>
      <div class="info-row"><span class="text-muted">Entry Point</span>${sourceBadge(c.source)}</div>
      <div class="info-row"><span class="text-muted">Pre-Advice Time</span><span class="text-xs">${new Date(c.preadviceTime || c.created).toLocaleString()}</span></div>
      <div class="info-row"><span class="text-muted">Vessel</span><span>${c.vessel}</span></div>
      <div class="info-row"><span class="text-muted">Voyage</span><span>${c.voyage || '—'}</span></div>
      <div class="info-row"><span class="text-muted">Type / ISO</span><span>${c.type} / ${c.iso || c.type}</span></div>
      <div class="info-row"><span class="text-muted">POD</span><span>${c.pod || '—'}</span></div>
      <div class="info-row"><span class="text-muted">Yard / Block</span><span>${c.yard || '—'}</span></div>
      <div class="info-row"><span class="text-muted">Key Site Bay</span><span>${c.ksBay || '—'}</span></div>
      <div class="info-row"><span class="text-muted">Slip No.</span><span class="code">${c.positionSlip || '—'}</span></div>
      <div class="info-row"><span class="text-muted">Dwell</span><span>${dwellHours(c).toFixed(1)}h</span></div>
      <div class="info-row"><span class="text-muted">Free Period</span><span>${getFreeTimeDays(c.source)} days</span></div>
      <div class="info-row"><span class="text-muted">Free Time Left</span>${freeTimeDisplay(c)}</div>
      <div class="info-row"><span class="text-muted">Status</span>${badge(c.status)}</div>
      <div class="info-row"><span class="text-muted">Shift Count</span><span class="font-bold ${(c.shiftCount || 0) > 2 ? 'text-gold' : ''}">${c.shiftCount || 0}</span></div>
      <div class="info-row"><span class="text-muted">Shutout</span><span>${c.shutout ? '<span class="text-danger font-bold">YES</span>' : 'No'}</span></div>
      <div class="info-row"><span class="text-muted">Loading Clerk</span><span>${c.loadedBy || '—'}</span></div>
      <div class="info-row"><span class="text-muted">Weight</span><span>${c.weight || '—'} kg</span></div>
    </div>
    ${cShifts.length ? `<div class="divider"></div><div class="card-title">🔀 Shift History (${cShifts.length})</div><div class="scroll-table" style="max-height:120px;background:rgba(6,11,22,0.5);padding:0.75rem;border-radius:9px">${cShifts.map(s => `<div class="info-row"><span>${s.from} → <strong>${s.to}</strong> · ${s.reason}</span><span class="text-xs text-muted">${new Date(s.shiftedAt).toLocaleString()}</span></div>`).join('')}</div>` : ''}
    ${cShutouts.length ? `<div class="divider"></div><div class="card-title">🚫 Shutout Records (${cShutouts.length})</div><div class="scroll-table" style="max-height:100px;background:rgba(251,113,133,0.05);padding:0.75rem;border-radius:9px">${cShutouts.map(s => `<div class="info-row"><span class="text-danger">${s.reason}</span><span class="text-xs text-muted">${new Date(s.shutoutAt).toLocaleString()}</span></div>`).join('')}</div>` : ''}
    <div class="divider"></div>
    <div class="card-title">📋 Workflow</div><div class="workflow">${wfHTML}</div>
    <div class="divider"></div>
    <div class="card-title">📜 Movement History</div>
    <div class="scroll-table" style="max-height:180px;background:rgba(6,11,22,0.5);padding:0.75rem;border-radius:9px">${(c.movements || []).map(m => `<div class="info-row"><span>${m.note || m.status}</span><span class="text-muted text-xs">${new Date(m.time).toLocaleString()} · ${m.user || 'System'}</span></div>`).join('') || '<span class="text-muted">No movement history</span>'}</div>
    ${c.positionSlip ? `<div class="mt-3 btn-group"><button class="btn btn-secondary btn-sm" onclick="showSlipModal('${c.positionSlip}')">🏷️ View Position Slip</button></div>` : ''}
  `;
    document.getElementById('modalOverlay').classList.remove('hidden');
};
window.closeModal = (e) => { if (!e || e.target === document.getElementById('modalOverlay')) document.getElementById('modalOverlay').classList.add('hidden'); };

// ═══ SLIP ═══
window.showSlipModal = (slipNo) => { const slip = DB.slips.find(s => s.slipNo === slipNo); if (!slip) return; const c = findC(slip.containerId); document.getElementById('slipPrintContent').innerHTML = buildSlipHTML(slip, c); document.getElementById('slipModal').classList.remove('hidden'); };
window.closeSlipModal = (e) => { if (!e || e.target === document.getElementById('slipModal')) document.getElementById('slipModal').classList.add('hidden'); };
window.printSlip = () => { const content = document.getElementById('printableSlip')?.outerHTML; if (!content) return; const w = window.open('', '_blank'); w.document.write(`<!DOCTYPE html><html><head><title>KPA Position Slip</title><style>body{font-family:Georgia,serif;padding:18px;max-width:640px;margin:0 auto;font-size:11pt;color:#000}.kpa-slip{padding:0}.kpa-slip-top{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:6px}.kpa-slip h2{font-size:12pt;font-weight:bold;text-decoration:underline;margin-bottom:6px}.kpa-slip-ref{font-size:10pt;margin-top:3px}.kpa-slip-ref span{font-weight:bold}.kpa-slip-section{border-top:1px solid #aaa;padding-top:8px;margin-top:8px}.kpa-slip-section h3{font-size:10.5pt;font-weight:bold;text-decoration:underline;margin-bottom:6px}.kpa-slip-grid-2{display:grid;grid-template-columns:1fr 1fr;gap:3px 20px}.kpa-slip-f{font-size:10pt;margin-bottom:2px}.fl{font-weight:bold;text-transform:uppercase}.kpa-slip-vessel-section,.kpa-slip-trans-section{margin-top:8px;border-top:1px solid #aaa;padding-top:8px}.kpa-slip-trans-row{display:flex;gap:20px;font-size:10pt;flex-wrap:wrap}.kpa-slip-barcode{text-align:right;margin-top:8px;font-family:'Courier New',monospace;font-size:8pt;color:#444}.kpa-slip-footer{text-align:center;font-size:8pt;color:#666;margin-top:8px;border-top:1px solid #ddd;padding-top:5px;font-style:italic}</style></head><body>${content}</body></html>`); w.document.close(); setTimeout(() => w.print(), 400); };
function buildSlipHTML(slip, c) {
    const now = new Date(slip.issued); const dtStr = `${now.getDate().toString().padStart(2, '0')}-${now.toLocaleString('en', { month: 'short' })}-${now.getFullYear().toString().slice(-2)} ${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`; const type = (c && c.type) || slip.type || '20G0'; const sizePart = type.startsWith('40') || type.startsWith('45') ? "40'" : "20'"; const typePart = type.includes('HC') ? 'HC DRY' : type.includes('RF') ? 'REEFER' : type.includes('OT') ? 'OPEN TOP' : type.includes('FR') ? 'FLAT RACK' : 'DRY'; const lineFullName = getLineFullName((c && c.line) || slip.line || '');
    return `<div class="kpa-slip" id="printableSlip">
  <div class="kpa-slip-top"><div><h2>POSITION SLIP</h2><div class="kpa-slip-ref">SLIP NO: <span>${slip.slipNo}</span></div><div class="kpa-slip-ref">DATE/TIME: <span>${dtStr}</span></div></div><div style="text-align:right"><div style="font-size:9pt;font-weight:bold">KENYA PORTS AUTHORITY</div><div style="font-size:8pt">Mombasa Container Terminal</div><div style="font-size:8pt">P.O. Box 95009 — 80104 Mombasa</div></div></div>
  <div class="kpa-slip-section"><h3>CONTAINER DETAILS</h3>
    <div class="kpa-slip-grid-2">
      <div class="kpa-slip-f"><span class="fl">CONTAINER: </span><span>${slip.containerId}</span></div>
      <div class="kpa-slip-f"><span class="fl">LOCATION: </span><span>${slip.yard}</span></div>
      <div class="kpa-slip-f"><span class="fl">OPERATOR: </span><span>${(c && c.line) || slip.line || ''}</span></div>
      <div class="kpa-slip-f"><span class="fl">FULL NAME: </span><span>${lineFullName}</span></div>
      <div class="kpa-slip-f"><span class="fl">TYPE: </span><span>${typePart}</span></div>
      <div class="kpa-slip-f"><span class="fl">SIZE: </span><span>${sizePart}</span></div>
      <div class="kpa-slip-f"><span class="fl">HEIGHT: </span><span>${slip.height || "8'"}</span></div>
      <div class="kpa-slip-f"><span class="fl">WEIGHT: </span><span>${slip.weight || '4444.0'} Kg</span></div>
      <div class="kpa-slip-f"><span class="fl">POD: </span><span>${(c && c.pod) || slip.pod || ''}</span></div>
      <div class="kpa-slip-f"><span class="fl">CARGO: </span><span>EMPTY</span></div>
      <div class="kpa-slip-f"><span class="fl">ENTRY POINT: </span><span>${(c && c.source) || slip.gate || ''}</span></div>
      <div class="kpa-slip-f"><span class="fl">FREE PERIOD: </span><span>${c ? getFreeTimeDays(c.source) : 5} days</span></div>
      <div class="kpa-slip-f"><span class="fl">CUSTOM INSP: </span><span>${slip.customInspection || 'N'}</span></div>
      <div class="kpa-slip-f"><span class="fl">REFERENCE: </span><span>${slip.reference || ''}</span></div>
    </div>
  </div>
  <div class="kpa-slip-vessel-section"><h3>VESSEL DETAILS</h3>
    <div class="kpa-slip-grid-2">
      <div class="kpa-slip-f"><span class="fl">VESSEL: </span><span>${(c && c.vessel) || slip.vessel || '—'}</span></div>
      <div class="kpa-slip-f"><span class="fl">VOYAGE: </span><span>${(c && c.voyage) || slip.voyage || '—'}</span></div>
    </div>
  </div>
  <div class="kpa-slip-trans-section"><h3>TRANSPORTATION DETAILS</h3>
    <div class="kpa-slip-trans-row">
      <div><span class="fl">TRANS TYPE: </span><span>${slip.transtype || 'TRUCK'}</span></div>
      <div><span class="fl">TRANS COMPANY: </span><span>${slip.transco || '—'}</span></div>
      <div><span class="fl">PLATE NO: </span><span>${slip.plate || '—'}</span></div>
    </div>
  </div>
  <div class="kpa-slip-barcode">CLERK: ${slip.clerk || '—'} &nbsp;&nbsp; GATE: ${(c && c.source) || slip.gate || '—'} &nbsp;&nbsp; FREE: ${c ? getFreeTimeDays(c.source) : 5} days &nbsp;&nbsp; REF: ${slip.reference || ''}</div>
  <div class="kpa-slip-footer">This position slip must be presented at yard entry · Kenya Ports Authority · Mombasa Container Terminal · Authorized personnel only</div>
</div>`;
}
function getLineFullName(line) { const n = { EVG: 'EVERGREEN SHIPPING LINE', MSC: 'MEDITERRANEAN SHIPPING CO', MAERSK: 'MAERSK LINE A/S', 'CMA CGM': 'CMA CGM GROUP', CMA: 'CMA CGM GROUP', HLCU: 'HAPAG-LLOYD AG', HAPAG: 'HAPAG-LLOYD AG', 'HAPAG-LLOYD': 'HAPAG-LLOYD AG', COSCO: 'COSCO SHIPPING LINES', OOCL: 'ORIENT OVERSEAS CONTAINER', APL: 'APL LIMITED', YANG: 'YANG MING MARINE', PIL: 'PACIFIC INTERNATIONAL LINES', ONE: 'OCEAN NETWORK EXPRESS', HMM: 'HYUNDAI MERCHANT MARINE' }; return n[line] || line || ''; }
function generateSlipPDF(slip, c) { const { jsPDF } = window.jspdf; const doc = new jsPDF('p', 'mm', 'a4'); const now = new Date(slip.issued); const dtStr = `${now.getDate().toString().padStart(2, '0')}-${now.toLocaleString('en', { month: 'short' })}-${now.getFullYear().toString().slice(-2)} ${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`; doc.setFontSize(13); doc.setFont('helvetica', 'bold'); doc.text('POSITION SLIP', 14, 20); doc.setFontSize(10); doc.setFont('helvetica', 'normal'); doc.text(`SLIP NO: ${slip.slipNo}`, 140, 20); doc.text(`DATE/TIME: ${dtStr}`, 140, 27); doc.text(`CONTAINER: ${slip.containerId}`, 14, 28); doc.text(`LOCATION: ${slip.yard}`, 14, 35); doc.text(`OPERATOR: ${(c && c.line) || slip.line || ''} : ${getLineFullName((c && c.line) || slip.line || '')}`, 14, 42); let y = 52; doc.setFont('helvetica', 'bold'); doc.text('CONTAINER DETAILS', 14, y); y += 6; doc.setFont('helvetica', 'normal'); const type = (c && c.type) || slip.type || '20G0'; const sz = type.startsWith('40') || type.startsWith('45') ? "40'" : "20'"; const tp = type.includes('HC') ? 'HC DRY' : type.includes('RF') ? 'REEFER' : 'DRY'; doc.text(`TYPE: ${tp}  SIZE: ${sz}  HEIGHT: ${slip.height || "8'"}  WEIGHT: ${slip.weight || '4444.0'} Kg`, 14, y); y += 6; doc.text(`POD: ${(c && c.pod) || slip.pod || ''}  CARGO: EMPTY  ENTRY: ${(c && c.source) || slip.gate || ''}  FREE PERIOD: ${c ? getFreeTimeDays(c.source) : 5} days`, 14, y); y += 10; doc.setFont('helvetica', 'bold'); doc.text('VESSEL DETAILS', 14, y); y += 6; doc.setFont('helvetica', 'normal'); doc.text(`VESSEL: ${(c && c.vessel) || slip.vessel || ''}   VOYAGE: ${(c && c.voyage) || slip.voyage || ''}`, 14, y); y += 10; doc.setFont('helvetica', 'bold'); doc.text('TRANSPORTATION DETAILS', 14, y); y += 6; doc.setFont('helvetica', 'normal'); doc.text(`TYPE: ${slip.transtype || 'TRUCK'}  COMPANY: ${slip.transco || 'N/A'}  PLATE: ${slip.plate || 'N/A'}`, 14, y); y += 8; doc.text(`GATE CLERK: ${slip.clerk || ''}  REF: ${slip.reference || ''}`, 14, y); y += 10; doc.setFontSize(8); doc.setTextColor(100); doc.text('Kenya Ports Authority · Mombasa Container Terminal · This position slip must be presented at yard entry', 14, y); doc.save(`Position_Slip_${slip.containerId}.pdf`); toast('📄 Position Slip PDF saved', 'success'); }
window.pdfSlip = () => { if (lastSlipData) generateSlipPDF(lastSlipData.slip, lastSlipData.c); else toast('Use Print button', 'info'); };

// ═══ RENDER ALL ═══
function renderAll() {
    populateAllDropdowns();
    renderDashboard(); renderTable(); renderSlips(); renderKeysite(); renderVessel(); renderSGR(); renderYardBlocks(); renderLogs(); renderShifting(); renderShutouts(); renderVesselYardTable(); renderRandomLoading();
    if (document.getElementById('tab-reports')?.classList.contains('active')) renderReports();
    renderImportStats(); renderImportTable(); renderImportCharts();
}

// ═══════════════════════════════════════════════════════
// ═══ DASHBOARD v2 — REFINED, MODERN, SOPHISTICATED ═══
// ═══════════════════════════════════════════════════════
const LINE_DOT_COLORS = ['#378ADD', '#1D9E75', '#D85A30', '#7F77DD', '#D4537E', '#639922', '#BA7517', '#E24B4A', '#888780', '#5DCAA5', '#F09595', '#9FE1CB'];

function renderDashboard() {
    const cs = DB.containers;
    const now = Date.now();

    // ── Core counts ──
    const total = cs.length;
    const pa = cs.filter(c => c.status === 'PREADVISED').length;
    const gated = cs.filter(c => c.status === 'GATED_IN').length;
    const ks = cs.filter(c => c.status === 'KEY_SITE').length;
    const loaded = cs.filter(c => c.status === 'LOADED_VESSEL').length;
    const sgrCount = cs.filter(c => c.source === 'ICD' && !['LOADED_VESSEL', 'OUT_OF_PORT'].includes(c.status)).length;
    const vty = cs.filter(c => c.status === 'VESSEL_TO_YARD').length;
    const out = cs.filter(c => c.status === 'OUT_OF_PORT').length;
    const shutouts = DB.shutouts.length;
    const shifts = DB.shifts.length;
    const slips = DB.slips.length;
    const inPort = cs.filter(c => !['OUT_OF_PORT'].includes(c.status)).length;
    const gate18 = cs.filter(c => c.source === 'Gate18').length;
    const gate24 = cs.filter(c => c.source === 'Gate24').length;
    const icd = cs.filter(c => c.source === 'ICD').length;
    const vesselSrc = cs.filter(c => c.source === 'Vessel').length;

    // ── Active / overdue ──
    const active = cs.filter(c => !['LOADED_VESSEL', 'OUT_OF_PORT'].includes(c.status));
    const overdue = active.filter(c => freeDaysLeft(c) < 0);
    const nearExpiry = active.filter(c => freeDaysLeft(c) >= 0 && freeDaysLeft(c) < 48);
    const avgDwell = active.length ? active.reduce((a, c) => a + dwellHours(c), 0) / active.length : 0;
    const highDwell = active.filter(c => dwellHours(c) > 96).length;

    // ── Update date chip ──
    const dateEl = document.getElementById('dashDateChip');
    if (dateEl) {
        const d = new Date();
        dateEl.textContent = d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
    }

    // ── Alert banner ──
    const alertEl = document.getElementById('dashAlertBanner');
    if (overdue.length > 0) {
        alertEl.innerHTML = `<div class="dv2-alert">
      <span class="dv2-alert-icon">⚠</span>
      <span><strong>${overdue.length} container${overdue.length > 1 ? 's' : ''} have exceeded free time</strong> — immediate action required.
      Affected: ${overdue.slice(0, 4).map(c => `<span class="code" onclick="showDetail('${c.id}')" style="cursor:pointer">${c.id}</span>`).join(', ')}${overdue.length > 4 ? ` +${overdue.length - 4} more` : ''}.</span>
    </div>`;
    } else {
        alertEl.innerHTML = '';
    }

    // ── Validation strip ──
    const vals = [
        {
            cls: overdue.length > 0 ? 'dv2-val-err' : (nearExpiry.length > 0 ? 'dv2-val-warn' : 'dv2-val-ok'),
            icon: overdue.length > 0 ? '⚠' : '⏰',
            title: overdue.length > 0 ? `${overdue.length} overdue` : (nearExpiry.length > 0 ? `${nearExpiry.length} near expiry` : 'Free time clear'),
            sub: overdue.length > 0 ? 'Freetime exceeded — act now' : `${nearExpiry.length} containers within 48h`
        },
        {
            cls: shutouts > 3 ? 'dv2-val-warn' : (shutouts > 0 ? 'dv2-val-info' : 'dv2-val-ok'),
            icon: '⊘',
            title: `${shutouts} shutout${shutouts !== 1 ? 's' : ''}`,
            sub: shutouts > 0 ? 'Missed vessel loads' : 'No shutouts on record'
        },
        {
            cls: pa > 20 ? 'dv2-val-warn' : 'dv2-val-ok',
            icon: '✓',
            title: `${pa} pre-advised`,
            sub: pa > 20 ? 'High pending queue — action needed' : 'Awaiting gate-in'
        },
        {
            cls: highDwell > 5 ? 'dv2-val-warn' : (shifts > 15 ? 'dv2-val-info' : 'dv2-val-ok'),
            icon: '↔',
            title: `${shifts} shift${shifts !== 1 ? 's' : ''}`,
            sub: `${highDwell} containers dwell >96h`
        }
    ];
    const valEl = document.getElementById('dv2ValStrip');
    if (valEl) valEl.innerHTML = vals.map(v => `
    <div class="dv2-val-item">
      <div class="dv2-val-icon ${v.cls}">${v.icon}</div>
      <div class="dv2-val-body">
        <div class="dv2-val-title">${v.title}</div>
        <div class="dv2-val-sub">${v.sub}</div>
      </div>
    </div>
  `).join('');

    // ── Primary KPIs ──
    const kpiEl = document.getElementById('dv2KpiRow');
    if (kpiEl) kpiEl.innerHTML = [
        { label: 'Total containers', val: total, sub: `${inPort} currently in port`, accent: 'var(--accent)', cls: '' },
        { label: 'Gated in', val: gated, sub: `${slips} position slips issued`, accent: '#1D9E75', cls: 'dv2-kpi-success' },
        { label: 'Key site / Pre-stake', val: ks, sub: 'Ready for vessel load', accent: '#BA7517', cls: ks > 0 ? 'dv2-kpi-warn' : '' },
        { label: 'Overdue free time', val: overdue.length, sub: `${nearExpiry.length} near expiry (<48h)`, accent: overdue.length > 0 ? '#E24B4A' : '#1D9E75', cls: overdue.length > 0 ? 'dv2-kpi-danger' : '' },
    ].map(k => `
    <div class="dv2-kpi ${k.cls}">
      <div class="dv2-kpi-stripe" style="background:${k.accent}"></div>
      <div class="dv2-kpi-label">${k.label}</div>
      <div class="dv2-kpi-val">${k.val}</div>
      <div class="dv2-kpi-sub">${k.sub}</div>
    </div>
  `).join('');

    // ── Secondary metrics ──
    const secEl = document.getElementById('dv2SecRow');
    if (secEl) secEl.innerHTML = [
        { icon: '📋', val: pa, lbl: 'Pre-advised', sub: 'Awaiting gate' },
        { icon: '🛳️', val: loaded, lbl: 'Loaded', sub: 'On vessel' },
        { icon: '🚃', val: sgrCount, lbl: 'SGR / ICD', sub: 'Rail pipeline' },
        { icon: '🏷️', val: slips, lbl: 'Slips issued', sub: 'Position slips' },
        { icon: '🔀', val: shifts, lbl: 'Shifts', sub: 'Container moves' },
        { icon: '⚡', val: avgDwell.toFixed(1) + 'h', lbl: 'Avg dwell', sub: highDwell + ' above 96h', cls: avgDwell > 72 ? 'dv2-sec-warn' : '' },
    ].map(s => `
    <div class="dv2-sec ${s.cls || ''}">
      <div class="dv2-sec-icon">${s.icon}</div>
      <div class="dv2-sec-val">${s.val}</div>
      <div class="dv2-sec-lbl">${s.lbl}</div>
      <div class="dv2-sec-sub">${s.sub}</div>
    </div>
  `).join('');

    // ── Gate distribution ──
    const gTotal = Math.max(1, gate18 + gate24 + icd + vesselSrc);
    const gateEl = document.getElementById('dv2GateRow');
    if (gateEl) gateEl.innerHTML = [
        { label: 'Gate 18 — Depot repatriation', val: gate18, color: '#378ADD', free: '5-day free period' },
        { label: 'Gate 24 — Depot repatriation', val: gate24, color: '#1D9E75', free: '5-day free period' },
        { label: 'ICD / SGR Rail', val: icd, color: '#7F77DD', free: '7-day free period' },
    ].map(g => `
    <div class="dv2-gate">
      <div class="dv2-gate-left">
        <div class="dv2-gate-label">${g.label}</div>
        <div class="dv2-gate-val">${g.val}</div>
      </div>
      <div class="dv2-gate-right">
        <div class="dv2-gate-pct">${Math.round(g.val / gTotal * 100)}%</div>
        <div class="dv2-gate-track"><div class="dv2-gate-fill" style="width:${g.val / gTotal * 100}%;background:${g.color}"></div></div>
        <div class="dv2-gate-free">${g.free}</div>
      </div>
    </div>
  `).join('');

    // ── Shipping line summary table ──
    const lines = [...new Set(cs.map(c => c.line))].filter(Boolean).sort();
    const lineTbody = document.getElementById('dv2LineTbody');
    if (lineTbody) {
        if (!lines.length) {
            lineTbody.innerHTML = '<tr><td colspan="11" style="text-align:center;color:var(--text-3);padding:1.5rem;font-size:0.82rem">No container data loaded</td></tr>';
        } else {
            lineTbody.innerHTML = lines.map((line, li) => {
                const lcs = cs.filter(c => c.line === line);
                const lPa = lcs.filter(c => c.status === 'PREADVISED').length;
                const lGated = lcs.filter(c => c.status === 'GATED_IN').length;
                const lKs = lcs.filter(c => c.status === 'KEY_SITE').length;
                const lLoaded = lcs.filter(c => c.status === 'LOADED_VESSEL').length;
                const lSgr = lcs.filter(c => c.source === 'ICD').length;
                const lActive = lcs.filter(c => !['LOADED_VESSEL', 'OUT_OF_PORT'].includes(c.status));
                const lOverdue = lActive.filter(c => freeDaysLeft(c) < 0).length;
                const lAvg = lActive.length ? lActive.reduce((a, c) => a + dwellHours(c), 0) / lActive.length : 0;
                const lShutouts = DB.shutouts.filter(s => s.line === line).length;
                const dotColor = LINE_DOT_COLORS[li % LINE_DOT_COLORS.length];
                // Mini spread bar
                const lTotal = Math.max(1, lcs.length);
                const spread = [
                    { n: lPa, c: '#888780' }, { n: lGated, c: '#1D9E75' }, { n: lKs, c: '#BA7517' },
                    { n: lLoaded, c: '#378ADD' }, { n: lOverdue, c: '#E24B4A' }
                ].map(s => `<div style="width:${Math.max(3, Math.round(s.n / lTotal * 44))}px;height:10px;background:${s.c};border-radius:1px" title="${s.n}"></div>`).join('');

                return `<tr>
          <td>
            <span style="width:7px;height:7px;border-radius:50%;background:${dotColor};display:inline-block;margin-right:7px;flex-shrink:0"></span>
            <strong style="font-size:0.78rem">${line}</strong>
          </td>
          <td><strong>${lcs.length}</strong></td>
          <td>${lPa || '—'}</td>
          <td style="color:var(--green)">${lGated || '—'}</td>
          <td style="color:var(--orange)">${lKs || '—'}</td>
          <td style="color:var(--accent)">${lLoaded || '—'}</td>
          <td>${lSgr || '—'}</td>
          <td>${lOverdue > 0 ? `<span class="dv2-pill dv2-pill-danger">${lOverdue}</span>` : '<span style="color:var(--text-3);font-size:0.72rem">—</span>'}</td>
          <td style="font-family:'JetBrains Mono',monospace;font-size:0.75rem;color:${lAvg > 96 ? 'var(--orange)' : 'inherit'}">${lAvg > 0 ? lAvg.toFixed(1) + 'h' : '—'}</td>
          <td>${lShutouts > 0 ? `<span class="dv2-pill dv2-pill-warn">${lShutouts}</span>` : '<span style="color:var(--text-3);font-size:0.72rem">—</span>'}</td>
          <td><div style="display:flex;gap:2px;align-items:flex-end;height:14px">${spread}</div></td>
        </tr>`;
            }).join('');
        }
    }

    // ── Dwell buckets (bottom grid) ──
    const buckets = { '<24h': 0, '24-48h': 0, '48-72h': 0, '3-5d': 0, '5-7d': 0, '>7d': 0 };
    active.forEach(c => { const h = dwellHours(c); if (h < 24) buckets['<24h']++; else if (h < 48) buckets['24-48h']++; else if (h < 72) buckets['48-72h']++; else if (h < 120) buckets['3-5d']++; else if (h < 168) buckets['5-7d']++; else buckets['>7d']++; });
    const maxB = Math.max(...Object.values(buckets), 1);
    document.getElementById('dwellBuckets').innerHTML = Object.entries(buckets).map(([label, n]) => `<div><div class="flex justify-between text-xs mb-1"><span style="color:var(--text-2)">${label}</span><span class="font-bold">${n}</span></div><div style="height:4px;background:rgba(56,189,248,0.08);border-radius:99px;overflow:hidden"><div style="width:${n / maxB * 100}%;height:100%;background:${n / maxB > 0.6 ? 'linear-gradient(90deg,#e11d48,#fb7185)' : n / maxB > 0.3 ? 'linear-gradient(90deg,#d97706,#fbbf24)' : 'linear-gradient(90deg,#0ea5e9,#38bdf8)'};border-radius:99px"></div></div></div>`).join('');
    document.getElementById('overdueList').innerHTML = overdue.slice(0, 8).map(c => `<div class="info-row"><span class="tbl-id" onclick="showDetail('${c.id}')">${c.id}</span><span class="overdue">${Math.abs(freeDaysLeft(c) / 24).toFixed(1)}d overdue</span></div>`).join('') || '<span class="text-success text-sm">✅ All containers within free time</span>';

    // ── Workflow snapshot ──
    const statusCounts = {}; Object.keys(STATUS_META).forEach(s => statusCounts[s] = cs.filter(c => c.status === s).length);
    document.getElementById('wfSnapshot').innerHTML = Object.entries(STATUS_META).map(([s, m]) => `<div class="info-row"><span>${m.icon} ${m.label}</span><span class="font-bold" style="min-width:28px;text-align:right">${statusCounts[s] || 0}</span></div>`).join('');

    // ── Vessels in play ──
    const vesselMap = {}; cs.filter(c => c.vessel && !['OUT_OF_PORT'].includes(c.status)).forEach(c => { if (!vesselMap[c.vessel]) vesselMap[c.vessel] = { total: 0, loaded: 0, ks: 0 }; vesselMap[c.vessel].total++; if (c.status === 'LOADED_VESSEL') vesselMap[c.vessel].loaded++; if (c.status === 'KEY_SITE') vesselMap[c.vessel].ks++; });
    document.getElementById('vesselSnapshot').innerHTML = Object.entries(vesselMap).slice(0, 5).map(([v, d]) => `<div class="info-row"><span class="text-sm">${v}</span><span class="text-xs"><span class="text-success">${d.loaded}✓</span> <span style="color:var(--orange)">${d.ks}⚓</span> <span class="text-muted">${d.total} tot</span></span></div>`).join('') || '<span class="text-muted text-sm">No active vessels</span>';

    // ── Recent activity ──
    document.getElementById('recentActivity').innerHTML = DB.logs.slice(0, 12).map(l => `<div class="info-row"><span><span class="code">${l.containerId}</span> <span class="text-xs" style="color:var(--accent)">${l.action}</span></span><span class="text-xs text-muted">${timeAgo(l.time)}</span></div>`).join('') || '<span class="text-muted text-sm">No recent activity</span>';
}

function timeAgo(ts) { const s = Math.floor((Date.now() - ts) / 1000); if (s < 60) return `${s}s ago`; if (s < 3600) return `${Math.floor(s / 60)}m ago`; if (s < 86400) return `${Math.floor(s / 3600)}h ago`; return `${Math.floor(s / 86400)}d ago`; }

// ═══ CONTAINER TABLE ═══
function renderTable() {
    const srch = (document.getElementById('srch')?.value || '').toLowerCase();
    const fStatus = document.getElementById('fStatus')?.value || '';
    const fSource = document.getElementById('fSource')?.value || '';
    const fLine = tsGetValue('fLine') || '';
    const fVessel = tsGetValue('fVessel') || '';
    let arr = DB.containers.slice().sort((a, b) => b.created - a.created);
    if (fStatus) arr = arr.filter(c => c.status === fStatus);
    if (fSource) arr = arr.filter(c => c.source === fSource);
    if (fLine) arr = arr.filter(c => c.line === fLine);
    if (fVessel) arr = arr.filter(c => c.vessel === fVessel);
    if (srch) arr = arr.filter(c => [c.id, c.line, c.vessel, c.yard, c.positionSlip].join(' ').toLowerCase().includes(srch));
    document.getElementById('tBody').innerHTML = arr.map(c => `<tr>
    <td><span class="tbl-id" onclick="showDetail('${c.id}')">${c.id}</span></td>
    <td>${c.line}</td>
    <td>${sourceBadge(c.source)}</td>
    <td>${badge(c.status)}</td>
    <td><span class="text-sm">${c.vessel}</span>${c.voyage ? `<br><span class="text-xs text-muted">${c.voyage}</span>` : ''}</td>
    <td>${c.yard || '—'}</td>
    <td>${c.positionSlip ? `<span class="code">${c.positionSlip}</span>` : '—'}</td>
    <td>${freeTimeDisplay(c)}</td>
    <td class="${dwellHours(c) > 120 ? 'overdue' : ''}">${dwellHours(c).toFixed(1)}h</td>
    <td>${c.clerk || c.loadedBy || '—'}</td>
    <td><button class="btn btn-xs btn-secondary" onclick="showDetail('${c.id}')">📋</button></td>
  </tr>`).join('') || '<tr><td colspan="11" class="text-muted" style="text-align:center;padding:2rem">No containers match filters</td></tr>';
    document.getElementById('tCount').textContent = `${arr.length} of ${DB.containers.length} containers`;
}

// ═══ SLIPS ═══
function renderSlips() {
    const srch = (document.getElementById('slipSearch')?.value || '').toLowerCase();
    let arr = DB.slips.slice().sort((a, b) => new Date(b.issued) - new Date(a.issued));
    if (srch) arr = arr.filter(s => [s.slipNo, s.containerId, s.yard, s.plate, s.clerk, s.vessel].join(' ').toLowerCase().includes(srch));
    document.getElementById('slipBody').innerHTML = arr.map(s => `<tr><td><span class="code">${s.slipNo}</span></td><td><span class="tbl-id" onclick="showDetail('${s.containerId}')">${s.containerId}</span></td><td>${s.line}</td><td>${s.vessel}</td><td>${s.yard}</td><td>${s.plate || '—'}</td><td>${s.transco || '—'}</td><td>${s.transtype || 'TRUCK'}</td><td>${s.clerk || '—'}</td><td style="font-size:0.7rem">${new Date(s.issued).toLocaleString()}</td><td><button class="btn btn-xs btn-primary" onclick="showSlipModal('${s.slipNo}')">🖨️</button></td></tr>`).join('');
    document.getElementById('slipCount').textContent = `${arr.length} slips`;
}

// ═══ VESSEL TABLE ═══
function renderVessel() {
    const arr = DB.containers.filter(c => c.status === 'LOADED_VESSEL').sort((a, b) => b.loaded - a.loaded);
    document.getElementById('vesselBody').innerHTML = arr.map(c => `<tr><td><span class="tbl-id" onclick="showDetail('${c.id}')">${c.id}</span></td><td>${c.line}</td><td>${c.type}</td><td>${c.vessel}</td><td>${c.voyage || '—'}</td><td>${c.bay || '—'}</td><td>${c.loadedBy || '—'}</td><td>${c.shiftCount || 0}</td><td style="font-size:0.7rem">${c.loaded ? new Date(c.loaded).toLocaleString() : '—'}</td></tr>`).join('') || '<tr><td colspan="9" class="text-muted" style="text-align:center;padding:1.5rem">No containers loaded yet</td></tr>';
    const byVessel = {}; arr.forEach(c => { (byVessel[c.vessel] = byVessel[c.vessel] || []).push(c); });
    document.getElementById('vesselLoadedTable').innerHTML = Object.entries(byVessel).sort((a, b) => b[1].length - a[1].length).map(([v, cs]) => `<div class="info-row"><span>${v}</span><span class="font-bold text-accent">${cs.length} loaded</span></div>`).join('') || '<span class="text-muted text-sm">No vessels loaded</span>';
}

// ═══ YARD BLOCKS ═══
function renderYardBlocks() {
    const blocks = {}; DB.containers.filter(c => c.yard && !['OUT_OF_PORT', 'LOADED_VESSEL'].includes(c.status)).forEach(c => { blocks[c.yard] = (blocks[c.yard] || 0) + 1; });
    document.getElementById('yardBlockTable').innerHTML = Object.entries(blocks).sort((a, b) => b[1] - a[1]).map(([b, n]) => `<div class="info-row"><span>${b}</span><span class="font-bold">${n} container${n !== 1 ? 's' : ''}</span></div>`).join('') || '<span class="text-muted text-sm">No containers in yard</span>';
}

// ═══ LOGS ═══
function renderLogs() {
    document.getElementById('logsContent').innerHTML = DB.logs.slice(0, 200).map(l => `<div class="info-row"><span><span class="code">${l.containerId}</span> <span style="color:var(--accent);font-size:0.7rem;font-weight:700">${l.action}</span> ${l.detail ? `<span class="text-xs text-muted">· ${l.detail}</span>` : ''}</span><div style="text-align:right;flex-shrink:0"><span class="text-xs text-muted">${new Date(l.time).toLocaleString()}</span><br><span class="text-xs" style="color:var(--violet)">${l.user}</span></div></div>`).join('') || '<div class="text-muted">No audit log entries</div>';
}
window.exportLogsCSV = () => { let csv = 'ID,Container,Action,Detail,User,Time\n'; DB.logs.forEach(l => { csv += `${l.id},"${l.containerId}","${l.action}","${(l.detail || '').replace(/"/g, "'")}","${l.user}","${new Date(l.time).toLocaleString()}"\n`; }); dlFile(csv, 'text/csv', 'kpa_audit_logs.csv'); toast('📥 Audit logs exported', 'success'); };
window.clearLogs = () => { if (!confirm('Clear all audit logs? This cannot be undone.')) return; DB.logs = []; save(); renderLogs(); toast('🗑️ Audit logs cleared', 'warn'); };

// ═══ EXPORTS ═══
window.exportCSV = () => { let csv = 'Container ID,Line,Source,Status,Vessel,Voyage,Yard,Slip No,Dwell(h),Clerk\n'; DB.containers.forEach(c => { csv += `${c.id},${c.line},${c.source},${c.status},${c.vessel},${c.voyage || ''},${c.yard || ''},${c.positionSlip || ''},${dwellHours(c).toFixed(1)},${c.clerk || c.loadedBy || ''}\n`; }); dlFile(csv, 'text/csv', 'kpa_containers.csv'); toast('📥 Container CSV exported', 'success'); };
window.exportContainerPDF = () => { const { jsPDF } = window.jspdf; const doc = new jsPDF('l', 'mm', 'a4'); doc.setFontSize(14); doc.text('KPA Container Inventory — Mombasa MCT', 14, 18); doc.setFontSize(8); doc.text(`Generated: ${new Date().toLocaleString()} · info@kpa.go.ke`, 14, 24); doc.autoTable({ head: [['Container ID', 'Line', 'Source', 'Status', 'Vessel', 'Yard', 'Slip No', 'Dwell(h)']], body: DB.containers.map(c => [c.id, c.line, c.source, c.status, c.vessel, c.yard || '', c.positionSlip || '', dwellHours(c).toFixed(1)]), startY: 30, styles: { fontSize: 6.5 }, headStyles: { fillColor: [2, 132, 199] }, alternateRowStyles: { fillColor: [240, 249, 255] } }); doc.save('kpa_containers.pdf'); toast('📄 Container PDF exported', 'success'); };
window.exportSlipsCSV = () => { let csv = 'Slip No,Container,Line,Vessel,Yard,Plate,Trans Co,Trans Type,Clerk,Issued\n'; DB.slips.forEach(s => { csv += `${s.slipNo},${s.containerId},${s.line},${s.vessel},${s.yard},${s.plate || ''},${s.transco || ''},${s.transtype || 'TRUCK'},${s.clerk || ''},"${new Date(s.issued).toLocaleString()}"\n`; }); dlFile(csv, 'text/csv', 'kpa_slips.csv'); toast('📥 Slips CSV exported', 'success'); };
window.exportShiftingCSV = () => { let csv = 'Shift ID,Container,Line,Vessel,From,To,Reason,Equipment,Clerk,Date\n'; DB.shifts.forEach(s => { csv += `${s.id},${s.containerId},${s.line || ''},${s.vessel || ''},${s.from},${s.to},${s.reason},${s.equipment || ''},${s.clerk || ''},"${new Date(s.shiftedAt).toLocaleString()}"\n`; }); dlFile(csv, 'text/csv', 'kpa_shifts.csv'); toast('📥 Shifts CSV exported', 'success'); };
window.exportShutoutsCSV = () => { let csv = 'Shutout ID,Container,Line,Vessel,Voyage,Source,Reason,Clerk,Next Action,Date\n'; DB.shutouts.forEach(s => { csv += `${s.id},${s.containerId},${s.line || ''},${s.vessel || ''},${s.voyage || ''},${s.source},${s.reason},${s.clerk || ''},${s.nextAction},"${new Date(s.shutoutAt).toLocaleString()}"\n`; }); dlFile(csv, 'text/csv', 'kpa_shutouts.csv'); toast('📥 Shutouts CSV exported', 'success'); };
window.exportAllCSV = () => { exportCSV(); setTimeout(() => exportShiftingCSV(), 500); setTimeout(() => exportShutoutsCSV(), 1000); setTimeout(() => exportImportCSV(), 1500); };
window.exportDashboardPDF = () => {
    const { jsPDF } = window.jspdf; const doc = new jsPDF('p', 'mm', 'a4');
    doc.setFontSize(16); doc.text('KPA Operations Dashboard Report', 14, 20);
    doc.setFontSize(10); doc.text(`Generated: ${new Date().toLocaleString()} · ${currentUser}`, 14, 28);
    doc.setFontSize(9);
    const total = DB.containers.length;
    const gated = DB.containers.filter(c => c.status === 'GATED_IN').length;
    const ks = DB.containers.filter(c => c.status === 'KEY_SITE').length;
    const loaded = DB.containers.filter(c => c.status === 'LOADED_VESSEL').length;
    const active = DB.containers.filter(c => !['LOADED_VESSEL', 'OUT_OF_PORT'].includes(c.status));
    const overdue = active.filter(c => freeDaysLeft(c) < 0).length;
    doc.text(`Total Containers: ${total}`, 14, 40); doc.text(`Gated In: ${gated}`, 14, 48); doc.text(`Key Site: ${ks}`, 14, 56); doc.text(`Loaded to Vessel: ${loaded}`, 14, 64); doc.text(`Overdue Free Time: ${overdue}`, 14, 72);

    // Line summary
    const lines = [...new Set(DB.containers.map(c => c.line))].filter(Boolean).sort();
    const lineBody = lines.map(line => {
        const lcs = DB.containers.filter(c => c.line === line);
        const lActive = lcs.filter(c => !['LOADED_VESSEL', 'OUT_OF_PORT'].includes(c.status));
        return [line, lcs.length, lcs.filter(c => c.status === 'GATED_IN').length, lcs.filter(c => c.status === 'KEY_SITE').length, lcs.filter(c => c.status === 'LOADED_VESSEL').length, lActive.filter(c => freeDaysLeft(c) < 0).length];
    });
    if (lineBody.length) { doc.autoTable({ startY: 80, head: [['Line', 'Total', 'Gated', 'Key Site', 'Loaded', 'Overdue']], body: lineBody, styles: { fontSize: 8 }, headStyles: { fillColor: [2, 132, 199] } }); }

    const overdueList = active.filter(c => freeDaysLeft(c) < 0).slice(0, 15);
    if (overdueList.length) { const startY = doc.lastAutoTable?.finalY || 140; doc.autoTable({ startY: startY + 8, head: [['Container ID', 'Line', 'Status', 'Overdue (h)']], body: overdueList.map(c => [c.id, c.line, c.status, Math.abs(freeDaysLeft(c)).toFixed(1)]), styles: { fontSize: 7 }, headStyles: { fillColor: [220, 38, 38] } }); }
    doc.save('kpa_dashboard_report.pdf'); toast('📄 Dashboard PDF exported', 'success');
};

// ═══ CLOCK & BADGES ═══
function startClock() {
    const tick = () => { const el = document.getElementById('dashClock'); if (el) el.textContent = new Date().toLocaleTimeString('en-GB'); };
    tick(); setInterval(tick, 1000);
}
function updateNavBadges() {
    const nb = id => document.getElementById(id);
    if (nb('nb-total')) nb('nb-total').textContent = DB.containers.length;
    if (nb('nb-shift')) nb('nb-shift').textContent = DB.shifts.length;
    if (nb('nb-shutout')) nb('nb-shutout').textContent = DB.shutouts.length;
    if (nb('nb-sgr')) nb('nb-sgr').textContent = DB.containers.filter(c => c.source === 'ICD' && !['OUT_OF_PORT', 'LOADED_VESSEL'].includes(c.status)).length;
    if (nb('nb-import')) nb('nb-import').textContent = ImportDB.containers.filter(c => c.status !== 'RELEASED_OUT').length;
    if (nb('nb-random')) nb('nb-random').textContent = DB.randomLoads.length;
}

async function resetAllSystemData() {
    if (!confirm('!!! DANGER !!! This will erase ALL terminal data (local AND Supabase). This action is irreversible. Proceed?')) return;
    const check = prompt('Type "CONFIRM" to delete all data:');
    if (check !== 'CONFIRM') return;
    toast('💥 Wiping all data — this may take a moment…', 'warn');
    try {
        await Promise.all([
            sb.from('containers').delete().neq('id', ''),
            sb.from('import_containers').delete().neq('id', ''),
            sb.from('logs').delete().neq('id', ''),
            sb.from('import_logs').delete().neq('id', ''),
            sb.from('slips').delete().neq('slip_no', ''),
            sb.from('shifts').delete().neq('id', ''),
            sb.from('shutouts').delete().neq('id', ''),
            sb.from('random_loads').delete().neq('id', ''),
        ]);
        await sb.from('counters').update({ value: 260477500 }).eq('name', 'slip');
        await sb.from('counters').update({ value: 1 }).eq('name', 'shift');
        await sb.from('counters').update({ value: 1 }).eq('name', 'shutout');
        await sb.from('counters').update({ value: 1 }).eq('name', 'random');
    } catch (e) { console.error('Remote reset error:', e); toast('⚠️ Remote wipe failed — check connection; local data was still cleared', 'error'); }
    DB.containers = []; DB.logs = []; DB.slips = []; DB.shifts = []; DB.shutouts = []; DB.randomLoads = [];
    ImportDB.containers = []; ImportDB.logs = [];
    _logsSyncedCount = 0; _ilogsSyncedCount = 0;
    localStorage.removeItem(STORE_KEY); localStorage.removeItem(IMP_STORAGE);
    localStorage.removeItem('KPA_SLIP_CTR'); localStorage.removeItem('KPA_SHIFT_CTR'); localStorage.removeItem('KPA_SHUT_CTR'); localStorage.removeItem('KPA_RAND_CTR');
    _slipCtr = 260477500; _shiftCtr = 1; _shutCtr = 1; _randCtr = 1;
    seedDemo(); seedImportContainers(true); save(); impSave(); await syncToSupabase(); renderAll(); updateNavBadges();
    toast('💥 All system data has been reset to demo state', 'error');
}

// ═══ IMPORTS ═══
function seedImportContainers(silent = false) {
    if (ImportDB.containers.length && !silent) return;
    const now = Date.now();
    ImportDB.containers = [
        { id: 'MEDU1234567', line: 'MSC', vessel: 'MSC FLORIANA VI', voyage: 'V.2412', type: '40G0', status: 'VESSEL_DISCHARGED', dischargedAt: now - 12 * 3600000, ttTag: '', yardBlock: '', receivingClerk: '', rtgOperator: '', releaseClerk: '', truckPlate: '', transco: '', destination: '', movements: [] },
        { id: 'MAEU7654321', line: 'MAERSK', vessel: 'MAERSK OHIO', voyage: '503W', type: '20G0', status: 'AT_TAG_MASTER', dischargedAt: now - 36 * 3600000, ttTag: 'TT-101', yardBlock: '', receivingClerk: '', rtgOperator: '', releaseClerk: '', truckPlate: '', transco: '', destination: '', movements: [] },
        { id: 'CMAU9988776', line: 'CMA CGM', vessel: 'CMA TITAN', voyage: '112E', type: '40HC', status: 'RECEIVED_YARD', dischargedAt: now - 60 * 3600000, ttTag: 'TT-205', yardBlock: 'YARD-C12', receivingClerk: 'John Otieno', rtgOperator: '', releaseClerk: '', truckPlate: '', transco: '', destination: '', movements: [] },
        { id: 'EVGU5554443', line: 'EVG', vessel: 'X-PRESS ANTARES', voyage: '26016W', type: '20RF', status: 'OFFLOADED_RTG', dischargedAt: now - 84 * 3600000, ttTag: 'TT-089', yardBlock: 'YARD-A05', receivingClerk: 'Mary Wambui', rtgOperator: 'RTG-02', releaseClerk: '', truckPlate: '', transco: '', destination: '', movements: [] },
        { id: 'HLCU3322110', line: 'HAPAG-LLOYD', vessel: 'BELLAVIA', voyage: 'V.09', type: '45G0', status: 'RELEASED_OUT', dischargedAt: now - 120 * 3600000, ttTag: 'TT-312', yardBlock: 'YARD-B09', receivingClerk: 'Peter Njeru', rtgOperator: 'RTG-05', releaseClerk: 'Grace Muthoni', truckPlate: 'KCD 123X', transco: 'Logistic Solutions', destination: 'Nairobi ICD', movements: [], releasedAt: now - 24 * 3600000 }
    ];
    if (!silent) toast('🌊 Demo import containers seeded', 'success');
    impSave();
}
function handleImportBulkFile(event) { const file = event.target.files[0]; if (!file) return; const reader = new FileReader(); reader.onload = ev => parseImportBulkCSV(ev.target.result); reader.readAsText(file); }
let importBulkData = [];
function parseImportBulkCSV(text) {
    const lines = text.split('\n').filter(l => l.trim()); if (lines.length < 2) return toast('CSV must have header + data rows', 'error');
    const h = lines[0].split(',').map(x => x.trim().toLowerCase());
    const ci = h.findIndex(x => x.includes('container') || x === 'id'); const li = h.findIndex(x => x.includes('line') || x.includes('shipping')); const vi = h.findIndex(x => x.includes('vessel')); const ti = h.findIndex(x => x.includes('type')); const vyi = h.findIndex(x => x.includes('voyage'));
    if (ci === -1 || li === -1 || vi === -1) return toast('CSV must have Container ID, Shipping Line, Vessel', 'error');
    importBulkData = []; const errors = [];
    for (let i = 1; i < lines.length; i++) { const cols = lines[i].split(',').map(x => x.trim()); const id = (cols[ci] || '').toUpperCase(); const line = cols[li] || ''; const vessel = cols[vi] || ''; const type = (ti >= 0 ? cols[ti] : '20G0') || '20G0'; const voyage = vyi >= 0 ? cols[vyi] || '' : ''; const valid = !!(id && line && vessel && !ImportDB.containers.some(c => c.id === id)); if (!valid && id) errors.push(`Row ${i}: ${id} — ${ImportDB.containers.some(c => c.id === id) ? 'Duplicate' : 'Missing fields'}`); importBulkData.push({ id, line, vessel, type, voyage, valid, row: i }); }
    renderImportBulkPreview(); document.getElementById('importBulkErrors').innerHTML = errors.length ? `<strong>${errors.length} errors:</strong><br>${errors.join('<br>')}` : '';; toast(`Parsed ${importBulkData.length} containers — ${importBulkData.filter(d => d.valid).length} valid`, 'info');
}
function renderImportBulkPreview() { document.getElementById('importBulkPreview').classList.remove('hidden'); document.getElementById('importBulkCount').textContent = importBulkData.length; document.getElementById('importBulkBody').innerHTML = importBulkData.map(d => `<tr style="${d.valid ? '' : 'opacity:0.5;background:rgba(251,113,133,0.03)'}"><td>${d.row}</td><td class="tbl-id">${d.id || '—'}</td><td>${d.line || '—'}</td><td>${d.vessel || '—'}</td><td>${d.type || '—'}</td><td>${d.voyage || '—'}</td><td>${d.valid ? '<span class="text-success">✅ Valid</span>' : '<span class="text-danger">❌ Invalid</span>'}</td></tr>`).join(''); }
function commitImportBulk() { const valid = importBulkData.filter(d => d.valid); if (!valid.length) return toast('No valid containers to commit', 'error'); let added = 0; const now = Date.now(); valid.forEach(d => { if (ImportDB.containers.some(c => c.id === d.id)) return; ImportDB.containers.push({ id: d.id, line: d.line, vessel: d.vessel, voyage: d.voyage, type: d.type, status: 'VESSEL_DISCHARGED', dischargedAt: now, ttTag: '', yardBlock: '', receivingClerk: '', rtgOperator: '', releaseClerk: '', truckPlate: '', transco: '', destination: '', movements: [] }); impLog(d.id, 'BULK_IMPORT', `Vessel:${d.vessel} Type:${d.type}`); added++; }); impSave(); renderImportStats(); renderImportTable(); renderImportCharts(); clearImportBulk(); toast(`✅ ${added} import containers added`, 'success'); }
function clearImportBulk() { importBulkData = []; document.getElementById('importBulkPreview').classList.add('hidden'); document.getElementById('importBulkFile').value = ''; document.getElementById('importBulkErrors').innerHTML = ''; }
function moveToTagMaster() { const id = tsGetValue('imp-tag-id'); const tt = document.getElementById('imp-tag-tt').value.trim(); if (!id) return toast('Select a container', 'error'); if (!tt) return toast('TT / Tag ID is required', 'error'); const imp = ImportDB.containers.find(c => c.id === id); if (!imp) return toast('Container not found', 'error'); if (imp.status !== 'VESSEL_DISCHARGED') return toast(`Status must be VESSEL_DISCHARGED, current: ${imp.status}`, 'error'); imp.status = 'AT_TAG_MASTER'; imp.ttTag = tt; imp.movements = imp.movements || []; imp.movements.push({ status: 'AT_TAG_MASTER', note: `Tag Master TT:${tt}`, time: Date.now(), user: currentUser }); impLog(id, 'TAG_MASTER', `TT:${tt}`); impSave(); renderImportStats(); renderImportTable(); renderImportCharts(); tsSetValue('imp-tag-id', ''); document.getElementById('imp-tag-tt').value = ''; toast(`🚛 ${id} moved to Tag Master (${tt})`, 'success'); }
function moveToYardReceive() { const id = tsGetValue('imp-yard-id'); const yard = document.getElementById('imp-yard-block').value.trim(); const clerk = document.getElementById('imp-receiving-clerk').value.trim(); if (!id) return toast('Select a container', 'error'); if (!yard) return toast('Yard Block is required', 'error'); if (!clerk) return toast('Receiving Clerk name is required', 'error'); const imp = ImportDB.containers.find(c => c.id === id); if (!imp) return toast('Container not found', 'error'); if (imp.status !== 'AT_TAG_MASTER') return toast(`Status must be AT_TAG_MASTER, current: ${imp.status}`, 'error'); imp.status = 'RECEIVED_YARD'; imp.yardBlock = yard; imp.receivingClerk = clerk; imp.movements = imp.movements || []; imp.movements.push({ status: 'RECEIVED_YARD', note: `Yard:${yard} Clerk:${clerk}`, time: Date.now(), user: currentUser }); impLog(id, 'RECEIVED_YARD', `${yard} by ${clerk}`); impSave(); renderImportStats(); renderImportTable(); renderImportCharts(); tsSetValue('imp-yard-id', ''); document.getElementById('imp-yard-block').value = ''; document.getElementById('imp-receiving-clerk').value = ''; toast(`📌 ${id} received at yard ${yard}`, 'success'); }
function rtgOffload() { const id = tsGetValue('imp-offload-id'); const op = document.getElementById('imp-rtg-op').value.trim(); const driver = document.getElementById('imp-driver-name').value.trim(); if (!id) return toast('Select a container', 'error'); if (!op) return toast('RTG Operator / Crane ID is required', 'error'); const imp = ImportDB.containers.find(c => c.id === id); if (!imp) return toast('Container not found', 'error'); if (imp.status !== 'RECEIVED_YARD') return toast(`Status must be RECEIVED_YARD, current: ${imp.status}`, 'error'); imp.status = 'OFFLOADED_RTG'; imp.rtgOperator = op; imp.movements = imp.movements || []; imp.movements.push({ status: 'OFFLOADED_RTG', note: `RTG:${op} Driver:${driver}`, time: Date.now(), user: currentUser }); impLog(id, 'OFFLOADED_RTG', `${op}`); impSave(); renderImportStats(); renderImportTable(); renderImportCharts(); tsSetValue('imp-offload-id', ''); document.getElementById('imp-rtg-op').value = ''; document.getElementById('imp-driver-name').value = ''; toast(`🏗️ ${id} marked as offloaded by RTG ${op}`, 'success'); }
function releaseContainerOut() { const id = tsGetValue('imp-release-id'); const plate = document.getElementById('imp-truck-plate').value.trim().toUpperCase(); const transco = document.getElementById('imp-transco').value.trim(); const dest = document.getElementById('imp-dest').value.trim(); const clerk = document.getElementById('imp-release-clerk').value.trim(); if (!id) return toast('Select a container', 'error'); if (!plate) return toast('Truck Plate is required', 'error'); if (!clerk) return toast('Release Clerk is required', 'error'); const imp = ImportDB.containers.find(c => c.id === id); if (!imp) return toast('Container not found', 'error'); if (imp.status !== 'OFFLOADED_RTG') return toast(`Status must be OFFLOADED_RTG, current: ${imp.status}`, 'error'); imp.status = 'RELEASED_OUT'; imp.truckPlate = plate; imp.transco = transco; imp.destination = dest; imp.releaseClerk = clerk; imp.releasedAt = Date.now(); imp.movements = imp.movements || []; imp.movements.push({ status: 'RELEASED_OUT', note: `Truck:${plate} Clerk:${clerk}`, time: Date.now(), user: currentUser }); impLog(id, 'RELEASED_OUT', `${plate} → ${dest || 'N/A'}`); impSave(); renderImportStats(); renderImportTable(); renderImportCharts(); tsSetValue('imp-release-id', ''); document.getElementById('imp-truck-plate').value = ''; document.getElementById('imp-transco').value = ''; document.getElementById('imp-dest').value = ''; document.getElementById('imp-release-clerk').value = ''; toast(`🚛 ${id} released out with truck ${plate}`, 'success'); }
function renderImportStats() { const all = ImportDB.containers; const discharged = all.filter(c => c.status === 'VESSEL_DISCHARGED').length; const tag = all.filter(c => c.status === 'AT_TAG_MASTER').length; const yard = all.filter(c => c.status === 'RECEIVED_YARD').length; const offloaded = all.filter(c => c.status === 'OFFLOADED_RTG').length; const released = all.filter(c => c.status === 'RELEASED_OUT').length; document.getElementById('importStatsGrid').innerHTML = `<div class="sec-card"><div class="sc-icon">⛴️</div><div class="sc-val">${discharged}</div><div class="sc-lbl">Vessel Discharged</div></div><div class="sec-card"><div class="sc-icon">🚛</div><div class="sc-val">${tag}</div><div class="sc-lbl">Tag Master</div></div><div class="sec-card"><div class="sc-icon">📍</div><div class="sc-val">${yard}</div><div class="sc-lbl">Yard Staged</div></div><div class="sec-card"><div class="sc-icon">🏗️</div><div class="sc-val">${offloaded}</div><div class="sc-lbl">RTG Offloaded</div></div><div class="sec-card"><div class="sc-icon">🚪</div><div class="sc-val">${released}</div><div class="sc-lbl">Released Out</div></div>`; }
let importCharts = {};
function renderImportTable() { const search = document.getElementById('impSearch')?.value.toLowerCase() || ''; const statusFilter = document.getElementById('impStatusFilter')?.value || ''; const lineFilter = tsGetValue('impLineFilter') || ''; let arr = ImportDB.containers.slice().sort((a, b) => b.dischargedAt - a.dischargedAt); if (statusFilter) arr = arr.filter(c => c.status === statusFilter); if (lineFilter) arr = arr.filter(c => c.line === lineFilter); if (search) arr = arr.filter(c => [c.id, c.line, c.vessel, c.yardBlock, c.ttTag].join(' ').toLowerCase().includes(search)); document.getElementById('importTbody').innerHTML = arr.map(c => `<tr><td><span class="tbl-id" onclick="showImportDetail('${c.id}')">${c.id}</span></td><td>${c.line}</td><td>${c.vessel}</td><td>${c.type}</td><td>${impBadge(c.status)}</td><td>${c.ttTag || '—'}</td><td>${c.yardBlock || '—'}</td><td>${c.receivingClerk || '—'}</td><td>${c.rtgOperator || '—'}</td><td>${c.releaseClerk || '—'}</td><td>${c.truckPlate || '—'}</td><td>${freeImport(c)}</td><td>${dwellImport(c).toFixed(1)}h</td><td><button class="btn btn-xs btn-secondary" onclick="showImportDetail('${c.id}')">📋</button></td></tr>`).join('') || '<tr><td colspan="14" class="text-muted" style="text-align:center">No import containers</td></tr>'; }
function renderImportCharts() { const statusCounts = { VESSEL_DISCHARGED: 0, AT_TAG_MASTER: 0, RECEIVED_YARD: 0, OFFLOADED_RTG: 0, RELEASED_OUT: 0 }; ImportDB.containers.forEach(c => statusCounts[c.status]++); const ctx1 = document.getElementById('importStatusChart')?.getContext('2d'); if (ctx1) { if (importCharts.status) importCharts.status.destroy(); importCharts.status = new Chart(ctx1, { type: 'doughnut', data: { labels: Object.keys(statusCounts).map(s => IMP_LABELS[s]), datasets: [{ data: Object.values(statusCounts), backgroundColor: ['#0ea5e9', '#a78bfa', '#34d399', '#fbbf24', '#fb7185'] }] }, options: { responsive: true, maintainAspectRatio: true } }); } const lineCounts = {}; ImportDB.containers.forEach(c => lineCounts[c.line] = (lineCounts[c.line] || 0) + 1); const ctx2 = document.getElementById('importLineChart')?.getContext('2d'); if (ctx2) { if (importCharts.line) importCharts.line.destroy(); importCharts.line = new Chart(ctx2, { type: 'bar', data: { labels: Object.keys(lineCounts), datasets: [{ label: 'Containers', data: Object.values(lineCounts), backgroundColor: '#38bdf8' }] }, options: { responsive: true } }); } const dwellBins = { '<24h': 0, '24-48h': 0, '48-72h': 0, '72-96h': 0, '>96h': 0 }; ImportDB.containers.forEach(c => { const h = dwellImport(c); if (h < 24) dwellBins['<24h']++; else if (h < 48) dwellBins['24-48h']++; else if (h < 72) dwellBins['48-72h']++; else if (h < 96) dwellBins['72-96h']++; else dwellBins['>96h']++; }); const ctx3 = document.getElementById('importDwellChart')?.getContext('2d'); if (ctx3) { if (importCharts.dwell) importCharts.dwell.destroy(); importCharts.dwell = new Chart(ctx3, { type: 'bar', data: { labels: Object.keys(dwellBins), datasets: [{ label: 'Containers', data: Object.values(dwellBins), backgroundColor: '#fbbf24' }] }, options: { responsive: true } }); } const clerkStats = {}; ImportDB.containers.filter(c => c.releaseClerk).forEach(c => clerkStats[c.releaseClerk] = (clerkStats[c.releaseClerk] || 0) + 1); document.getElementById('importReleaseStats').innerHTML = Object.entries(clerkStats).sort((a, b) => b[1] - a[1]).map(([name, count]) => `<div class="info-row"><span>${name}</span><span class="font-bold text-accent">${count}</span></div>`).join('') || '<span class="text-muted">No releases yet</span>'; }
function showImportDetail(id) { const c = ImportDB.containers.find(c => c.id === id); if (!c) return; document.getElementById('importDetailTitle').textContent = `${c.id} — Import Container`; document.getElementById('importDetailBody').innerHTML = `<div class="grid-2"><div class="info-row"><span>Line</span><span>${c.line}</span></div><div class="info-row"><span>Vessel</span><span>${c.vessel} / ${c.voyage || ''}</span></div><div class="info-row"><span>Type</span><span>${c.type}</span></div><div class="info-row"><span>Status</span>${impBadge(c.status)}</div><div class="info-row"><span>Discharged At</span><span>${new Date(c.dischargedAt).toLocaleString()}</span></div><div class="info-row"><span>TT/Tag</span><span>${c.ttTag || '—'}</span></div><div class="info-row"><span>Yard Block</span><span>${c.yardBlock || '—'}</span></div><div class="info-row"><span>Receiving Clerk</span><span>${c.receivingClerk || '—'}</span></div><div class="info-row"><span>RTG Operator</span><span>${c.rtgOperator || '—'}</span></div><div class="info-row"><span>Release Clerk</span><span>${c.releaseClerk || '—'}</span></div><div class="info-row"><span>Truck Plate</span><span>${c.truckPlate || '—'}</span></div><div class="info-row"><span>Transport Co.</span><span>${c.transco || '—'}</span></div><div class="info-row"><span>Destination</span><span>${c.destination || '—'}</span></div><div class="info-row"><span>Dwell (h)</span><span>${dwellImport(c).toFixed(1)}h</span></div><div class="info-row"><span>Free Time Left</span>${freeImport(c)}</div></div><div class="divider"></div><div class="card-title">Movement History</div><div class="scroll-table">${(c.movements || []).map(m => `<div class="info-row"><span>${m.note || m.status}</span><span class="text-xs">${new Date(m.time).toLocaleString()} · ${m.user || 'System'}</span></div>`).join('') || '<span class="text-muted">No movements</span>'}</div>`; document.getElementById('importDetailModal').classList.remove('hidden'); }
function closeImportDetailModal(e) { if (!e || e.target === document.getElementById('importDetailModal')) document.getElementById('importDetailModal').classList.add('hidden'); }
function exportImportCSV() { let csv = 'Container ID,Line,Vessel,Type,Status,TT/Tag,Yard,Receiving Clerk,RTG Operator,Release Clerk,Truck,Transco,Destination,Dwell(h),Released At\n'; ImportDB.containers.forEach(c => { csv += `${c.id},${c.line},${c.vessel},${c.type},${c.status},${c.ttTag || ''},${c.yardBlock || ''},${c.receivingClerk || ''},${c.rtgOperator || ''},${c.releaseClerk || ''},${c.truckPlate || ''},${c.transco || ''},${c.destination || ''},${dwellImport(c).toFixed(1)},"${c.releasedAt ? new Date(c.releasedAt).toLocaleString() : ''}"\n`; }); dlFile(csv, 'text/csv', 'kpa_imports.csv'); toast('📥 Imports CSV exported', 'success'); }
function exportImportPDF() { const { jsPDF } = window.jspdf; const doc = new jsPDF('l', 'mm', 'a4'); doc.setFontSize(14); doc.text('KPA Imports / Full Containers Report', 14, 18); doc.setFontSize(8); doc.text(`Generated: ${new Date().toLocaleString()}`, 14, 25); const body = ImportDB.containers.map(c => [c.id, c.line, c.vessel, c.type, c.status, c.yardBlock || '', dwellImport(c).toFixed(1)]); doc.autoTable({ head: [['Container ID', 'Line', 'Vessel', 'Type', 'Status', 'Yard', 'Dwell(h)']], body, startY: 32, styles: { fontSize: 7 }, headStyles: { fillColor: [2, 132, 199] } }); doc.save('kpa_imports.pdf'); toast('📄 Imports PDF exported', 'success'); }

// ═══ REPORTS ═══
let reportCharts = {};
function applyReportFilters() { renderReports(); }
function clearReportFilters() { tsSetValue('rpt-vessel', ''); tsSetValue('rpt-line', ''); tsSetValue('rpt-source', ''); tsSetValue('rpt-status', ''); renderReports(); }
function switchReportTab(tab, ev) {
    document.querySelectorAll('.report-section').forEach(s => s.classList.remove('active'));
    document.getElementById(`rsec-${tab}`).classList.add('active');
    document.querySelectorAll('.rtab').forEach(t => t.classList.remove('active'));
    if (ev && ev.target) ev.target.classList.add('active');
    renderReports();
}
function renderReports() {
    const vesselFilter = tsGetValue('rpt-vessel'); const lineFilter = tsGetValue('rpt-line'); const sourceFilter = tsGetValue('rpt-source'); const statusFilter = tsGetValue('rpt-status');
    let filtered = DB.containers.filter(c => { if (vesselFilter && c.vessel !== vesselFilter) return false; if (lineFilter && c.line !== lineFilter) return false; if (sourceFilter && c.source !== sourceFilter) return false; if (statusFilter && c.status !== statusFilter) return false; return true; });
    const kpis = { 'Total Containers': filtered.length, 'Gated In': filtered.filter(c => c.status === 'GATED_IN').length, 'Key Site': filtered.filter(c => c.status === 'KEY_SITE').length, 'Loaded': filtered.filter(c => c.status === 'LOADED_VESSEL').length, 'Avg Dwell (h)': (filtered.reduce((a, c) => a + dwellHours(c), 0) / filtered.length || 0).toFixed(1) };
    document.getElementById('rpt-kpi-row').innerHTML = Object.entries(kpis).map(([k, v]) => `<div class="report-kpi"><div class="rk-val">${v}</div><div class="rk-lbl">${k}</div></div>`).join('');
    const statusCounts = {}; filtered.forEach(c => statusCounts[c.status] = (statusCounts[c.status] || 0) + 1);
    const ctxStatus = document.getElementById('chartStatus')?.getContext('2d'); if (ctxStatus) { if (reportCharts.status) reportCharts.status.destroy(); reportCharts.status = new Chart(ctxStatus, { type: 'bar', data: { labels: Object.keys(statusCounts).map(s => STATUS_META[s]?.label || s), datasets: [{ label: 'Containers', data: Object.values(statusCounts), backgroundColor: '#38bdf8' }] }, options: { responsive: true, maintainAspectRatio: true } }); }
    const lineCounts = {}; filtered.forEach(c => lineCounts[c.line] = (lineCounts[c.line] || 0) + 1);
    const ctxLine = document.getElementById('chartLine')?.getContext('2d'); if (ctxLine) { if (reportCharts.line) reportCharts.line.destroy(); reportCharts.line = new Chart(ctxLine, { type: 'pie', data: { labels: Object.keys(lineCounts), datasets: [{ data: Object.values(lineCounts), backgroundColor: ['#0ea5e9', '#34d399', '#fbbf24', '#a78bfa', '#fb7185'] }] }, options: { responsive: true } }); }
    const sourceCounts = { Gate18: 0, Gate24: 0, ICD: 0, Vessel: 0 }; filtered.forEach(c => sourceCounts[c.source] = (sourceCounts[c.source] || 0) + 1);
    const ctxSource = document.getElementById('chartSource')?.getContext('2d'); if (ctxSource) { if (reportCharts.source) reportCharts.source.destroy(); reportCharts.source = new Chart(ctxSource, { type: 'doughnut', data: { labels: Object.keys(sourceCounts), datasets: [{ data: Object.values(sourceCounts), backgroundColor: ['#38bdf8', '#34d399', '#a78bfa', '#fbbf24'] }] }, options: { responsive: true } }); }
    const vesselGated = {}; const vesselLoaded = {}; filtered.forEach(c => { if (c.status === 'GATED_IN') vesselGated[c.vessel] = (vesselGated[c.vessel] || 0) + 1; if (c.status === 'LOADED_VESSEL') vesselLoaded[c.vessel] = (vesselLoaded[c.vessel] || 0) + 1; });
    const ctxGated = document.getElementById('chartGatedVessel')?.getContext('2d'); if (ctxGated) { if (reportCharts.gated) reportCharts.gated.destroy(); reportCharts.gated = new Chart(ctxGated, { type: 'bar', data: { labels: Object.keys(vesselGated), datasets: [{ label: 'Gated In', data: Object.values(vesselGated), backgroundColor: '#0ea5e9' }] }, options: { responsive: true } }); }
    const ctxLoaded = document.getElementById('chartLoaded')?.getContext('2d'); if (ctxLoaded) { if (reportCharts.loaded) reportCharts.loaded.destroy(); reportCharts.loaded = new Chart(ctxLoaded, { type: 'bar', data: { labels: Object.keys(vesselLoaded), datasets: [{ label: 'Loaded', data: Object.values(vesselLoaded), backgroundColor: '#34d399' }] }, options: { responsive: true } }); }
    document.getElementById('rpt-container-tbody').innerHTML = filtered.slice(0, 100).map(c => `<tr><td>${c.id}</td><td>${c.line}</td><td>${c.vessel}</td><td>${c.type}</td><td>${c.source}</td><td>${badge(c.status)}</td><td>${c.yard || '—'}</td><td>${dwellHours(c).toFixed(1)}</td><td>${freeTimeDisplay(c)}</td><td>${c.shiftCount || 0}</td><td>${c.positionSlip || '—'}</td></tr>`).join('') || '<tr><td colspan="11">No containers match filters</td></tr>';
    document.getElementById('rpt-vessel-tbody').innerHTML = [...new Set(filtered.map(c => c.vessel))].map(v => { const gatedCnt = filtered.filter(c => c.vessel === v && c.status === 'GATED_IN').length; const ksCnt = filtered.filter(c => c.vessel === v && c.status === 'KEY_SITE').length; const loadedCnt = filtered.filter(c => c.vessel === v && c.status === 'LOADED_VESSEL').length; const shutCnt = filtered.filter(c => c.vessel === v && c.shutout).length; const rate = loadedCnt ? ((loadedCnt / (loadedCnt + shutCnt)) * 100).toFixed(1) : 0; return `<tr><td>${v}</td><td>${gatedCnt}</td><td>${ksCnt}</td><td>${loadedCnt}</td><td>${shutCnt}</td><td>${rate}%</td></tr>`; }).join('');
    const clerkStats = {}; filtered.filter(c => c.loadedBy).forEach(c => clerkStats[c.loadedBy] = (clerkStats[c.loadedBy] || 0) + 1);
    document.getElementById('clerkTable').innerHTML = Object.entries(clerkStats).sort((a, b) => b[1] - a[1]).map(([name, count]) => `<div class="info-row"><span>${name}</span><span class="font-bold text-accent">${count}</span></div>`).join('') || '<span class="text-muted">No loading clerks recorded</span>';
    const gateClerks = {}; DB.slips.forEach(s => { if (s.clerk) gateClerks[s.clerk] = (gateClerks[s.clerk] || 0) + 1; });
    document.getElementById('rpt-clerk-tbody').innerHTML = Object.entries(gateClerks).sort((a, b) => b[1] - a[1]).map(([clerk, count]) => `<tr><td>${clerk}</td><td>${count}</td><td>Gate</td><td>—</td></tr>`).join('') || '<tr><td colspan="4">No gate activity</td></tr>';
    const dwellBins = { '<24h': 0, '24-48h': 0, '48-72h': 0, '3-5d': 0, '5-7d': 0, '>7d': 0 }; filtered.forEach(c => { const h = dwellHours(c); if (h < 24) dwellBins['<24h']++; else if (h < 48) dwellBins['24-48h']++; else if (h < 72) dwellBins['48-72h']++; else if (h < 120) dwellBins['3-5d']++; else if (h < 168) dwellBins['5-7d']++; else dwellBins['>7d']++; });
    const ctxDwell = document.getElementById('chartDwell')?.getContext('2d'); if (ctxDwell) { if (reportCharts.dwell) reportCharts.dwell.destroy(); reportCharts.dwell = new Chart(ctxDwell, { type: 'bar', data: { labels: Object.keys(dwellBins), datasets: [{ label: 'Containers', data: Object.values(dwellBins), backgroundColor: '#fbbf24' }] }, options: { responsive: true } }); }
    const overdueCont = filtered.filter(c => !['LOADED_VESSEL', 'OUT_OF_PORT'].includes(c.status) && freeDaysLeft(c) < 0);
    document.getElementById('rpt-overdue-tbody').innerHTML = overdueCont.map(c => `<tr><td>${c.id}</td><td>${c.line}</td><td>${c.vessel}</td><td>${c.source}</td><td>${badge(c.status)}</td><td>${c.yard || '—'}</td><td>${getFreeTimeDays(c.source)}d</td><td>${dwellHours(c).toFixed(1)}h</td><td class="text-danger">${Math.abs(freeDaysLeft(c)).toFixed(1)}h</td></tr>`).join('') || '<tr><td colspan="9">No overdue containers</td></tr>';
    const shutoutReasons = {}; DB.shutouts.forEach(s => shutoutReasons[s.reason] = (shutoutReasons[s.reason] || 0) + 1);
    const ctxShut = document.getElementById('chartShutout')?.getContext('2d'); if (ctxShut) { if (reportCharts.shutout) reportCharts.shutout.destroy(); reportCharts.shutout = new Chart(ctxShut, { type: 'pie', data: { labels: Object.keys(shutoutReasons), datasets: [{ data: Object.values(shutoutReasons), backgroundColor: ['#fb7185', '#fbbf24', '#a78bfa', '#34d399', '#38bdf8'] }] }, options: { responsive: true } }); }
    document.getElementById('shutoutStatsRpt').innerHTML = `<div class="info-row"><span>Total Shutouts</span><span class="font-bold text-danger">${DB.shutouts.length}</span></div><div class="info-row"><span>Unique Containers</span><span>${new Set(DB.shutouts.map(s => s.containerId)).size}</span></div>`;
    document.getElementById('rpt-shutout-tbody').innerHTML = DB.shutouts.slice(0, 100).map(s => `<tr><td>${s.containerId}</td><td>${s.line}</td><td>${s.vessel}</td><td>${s.voyage}</td><td>${s.reason}</td><td>${s.clerk}</td><td>${s.nextAction}</td><td>${new Date(s.shutoutAt).toLocaleString()}</td></tr>`).join('');
    const icdCont = DB.containers.filter(c => c.source === 'ICD'); const icdStatus = { PREADVISED: 0, ON_WAGON: 0, RECEIVED_SGR: 0, GATED_IN: 0, OUT_OF_PORT: 0 }; icdCont.forEach(c => icdStatus[c.status] = (icdStatus[c.status] || 0) + 1);
    document.getElementById('icdTable').innerHTML = Object.entries(icdStatus).map(([s, n]) => `<div class="info-row"><span>${s.replace(/_/g, ' ')}</span><span class="font-bold">${n}</span></div>`).join('');
    document.getElementById('rpt-sgr-tbody').innerHTML = icdCont.slice(0, 100).map(c => `<tr><td>${c.id}</td><td>${c.line}</td><td>${c.type}</td><td>${badge(c.status)}</td><td>${c.wagon || '—'}</td><td>${c.yard || '—'}</td><td>${dwellHours(c).toFixed(1)}h</td><td>${freeTimeDisplay(c)}</td></tr>`).join('');
    const impStatusCounts = { VESSEL_DISCHARGED: 0, AT_TAG_MASTER: 0, RECEIVED_YARD: 0, OFFLOADED_RTG: 0, RELEASED_OUT: 0 }; ImportDB.containers.forEach(c => impStatusCounts[c.status]++);
    const ctxImpStatus = document.getElementById('rptImportStatus')?.getContext('2d'); if (ctxImpStatus) { if (reportCharts.impStatus) reportCharts.impStatus.destroy(); reportCharts.impStatus = new Chart(ctxImpStatus, { type: 'doughnut', data: { labels: Object.keys(impStatusCounts).map(s => IMP_LABELS[s]), datasets: [{ data: Object.values(impStatusCounts), backgroundColor: ['#0ea5e9', '#a78bfa', '#34d399', '#fbbf24', '#fb7185'] }] }, options: { responsive: true } }); }
    const impLineCounts = {}; ImportDB.containers.forEach(c => impLineCounts[c.line] = (impLineCounts[c.line] || 0) + 1);
    const ctxImpLine = document.getElementById('rptImportLine')?.getContext('2d'); if (ctxImpLine) { if (reportCharts.impLine) reportCharts.impLine.destroy(); reportCharts.impLine = new Chart(ctxImpLine, { type: 'bar', data: { labels: Object.keys(impLineCounts), datasets: [{ label: 'Containers', data: Object.values(impLineCounts), backgroundColor: '#38bdf8' }] }, options: { responsive: true } }); }
    document.getElementById('rpt-import-tbody').innerHTML = ImportDB.containers.slice(0, 100).map(c => `<tr><td>${c.id}</td><td>${c.line}</td><td>${c.vessel}</td><td>${c.type}</td><td>${impBadge(c.status)}</td><td>${c.yardBlock || '—'}</td><td>${c.receivingClerk || '—'}</td><td>${c.rtgOperator || '—'}</td><td>${c.releaseClerk || '—'}</td><td>${c.truckPlate || '—'}</td><td>${dwellImport(c).toFixed(1)}h</td></tr>`).join('');
    const randomReasons = {}; DB.randomLoads.forEach(r => randomReasons[r.reason] = (randomReasons[r.reason] || 0) + 1);
    const ctxRandom = document.getElementById('chartRandom')?.getContext('2d'); if (ctxRandom) { if (reportCharts.random) reportCharts.random.destroy(); reportCharts.random = new Chart(ctxRandom, { type: 'pie', data: { labels: Object.keys(randomReasons), datasets: [{ data: Object.values(randomReasons), backgroundColor: ['#fbbf24', '#38bdf8', '#a78bfa', '#34d399', '#fb7185', '#f97316', '#94a3b8'] }] }, options: { responsive: true } }); }
    document.getElementById('randomStatsRpt').innerHTML = `<div class="info-row"><span>Total Random Loads</span><span class="font-bold text-gold">${DB.randomLoads.length}</span></div><div class="info-row"><span>Unique Containers</span><span class="font-bold">${new Set(DB.randomLoads.map(r => r.containerId)).size}</span></div><div class="info-row"><span>Unique Vessels Involved</span><span class="font-bold">${new Set(DB.randomLoads.map(r => r.actualVessel)).size}</span></div>`;
    document.getElementById('rpt-random-tbody').innerHTML = DB.randomLoads.slice(0, 100).map(r => `<tr><td>${r.containerId}</td><td>${r.line || '—'}</td><td>${r.designatedVessel || '—'}</td><td>${r.actualVessel || '—'}</td><td>${r.reason || '—'}</td><td>${r.clerk || '—'}</td><td>${new Date(r.recordedAt).toLocaleString()}</td></tr>`).join('') || '<tr><td colspan="7">No random loading records</td></tr>';
}
function exportFullReportPDF() { const { jsPDF } = window.jspdf; const doc = new jsPDF('l', 'mm', 'a4'); doc.setFontSize(16); doc.text('KPA Terminal Full Performance Report', 14, 20); doc.setFontSize(9); doc.text(`Generated: ${new Date().toLocaleString()} by ${currentUser}`, 14, 28); const total = DB.containers.length; const loaded = DB.containers.filter(c => c.status === 'LOADED_VESSEL').length; const shutouts = DB.shutouts.length; doc.text(`Total Containers: ${total}   Loaded: ${loaded}   Shutouts: ${shutouts}`, 14, 40); doc.autoTable({ head: [['Vessel', 'Gated', 'Key Site', 'Loaded', 'Shutouts']], body: [...new Set(DB.containers.map(c => c.vessel))].map(v => { const gated = DB.containers.filter(c => c.vessel === v && c.status === 'GATED_IN').length; const ks = DB.containers.filter(c => c.vessel === v && c.status === 'KEY_SITE').length; const ld = DB.containers.filter(c => c.vessel === v && c.status === 'LOADED_VESSEL').length; const so = DB.shutouts.filter(s => s.vessel === v).length; return [v, gated, ks, ld, so]; }), startY: 50, styles: { fontSize: 7 }, headStyles: { fillColor: [2, 132, 199] } }); doc.save('kpa_full_report.pdf'); toast('📄 Full PDF report generated', 'success'); }

// ═══ NAV & EVENT BINDINGS ═══
document.querySelectorAll('.nav-item, .mob-item').forEach(el => {
    el.addEventListener('click', () => {
        const tab = el.getAttribute('data-tab'); if (!tab) return;
        document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
        document.getElementById(`tab-${tab}`).classList.add('active');
        document.querySelectorAll('.nav-item, .mob-item').forEach(nav => nav.classList.remove('active'));
        el.classList.add('active');
        if (tab === 'reports') renderReports();
        if (tab === 'imports-full') { renderImportStats(); renderImportTable(); renderImportCharts(); }
        if (tab === 'containers') renderTable();
        if (tab === 'position-slips') renderSlips();
        if (tab === 'shifting') renderShifting();
        if (tab === 'shutouts') renderShutouts();
        if (tab === 'keysite') renderKeysite();
        if (tab === 'sgr') renderSGR();
        if (tab === 'vessel-to-yard') renderVesselYardTable();
        if (tab === 'yard') renderYardBlocks();
        if (tab === 'vessel') renderVessel();
        populateAllDropdowns();
    });
});

window.addEventListener('load', () => {
    loadAll();
    document.getElementById('loginUser').focus();
    const dz = document.getElementById('bulkDZ');
    if (dz) { dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('drag-over'); }); dz.addEventListener('dragleave', () => dz.classList.remove('drag-over')); dz.addEventListener('drop', e => { e.preventDefault(); dz.classList.remove('drag-over'); const file = e.dataTransfer.files[0]; if (file && file.name.endsWith('.csv')) { handleBulkFile({ target: { files: [file] } }); } else toast('Please drop a CSV file', 'error'); }); }
    const impDz = document.getElementById('importBulkDZ');
    if (impDz) { impDz.addEventListener('dragover', e => { e.preventDefault(); impDz.classList.add('drag-over'); }); impDz.addEventListener('dragleave', () => impDz.classList.remove('drag-over')); impDz.addEventListener('drop', e => { e.preventDefault(); impDz.classList.remove('drag-over'); const file = e.dataTransfer.files[0]; if (file && file.name.endsWith('.csv')) { handleImportBulkFile({ target: { files: [file] } }); } else toast('Please drop a CSV file', 'error'); }); }
});