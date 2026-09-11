/**
 * Project list. Row click opens the project; edit is a pen icon and delete sits
 * last and demands a reason.
 */

import { api } from '../api.js';
import { state, isPartner, loadProjects } from '../state.js';
import { navigate } from '../router.js';
import { escapeHtml, plural, formatRangeWithDays, statusBadge, dayLabel } from '../format.js';
import { openModal, closeModal, confirmDialog, modalError, clearModalError, attempt, toast } from '../ui.js';

const PEN = `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor"
  stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M11.5 2.5l2 2L6 12l-3 1 1-3z"/></svg>`;
const TRASH = `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor"
  stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5"/></svg>`;

const TYPES = ['Migration', 'Custom Application', 'Integration'];
const STATUSES = ['Not Started', 'In-Progress', 'Completed'];

function projectFormBody(p) {
  const v = f => escapeHtml(p?.[f] ?? '');
  return `
    <div class="row">
      <div><label for="f-code">Project Code *</label>
        <input type="text" id="f-code" placeholder="PRJ-001" required value="${v('code')}" /></div>
      <div><label for="f-type">Project Type *</label>
        <select id="f-type" required>
          <option value="">Select type…</option>
          ${TYPES.map(t => `<option${p?.type === t ? ' selected' : ''}>${t}</option>`).join('')}
        </select></div>
    </div>

    <label for="f-status">Project Status *</label>
    <select id="f-status" required>
      ${STATUSES.map(s => `<option${p?.status === s ? ' selected' : ''}>${s}</option>`).join('')}
    </select>

    <label for="f-title">Title *</label>
    <input type="text" id="f-title" placeholder="Project title" required value="${v('title')}" />

    <label for="f-desc">Description</label>
    <textarea id="f-desc" rows="3">${v('description')}</textarea>

    ${[['Partner Provided Date', 'p', 'partnerStart', 'partnerEnd'],
       ['Company Provided Date', 'c', 'companyStart', 'companyEnd'],
       ['Approved Date Range', 'a', 'approvedStart', 'approvedEnd']].map(([legend, key, s, e]) => `
      <fieldset><legend>${legend}</legend>
        <div class="row">
          <div><label for="f-${key}-start">Start Date</label>
            <input type="date" id="f-${key}-start" value="${v(s)}" /></div>
          <div><label for="f-${key}-end">End Date</label>
            <input type="date" id="f-${key}-end" value="${v(e)}" /></div>
        </div>
        ${key === 'a' ? '<p class="day-hint" id="approved-days"></p>' : ''}
      </fieldset>`).join('')}`;
}

function readProjectForm(modal) {
  const val = id => modal.querySelector('#' + id).value;
  return {
    code: val('f-code').trim(),
    type: val('f-type'),
    status: val('f-status'),
    title: val('f-title').trim(),
    description: val('f-desc').trim(),
    partnerStart: val('f-p-start'), partnerEnd: val('f-p-end'),
    companyStart: val('f-c-start'), companyEnd: val('f-c-end'),
    approvedStart: val('f-a-start'), approvedEnd: val('f-a-end')
  };
}

export function openProjectForm(project, onSaved) {
  const editing = !!project;

  const modal = openModal({
    title: editing ? 'Edit Project' : 'New Project',
    body: projectFormBody(project),
    actions: [
      { label: 'Cancel', className: 'btn-ghost', onClick: closeModal },
      {
        label: 'Save Project', className: 'btn-primary',
        onClick: async (m) => {
          clearModalError(m);
          const payload = readProjectForm(m);
          if (!payload.code) return modalError(m, 'Project code is required.');
          if (!payload.type) return modalError(m, 'Project type is required.');
          if (!payload.title) return modalError(m, 'Title is required.');

          const save = async () => {
            const saved = editing
              ? await api.patch(`/api/projects/${project.id}`, payload)
              : await api.post('/api/projects', payload);
            closeModal();
            await onSaved(saved);
          };

          // Closing a project is irreversible — make it deliberate
          const closing = payload.status === 'Completed' && (!editing || project.status !== 'Completed');
          if (!closing) return attempt(save, { modal: m }).catch(() => {});

          closeModal();
          confirmDialog({
            title: 'Mark project as Completed?',
            message: `${payload.code} — ${payload.title} will be marked Completed.`,
            warning: 'This cannot be undone. A completed project cannot be moved back to ' +
                     'In-Progress or Not Started, and its milestones and sub-tasks become locked.',
            requireText: payload.code,
            confirmLabel: 'Mark project Completed',
            onConfirm: save
          });
        }
      }
    ],
    onMount(m) {
      const start = m.querySelector('#f-a-start');
      const end = m.querySelector('#f-a-end');
      const hint = m.querySelector('#approved-days');
      const update = () => {
        const label = dayLabel(start.value, end.value);
        hint.textContent = label ? `Approved duration: ${label}`
          : (start.value && end.value ? 'End date is before the start date.' : 'No approved range set.');
      };
      start.addEventListener('change', update);
      end.addEventListener('change', update);
      update();

      // Status is forward-only, and Completed waits on the milestones
      if (editing) {
        const flow = STATUSES.indexOf(project.status);
        const blocked = project.milestones.some(ms => !ms.completed || ms.approval !== 'approved');
        [...m.querySelector('#f-status').options].forEach(o => {
          o.disabled = STATUSES.indexOf(o.value) < flow || (o.value === 'Completed' && blocked);
        });
      }
      m.querySelector('#f-code').focus();
    }
  });
  return modal;
}

