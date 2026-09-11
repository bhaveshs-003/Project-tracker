/**
 * Landing dashboard: status counts for everyone, plus the portfolio roll-up
 * for the company side.
 */

import { state, isPartner, loadProjects } from '../state.js';
import { navigate } from '../router.js';
import {
  escapeHtml, plural, sharePercent, statusBadge, formatDate,
  portfolioMetrics, weeklyBuckets, TREND_WEEKS, segment, legendItem
} from '../format.js';

function outcomeBox(totals) {
  const done = totals.onTime + totals.delayed;
  if (!done) return '<p class="muted-sm">Nothing completed yet.</p>';
  return `
    <div class="stack">${segment(totals.onTime, done, 'ontime')}${segment(totals.delayed, done, 'delayed')}</div>
    <ul class="legend">
      ${legendItem('ontime', 'On-Time', totals.onTime, done)}
      ${legendItem('delayed', 'Delayed', totals.delayed, done)}
    </ul>`;
}

function delaysBox(totals) {
  if (!totals.delayed) return '<p class="muted-sm">No delays recorded across your projects.</p>';
  const unattributed = totals.delayed - totals.companySide - totals.partnerSide;
  return `
    <div class="stack">
      ${segment(totals.companySide, totals.delayed, 'company')}
      ${segment(totals.partnerSide, totals.delayed, 'partner')}
      ${segment(unattributed, totals.delayed, 'unattributed')}
    </div>
    <ul class="legend">
      ${legendItem('company', 'Company Side', totals.companySide, totals.delayed)}
      ${legendItem('partner', 'Partner Side', totals.partnerSide, totals.delayed)}
      ${unattributed > 0 ? legendItem('unattributed', 'Unattributed', unattributed, totals.delayed) : ''}
    </ul>`;
}

function byTypeBox(totals) {
  const types = Object.keys(totals.byType).sort();
  if (!types.length) return '<p class="muted-sm">No projects yet.</p>';

  return types.map(type => {
    const row = totals.byType[type];
    const done = row.onTime + row.delayed;
    const bar = done
      ? `<div class="stack type-stack">${segment(row.onTime, done, 'ontime')}${segment(row.delayed, done, 'delayed')}</div>`
      : '<p class="muted-sm type-empty">Nothing completed yet</p>';
    return `<div class="type-row">
      <div class="type-head">
        <b>${escapeHtml(type)}</b>
        <span class="muted-sm">${plural(row.projects, 'project')}${done ? ` · ${plural(done, 'completed item')}` : ''}</span>
      </div>${bar}</div>`;
  }).join('');
  // No legend: the On-Time / Delayed key is already on the chart above, and it
  // was printed three times on this one screen.
}

function trendBox(totals) {
  const data = weeklyBuckets(totals.completions);
  if (!data.counted) {
    return `<p class="muted-sm">No completions recorded in the last ${TREND_WEEKS} weeks yet.
      Completion dates are stamped when an item is marked complete, so earlier work does not appear here.</p>`;
  }
  const tallest = data.weeks.reduce((top, w) => Math.max(top, w.total), 0);

  return `
    <div class="columns">
      ${data.weeks.map(week => `
        <div class="column">
          <span class="column-value">${week.total || ''}</span>
          <div class="column-track">
            ${week.total ? `<div class="column-stack" style="height:${sharePercent(week.total, tallest)}%">
              ${week.delayed ? `<div class="col-seg delayed" style="height:${sharePercent(week.delayed, week.total)}%"></div>` : ''}
              ${week.onTime ? `<div class="col-seg ontime" style="height:${sharePercent(week.onTime, week.total)}%"></div>` : ''}
            </div>` : ''}
          </div>
          <span class="column-label">${escapeHtml(formatDate(week.weekStart).slice(0, 6))}</span>
        </div>`).join('')}
    </div>
    <p class="muted-sm">${plural(data.counted, 'completion')} in the last ${TREND_WEEKS} weeks${
      data.outsideWindow ? ` · ${data.outsideWindow} older than that` : ''}</p>`;
}

