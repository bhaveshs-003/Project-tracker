/**
 * One function per notification, each returning { subject, text, html }.
 *
 * Text is written first and carries the whole message; the HTML is the same
 * content with inline styles. No images, no external CSS, one accent colour —
 * anything more is a liability across mail clients.
 */

var transport = require('./transport');

var APP = transport.config.appUrl;
var ACCENT = '#4f6df5';

function projectUrl(project) {
  return APP + '/projects/' + encodeURIComponent(project.code);
}

/** Delay notifications deep-link to the tab the conversation is on. */
function commentsUrl(project) {
  return projectUrl(project) + '/comments';
}

function escapeHtml(text) {
  return String(text == null ? '' : text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Shared chrome so every email looks like it came from the same system. */
function wrap(heading, bodyHtml, cta) {
  return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
    background:#f4f6f8;padding:24px;">
    <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:10px;
      padding:28px 30px;border:1px solid #e5e8ec;">
      <p style="margin:0 0 4px;font-size:12px;letter-spacing:.06em;text-transform:uppercase;
        color:#9aa1ad;">Functional Tool</p>
      <h1 style="margin:0 0 16px;font-size:19px;color:#1f2430;">${escapeHtml(heading)}</h1>
      ${bodyHtml}
      ${cta ? `<p style="margin:24px 0 0;">
        <a href="${cta.url}" style="display:inline-block;background:${ACCENT};color:#fff;
          text-decoration:none;padding:10px 18px;border-radius:6px;font-weight:600;
          font-size:14px;">${escapeHtml(cta.label)}</a></p>` : ''}
      <p style="margin:24px 0 0;font-size:12px;color:#9aa1ad;">
        You are receiving this because of your role on this project in Functional Tool.</p>
    </div></div>`;
}

const p = text => `<p style="margin:0 0 12px;font-size:14px;line-height:1.55;color:#46505f;">${text}</p>`;

const quote = text => `<blockquote style="margin:14px 0 0;padding:10px 14px;
  border-left:3px solid ${ACCENT};background:#f7f9ff;font-size:14px;color:#46505f;">
  ${escapeHtml(text)}</blockquote>`;

function detailList(pairs) {
  return `<table style="margin:0 0 4px;font-size:14px;color:#46505f;border-collapse:collapse;">
    ${pairs.filter(Boolean).map(([k, v]) =>
      `<tr><td style="padding:3px 14px 3px 0;color:#9aa1ad;">${escapeHtml(k)}</td>
           <td style="padding:3px 0;"><b>${escapeHtml(v)}</b></td></tr>`).join('')}
  </table>`;
}

// ---------------------------------------------------------------
// 1. A milestone needs the partner's approval
// ---------------------------------------------------------------
function milestoneSubmitted({ project, milestone, actor, recipient }) {
  const url = projectUrl(project);
  return {
    subject: `Approval needed: ${milestone.title} — ${project.code}`,
    text: [
      `Hello ${recipient.name},`,
      ``,
      `${actor.name} has submitted a milestone for your approval.`,
      ``,
      `Project:   ${project.code} — ${project.title}`,
      `Milestone: ${milestone.title}`,
      `Outcome:   ${milestone.outcome || 'Completed'}${milestone.delay_side ? ' (' + milestone.delay_side + ')' : ''}`,
      ``,
      `Review and approve it here:`,
      url,
      ``,
      `You are named as Partner POC on this project, so approval sits with you.`
    ].join('\n'),
    html: wrap('A milestone needs your approval',
      p(`Hello ${escapeHtml(recipient.name)},`) +
      p(`<b>${escapeHtml(actor.name)}</b> has submitted a milestone for your approval.`) +
      detailList([
        ['Project', `${project.code} — ${project.title}`],
        ['Milestone', milestone.title],
        ['Outcome', (milestone.outcome || 'Completed') +
          (milestone.delay_side ? ` (${milestone.delay_side})` : '')]
      ]),
      { url, label: 'Review and approve' })
  };
}

// ---------------------------------------------------------------
// 2. The partner approved it — tell whoever asked
// ---------------------------------------------------------------
function milestoneApproved({ project, milestone, approver, recipient, rating, comment }) {
  const url = projectUrl(project);
  return {
    subject: `Approved: ${milestone.title} — ${project.code}`,
    text: [
      `Hello ${recipient.name},`,
      ``,
      `${approver.name} has approved the milestone you submitted.`,
      ``,
      `Project:   ${project.code} — ${project.title}`,
      `Milestone: ${milestone.title}`,
      `Rating:    ${rating}/5`,
      ``,
      `Their feedback:`,
      `  "${comment}"`,
      ``,
      url
    ].join('\n'),
    html: wrap('Milestone approved',
      p(`Hello ${escapeHtml(recipient.name)},`) +
      p(`<b>${escapeHtml(approver.name)}</b> has approved the milestone you submitted.`) +
      detailList([
        ['Project', `${project.code} — ${project.title}`],
        ['Milestone', milestone.title],
        ['Rating', `${rating}/5`]
      ]) +
      `<blockquote style="margin:14px 0 0;padding:10px 14px;border-left:3px solid ${ACCENT};
        background:#f7f9ff;font-size:14px;color:#46505f;">${escapeHtml(comment)}</blockquote>`,
      { url, label: 'Open the project' })
  };
}

