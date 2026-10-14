(function () {
  if (!requireRole('coach')) return;
  const $ = (id) => document.getElementById(id);

  /* ---------------- Videos ---------------- */

  async function loadVideos() {
    try {
      const videos = await api('/api/videos');
      $('videos').innerHTML = videos.length
        ? videos.map((v) => `
          <article class="card">
            <div class="media">${playerHtml(v.kind, v.src, v.title)}</div>
            <div class="body">
              <h3>${esc(v.title)}</h3>
              ${v.description ? `<p>${esc(v.description)}</p>` : ''}
              <div class="meta"><span>${timeAgo(v.created_at)}</span>
                <button class="danger small" data-del-video="${v.id}" style="margin-left:auto">Delete</button></div>
            </div>
          </article>`).join('')
        : '<div class="empty" style="grid-column:1/-1">Nothing published yet. Add your first video above.</div>';
    } catch (e) { toast(e.message); }
  }

  $('videos').addEventListener('click', async (e) => {
    const id = e.target.dataset.delVideo;
    if (!id || !confirm('Delete this video for everyone?')) return;
    try { await api('/api/videos/' + id, { method: 'DELETE' }); loadVideos(); } catch (err) { toast(err.message); }
  });

  $('video-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('v-error'), btn = $('v-submit');
    err.textContent = '';
    const fd = new FormData(e.target);
    const file = fd.get('file');
    if (file && file.size === 0) fd.delete('file');
    btn.disabled = true; btn.textContent = 'Publishing…';
    try {
      await api('/api/videos', { method: 'POST', body: fd });
      e.target.reset();
      toast('Video published. Members see it on their home page.');
      loadVideos();
    } catch (ex) { err.textContent = ex.message; }
    finally { btn.disabled = false; btn.textContent = 'Publish'; }
  });

  /* ---------------- Lives ---------------- */

  async function loadLives() {
    try {
      const lives = await api('/api/lives');
      $('lives').innerHTML = lives.length
        ? lives.map((l) => {
          const badge = l.status === 'live' ? '<span class="badge live">LIVE</span>'
            : l.status === 'scheduled' ? '<span class="badge off">SOON</span>' : '<span class="badge off">ENDED</span>';
          const actions = l.status === 'live'
            ? `<button class="small" data-status="ended" data-id="${l.id}">End live</button>`
            : `<button class="accent small" data-status="live" data-id="${l.id}">Go live</button>`;
          return `<article class="card"><div class="media">${playerHtml('embed', l.embed_url, l.title)}</div>
            <div class="body"><h3>${esc(l.title)} ${badge}</h3>
              <div class="actions" style="margin-top:auto">${actions}
                <button class="danger small" data-del-live="${l.id}">Delete</button></div></div></article>`;
        }).join('')
        : '<div class="empty" style="grid-column:1/-1">No lives yet. Add a YouTube Live link above, then press Go live when you start.</div>';
    } catch (e) { toast(e.message); }
  }

  $('lives').addEventListener('click', async (e) => {
    const { status, id, delLive } = e.target.dataset;
    try {
      if (status) await api('/api/lives/' + id, { method: 'PATCH', body: { status } });
      else if (delLive && confirm('Delete this live?')) await api('/api/lives/' + delLive, { method: 'DELETE' });
      else return;
      loadLives();
    } catch (err) { toast(err.message); }
  });

  $('live-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('l-error');
    err.textContent = '';
    try {
      await api('/api/lives', { method: 'POST', body: { title: $('l-title').value, url: $('l-url').value } });
      e.target.reset();
      loadLives();
    } catch (ex) { err.textContent = ex.message; }
  });

  /* ---------------- Inbox ---------------- */

  const thread = $('thread');
  let activeUser = null;

  async function loadPeople() {
    try {
      const people = await api('/api/coach/conversations');
      const total = people.reduce((n, p) => n + p.unread, 0);
      document.querySelector('.tab[data-tab="inbox"]').innerHTML = 'Messages' + (total ? `<span class="dot">${total}</span>` : '');
      $('people').innerHTML = people.length
        ? people.map((p) => `
          <button class="person" data-user="${p.id}" ${p.id === activeUser ? 'aria-current="true"' : ''}>
            ${p.picture ? `<img src="${esc(p.picture)}" alt="" referrerpolicy="no-referrer">`
              : `<span class="avatar">${esc((p.name || '?')[0].toUpperCase())}</span>`}
            <span class="txt"><b>${esc(p.name || p.email)}</b><span>${esc(p.last_body || 'No messages yet')}</span></span>
            ${p.unread ? `<span class="badge">${p.unread}</span>` : ''}
          </button>`).join('')
        : '<div class="empty" style="border:0">No members yet. They appear here after their first sign-in.</div>';
    } catch (e) { toast(e.message); }
  }

  async function openThread(userId) {
    activeUser = userId;
    $('msg-input').disabled = false;
    $('msg-send').disabled = false;
    try {
      const msgs = await api(`/api/coach/conversations/${userId}/messages`);
      thread.innerHTML = msgs.length
        ? msgs.map((m) => renderBubble(m, m.sender === 'coach')).join('')
        : '<div class="empty">No messages yet. Write the first one.</div>';
      thread.scrollTop = thread.scrollHeight;
      await api(`/api/coach/conversations/${userId}/read`, { method: 'POST' });
      loadPeople();
    } catch (e) { toast(e.message); }
  }

  $('people').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-user]');
    if (btn) openThread(Number(btn.dataset.user));
  });

  const socket = io({ auth: { token: getToken() } });
  socket.on('connect_error', (err) => { if (err.message === 'unauthorized') logout(); });

  socket.on('message:new', async (m) => {
    if (m.user_id === activeUser) {
      const empty = thread.querySelector('.empty');
      if (empty) empty.remove();
      thread.insertAdjacentHTML('beforeend', renderBubble(m, m.sender === 'coach'));
      thread.scrollTop = thread.scrollHeight;
      if (m.sender === 'user') api(`/api/coach/conversations/${activeUser}/read`, { method: 'POST' }).catch(() => {});
    } else if (m.sender === 'user') {
      toast('New message from a member');
    }
    loadPeople();
  });

  $('msg-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('msg-input');
    const body = input.value.trim();
    if (!body || !activeUser) return;
    socket.emit('message:send', { userId: activeUser, body }, (r) => { if (r && r.error) toast(r.error); });
    input.value = '';
  });

  /* ---------------- Tabs ---------------- */

  setupTabs((name) => {
    if (name === 'videos') loadVideos();
    if (name === 'lives') loadLives();
    if (name === 'inbox') loadPeople();
  });
  loadPeople(); // keeps the unread counter fresh from the start
})();
