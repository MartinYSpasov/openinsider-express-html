const fmtMoney = n => (n==null?'-': '$' + Number(n).toLocaleString());
const fmtNum   = n => (n==null?'-': Number(n).toLocaleString());
const fmtDate  = s => new Date(s).toLocaleDateString();

async function getPricesForTickers(tickers) {
    const unique = [...new Set(tickers)];
    const priceMap = {};
    await Promise.all(unique.map(async (t) => {
        try {
            const res = await fetch(`/api/price/${encodeURIComponent(t)}`);
            if (!res.ok) throw new Error(await res.text());
            const p = await res.json();
            priceMap[t] = Number(p.close);
        } catch {
            priceMap[t] = null;
        }
    }));
    return priceMap;
}

async function loadClusters() {
    const res = await fetch('/api/clusters');
    const data = await res.json();
    const wrap = document.getElementById('clusters');
    wrap.innerHTML = '';
    for (const c of data) {
        let curr = null;
        try {
            const priceRes = await fetch('/api/price/' + encodeURIComponent(c.ticker));
            const priceObj = priceRes.ok ? await priceRes.json() : null;
            curr = priceObj ? Number(priceObj.close) : null;
        } catch {}

        const card = document.createElement('div');
        card.className = 'card';
        card.innerHTML = `
      <div class="card-head">
        <div>
          <div class="ticker">${c.ticker}</div>
          <div class="meta">${fmtDate(c.window_start)} → ${fmtDate(c.window_end)}</div>
        </div>
        <div class="right">
          <div>Insiders: <span class="pill">${c.insider_count}</span></div>
          <div>Trades: ${c.trade_count}</div>
          <div>Total: <b>${fmtMoney(c.total_value_usd)}</b></div>
        </div>
      </div>
      <div class="meta" style="margin-top:8px">Current: <b>${curr==null?'-':curr.toFixed(2)}</b></div>
      <canvas height="110" style="margin-top:10px;"></canvas>
    `;
        wrap.appendChild(card);

        const ctx = card.querySelector('canvas').getContext('2d');
        new Chart(ctx, {
            type: 'bar',
            data: {
                labels: ['Cluster Total (USD)', 'Price (USD)'],
                datasets: [{ label: c.ticker, data: [Number(c.total_value_usd), curr ?? 0] }]
            },
            options: {
                plugins: { legend: { display: false } },
                scales: { y: { beginAtZero: true, ticks: { color: '#a9b1c6' } }, x: { ticks: { color: '#a9b1c6' } } }
            }
        });
    }
}

async function loadTrades() {
    const res = await fetch('/api/trades');
    const data = await res.json();

    const tickers = data.map(r => r.ticker);
    const prices = await getPricesForTickers(tickers);

    const tbody = document.querySelector('#trades tbody');
    tbody.innerHTML = '';
    for (const t of data) {
        const curr = prices[t.ticker];
        const buy  = (t.price==null? null : Number(t.price));
        const pct  = (curr!=null && buy!=null && buy>0) ? ((curr - buy) / buy) * 100 : null;

        const tr = document.createElement('tr');
        tr.innerHTML = `
      <td>${fmtDate(t.filing_date)}</td>
      <td><strong>${t.ticker}</strong></td>
      <td>${t.insider_name}</td>
      <td>${t.insider_title}</td>
      <td class="num">${buy==null?'-':buy.toFixed(2)}</td>
      <td class="num">${fmtNum(t.shares)}</td>
      <td class="num">${fmtMoney(t.value_usd)}</td>
      <td class="num">${curr==null?'-':curr.toFixed(2)}</td>
      <td class="num ${pct==null?'':(pct>=0?'pos':'neg')}">${pct==null?'-':pct.toFixed(1)+'%'}</td>
      <td><a class="link" href="${t.source_url}" target="_blank" rel="noreferrer">Open Form 4</a></td>
    `;
        tbody.appendChild(tr);
    }
}

// Run Now button
document.getElementById('trigger').addEventListener('click', async () => {
    const btn = document.getElementById('trigger');
    const status = document.getElementById('status');
    btn.disabled = true; btn.textContent = 'Running…'; status.textContent = '';
    try {
        const res = await fetch('/api/trigger');
        if (!res.ok) throw new Error(await res.text());
        status.textContent = 'Refreshed.';
    } catch {
        status.textContent = 'Failed.';
    } finally {
        await loadClusters();
        await loadTrades();
        btn.disabled = false; btn.textContent = 'Run Now';
        setTimeout(()=> status.textContent='', 2500);
    }
});

// Initial load
(async () => {
    await loadClusters();
    await loadTrades();
})();