// ---------------------------------------------------------------
// 3. The project is finished
// ---------------------------------------------------------------
function projectCompleted({ project, actor, recipient, summary }) {
  const url = projectUrl(project);
  return {
    subject: `Project completed: ${project.code} — ${project.title}`,
    text: [
      `Hello ${recipient.name},`,
      ``,
      `${actor.name} has marked this project as Completed.`,
      ``,
      `Project:    ${project.code} — ${project.title}`,
      `Milestones: ${summary.milestones} completed and approved`,
      `Delivery:   ${summary.onTime} on time, ${summary.delayed} delayed`,
      ``,
      url
    ].join('\n'),
    html: wrap('Project completed',
      p(`Hello ${escapeHtml(recipient.name)},`) +
      p(`<b>${escapeHtml(actor.name)}</b> has marked this project as Completed.`) +
      detailList([
        ['Project', `${project.code} — ${project.title}`],
        ['Milestones', `${summary.milestones} completed and approved`],
        ['Delivery', `${summary.onTime} on time, ${summary.delayed} delayed`]
      ]),
      { url, label: 'View the project' })
  };
}

// ---------------------------------------------------------------
// 4. Someone was tagged in approval feedback
// ---------------------------------------------------------------
function mentioned({ project, milestone, approver, recipient, comment }) {
  const url = projectUrl(project);
  return {
    subject: `You were mentioned on ${milestone.title}`,
    text: [
      `Hello ${recipient.name},`,
      ``,
      `${approver.name} mentioned you when approving a milestone.`,
      ``,
      `Project:   ${project.code} — ${project.title}`,
      `Milestone: ${milestone.title}`,
      ``,
      `  "${comment}"`,
      ``,
      url
    ].join('\n'),
    html: wrap('You were mentioned',
      p(`Hello ${escapeHtml(recipient.name)},`) +
      p(`<b>${escapeHtml(approver.name)}</b> mentioned you when approving
         <b>${escapeHtml(milestone.title)}</b> on ${escapeHtml(project.code)}.`) +
      `<blockquote style="margin:14px 0 0;padding:10px 14px;border-left:3px solid ${ACCENT};
        background:#f7f9ff;font-size:14px;color:#46505f;">${escapeHtml(comment)}</blockquote>`,
      { url, label: 'Open the project' })
  };
}

