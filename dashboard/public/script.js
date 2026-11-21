document.addEventListener('DOMContentLoaded', async () => {
  const runSelector = document.getElementById('run-selector');
  let historyData = [];

  try {
    const res = await fetch('/api/history');
    historyData = await res.json();
  } catch(e) {
    console.error('Failed to fetch history', e);
  }

  if (historyData.length === 0) {
    runSelector.innerHTML = '<option disabled>No history found</option>';
    return;
  }

  // Populate selector
  runSelector.innerHTML = '';
  historyData.forEach((run, index) => {
    const date = new Date(run.timestamp).toLocaleString();
    const opt = document.createElement('option');
    opt.value = index;
    opt.textContent = `Run ${historyData.length - index} (${date})`;
    runSelector.appendChild(opt);
  });

  runSelector.addEventListener('change', (e) => {
    renderDashboard(historyData[e.target.value]);
  });

  // Render the most recent run by default
  renderDashboard(historyData[0]);
});

function renderDashboard(data) {
  if (!data) return;

  // Render Summary Stats
  document.getElementById('stat-total').textContent = data.totalSessions || 0;
  document.getElementById('stat-success').textContent = data.successes || 0;
  document.getElementById('stat-failed').textContent = data.failures || 0;
  document.getElementById('stat-clicks').textContent = data.targetClicks || 0;

  // Render Keyword Table
  const kwTableBody = document.querySelector('#keyword-table tbody');
  kwTableBody.innerHTML = '';

  const allAdDomains = {};

  if (data.keywordData) {
    for (const [kw, stats] of Object.entries(data.keywordData)) {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><strong>${kw}</strong></td>
        <td>${stats.totalSessions || 0}</td>
        <td>${stats.sponsoredSessions || 0}</td>
        <td>${stats.sponsoredMax || 0} ads</td>
        <td>${stats.targetsMax || 0} targets</td>
      `;
      kwTableBody.appendChild(tr);

      if (stats.adDomains) {
        for (const [dom, count] of Object.entries(stats.adDomains)) {
          allAdDomains[dom] = (allAdDomains[dom] || 0) + count;
        }
      }
    }
  }

  // Render Domain Table
  const domTableBody = document.querySelector('#domain-table tbody');
  domTableBody.innerHTML = '';

  const sortedDomains = Object.entries(allAdDomains).sort((a, b) => b[1] - a[1]);

  if (sortedDomains.length === 0) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td colspan="2" style="text-align:center; color: var(--text-secondary);">No sponsored ads detected in this run.</td>`;
    domTableBody.appendChild(tr);
  } else {
    for (const [dom, count] of sortedDomains) {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${dom}</td>
        <td><strong>${count}</strong> appearances</td>
      `;
      domTableBody.appendChild(tr);
    }
  }
}
