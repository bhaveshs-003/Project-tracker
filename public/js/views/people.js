/**
 * User management. Admin-only — the route guard and the server both say so.
 *
 * Company resources are directory records with no login; Partner POCs get an
 * account, created by the server in the same transaction as the person.
 */

import { api } from '../api.js';
import { state, loadPeople, companyResources, partnerContacts } from '../state.js';
import { escapeHtml } from '../format.js';
import { openModal, closeModal, confirmDialog, modalError, clearModalError } from '../ui.js';

function personForm(kind, person) {
  const isPartnerKind = kind === 'partner';
  return `
    <label for="u-name">Name *</label>
    <input type="text" id="u-name" required value="${escapeHtml(person?.name ?? '')}" />

    <label for="u-role">Job Title *</label>
    <input type="text" id="u-role" required value="${escapeHtml(person?.role ?? '')}" />

    ${isPartnerKind ? `
      <label for="u-email">Email *</label>
      <input type="email" id="u-email" value="${escapeHtml(person?.email ?? '')}" />

      <label for="u-password">Password ${person ? '' : '*'}</label>
      <input type="password" id="u-password" placeholder="At least 6 characters" />
      <p class="day-hint">${person ? 'Leave blank to keep the current password.' : 'At least 6 characters.'}</p>
    ` : '<p class="day-hint">Company resources are directory records and do not sign in.</p>'}`;
}

function openPersonForm(kind, person, onSaved) {
  openModal({
    title: `${person ? 'Edit' : 'Add'} ${kind === 'partner' ? 'Partner POC' : 'Resource'}`,
    narrow: true,
    body: personForm(kind, person),
    actions: [
      { label: 'Cancel', className: 'btn-ghost', onClick: closeModal },
      {
        label: 'Save', className: 'btn-primary',
        onClick: async (m) => {
          clearModalError(m);
          const payload = {
            kind,
            name: m.querySelector('#u-name').value.trim(),
            jobTitle: m.querySelector('#u-role').value.trim()
          };
          if (kind === 'partner') {
            payload.email = m.querySelector('#u-email').value.trim();
            const pw = m.querySelector('#u-password').value;
            if (pw) payload.password = pw;
          }
          try {
            person ? await api.patch(`/api/people/${person.id}`, payload)
                   : await api.post('/api/people', payload);
            closeModal();
            await onSaved();
          } catch (err) { modalError(m, err.message); }
        }
      }
    ],
    onMount: m => m.querySelector('#u-name').focus()
  });
}

const PEN = `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor"
  stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M11.5 2.5l2 2L6 12l-3 1 1-3z"/></svg>`;
const TRASH = `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor"
  stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5"/></svg>`;

export async function renderPeople(mount) {
  await loadPeople();

  const reload = async () => { await loadPeople(); draw(); };

  function draw() {
    mount.innerHTML = `
      <div class="panel-head"><h2>User Management</h2></div>

      <div class="box-head mgmt-head">
        <h4>Company Resources</h4>
        <button class="btn-primary" id="add-resource">+ Add Resource</button>
      </div>
      <div class="table-wrap"><table>
        <thead><tr><th>Name</th><th>Job Title</th><th class="right">Actions</th></tr></thead>
        <tbody>${companyResources().map(p => `
          <tr><td><b>${escapeHtml(p.name)}</b></td><td>${escapeHtml(p.role)}</td>
            <td class="right nowrap">
              <button class="icon-btn" data-edit="${p.id}" title="Edit">${PEN}</button>
              <button class="icon-btn danger" data-delete="${p.id}" title="Delete">${TRASH}</button>
            </td></tr>`).join('')}</tbody>
      </table></div>

      <div class="box-head mgmt-head">
        <h4>Partner POCs</h4>
        <button class="btn-primary" id="add-poc">+ Add Partner POC</button>
      </div>
      <div class="table-wrap"><table>
        <thead><tr><th>Name</th><th>Job Title</th><th>Email</th><th>Credentials</th><th class="right">Actions</th></tr></thead>
        <tbody>${partnerContacts().map(p => `
          <tr><td><b>${escapeHtml(p.name)}</b></td><td>${escapeHtml(p.role)}</td>
            <td>${escapeHtml(p.email)}</td><td class="muted-sm">Set on server</td>
            <td class="right nowrap">
              <button class="icon-btn" data-edit="${p.id}" title="Edit">${PEN}</button>
              <button class="icon-btn danger" data-delete="${p.id}" title="Delete">${TRASH}</button>
            </td></tr>`).join('')}</tbody>
      </table></div>`;

  }

  // Bound once; draw() only replaces innerHTML, so delegation keeps working
  mount.addEventListener('click', (e) => {
    const find = id => state.people.find(p => p.id === id);

    if (e.target.closest('#add-resource')) return openPersonForm('company', null, reload);
    if (e.target.closest('#add-poc')) return openPersonForm('partner', null, reload);

    const edit = e.target.closest('[data-edit]');
    if (edit) {
      const person = find(edit.dataset.edit);
      return openPersonForm(person.kind, person, reload);
    }

    const del = e.target.closest('[data-delete]');
    if (del) {
      const person = find(del.dataset.delete);
      if (person.id === state.user.id) {
        return confirmDialog({
          title: 'Cannot delete', message: 'You cannot delete the account you are signed in with.',
          confirmLabel: 'OK', onConfirm: closeModal
        });
      }
      return confirmDialog({
        title: `Delete ${person.name}?`,
        message: `${person.name} (${person.role}) will be removed from the directory.`,
        warning: 'This cannot be undone. They are unassigned from every project, and if they had a login it stops working immediately.',
        confirmLabel: 'Delete user',
        onConfirm: async () => { await api.del(`/api/people/${person.id}`); closeModal(); await reload(); }
      });
    }
  });

  draw();
}
