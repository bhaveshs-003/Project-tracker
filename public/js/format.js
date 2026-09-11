/**
 * Presentation helpers shared by every view: dates, escaping, badges, metrics.
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

export function formatDate(value) {
  if (!value) return '—';
  const [y, m, d] = value.split('-');
  return `${d} ${MONTHS[parseInt(m, 10) - 1]} ${y}`;
}

export function formatDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${formatDate(iso.slice(0, 10))}, ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** Inclusive of both ends: 1 Jan → 3 Jan is 3 days. */
export function dayCount(start, end) {
  if (!start || !end) return null;
  const ms = Date.parse(`${end}T00:00:00`) - Date.parse(`${start}T00:00:00`);
  if (isNaN(ms) || ms < 0) return null;
  return Math.round(ms / 86400000) + 1;
}

export function dayLabel(start, end) {
  const days = dayCount(start, end);
  return days === null ? '' : plural(days, 'day');
}

export function formatRange(start, end) {
  if (!start && !end) return '<span class="muted-sm">Not set</span>';
  return `${formatDate(start)} → ${formatDate(end)}`;
}

export function formatRangeWithDays(start, end) {
  const label = dayLabel(start, end);
  return formatRange(start, end) + (label ? `<span class="day-count">${label}</span>` : '');
}

export function initials(name) {
  return name.split(' ').map(w => w.charAt(0)).join('').slice(0, 2);
}

export function sharePercent(part, whole) {
  return whole ? (part / whole) * 100 : 0;
}

// ---------------------------------------------------------------
// Stacked bars — one definition, used by both dashboards
// ---------------------------------------------------------------

/** One slice of a stacked bar, direct-labelled with its own count. */
export function segment(value, whole, klass) {
  if (!value) return '';
  return `<div class="seg ${klass}" style="width:${sharePercent(value, whole)}%">
            <span class="seg-label">${value}</span></div>`;
}

/**
 * The legend deliberately carries the name and the share, never the count:
 * the count is already printed inside the segment right above it, and showing
 * it twice was the most repeated number in the app.
 *
 * Zero-valued keys are dropped, matching segment() — a legend entry for a
 * slice that is not in the bar ("Company Side 0%") is noise.
 */
export function legendItem(klass, label, value, whole) {
  if (!value) return '';
  return `<li><span class="swatch ${klass}"></span>${escapeHtml(label)}
          <b>${Math.round(sharePercent(value, whole))}%</b></li>`;
}

export const statusClass = {
  'Not Started': 'todo',
  'In-Progress': 'active',
  'Completed': 'done'
};

export function statusBadge(status) {
  return `<span class="badge ${statusClass[status] || 'todo'}">${escapeHtml(status)}</span>`;
}

// ---------------------------------------------------------------
// Metrics — the same shapes the dashboards were built against
// ---------------------------------------------------------------
export function projectMetrics(p) {
  const m = {
    milestonesDone: 0, milestonesTotal: p.milestones.length,
    subtasksDone: 0, subtasksTotal: 0,
    itemsDone: 0, itemsTotal: 0, percent: 0,
    onTime: 0, delayed: 0, companySide: 0, partnerSide: 0,
    milestonesOnTime: 0, milestonesDelayed: 0,
    delayNotes: [], cycleTimes: [], completions: []
  };

  const tally = (item, title) => {
    if (!item.completed) return;
    if (item.outcome === 'Delayed') {
      m.delayed++;
      if (item.delaySide === 'Company Side') m.companySide++;
      if (item.delaySide === 'Partner Side') m.partnerSide++;
      if (item.delayNotes) m.delayNotes.push({ title, side: item.delaySide, note: item.delayNotes });
    } else {
      m.onTime++;
    }
    if (item.completedAt) m.completions.push({ completedAt: item.completedAt, outcome: item.outcome });
  };

  p.milestones.forEach(ms => {
    if (ms.completed) {
      m.milestonesDone++;
      if (ms.outcome === 'Delayed') m.milestonesDelayed++; else m.milestonesOnTime++;
      const days = dayCount(ms.effectiveStart, ms.completedAt);
      if (days !== null) m.cycleTimes.push({ title: ms.title, days });
    }
    tally(ms, ms.title);

    m.subtasksTotal += ms.subtasks.length;
    ms.subtasks.forEach(st => {
      if (st.completed) m.subtasksDone++;
      tally(st, `${ms.title} › ${st.title}`);
    });
  });

  m.itemsTotal = m.milestonesTotal + m.subtasksTotal;
  m.itemsDone = m.milestonesDone + m.subtasksDone;
  m.percent = m.itemsTotal ? Math.round((m.itemsDone / m.itemsTotal) * 100) : 0;
  return m;
}

