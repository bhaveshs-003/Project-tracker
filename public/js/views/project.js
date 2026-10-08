/**
 * Project detail: the per-project dashboard, people, and the milestone /
 * approval workflow.
 *
 * Every button here mirrors a server rule. The server is the one that decides —
 * these checks exist so the reason is visible before you click.
 */

import { api } from '../api.js';
import { state, isPartner, personById, loadProject, mergeProject, mergeMilestone, companyResources, partnerContacts } from '../state.js';
import { navigate } from '../router.js';
import {
  escapeHtml, plural, initials, sharePercent, statusBadge, formatDate, formatDateTime,
  formatRange, formatRangeWithDays, projectMetrics, blockingSummary, allMilestonesComplete,
  openSubtasks, delayedItems, outstandingDelays, delayThreads, DELAY_STATUS_LABEL,
  segment, legendItem
} from '../format.js';
import { openModal, closeModal, confirmDialog, modalError, clearModalError, attempt, toast } from '../ui.js';
import { openProjectForm } from './projects.js';

const STATUSES = ['Not Started', 'In-Progress', 'Completed'];
const RATING_WORDS = { 1: 'Poor', 2: 'Fair', 3: 'Good', 4: 'Very Good', 5: 'Excellent' };

// Kept in step with server/uploads.js — the server is the gate, this is the hint
const ACCEPT_TYPES = '.pdf,.doc,.docx,.xls,.xlsx,.png,.jpg,.jpeg';
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

const TABS = [
  ['overview', 'Project Overview'],
  ['milestones', 'Milestones'],
  ['comments', 'Comments']
];
const TAB_KEYS = TABS.map(([key]) => key);

// [legend, form key, start property, end property] — the same shape the project
// form uses, so the two stay visually consistent
const MILESTONE_DATE_SETS = [
  ['Company Provided Date', 'c', 'companyStart', 'companyEnd'],
  ['Partner Provided Date', 'p', 'partnerStart', 'partnerEnd'],
  ['Approved Date Range', 'a', 'approvedStart', 'approvedEnd']
];

const SOURCE_LABEL = { approved: 'approved', company: 'company', partner: 'partner' };
const KEY_TO_SOURCE = { c: 'company', p: 'partner', a: 'approved' };

/**
 * The remaining ranges, shown small under the governing one.
 *
 * Filtered by value, not just by source: approved and company dates are
 * routinely identical, and matching on source alone printed the same date
 * string twice on the same card.
 */
function otherRanges(m) {
  const rows = MILESTONE_DATE_SETS
    .filter(([, key]) => SOURCE_LABEL[m.effectiveSource] !== KEY_TO_SOURCE[key])
    .map(([legend, , startField, endField]) => ({ legend, start: m[startField], end: m[endField] }))
    .filter(r => (r.start || r.end) &&
      !(r.start === m.effectiveStart && r.end === m.effectiveEnd));

  if (!rows.length) return '';
  return `<span class="other-dates">${rows.map(r =>
    `${escapeHtml(r.legend.replace(/ (Provided )?Date( Range)?$/, ''))}: ${formatRangeWithDays(r.start, r.end)}`
  ).join(' · ')}</span>`;
}

let mountEl = null;
let activeTab = 'overview';      // declared here, above every function that reads it

const refresh = async () => { await loadProject(state.project.code); draw(); };

// ---------------------------------------------------------------
// Small render helpers
// ---------------------------------------------------------------
function completionBadge(item) {
  if (!item.completed) return '';
  return item.outcome === 'Delayed'
    ? `<span class="badge delayed">Delayed · ${escapeHtml(item.delaySide || 'Unattributed')}</span>`
    : '<span class="badge ontime">On-Time</span>';
}

function approvalBadge(m) {
  if (m.approval === 'pending') return '<span class="badge pending">Pending Approval</span>';
  if (m.approval === 'approved') {
    const who = m.approvedBy ? personById(m.approvedBy) : null;
    return `<span class="badge approved">Approved${who ? ' · ' + escapeHtml(who.name) : ''}</span>`;
  }
  return '';
}

const delayNote = item => (item.completed && item.outcome === 'Delayed' && item.delayNotes)
  ? `<p class="delay-note">${escapeHtml(item.delayNotes)}</p>` : '';

/** Where a delay stands: awaiting a decision, accepted, or denied. */
function decisionChip(item) {
  if (!item.completed || item.outcome !== 'Delayed') return '';
  const status = item.delayStatus || 'pending';
  if (status === 'pending') return '<span class="decision-chip pending">Awaiting decision</span>';

  const who = item.delayDecidedBy ? personById(item.delayDecidedBy) : null;
  const when = item.delayDecidedAt ? ' on ' + formatDate(item.delayDecidedAt) : '';
  return `<span class="decision-chip ${status}">${status === 'accepted' ? 'Delay accepted' : 'Delay denied'}` +
    `${who ? ' by ' + escapeHtml(who.name) : ''}${when}</span>`;
}

/** How many messages are on a delay, so the Comments tab is discoverable. */
function threadChip(item) {
  const n = (item.delayComments || []).length;
  if (!n) return '';
  return `<span class="thread-chip">${n} ${n === 1 ? 'message' : 'messages'}</span>`;
}

function highlightMentions(escaped) {
  state.people.forEach(person => {
    const tag = '@' + escapeHtml(person.name);
    escaped = escaped.split(tag).join(`<span class="mention">${tag}</span>`);
  });
  return escaped;
}

function feedbackBlock(m) {
  if (!m.feedback || isPartner()) return '';       // server also withholds it
  const who = m.approvedBy ? personById(m.approvedBy) : null;
  const r = m.feedback.rating;
  return `<div class="feedback">
    <div class="feedback-head">
      <span class="stars">${'★'.repeat(r)}${'☆'.repeat(5 - r)}</span>
      <span class="rating-num">${r}/5 · ${RATING_WORDS[r]}</span>
      ${who ? `<span class="muted-sm">— ${escapeHtml(who.name)}${m.approvedAt ? ' on ' + formatDate(m.approvedAt) : ''}</span>` : ''}
    </div>
    <p>${highlightMentions(escapeHtml(m.feedback.comment))}</p>
  </div>`;
}

