/* Shared helpers for all pages */

function getToken() { return localStorage.getItem('token'); }

function logout() {
  const role = localStorage.getItem('role');
  localStorage.clear();
  location.href = role === 'coach' ? '/coach/login' : '/';
}

// Fetch wrapper: adds the JWT, handles JSON + errors, logs out on expired sessions
async function api(path, { method = 'GET', body } = {}) {
  const headers = { Authorization: 'Bearer ' + getToken() };
  let payload;
  if (body instanceof FormData) {
    payload = body;
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(path, { method, headers, body: payload });
  if (res.status === 401) { logout(); throw new Error('Session expired'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Something went wrong');
  return data;
}

// Redirect away if the stored session doesn't match the page's role
function requireRole(role) {
  if (!getToken() || localStorage.getItem('role') !== role) {
    location.href = role === 'coach' ? '/coach/login' : '/';
    return false;
  }
  return true;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function timeAgo(iso) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + ' min ago';
  if (s < 86400) return Math.floor(s / 3600) + ' h ago';
  if (s < 7 * 86400) return Math.floor(s / 86400) + ' d ago';
  return new Date(iso).toLocaleDateString();
}

function clockTime(iso) {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function isNew(iso) { return Date.now() - new Date(iso).getTime() < 7 * 86400 * 1000; }

// Player HTML for a video/live: iframe for YouTube/Vimeo, <video> for files
function playerHtml(kind, src, title) {
  if (kind === 'embed') {
    return `<iframe src="${esc(src)}" title="${esc(title)}" loading="lazy" allowfullscreen
      allow="accelerometer; autoplay; encrypted-media; picture-in-picture; fullscreen"></iframe>`;
  }
  const url = src.startsWith('/media/') ? `${src}?token=${encodeURIComponent(getToken())}` : src;
  return `<video src="${esc(url)}" controls preload="metadata" playsinline></video>`;
}

function toast(text) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.setAttribute('role', 'status');
  el.textContent = text;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 5000);
}

// Tab switching: buttons with data-tab, sections with id "tab-<name>"
function setupTabs(onShow) {
  const tabs = document.querySelectorAll('.tab');
  const show = (name) => {
    tabs.forEach((t) => t.setAttribute('aria-selected', String(t.dataset.tab === name)));
    document.querySelectorAll('[id^="tab-"]').forEach((s) => s.classList.toggle('hidden', s.id !== 'tab-' + name));
    if (onShow) onShow(name);
  };
  tabs.forEach((t) => t.addEventListener('click', () => show(t.dataset.tab)));
  show(tabs[0].dataset.tab);
  return show;
}

function renderBubble(m, mine) {
  return `<div class="bubble ${mine ? 'me' : 'them'}">${esc(m.body)}<small>${clockTime(m.created_at)}</small></div>`;
}