export function portfolioMetrics(projects) {
  const totals = {
    onTime: 0, delayed: 0, companySide: 0, partnerSide: 0,
    itemsDone: 0, itemsTotal: 0,
    perProject: [], delayedProjects: [], byType: {}, completions: []
  };

  projects.forEach(p => {
    const m = projectMetrics(p);
    totals.onTime += m.onTime;
    totals.delayed += m.delayed;
    totals.companySide += m.companySide;
    totals.partnerSide += m.partnerSide;
    totals.itemsDone += m.itemsDone;
    totals.itemsTotal += m.itemsTotal;
    totals.perProject.push({ project: p, metrics: m });
    totals.completions.push(...m.completions);
    if (m.delayed > 0) totals.delayedProjects.push({ project: p, metrics: m });

    const type = p.type || 'Not set';
    totals.byType[type] = totals.byType[type] || { onTime: 0, delayed: 0, projects: 0 };
    totals.byType[type].onTime += m.onTime;
    totals.byType[type].delayed += m.delayed;
    totals.byType[type].projects++;
  });

  totals.delayedProjects.sort((a, b) => b.metrics.delayed - a.metrics.delayed);
  return totals;
}

// ---- Milestone / project state helpers, mirroring the server rules ----

/**
 * The delayed items on a milestone that the Partner POC has to accept or deny.
 * `kind` doubles as the :itemType path segment on /api/delays.
 */
export function delayedItems(m) {
  const shape = (kind, item) => ({
    kind, id: item.id, title: item.title,
    side: item.delaySide, notes: item.delayNotes,
    status: item.delayStatus || 'pending',
    decidedBy: item.delayDecidedBy, decidedAt: item.delayDecidedAt,
    comments: item.delayComments || []
  });

  const items = [];
  if (m.completed && m.outcome === 'Delayed') items.push(shape('milestone', m));
  m.subtasks.forEach(s => {
    if (s.completed && s.outcome === 'Delayed') items.push(shape('subtask', s));
  });
  return items;
}

/** Everything still standing between a milestone and its approval. */
export function outstandingDelays(m) {
  const items = delayedItems(m);
  return {
    all: items,
    undecided: items.filter(d => d.status === 'pending'),
    denied: items.filter(d => d.status === 'denied'),
    ready: items.every(d => d.status === 'accepted')
  };
}

/** Every delay thread on a project, grouped by milestone, for the Comments tab. */
export function delayThreads(p) {
  return p.milestones
    .map(m => ({ milestone: m, delays: delayedItems(m) }))
    .filter(group => group.delays.length);
}

export const DELAY_STATUS_LABEL = {
  pending: 'Awaiting decision',
  accepted: 'Accepted',
  denied: 'Denied'
};

export const milestoneFinished = m => m.completed && m.approval === 'approved';
export const openSubtasks = m => m.subtasks.filter(s => !s.completed).length;
export const allMilestonesComplete = p => p.milestones.every(milestoneFinished);
export const openMilestoneCount = p => p.milestones.filter(m => !m.completed).length;
export const awaitingApprovalCount = p =>
  p.milestones.filter(m => m.completed && m.approval !== 'approved').length;

export function blockingSummary(p) {
  const parts = [];
  const open = openMilestoneCount(p);
  const waiting = awaitingApprovalCount(p);
  if (open) parts.push(`${plural(open, 'milestone')} still open`);
  if (waiting) parts.push(`${plural(waiting, 'milestone')} awaiting partner approval`);
  return parts.join(' and ');
}

const TREND_WEEKS = 8;

function mondayOf(date) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d;
}

const isoDate = d =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export function weeklyBuckets(completions) {
  const thisMonday = mondayOf(new Date());
  const weeks = [];
  const index = {};

  for (let i = TREND_WEEKS - 1; i >= 0; i--) {
    const start = new Date(thisMonday);
    start.setDate(start.getDate() - i * 7);
    const bucket = { weekStart: isoDate(start), onTime: 0, delayed: 0, total: 0 };
    weeks.push(bucket);
    index[bucket.weekStart] = bucket;
  }

  let outsideWindow = 0;
  completions.forEach(entry => {
    const [y, m, d] = entry.completedAt.split('-').map(Number);
    const bucket = index[isoDate(mondayOf(new Date(y, m - 1, d)))];
    if (!bucket) { outsideWindow++; return; }
    if (entry.outcome === 'Delayed') bucket.delayed++; else bucket.onTime++;
    bucket.total++;
  });

  return { weeks, counted: weeks.reduce((s, w) => s + w.total, 0), outsideWindow, TREND_WEEKS };
}

export { TREND_WEEKS };