// ---------------------------------------------------------------
// Delay threads
//
// The composer rules here mirror server/rules.js exactly. The server is what
// actually decides — hiding a box the server would refuse just means nobody
// wastes their time typing into it.
// ---------------------------------------------------------------
const KB = 1024;
function fileSize(bytes) {
  if (bytes < KB) return bytes + ' B';
  if (bytes < KB * KB) return Math.round(bytes / KB) + ' KB';
  return (bytes / KB / KB).toFixed(1) + ' MB';
}

const PAPERCLIP = `<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor"
  stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path
  d="M10.5 5.5L6 10a1.8 1.8 0 002.5 2.5l4.2-4.2a3.2 3.2 0 00-4.5-4.5L3.8 8.2a4.6 4.6 0 006.5 6.5"/></svg>`;

function attachmentChip(file) {
  return `<a class="attachment" href="/api/delays/attachments/${file.id}" download
     title="Download ${escapeHtml(file.filename)}">
    ${PAPERCLIP}<span class="attachment-name">${escapeHtml(file.filename)}</span>
    <span class="attachment-size">${fileSize(file.bytes)}</span></a>`;
}

function decisionTag(decision) {
  if (decision === 'accepted') return '<span class="decision-tag accepted">Accepted the delay</span>';
  if (decision === 'denied') return '<span class="decision-tag denied">Denied the delay</span>';
  return '';
}

function commentBubble(comment) {
  const who = personById(comment.authorId);
  const mine = comment.authorId === state.user.id;
  return `<li class="msg msg-${comment.authorRole}${mine ? ' mine' : ''}">
    <div class="avatar xs">${escapeHtml(initials(who?.name || '?'))}</div>
    <div class="msg-body">
      <div class="msg-head">
        <b>${escapeHtml(who?.name || 'Unknown')}</b>
        <span class="msg-role">${comment.authorRole === 'admin' ? 'Admin' : 'Partner POC'}</span>
        <span class="msg-time">${escapeHtml(formatDateTime(comment.createdAt))}</span>
        ${decisionTag(comment.decision)}
      </div>
      ${comment.body ? `<p class="msg-text">${escapeHtml(comment.body)}</p>` : ''}
      ${comment.attachments.map(attachmentChip).join('')}
    </div>
  </li>`;
}

/**
 * Who gets a box, and for what.
 *   Partner POC — decide while the milestone is pending, then keep replying.
 *   Admin       — reply, and only once the delay has actually been denied.
 */
function composerFor(milestone, delay) {
  const locked = reason => `<p class="composer-locked">${reason}</p>`;
  const partner = isPartner();
  const isPoc = state.project.pocs.includes(state.user.id);

  // These two apply to both roles and come first — an approved milestone or an
  // unsubmitted one has nothing to argue about, whoever is looking.
  if (milestone.approval === 'approved') {
    return locked('This milestone is approved — its delays are settled.');
  }
  if (milestone.approval !== 'pending') {
    return locked('This milestone has not been submitted for approval yet, so there is nothing to decide.');
  }

  if (partner) {
    if (!isPoc) return locked('Only an assigned Partner POC can decide on this delay.');
    const deciding = delay.status === 'pending';
    return composerHtml(delay, {
      placeholder: deciding
        ? 'Why do you accept or deny this delay?'
        : 'Add to this thread…',
      buttons: `
        <button class="btn-primary" data-delay-decide="accepted">Accept delay</button>
        <button class="btn-ghost danger-outline" data-delay-decide="denied">Deny delay</button>
        ${deciding ? '' : '<button class="btn-ghost" data-delay-comment>Comment</button>'}`,
      hint: deciding ? '' : `Currently ${DELAY_STATUS_LABEL[delay.status].toLowerCase()}. You can change it.`
    });
  }

  // Admin — a reply box appears on a denial and nowhere else
  if (delay.status !== 'denied') {
    return locked(delay.status === 'accepted'
      ? 'The Partner POC accepted this delay — nothing to answer.'
      : 'You can reply here once the Partner POC has denied this delay.');
  }
  return composerHtml(delay, {
    placeholder: 'Respond to the denial — add context or evidence.',
    buttons: '<button class="btn-primary" data-delay-comment>Send reply</button>',
    hint: ''
  });
}

function composerHtml(delay, { placeholder, buttons, hint }) {
  const id = `${delay.kind}-${delay.id}`;
  return `<form class="composer" data-composer="${delay.kind}:${delay.id}">
    <textarea rows="3" data-field="body" placeholder="${escapeHtml(placeholder)}"></textarea>
    <div class="composer-foot">
      <label class="file-pick" for="file-${id}">
        ${PAPERCLIP}<span data-file-label>Attach a file</span>
        <input type="file" id="file-${id}" data-field="attachment"
               accept="${ACCEPT_TYPES}" hidden />
      </label>
      <span class="composer-actions">${buttons}</span>
    </div>
    ${hint ? `<p class="day-hint">${escapeHtml(hint)}</p>` : ''}
    <p class="error hidden" data-composer-error></p>
  </form>`;
}

/**
 * One delay, its history, and whatever box the viewer is entitled to.
 *
 * `compact` is for the Milestones tab, where the thread sits directly beneath
 * the item's own row: the attribution badge, the decision chip and the delay
 * note are all already on screen an inch above, so repeating them here would be
 * the same three facts twice in one window.
 */
function delayThread(milestone, delay, { compact = false } = {}) {
  const sideClass = delay.side === 'Partner Side' ? 'attr-partner' : 'attr-company';
  return `<div class="delay-thread${compact ? ' compact' : ''}" data-thread="${delay.kind}:${delay.id}">
    <div class="thread-head">
      <div>
        <b>${escapeHtml(delay.title)}</b>
        ${delay.kind === 'milestone' ? '<span class="muted-sm">(the milestone itself)</span>' : ''}
        ${compact ? '' : `<span class="badge ${sideClass}">${escapeHtml(delay.side || 'Unattributed')}</span>`}
      </div>
      ${compact ? '' : `<span class="decision-chip ${delay.status}">${DELAY_STATUS_LABEL[delay.status]}</span>`}
    </div>
    ${!compact && delay.notes ? `<p class="delay-note">${escapeHtml(delay.notes)}</p>` : ''}
    ${delay.comments.length
      ? `<ul class="msgs">${delay.comments.map(commentBubble).join('')}</ul>`
      : '<p class="muted-sm no-msgs">No messages on this delay yet.</p>'}
    ${composerFor(milestone, delay)}
  </div>`;
}