function delayedProjectsBox(totals) {
  if (!totals.delayedProjects.length) return '<p class="muted-sm">No project is carrying a delay.</p>';
  return totals.delayedProjects.map(({ project, metrics }) => {
    const sides = [];
    if (metrics.companySide) sides.push(`${metrics.companySide} company`);
    if (metrics.partnerSide) sides.push(`${metrics.partnerSide} partner`);
    const unattributed = metrics.delayed - metrics.companySide - metrics.partnerSide;
    if (unattributed > 0) sides.push(`${unattributed} unattributed`);

    return `<a class="delayed-row clickable" href="/projects/${encodeURIComponent(project.code)}">
      <span class="delayed-name"><b>${escapeHtml(project.code)}</b> ${escapeHtml(project.title)}
        <span class="row-sub">${escapeHtml(project.type || 'Type not set')}</span></span>
      <span class="badge delayed">${plural(metrics.delayed, 'delay')}</span>
      <span class="muted-sm">${escapeHtml(sides.join(' · '))}</span>
    </a>`;
  }).join('');
}

function progressTable(totals) {
  if (!totals.perProject.length) return '<p class="empty">No projects yet.</p>';
  const rows = [...totals.perProject].sort((a, b) => b.metrics.percent - a.metrics.percent);

  return `<div class="table-wrap"><table>
    <thead><tr><th>Project</th><th>Status</th><th>Progress</th><th>Items</th></tr></thead>
    <tbody>${rows.map(({ project, metrics }) => `
      <tr class="clickable" data-href="/projects/${encodeURIComponent(project.code)}">
        <td><b>${escapeHtml(project.code)}</b><span class="row-sub">${escapeHtml(project.title)}</span></td>
        <td>${statusBadge(project.status)}</td>
        <td class="progress-cell">
          <span class="meter"><span class="meter-fill" style="width:${metrics.percent}%"></span></span>
          <span class="progress-value">${metrics.percent}%</span>
        </td>
        <td class="dates">${metrics.itemsDone} / ${plural(metrics.itemsTotal, 'item')}
          <span class="row-sub">${metrics.milestonesDone} / ${plural(metrics.milestonesTotal, 'milestone')}</span></td>
      </tr>`).join('')}</tbody>
  </table></div>`;
}

export async function renderDashboard(mount) {
  await loadProjects();
  const projects = state.projects;
  const count = status => projects.filter(p => p.status === status).length;
  const totals = portfolioMetrics(projects);

  mount.innerHTML = `
    <h2>Dashboard</h2>
    <div class="cards">
      <div class="card"><span class="num">${projects.length}</span><span class="lbl">Total Projects</span></div>
      <div class="card"><span class="num">${count('In-Progress')}</span><span class="lbl">In-Progress</span></div>
      <div class="card"><span class="num">${count('Not Started')}</span><span class="lbl">Not Started</span></div>
      <div class="card"><span class="num">${count('Completed')}</span><span class="lbl">Completed</span></div>
    </div>

    ${isPartner() ? '' : `
      <div class="section-head"><h3>Delivery Quality</h3></div>
      <div class="two-col">
        <div class="box dash-box"><h4>On-Time vs Delayed</h4>${outcomeBox(totals)}</div>
        <div class="box dash-box"><h4>Delays</h4>${delaysBox(totals)}</div>
      </div>
      <div class="box dash-box"><h4>Quality by Project Type</h4>${byTypeBox(totals)}</div>

      <div class="section-head"><h3>Throughput &amp; Delay Trend</h3></div>
      <div class="box dash-box">${trendBox(totals)}</div>

      <div class="section-head">
        <h3>Delayed Projects</h3>
        <span class="muted-sm">${plural(totals.delayedProjects.length, 'project')} carrying a delay</span>
      </div>
      <div class="box dash-box">${delayedProjectsBox(totals)}</div>

      <div class="section-head"><h3>Project Progress</h3></div>
      ${progressTable(totals)}
    `}`;

  mount.querySelectorAll('tr.clickable[data-href]').forEach(tr => {
    tr.addEventListener('click', () => navigate(tr.dataset.href));
  });
}
