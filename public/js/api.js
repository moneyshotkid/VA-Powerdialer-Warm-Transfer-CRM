export async function api(path, options = {}) {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
    body: options.body && typeof options.body !== 'string' ? JSON.stringify(options.body) : options.body,
  });

  if (res.status === 401 && path !== '/api/auth/login') {
    window.location.href = '/index.html';
    throw new Error('Not authenticated');
  }

  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // Not JSON — e.g. a 404/500 HTML error page from a route path mismatch, or a proxy/
    // gateway error page. Surface something readable instead of a raw JSON syntax error.
    throw new Error(`Unexpected non-JSON response from ${path} (HTTP ${res.status})`);
  }
  if (!res.ok) {
    throw new Error((data && data.error) || res.statusText);
  }
  return data;
}

export const get = (path) => api(path);
export const post = (path, body) => api(path, { method: 'POST', body });
export const put = (path, body) => api(path, { method: 'PUT', body });
export const del = (path, body) => api(path, { method: 'DELETE', body });