// ---------------------------------------------------------------
// Per-project dashboard
//
// Collapsed by default so the milestones — the part of the page people act on
// — start near the top. The summary carries the headline figures, so folding
// it away hides the charts rather than the project's status.
//
// Every number below appears exactly once on this screen. The percentage, the
// milestone tally and the delayed count live in the summary; the charts show
// the breakdowns that the summary cannot.
// ---------------------------------------------------------------
function dashboardSection(p) {
  if (isPartner()) return '';
  const m = projectMetrics(p);
  if (!m.itemsTotal) {
    return `<div class="section-head"><h3>Dashboard</h3></div>
            <p class="empty">Add milestones to see progress for this project.</p>`;
  }

  const done = m.onTime + m.delayed;
  const unattributed = m.delayed - m.companySide - m.partnerSide;
  const measured = m.cycleTimes.length;
  const slowest = [...m.cycleTimes].sort((a, b) => b.days - a.days).slice(0, 3);
  const longest = slowest[0]?.days || 1;
  const sep = '<span class="sep">·</span>';

  return `
    <details class="box dash-accordion">
      <summary>
        <span class="acc-title">Dashboard</span>
        <span class="dash-summary-stats">
          <span><b>${m.percent}%</b> complete</span>${sep}
          <span><b>${m.milestonesDone} / ${m.milestonesTotal}</b> milestones</span>${sep}
          <span><b>${m.subtasksDone} / ${m.subtasksTotal}</b> sub-tasks</span>${sep}
          <span class="stat-delayed"><b>${m.delayed}</b> delayed</span>
        </span>
        <span class="meter summary-meter"><span class="meter-fill" style="width:${m.percent}%"></span></span>
      </summary>

      <div class="dash-body">
        <div class="two-col">
          <div class="box dash-box"><h4>On-Time vs Delayed</h4>
            ${done ? `<div class="stack">${segment(m.onTime, done, 'ontime')}${segment(m.delayed, done, 'delayed')}</div>
              <ul class="legend">${legendItem('ontime', 'On-Time', m.onTime, done)}${legendItem('delayed', 'Delayed', m.delayed, done)}</ul>`
              : '<p class="muted-sm">Nothing completed yet.</p>'}
          </div>
          <div class="box dash-box"><h4>Delay Attribution</h4>
            ${m.delayed ? `<div class="stack">
                ${segment(m.companySide, m.delayed, 'company')}
                ${segment(m.partnerSide, m.delayed, 'partner')}
                ${segment(unattributed, m.delayed, 'unattributed')}
              </div>
              <ul class="legend">
                ${legendItem('company', 'Company Side', m.companySide, m.delayed)}
                ${legendItem('partner', 'Partner Side', m.partnerSide, m.delayed)}
                ${unattributed > 0 ? legendItem('unattributed', 'Unattributed', unattributed, m.delayed) : ''}
              </ul>` : '<p class="muted-sm">No delays recorded on this project.</p>'}
          </div>
        </div>

        <div class="box dash-box"><h4>Milestone Cycle Time</h4>
          ${measured ? `
            <p class="hero-stat">${plural(Math.round(m.cycleTimes.reduce((s, c) => s + c.days, 0) / measured), 'day')}
              <span class="hero-sub">average, based on ${measured} of ${plural(m.milestonesTotal, 'milestone')}</span></p>
            ${slowest.map(c => `<div class="rank-row">
              <span class="rank-label">${escapeHtml(c.title)}</span>
              <span class="rank-track"><span class="rank-bar cycle" style="width:${sharePercent(c.days, longest)}%"></span></span>
              <span class="rank-count">${c.days}d</span></div>`).join('')}`
            : '<p class="muted-sm">No milestones have both a start date and a recorded completion date yet, so cycle time cannot be measured.</p>'}
        </div>
      </div>
    </details>`;
}

/**
 * The three negotiated project ranges on one line. They used to be three
 * full-width cards; the governing one is emphasised and the rest sit beside it.
 */
function dateStrip(p) {
  const item = (label, start, end, primary) =>
    `<span class="ds-item${primary ? ' primary' : ''}">
       <span class="ds-label">${label}</span>
       <span class="ds-value">${primary ? formatRangeWithDays(start, end) : formatRange(start, end)}</span>
     </span>`;

  return `<div class="date-strip">
    ${item('Approved', p.approvedStart, p.approvedEnd, true)}
    ${item('Company', p.companyStart, p.companyEnd, false)}
    ${item('Partner', p.partnerStart, p.partnerEnd, false)}
  </div>`;
}

// ---------------------------------------------------------------
// People
// ---------------------------------------------------------------
/**
 * Collapsed by default so the milestones sit higher up the page. The summary
 * keeps the count and the avatars visible while closed, so collapsing does not
 * hide who is on the project.
 */
function peopleAccordion(title, ids, kind, readOnly) {
  const avatars = ids.map(personById).filter(Boolean).slice(0, 5)
    .map(person => `<span class="avatar xs" title="${escapeHtml(person.name)}">${escapeHtml(initials(person.name))}</span>`)
    .join('');

  return `<details class="box people-accordion">
    <summary>
      <span class="acc-title">${escapeHtml(title)} <span class="acc-count">${ids.length}</span></span>
      <span class="acc-avatars">${avatars}${ids.length > 5 ? `<span class="muted-sm">+${ids.length - 5}</span>` : ''}</span>
      ${readOnly ? '' : `<button class="icon-btn" data-assign="${kind}">+ Assign</button>`}
    </summary>
    <ul class="people">${peopleList(ids, kind)}</ul>
  </details>`;
}

function peopleList(ids, kind) {
  if (!ids.length) return '<li class="muted-sm">Nobody assigned yet.</li>';
  return ids.map(id => {
    const person = personById(id);
    if (!person) return '';
    return `<li>
      <div class="avatar xs">${escapeHtml(initials(person.name))}</div>
      <div class="person-info"><b>${escapeHtml(person.name)}</b><span>${escapeHtml(person.role)}</span></div>
      ${isPartner() ? '' : `<button class="unassign" data-unassign="${kind}" data-person="${person.id}" title="Remove">&times;</button>`}
    </li>`;
  }).join('');
}

