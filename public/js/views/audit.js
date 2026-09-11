/**
 * Audit trail — admin only, with its own search and sort.
 */

import { api } from '../api.js';
import { escapeHtml, formatDateTime, plural } from '../format.js';

export async function renderAudit(mount) {
  const entries = await api.get('/api/audit');

  const categories = [...new Set(entries.map(e => e.category))].sort();

  mount.innerHTML = `
    <div class="panel-head">
      <h2>Audit Trail</h2>
      <span class="muted-sm" id="audit-count"></span>
    </div>
    <div class="filter-row">
      <input type="text" id="audit-search" class="search" placeholder="Search action, item, details or user…" />
      <select id="audit-category">
        <option value="">All categories</option>
        ${categories.map(c => `<option>${escapeHtml(c)}</option>`).join('')}
      </select>
      <select id="audit-sort">
        <option value="newest">Newest first</option>
        <option value="oldest">Oldest first</option>
        <option value="category">Category (A–Z)</option>
        <option value="actor">User (A–Z)</option>
      </select>
    </div>
    <div class="table-wrap"><table>
      <thead><tr><th>When</th><th>Category</th><th>Action</th><th>Item</th><th>Details</th><th>By</th></tr></thead>
      <tbody id="audit-rows"></tbody>
    </table></div>
    <p class="empty hidden" id="audit-empty">No matching entries.</p>`;

  const rows = mount.querySelector('#audit-rows');
  const empty = mount.querySelector('#audit-empty');
  const count = mount.querySelector('#audit-count');
  const search = mount.querySelector('#audit-search');
  const category = mount.querySelector('#audit-category');
  const sort = mount.querySelector('#audit-sort');

  function draw() {
    const term = search.value.trim().toLowerCase();
    const cat = category.value;

    let list = entries.filter(e => {
      if (cat && e.category !== cat) return false;
      if (!term) return true;
      return [e.action, e.target, e.detail, e.actorName, e.category]
        .some(v => String(v).toLowerCase().includes(term));
    });

    const order = sort.value;
    list = [...list].sort((a, b) => {
      if (order === 'oldest') return a.at.localeCompare(b.at);
      if (order === 'category') return a.category.localeCompare(b.category) || b.at.localeCompare(a.at);
      if (order === 'actor') return a.actorName.localeCompare(b.actorName) || b.at.localeCompare(a.at);
      return b.at.localeCompare(a.at);
    });

    rows.innerHTML = list.map(e => `
      <tr>
        <td class="dates nowrap">${formatDateTime(e.at)}</td>
        <td><span class="badge todo">${escapeHtml(e.category)}</span></td>
        <td>${escapeHtml(e.action)}</td>
        <td>${escapeHtml(e.target)}</td>
        <td class="muted-sm">${escapeHtml(e.detail)}</td>
        <td>${escapeHtml(e.actorName)}<span class="row-sub">${escapeHtml(e.actorRole)}</span></td>
      </tr>`).join('');

    count.textContent = `${plural(list.length, 'entry').replace('entrys', 'entries')} of ${entries.length}`;
    empty.classList.toggle('hidden', list.length > 0);
  }

  [search, category, sort].forEach(el => el.addEventListener('input', draw));
  draw();
}
