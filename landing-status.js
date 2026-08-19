(function () {
    const ADV_CATEGORY_LABELS = { traffic: 'Traffic', gate_backlog: 'Gate backlog', capacity: 'Capacity', communications: 'Line communication', general: 'General' };

    function timeAgo(iso) {
        const diffMs = Date.now() - new Date(iso).getTime();
        const mins = Math.round(diffMs / 60000);
        if (mins < 1) return 'just now';
        if (mins < 60) return `${mins} min ago`;
        const hrs = Math.round(mins / 60);
        if (hrs < 24) return `${hrs} hr${hrs === 1 ? '' : 's'} ago`;
        const days = Math.round(hrs / 24);
        return `${days} day${days === 1 ? '' : 's'} ago`;
    }

    async function loadStatus() {
        const board = document.getElementById('statusBoard');
        const meta = document.getElementById('statusUpdated');
        if (!board || typeof sb === 'undefined') return;
        try {
            const { data, error } = await sb.rpc('get_public_terminal_status');
            if (error) throw error;
            const cells = board.querySelectorAll('.status-cell strong');
            if (cells[0]) cells[0].textContent = data.pre_advised;
            if (cells[1]) cells[1].textContent = data.gated_in_yard;
            if (cells[2]) cells[2].textContent = data.quayside_staged;
            if (cells[3]) cells[3].textContent = data.on_wagon_sgr;
            if (meta) meta.textContent = `Updated ${timeAgo(data.generated_at)}`;
        } catch (e) {
            if (meta) meta.textContent = 'Status temporarily unavailable';
            console.error('Public status fetch error:', e);
        }
    }

    async function loadAdvisories() {
        const list = document.getElementById('advisoryList');
        if (!list || typeof sb === 'undefined') return;
        try {
            const { data, error } = await sb.from('advisories').select('*').eq('active', true).order('created_at', { ascending: false }).limit(20);
            if (error) throw error;
            if (!data || !data.length) {
                list.innerHTML = '<div class="advisory-empty">No active advisories — gate, yard and quayside operations are running normally.</div>';
                return;
            }
            list.innerHTML = data.map(a => `
                <div class="advisory-card sev-${a.severity}">
                    <div class="advisory-head">
                        <h4>${escapeHtml(a.title)}</h4>
                        <span class="advisory-tag ${a.severity !== 'info' ? 'sev-' + a.severity + '-tag' : ''}">${(ADV_CATEGORY_LABELS[a.category] || a.category)} · ${a.scope || 'ALL'}</span>
                    </div>
                    <p>${escapeHtml(a.message)}</p>
                    <div class="advisory-time">Posted ${timeAgo(a.created_at)}</div>
                </div>
            `).join('');
        } catch (e) {
            list.innerHTML = '<div class="advisory-empty">Advisories are temporarily unavailable.</div>';
            console.error('Advisories fetch error:', e);
        }
    }

    function escapeHtml(s) {
        const d = document.createElement('div');
        d.textContent = s == null ? '' : String(s);
        return d.innerHTML;
    }

    window.addEventListener('load', () => {
        loadStatus();
        loadAdvisories();
    });
})();// JavaScript source code