function openAssign(kind) {
  const p = state.project;
  const pool = kind === 'pocs' ? partnerContacts() : companyResources();
  const assigned = kind === 'pocs' ? p.pocs : p.resources;

  openModal({
    title: kind === 'pocs' ? 'Assign Partner Company POC' : 'Assign Organisation Resources',
    body: `<p class="muted-sm">Pick from the directory.</p>
      <div class="picker">${pool.map(person => `
        <label class="pick">
          <input type="checkbox" value="${person.id}"${assigned.includes(person.id) ? ' checked' : ''} />
          <div class="avatar xs">${escapeHtml(initials(person.name))}</div>
          <div class="person-info"><b>${escapeHtml(person.name)}</b><span>${escapeHtml(person.role)}</span></div>
        </label>`).join('')}</div>`,
    actions: [
      { label: 'Cancel', className: 'btn-ghost', onClick: closeModal },
      {
        label: 'Save', className: 'btn-primary',
        onClick: async (m) => {
          const personIds = [...m.querySelectorAll('.picker input:checked')].map(i => i.value);
          await attempt(async () => {
            mergeProject(await api.put(`/api/projects/${p.id}/${kind}`, { personIds }));
            closeModal();
            draw();
          }, { modal: m }).catch(() => {});
        }
      }
    ]
  });
}

// ---------------------------------------------------------------
// Completion + approval modals
// ---------------------------------------------------------------
function openCompleteForm({ title, subject, url }) {
  openModal({
    title,
    body: `
      <p class="muted-sm">${escapeHtml(subject)}</p>
      <label for="c-outcome">Completion *</label>
      <select id="c-outcome" required>
        <option value="">Select…</option><option>On-Time</option><option>Delayed</option>
      </select>
      <div id="delay-fields" class="hidden">
        <label for="c-side">Delay Attributed To *</label>
        <select id="c-side"><option value="">Select…</option><option>Company Side</option><option>Partner Side</option></select>
        <label for="c-notes">Delay Details</label>
        <textarea id="c-notes" rows="3" placeholder="What caused the delay?"></textarea>
      </div>`,
    actions: [
      { label: 'Cancel', className: 'btn-ghost', onClick: closeModal },
      {
        label: 'Mark Completed', className: 'btn-primary',
        onClick: async (m) => {
          clearModalError(m);
          const outcome = m.querySelector('#c-outcome').value;
          const delaySide = m.querySelector('#c-side').value;
          if (!outcome) return modalError(m, 'Choose whether it finished on time or was delayed.');
          if (outcome === 'Delayed' && !delaySide) {
            return modalError(m, 'Attribute the delay to either the company or the partner side.');
          }
          await attempt(async () => {
            mergeMilestone(await api.post(url, {
              outcome, delaySide,
              delayNotes: outcome === 'Delayed' ? m.querySelector('#c-notes').value.trim() : ''
            }));
            closeModal();
            await refresh();
          }, { modal: m }).catch(() => {});
        }
      }
    ],
    onMount(m) {
      const outcome = m.querySelector('#c-outcome');
      outcome.addEventListener('change', () => {
        m.querySelector('#delay-fields').classList.toggle('hidden', outcome.value !== 'Delayed');
      });
      outcome.focus();
    }
  });
}

/**
 * Where the delays stand, read-only.
 *
 * Deciding happens on the Milestones tab, against its own endpoint, so the
 * choice survives closing this modal. All the modal does is refuse to submit
 * while anything is outstanding, and say what.
 */
function delaySignOff(milestone) {
  const state_ = outstandingDelays(milestone);
  if (!state_.all.length) return '';
  if (state_.ready) {
    return `<p class="hint-bar all-agreed">All ${state_.all.length === 1 ? 'delay is' :
      state_.all.length + ' delays are'} accepted — you can approve this milestone.</p>`;
  }

  const rows = state_.all.map(d => `<li>
    <span class="decision-chip ${d.status}">${DELAY_STATUS_LABEL[d.status]}</span>
    ${escapeHtml(d.title)}${d.kind === 'milestone' ? ' <span class="muted-sm">(the milestone itself)</span>' : ''}
  </li>`).join('');

  return `
    <div class="approve-section">
      <h4>Delays blocking this approval</h4>
      <p class="hint-bar">${state_.denied.length
        ? `You denied ${plural(state_.denied.length, 'delay')}. Accept ${state_.denied.length === 1
            ? 'it' : 'them'}, or wait for a reply, before approving.`
        : `${plural(state_.undecided.length, 'delay')} still ${state_.undecided.length === 1
            ? 'needs' : 'need'} your decision.`}</p>
      <ul class="delay-status-list">${rows}</ul>
      <p class="day-hint">Accept or deny each one on the
        <a href="/projects/${encodeURIComponent(state.project.code)}/milestones"
           data-close-modal>Milestones tab</a>.</p>
    </div>`;
}

/**
 * The sub-task roll-up, collapsed at the bottom. The partner clicked Approve
 * from the milestone card, which already lists these tasks and their outcomes,
 * so it is a reference rather than something to read first.
 */
function subtaskRollup(milestone) {
  const rows = milestone.subtasks.length
    ? milestone.subtasks.map(s => `
        <tr>
          <td>${escapeHtml(s.title)}</td>
          <td>${s.completed ? completionBadge(s) : '<span class="badge todo">Open</span>'}</td>
          <td class="muted-sm">${s.completedAt ? formatDate(s.completedAt) : '—'}</td>
        </tr>`).join('')
    : '<tr><td colspan="3" class="muted-sm">No sub-tasks on this milestone.</td></tr>';

  return `<details class="tasks-accordion">
    <summary>Sub-tasks (${milestone.subtasks.length})</summary>
    <table class="overview-table">
      <thead><tr><th>Task</th><th>Status</th><th>Completed</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </details>`;
}

