/**
 * The single door to the server.
 *
 * Only a 401 means "not signed in". Everything else — a dropped connection, a
 * 500, a proxy hiccup — is surfaced as an error the caller can show, never as a
 * silent trip back to the login screen.
 */

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function request(method, url, body) {
  const options = { method, credentials: 'same-origin', headers: {} };
  if (body !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }

  let res;
  try {
    res = await fetch(url, options);
  } catch (cause) {
    // No status: the request never reached the server
    throw new ApiError('Could not reach the server. Check it is running and try again.', 0);
  }

  let data = null;
  try { data = await res.json(); } catch { /* empty or non-JSON body */ }

  if (!res.ok) {
    throw new ApiError((data && data.error) || `Request failed (${res.status})`, res.status);
  }
  return data;
}

/**
 * Multipart, for a comment carrying a file. The Content-Type header is left
 * unset on purpose — the browser has to add it itself so the multipart boundary
 * matches the body it generated.
 */
async function postForm(url, formData) {
  let res;
  try {
    res = await fetch(url, { method: 'POST', credentials: 'same-origin', body: formData });
  } catch {
    throw new ApiError('Could not reach the server. Check it is running and try again.', 0);
  }

  let data = null;
  try { data = await res.json(); } catch { /* empty or non-JSON body */ }

  if (!res.ok) {
    throw new ApiError((data && data.error) || `Request failed (${res.status})`, res.status);
  }
  return data;
}

export const api = {
  get: (url) => request('GET', url),
  post: (url, body) => request('POST', url, body ?? {}),
  patch: (url, body) => request('PATCH', url, body ?? {}),
  put: (url, body) => request('PUT', url, body ?? {}),
  del: (url, body) => request('DELETE', url, body),
  postForm
};

/** Opened off the filesystem, no server can ever be reached. */
export const isFileProtocol = location.protocol === 'file:';