export function confirmDeleteProject(project, onDeleted) {
  const modal = openModal({
    title: 'Delete Project',
    narrow: true,
    body: `
      <p class="confirm-message">${escapeHtml(project.code)} — ${escapeHtml(project.title)} will be deleted.</p>
      <p class="warn-note">This cannot be undone. Its milestones, sub-tasks and assignments go with it.</p>
      <label for="delete-reason">Reason for deletion *</label>
      <textarea id="delete-reason" rows="3" placeholder="Why is this project being deleted?"></textarea>`,
    actions: [
      { label: 'Cancel', className: 'btn-ghost', onClick: closeModal },
      {
        label: 'Delete project', className: 'btn-primary danger-btn',
        onClick: async (m) => {
          clearModalError(m);
          const reason = m.querySelector('#delete-reason').value.trim();
          if (reason.length < 5) {
            return modalError(m, 'Give a reason for deleting this project (at least 5 characters).');
          }
          try {
            await api.del(`/api/projects/${project.id}`, { reason });
            closeModal();
            await onDeleted();
          } catch (err) { modalError(m, err.message); }
        }
      }
    ],
    onMount: m => m.querySelector('#delete-reason').focus()
  });
  return modal;
}

export async function renderProjects(mount) {
  await loadProjects();
  const partner = isPartner();

  mount.innerHTML = `
    <div class="panel-head">
      <h2>Projects</h2>
      ${partner ? '' : '<button class="btn-primary" id="new-project">+ New Project</button>'}
    </div>
    <input type="text" id="search" class="search" placeholder="Search by code or title…" />
    <div class="table-wrap"><table>
      <thead><tr>
        <th>Code</th><th>Title</th><th>Type</th>
        <th>Approved Date Range</th>
        <th>Status</th>${partner ? '' : '<th class="right">Actions</th>'}
      </tr></thead>
      <tbody id="project-rows"></tbody>
    </table></div>
    <p class="empty hidden" id="empty-msg"></p>`;

  const rows = mount.querySelector('#project-rows');
  const empty = mount.querySelector('#empty-msg');
  const search = mount.querySelector('#search');

  function draw() {
    const term = search.value.trim().toLowerCase();
    const list = state.projects.filter(p =>
      p.code.toLowerCase().includes(term) || p.title.toLowerCase().includes(term));

    rows.innerHTML = list.map(p => `
      <tr class="clickable" data-code="${escapeHtml(p.code)}">
        <td><b>${escapeHtml(p.code)}</b></td>
        <td>${escapeHtml(p.title)}<span class="row-sub">${plural(p.milestones.length, 'milestone')}</span></td>
        <td>${p.type ? escapeHtml(p.type) : '<span class="muted-sm">Not set</span>'}</td>
        <!-- Only the governing range. The partner and company ranges were two
             more near-identical date columns that pushed Actions off-screen;
             all three are on the project page. -->
        <td class="dates approved-cell">${formatRangeWithDays(p.approvedStart, p.approvedEnd)}</td>
        <td>${statusBadge(p.status)}</td>
        ${partner ? '' : `<td class="right nowrap actions-cell">
          <button class="icon-btn" data-edit="${p.id}" title="Edit project">${PEN}</button>
          <button class="icon-btn danger" data-delete="${p.id}" title="Delete project">${TRASH}</button>
        </td>`}
      </tr>`).join('');

    empty.textContent = partner && !state.projects.length
      ? 'You are not assigned as Partner POC on any project yet.'
      : 'No projects found.';
    empty.classList.toggle('hidden', list.length > 0);
  }

  const reload = async () => { await loadProjects(); draw(); };

  rows.addEventListener('click', (e) => {
    const edit = e.target.closest('[data-edit]');
    const del = e.target.closest('[data-delete]');
    const byId = id => state.projects.find(p => p.id === Number(id));

    if (edit) { e.stopPropagation(); return openProjectForm(byId(edit.dataset.edit), reload); }
    if (del) { e.stopPropagation(); return confirmDeleteProject(byId(del.dataset.delete), reload); }

    const row = e.target.closest('tr[data-code]');
    if (row) navigate(`/projects/${encodeURIComponent(row.dataset.code)}`);
  });

  search.addEventListener('input', draw);
  mount.querySelector('#new-project')?.addEventListener('click', () => openProjectForm(null, reload));
  draw();
}