function openApprovalForm(milestone) {
  const p = state.project;
  const mentionable = [...p.resources, ...p.pocs].map(personById).filter(Boolean);
  const delays = outstandingDelays(milestone);
  let mentionStart = -1, mentionIndex = 0;

  openModal({
    title: 'Approve Milestone',
    // Feedback first, delay sign-off under it, the task list last and folded.
    body: `
      <p class="muted-sm">${escapeHtml(`${p.code} — ${p.title} · ${milestone.title}`)}</p>

      <label for="a-rating">Feedback</label>
      <div class="slider-row">
        <input type="range" id="a-rating" min="1" max="5" step="1" value="4" />
        <span class="rating-value" id="a-rating-label"></span>
      </div>
      <label for="a-comment">Comments *</label>
      <div class="mention-wrap">
        <textarea id="a-comment" rows="4" placeholder="How did this milestone go? Type @ to tag someone on this project."></textarea>
        <ul class="mention-list hidden" id="mention-list"></ul>
      </div>
      <p class="day-hint">Type <b>@</b> to tag a resource assigned to this project.</p>

      ${delaySignOff(milestone)}
      ${subtaskRollup(milestone)}`,
    actions: [
      { label: 'Cancel', className: 'btn-ghost', onClick: closeModal },
      {
        label: 'Approve Milestone', className: 'btn-primary', disabled: !delays.ready,
        onClick: async (m) => {
          clearModalError(m);
          const comment = m.querySelector('#a-comment').value.trim();
          if (!comment) return modalError(m, 'Add a comment before approving this milestone.');
          const mentions = mentionable.filter(p2 => comment.includes('@' + p2.name)).map(p2 => p2.id);

          await attempt(async () => {
            mergeMilestone(await api.post(`/api/milestones/${milestone.id}/approve`, {
              rating: Number(m.querySelector('#a-rating').value), comment, mentions
            }));
            closeModal();
            await refresh();
          }, { modal: m }).catch(() => {});
        }
      }
    ],
    onMount(m) {
      const rating = m.querySelector('#a-rating');
      const label = m.querySelector('#a-rating-label');
      const comment = m.querySelector('#a-comment');
      const list = m.querySelector('#mention-list');

      const showRating = () => { label.textContent = `${rating.value}/5 · ${RATING_WORDS[rating.value]}`; };
      rating.addEventListener('input', showRating);
      showRating();

      // Approve was disabled at construction if any delay is outstanding; the
      // decisions themselves are made on the Milestones tab, so nothing in this
      // modal can change that. This link is the way out.
      m.querySelector('[data-close-modal]')?.addEventListener('click', closeModal);

      const hide = () => { list.classList.add('hidden'); list.innerHTML = ''; mentionStart = -1; };

      comment.addEventListener('input', () => {
        const caret = comment.selectionStart;
        const found = comment.value.slice(0, caret).match(/@([A-Za-z]*)$/);
        if (!found) return hide();

        mentionStart = caret - found[0].length;
        const query = found[1].toLowerCase();
        const matches = mentionable.filter(p2 => p2.name.toLowerCase().includes(query));
        if (!matches.length) return hide();

        mentionIndex = 0;
        list.innerHTML = matches.map((p2, i) => `
          <li data-id="${p2.id}"${i === 0 ? ' class="active"' : ''}>
            <div class="avatar xs">${escapeHtml(initials(p2.name))}</div>
            <div class="person-info"><b>${escapeHtml(p2.name)}</b><span>${escapeHtml(p2.role)}</span></div>
          </li>`).join('');
        list.classList.remove('hidden');
      });

      const insert = (id) => {
        const person = personById(id);
        if (!person || mentionStart < 0) return;
        const caret = comment.selectionStart;
        const before = comment.value.slice(0, mentionStart);
        const tag = '@' + person.name + ' ';
        comment.value = before + tag + comment.value.slice(caret);
        const pos = (before + tag).length;
        comment.setSelectionRange(pos, pos);
        comment.focus();
        hide();
      };

      comment.addEventListener('keydown', e => {
        if (list.classList.contains('hidden')) return;
        const rows = [...list.querySelectorAll('li')];
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          mentionIndex = (mentionIndex + (e.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length;
          rows.forEach((r, i) => r.classList.toggle('active', i === mentionIndex));
        } else if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault();
          insert(rows[mentionIndex].dataset.id);
        } else if (e.key === 'Escape') { e.preventDefault(); hide(); }
      });

      list.addEventListener('mousedown', e => {
        const row = e.target.closest('li');
        if (!row) return;
        e.preventDefault();
        insert(row.dataset.id);
      });

      comment.focus();
    }
  });
}

function openItemForm({ title, item, isMilestone, onSave }) {
  openModal({
    title,
    body: `
      <label for="i-title">Title *</label>
      <input type="text" id="i-title" required value="${escapeHtml(item?.title ?? '')}" />
      ${isMilestone ? MILESTONE_DATE_SETS.map(([legend, key, startField, endField]) => `
        <fieldset><legend>${legend}</legend>
          <div class="row">
            <div><label for="i-${key}-start">Start Date</label>
              <input type="date" id="i-${key}-start" value="${escapeHtml(item?.[startField] ?? '')}" /></div>
            <div><label for="i-${key}-end">End Date</label>
              <input type="date" id="i-${key}-end" value="${escapeHtml(item?.[endField] ?? '')}" /></div>
          </div>
        </fieldset>`).join('') : ''}`,
    actions: [
      { label: 'Cancel', className: 'btn-ghost', onClick: closeModal },
      {
        label: 'Save', className: 'btn-primary',
        onClick: async (m) => {
          clearModalError(m);
          const payload = { title: m.querySelector('#i-title').value.trim() };
          if (!payload.title) return modalError(m, 'Title is required.');
          if (isMilestone) {
            for (const [legend, key, startField, endField] of MILESTONE_DATE_SETS) {
              const start = m.querySelector(`#i-${key}-start`).value;
              const end = m.querySelector(`#i-${key}-end`).value;
              if (start && end && end < start) {
                return modalError(m, `${legend} end date cannot be before its start date.`);
              }
              payload[startField] = start;
              payload[endField] = end;
            }
          }
          await attempt(async () => { await onSave(payload); closeModal(); await refresh(); },
            { modal: m }).catch(() => {});
        }
      }
    ],
    onMount: m => m.querySelector('#i-title').focus()
  });
}