// ---------------------------------------------------------------
// 5. Named as Partner POC
// ---------------------------------------------------------------
function pocAssigned({ project, actor, recipient }) {
  const url = projectUrl(project);
  return {
    subject: `You are now Partner POC on ${project.code}`,
    text: [
      `Hello ${recipient.name},`,
      ``,
      `${actor.name} has named you Partner POC on a project. Milestone approvals`,
      `for it will come to you.`,
      ``,
      `Project: ${project.code} — ${project.title}`,
      `Status:  ${project.status}`,
      ``,
      url
    ].join('\n'),
    html: wrap('You are now a Partner POC',
      p(`Hello ${escapeHtml(recipient.name)},`) +
      p(`<b>${escapeHtml(actor.name)}</b> has named you Partner POC on a project.
         Milestone approvals for it will come to you.`) +
      detailList([
        ['Project', `${project.code} — ${project.title}`],
        ['Status', project.status]
      ]),
      { url, label: 'Open the project' })
  };
}

// ---------------------------------------------------------------
// 6. The partner denied a delay — the approval is now blocked on a reply
// ---------------------------------------------------------------
function delayDenied({ project, milestone, actor, recipient, itemLabel, comment, hasAttachment }) {
  const url = commentsUrl(project);
  return {
    subject: `Delay denied: ${itemLabel} — ${project.code}`,
    text: [
      `Hello ${recipient.name},`,
      ``,
      `${actor.name} has denied the delay on "${itemLabel}".`,
      `The milestone stays pending approval until this is resolved.`,
      ``,
      `Project:   ${project.code} — ${project.title}`,
      `Milestone: ${milestone.title}`,
      `Item:      ${itemLabel}`,
      ``,
      `Their reason:`,
      `  "${comment}"`,
      hasAttachment ? `\nThey attached a file — open the project to download it.` : ``,
      ``,
      `You can reply on this delay from the Comments tab.`,
      ``,
      url
    ].join('\n'),
    html: wrap('Delay denied',
      p(`Hello ${escapeHtml(recipient.name)},`) +
      p(`<b>${escapeHtml(actor.name)}</b> has denied the delay on
         <b>${escapeHtml(itemLabel)}</b>. The milestone stays pending approval until
         this is resolved.`) +
      detailList([
        ['Project', `${project.code} — ${project.title}`],
        ['Milestone', milestone.title],
        ['Item', itemLabel],
        hasAttachment ? ['Attachment', 'One file — download it from the project'] : null
      ]) +
      quote(comment),
      { url, label: 'Reply on this delay' })
  };
}

// ---------------------------------------------------------------
// 7. The admin replied on a denied delay — tell the partner who denied it
// ---------------------------------------------------------------
function delayReplied({ project, milestone, actor, recipient, itemLabel, comment, hasAttachment }) {
  const url = commentsUrl(project);
  return {
    subject: `Reply on the delay you denied: ${itemLabel} — ${project.code}`,
    text: [
      `Hello ${recipient.name},`,
      ``,
      `${actor.name} has replied on the delay you denied.`,
      ``,
      `Project:   ${project.code} — ${project.title}`,
      `Milestone: ${milestone.title}`,
      `Item:      ${itemLabel}`,
      ``,
      `Their reply:`,
      `  "${comment}"`,
      hasAttachment ? `\nThey attached a file — open the project to download it.` : ``,
      ``,
      `If it settles the matter you can accept the delay and approve the milestone.`,
      ``,
      url
    ].join('\n'),
    html: wrap('Reply on a denied delay',
      p(`Hello ${escapeHtml(recipient.name)},`) +
      p(`<b>${escapeHtml(actor.name)}</b> has replied on the delay you denied for
         <b>${escapeHtml(itemLabel)}</b>.`) +
      detailList([
        ['Project', `${project.code} — ${project.title}`],
        ['Milestone', milestone.title],
        ['Item', itemLabel],
        hasAttachment ? ['Attachment', 'One file — download it from the project'] : null
      ]) +
      quote(comment) +
      p(`If it settles the matter you can accept the delay and approve the milestone.`),
      { url, label: 'Open the delay thread' })
  };
}

module.exports = {
  milestoneSubmitted,
  milestoneApproved,
  projectCompleted,
  mentioned,
  pocAssigned,
  delayDenied,
  delayReplied,
  projectUrl
};
