/**
 * The client's view of server data. A thin cache so a re-render does not refetch
 * everything, plus the current user.
 *
 * Nothing here is authoritative — it is a copy of what the server allowed this
 * user to see. Every mutation goes back through the API.
 */

import { api } from './api.js';

export const state = {
  user: null,
  people: [],
  projects: [],
  project: null      // the one open on the detail page
};

export const isPartner = () => state.user?.role === 'partner';
export const isAdmin = () => state.user?.role === 'admin';

export function personById(id) {
  return state.people.find(p => p.id === id) || null;
}

export function currentPerson() {
  return personById(state.user.id) || {
    id: state.user.id, name: state.user.name,
    role: isPartner() ? 'Partner POC' : 'Admin', email: state.user.email
  };
}

export const roleLabel = () => (isPartner() ? 'Partner POC' : 'Admin');

export const companyResources = () => state.people.filter(p => p.kind === 'company');
export const partnerContacts = () => state.people.filter(p => p.kind === 'partner');

// ---- Loaders ----
export async function loadPeople() {
  state.people = await api.get('/api/people');
  return state.people;
}

export async function loadProjects() {
  state.projects = await api.get('/api/projects');
  return state.projects;
}

export async function loadProject(idOrCode) {
  state.project = await api.get(`/api/projects/${encodeURIComponent(idOrCode)}`);
  return state.project;
}

/** Refresh the open project and its copy in the list, after a mutation. */
export function mergeProject(updated) {
  state.project = updated;
  const i = state.projects.findIndex(p => p.id === updated.id);
  if (i > -1) state.projects[i] = updated;
  return updated;
}

/** A milestone came back from the server; slot it into the open project. */
export function mergeMilestone(milestone) {
  if (!state.project) return;
  const i = state.project.milestones.findIndex(m => m.id === milestone.id);
  if (i > -1) state.project.milestones[i] = milestone;
  else state.project.milestones.push(milestone);
}

export function projectByCode(code) {
  return state.projects.find(p => p.code.toLowerCase() === String(code).toLowerCase()) || null;
}