// ---------------------------------------------------------------
// Milestones
// ---------------------------------------------------------------
function milestoneCard(p, m, inProgress) {
  const readOnly = isPartner();
  const open = openSubtasks(m);
  const doneCount = m.subtasks.filter(s => s.completed).length;

  const completeBtn = () => {
    if (readOnly || !inProgress || m.completed) return '';
    return open
      ? `<button class="icon-btn done-btn" disabled title="Complete all ${plural(open, 'sub-task')} first">Mark Complete</button>`
      : `<button class="icon-btn done-btn" data-complete-ms="${m.id}">Mark Complete</button>`;
  };

  const submitBtn = () => {
    if (readOnly || m.approval !== 'none') return '';
    if (!m.completed) return '<button class="icon-btn" disabled title="Complete this milestone before submitting it for approval">Submit for Approval</button>';
    if (!p.pocs.length) return '<button class="icon-btn" disabled title="Assign a Partner POC to this project first">Submit for Approval</button>';
    return `<button class="icon-btn submit-btn" data-submit="${m.id}">Submit for Approval</button>`;
  };

  const approveBtn = () =>
    (readOnly && m.approval === 'pending' && p.pocs.includes(state.user.id))
      ? `<button class="icon-btn approve-btn" data-approve="${m.id}">Approve</button>` : '';

  const subtasks = m.subtasks.length
    ? m.subtasks.map(s => `<li${s.completed ? ' class="is-done"' : ''}>
        <span class="st-title">${escapeHtml(s.title)}${completionBadge(s)}${decisionChip(s)}${threadChip(s)}${delayNote(s)}</span>
        ${readOnly ? '' : `<span class="st-actions">
          ${inProgress && !s.completed ? `<button class="icon-btn done-btn" data-complete-st="${s.id}">Mark Complete</button>` : ''}
          <button class="icon-btn" data-edit-st="${s.id}">Edit</button>
          <button class="icon-btn danger" data-delete-st="${s.id}">Delete</button>
        </span>`}
      </li>`).join('')
    : '<li class="muted-sm">No sub-tasks yet.</li>';

  return `<div class="milestone${m.completed ? ' is-done' : ''}">
    <div class="ms-head">
      <div>
        <h4>${escapeHtml(m.title)}${completionBadge(m)}${approvalBadge(m)}${decisionChip(m)}</h4>
        <span class="dates">${formatRangeWithDays(m.effectiveStart, m.effectiveEnd)}
          <span class="date-source">${escapeHtml(SOURCE_LABEL[m.effectiveSource])}</span></span>
        ${otherRanges(m)}
        <span class="row-sub">${doneCount} of ${m.subtasks.length} sub-tasks completed</span>
        ${delayNote(m)}
      </div>
      <div class="nowrap">
        ${readOnly ? approveBtn() : `${completeBtn()}${submitBtn()}
          ${m.completed ? '' : `<button class="icon-btn" data-add-st="${m.id}">+ Sub-task</button>`}
          <button class="icon-btn" data-edit-ms="${m.id}">Edit</button>
          <button class="icon-btn danger" data-delete-ms="${m.id}">Delete</button>`}
      </div>
    </div>
    ${feedbackBlock(m)}
    <ul class="subtasks">${subtasks}</ul>
    ${delayReviewBlock(m)}
  </div>`;
}

/**
 * The accept/deny controls, on the milestone they belong to.
 *
 * Only rendered once the milestone is actually with the partner — before it is
 * submitted there is nothing to decide, and after approval it is settled.
 */
function delayReviewBlock(m) {
  const delays = delayedItems(m);
  if (!delays.length || m.approval === 'none') return '';

  const settled = m.approval === 'approved';
  const outstanding = delays.filter(d => d.status !== 'accepted').length;

  return `<details class="delay-review"${outstanding && !settled ? ' open' : ''}>
    <summary>
      <span class="acc-title">Delay review <span class="acc-count">${delays.length}</span></span>
      <span class="review-state">${settled
        ? 'Settled'
        : outstanding
          ? `${outstanding} of ${delays.length} outstanding`
          : 'All accepted'}</span>
    </summary>
    <div class="delay-review-body">
      ${delays.map(d => delayThread(m, d, { compact: true })).join('')}
    </div>
  </details>`;
}

// ---------------------------------------------------------------
// The page
// ---------------------------------------------------------------
/** How many delays are waiting on this viewer, for the Comments tab badge. */
function commentsBadge(p) {
  const partner = isPartner();
  let n = 0;
  delayThreads(p).forEach(({ milestone, delays }) => {
    delays.forEach(d => {
      if (partner && milestone.approval === 'pending' && d.status === 'pending') n++;
      if (!partner && d.status === 'denied') n++;
    });
  });
  return n ? `<span class="subtab-badge">${n}</span>` : '';
}

function overviewTab(p, readOnly) {
  return `
    <p class="desc">${p.description ? escapeHtml(p.description) : '<span class="muted-sm">No description yet.</span>'}</p>
    ${dateStrip(p)}
    ${dashboardSection(p)}
    <div class="two-col">
      ${peopleAccordion('Organisation Resources', p.resources, 'resources', readOnly)}
      ${peopleAccordion('Partner Company POC', p.pocs, 'pocs', readOnly)}
    </div>`;
}

function milestonesTab(p, readOnly, inProgress) {
  return `
    <div class="section-head">
      <h3>Milestones</h3>
      ${readOnly ? '' : '<button class="btn-primary" id="add-milestone">+ Add Milestone</button>'}
    </div>
    ${p.milestones.length
      ? (!inProgress && !readOnly ? `<p class="hint-bar">${p.status === 'Completed'
          ? 'This project is Completed — milestone and sub-task statuses are locked.'
          : 'Milestone and sub-task statuses cannot be changed until this project is In-Progress.'}</p>` : '') +
        p.milestones.map(m => milestoneCard(p, m, inProgress)).join('')
      : `<p class="empty">${readOnly ? 'No milestones have been added to this project yet.'
          : 'No milestones yet. Add the first one to get started.'}</p>`}`;
}

function commentsTab(p) {
  const groups = delayThreads(p);
  if (!groups.length) {
    return `<div class="section-head"><h3>Comments</h3></div>
      <p class="empty">Nothing to discuss yet. A thread opens here whenever a milestone or
        sub-task is completed as Delayed and submitted for approval.</p>`;
  }

  return `<div class="section-head"><h3>Comments</h3></div>
    <p class="day-hint comments-intro">One thread per delay. The Partner POC accepts or denies;
      the admin can reply once a delay has been denied.</p>
    ${groups.map(({ milestone, delays }) => `
      <div class="thread-group">
        <div class="thread-group-head">
          <h4>${escapeHtml(milestone.title)}</h4>
          ${approvalBadge(milestone)}
        </div>
        ${delays.map(d => delayThread(milestone, d)).join('')}
      </div>`).join('')}`;
}

function draw() {
  const p = state.project;
  const readOnly = isPartner();
  const inProgress = p.status === 'In-Progress' && !readOnly;
  const blocking = blockingSummary(p);
  const canComplete = allMilestonesComplete(p);
  const flow = STATUSES.indexOf(p.status);
  const base = `/projects/${encodeURIComponent(p.code)}`;

  const body = activeTab === 'milestones' ? milestonesTab(p, readOnly, inProgress)
    : activeTab === 'comments' ? commentsTab(p)
    : overviewTab(p, readOnly);

  mountEl.innerHTML = `
    <a class="btn-ghost back" href="/projects">← Back to Projects</a>

    <div class="detail-head">
      <div>
        <span class="code-chip">${escapeHtml(p.code)}</span>
        <span class="type-chip${p.type ? '' : ' unset'}">${escapeHtml(p.type || 'Type not set')}</span>
        <h2>${escapeHtml(p.title)}</h2>
      </div>
      <div class="detail-actions">
        <div class="status-picker">
          <label for="d-status">Status</label>
          <select id="d-status" class="status-${p.status === 'In-Progress' ? 'active' : p.status === 'Completed' ? 'done' : 'todo'}"
            ${readOnly ? 'disabled' : ''}>
            ${STATUSES.map(s => `<option${s === p.status ? ' selected' : ''}
              ${STATUSES.indexOf(s) < flow || (s === 'Completed' && !canComplete) ? ' disabled' : ''}>${s}</option>`).join('')}
          </select>
        </div>
        ${readOnly ? '' : '<button class="btn-ghost" id="d-edit">Edit Project</button>'}
      </div>
    </div>

    <nav class="subtabs">
      ${TABS.map(([key, label]) => `<a class="subtab${key === activeTab ? ' active' : ''}"
        href="${base}${key === 'overview' ? '' : '/' + key}">${escapeHtml(label)}${
        key === 'comments' ? commentsBadge(p) : ''}</a>`).join('')}
    </nav>

    ${readOnly ? `<p class="view-only">You are viewing this project as a Partner POC — milestones and
      sub-tasks are read-only. Milestones submitted to you for approval can be approved here.</p>` : ''}

    ${p.status === 'Completed'
      ? '<p class="hint-bar">This project is Completed. Its status is final and cannot be moved back.</p>'
      : blocking ? `<p class="hint-bar">${escapeHtml(blocking)} — every milestone must be completed and
          approved before this project can be marked Completed.</p>` : ''}

    ${body}`;

  wire();
}

function wire() {
  const p = state.project;
  const el = mountEl;
  const msById = id => p.milestones.find(m => m.id === Number(id));
  const stById = id => {
    for (const m of p.milestones) {
      const s = m.subtasks.find(s2 => s2.id === Number(id));
      if (s) return { milestone: m, subtask: s };
    }
    return null;
  };

  el.querySelector('#d-edit')?.addEventListener('click', () =>
    openProjectForm(p, async saved => { mergeProject(saved); await refresh(); }));

  el.querySelector('#add-milestone')?.addEventListener('click', () =>
    openItemForm({
      title: 'Add Milestone', isMilestone: true,
      onSave: payload => api.post('/api/milestones', { ...payload, projectId: p.id })
    }));

  el.querySelector('#d-status')?.addEventListener('change', async (e) => {
    const next = e.target.value;
    const apply = async () => {
      mergeProject(await api.patch(`/api/projects/${p.id}`, { status: next }));
      await refresh();
    };
    if (next !== 'Completed') return attempt(apply).catch(() => { draw(); });

    e.target.value = p.status;    // hold until confirmed
    confirmDialog({
      title: 'Mark project as Completed?',
      message: `${p.code} — ${p.title} will be marked Completed.`,
      warning: 'This cannot be undone. A completed project cannot be moved back to In-Progress or ' +
               'Not Started, and its milestones and sub-tasks become locked.',
      requireText: p.code,
      confirmLabel: 'Mark project Completed',
      onConfirm: async () => { await apply(); closeModal(); }
    });
  });

  el.addEventListener('click', async (e) => {
    const t = sel => e.target.closest(sel);

    const assign = t('[data-assign]');
    if (assign) {
      // The button lives inside <summary>, where a click would otherwise toggle
      // the accordion shut underneath the modal we are about to open.
      e.preventDefault();
      return openAssign(assign.dataset.assign);
    }

    const unassign = t('[data-unassign]');
    if (unassign) {
      const kind = unassign.dataset.unassign;
      const ids = (kind === 'pocs' ? p.pocs : p.resources).filter(id => id !== unassign.dataset.person);
      return attempt(async () => {
        mergeProject(await api.put(`/api/projects/${p.id}/${kind}`, { personIds: ids }));
        draw();
      }).catch(() => {});
    }

    const addSt = t('[data-add-st]');
    if (addSt) return openItemForm({
      title: 'Add Sub-task', isMilestone: false,
      onSave: payload => api.post(`/api/milestones/${addSt.dataset.addSt}/subtasks`, payload)
    });

    const editMs = t('[data-edit-ms]');
    if (editMs) {
      const m = msById(editMs.dataset.editMs);
      return openItemForm({
        title: 'Edit Milestone', item: m, isMilestone: true,
        onSave: payload => api.patch(`/api/milestones/${m.id}`, payload)
      });
    }

    const editSt = t('[data-edit-st]');
    if (editSt) {
      const found = stById(editSt.dataset.editSt);
      return openItemForm({
        title: 'Edit Sub-task', item: found.subtask, isMilestone: false,
        onSave: payload => api.patch(`/api/milestones/subtasks/${found.subtask.id}`, payload)
      });
    }

    const delMs = t('[data-delete-ms]');
    if (delMs) {
      const m = msById(delMs.dataset.deleteMs);
      return confirmDialog({
        title: 'Delete milestone?',
        message: `"${m.title}" will be deleted.`,
        warning: `This cannot be undone.${m.subtasks.length ? ` Its ${plural(m.subtasks.length, 'sub-task')} go with it.` : ''}`,
        confirmLabel: 'Delete milestone',
        onConfirm: async () => { await api.del(`/api/milestones/${m.id}`); closeModal(); await refresh(); }
      });
    }

    const delSt = t('[data-delete-st]');
    if (delSt) {
      const found = stById(delSt.dataset.deleteSt);
      return confirmDialog({
        title: 'Delete sub-task?',
        message: `"${found.subtask.title}" will be deleted.`,
        warning: 'This cannot be undone.',
        confirmLabel: 'Delete sub-task',
        onConfirm: async () => {
          await api.del(`/api/milestones/subtasks/${found.subtask.id}`);
          closeModal(); await refresh();
        }
      });
    }

    const completeMs = t('[data-complete-ms]');
    if (completeMs) {
      const m = msById(completeMs.dataset.completeMs);
      return openCompleteForm({
        title: 'Mark Milestone as Completed', subject: m.title,
        url: `/api/milestones/${m.id}/complete`
      });
    }

    const completeSt = t('[data-complete-st]');
    if (completeSt) {
      const found = stById(completeSt.dataset.completeSt);
      return openCompleteForm({
        title: 'Mark Sub-task as Completed', subject: found.subtask.title,
        url: `/api/milestones/subtasks/${found.subtask.id}/complete`
      });
    }

    const submit = t('[data-submit]');
    if (submit) {
      const m = msById(submit.dataset.submit);
      const names = p.pocs.map(id => personById(id)?.name || id).join(', ');
      return confirmDialog({
        title: 'Submit for approval?',
        message: `Submit "${m.title}" to ${names} for approval?`,
        confirmLabel: 'Submit',
        onConfirm: async () => {
          mergeMilestone(await api.post(`/api/milestones/${m.id}/submit`));
          closeModal(); await refresh();
        }
      });
    }

    const approve = t('[data-approve]');
    if (approve) return openApprovalForm(msById(approve.dataset.approve));

    const decide = t('[data-delay-decide]');
    if (decide) { e.preventDefault(); return submitComposer(decide, decide.dataset.delayDecide); }

    const comment = t('[data-delay-comment]');
    if (comment) { e.preventDefault(); return submitComposer(comment, null); }
  });

  // Show the chosen filename, and refuse an oversized one before uploading it
  el.querySelectorAll('.composer input[type="file"]').forEach(input => {
    input.addEventListener('change', () => {
      const form = input.closest('.composer');
      const label = form.querySelector('[data-file-label]');
      const file = input.files[0];
      if (!file) { label.textContent = 'Attach a file'; return; }
      if (file.size > MAX_UPLOAD_BYTES) {
        input.value = '';
        label.textContent = 'Attach a file';
        return composerError(form, 'That file is larger than 10MB.');
      }
      composerError(form, '');
      label.textContent = file.name;
    });
  });
}

function composerError(form, message) {
  const el = form.querySelector('[data-composer-error]');
  el.textContent = message;
  el.classList.toggle('hidden', !message);
}

/**
 * Send the file straight to storage, and return the path the comment should
 * claim.
 *
 * Three steps rather than one multipart POST, because the API runs as a
 * serverless function and those cap a request body at 4.5MB — a 10MB
 * attachment cannot fit through one. The server checks permission before it
 * issues the ticket, so this cannot be used to put objects in the bucket
 * without the right to comment.
 */
async function uploadAttachment(kind, id, file, onProgress) {
  const ticket = await api.post(`/api/delays/${kind}/${id}/upload-url`,
    { filename: file.name, bytes: file.size });

  if (onProgress) onProgress('Uploading ' + file.name + '…');

  const sent = await fetch(ticket.uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': file.type || 'application/octet-stream' },
    body: file
  });
  if (!sent.ok) throw new Error('The upload did not complete. Try again.');

  return ticket.objectPath;
}

/**
 * Post one composer. `decision` non-null means accept/deny, which also writes
 * the item's status; null is a plain reply on the thread.
 */
async function submitComposer(button, decision) {
  const form = button.closest('.composer');
  const [kind, id] = form.dataset.composer.split(':');
  const body = form.querySelector('[data-field="body"]').value.trim();
  const file = form.querySelector('[data-field="attachment"]').files[0];

  composerError(form, '');
  if (decision === 'denied' && !body) {
    return composerError(form, 'Say why you are denying this delay.');
  }
  if (!decision && !body && !file) {
    return composerError(form, 'Write a comment or attach a file.');
  }
  if (file && file.size > MAX_UPLOAD_BYTES) {
    return composerError(form, 'That file is larger than 10MB.');
  }

  const buttons = [...form.querySelectorAll('button')];
  const label = form.querySelector('[data-file-label]');
  const original = label ? label.textContent : '';
  buttons.forEach(b => { b.disabled = true; });

  try {
    const objectPath = file
      ? await uploadAttachment(kind, id, file, t => { if (label) label.textContent = t; })
      : '';

    const url = decision
      ? `/api/delays/${kind}/${id}/decision`
      : `/api/delays/${kind}/${id}/comments`;

    mergeMilestone(await api.post(url, { body, objectPath, ...(decision ? { decision } : {}) }));
    await refresh();
    if (decision) toast(decision === 'accepted' ? 'Delay accepted.' : 'Delay denied.', 'info');
  } catch (err) {
    buttons.forEach(b => { b.disabled = false; });
    if (label) label.textContent = original;
    composerError(form, err.message);
  }
}

export async function renderProject(mount, code, tab) {
  mountEl = mount;
  // An unknown tab falls back to the overview rather than rendering nothing
  activeTab = TAB_KEYS.includes(tab) ? tab : 'overview';
  await loadProject(code);
  draw();
}
