(function () {
  if (!requireRole('user')) return;

  const me = JSON.parse(localStorage.getItem('user') || '{}');
  document.getElementById('name').textContent = me.name || '';
  if (me.picture) {
    const img = document.getElementById('avatar');
    img.src = me.picture; img.referrerPolicy = 'no-referrer'; img.classList.remove('hidden');
  }

  const $ = (id) => document.getElementById(id);

  /* ---------------- Home: videos + live banner ---------------- */

  async function loadHome() {
    try {
      const [videos, lives] = await Promise.all([api('/api/videos'), api('/api/lives')]);

      const live = lives.find((l) => l.status === 'live');
      $('live-banner').innerHTML = live
        ? `<div class="live-banner"><span class="pulse"></span><h3>${esc(live.title)} is live now</h3>
             <button id="watch-live">Watch live</button></div>`
        : '';
      if (live) $('watch-live').onclick = () => showTab('lives');

      $('videos').innerHTML = videos.length
        ? videos.map((v) => `
          <article class="card">
            <div class="media">${playerHtml(v.kind, v.src, v.title)}</div>
            <div class="body">
              <h3>${esc(v.title)} ${isNew(v.created_at) ? '<span class="badge">NEW</span>' : ''}</h3>
              ${v.description ? `<p>${esc(v.description)}</p>` : ''}
              <div class="meta">${timeAgo(v.created_at)}</div>
            </div>
          </article>`).join('')
        : '<div class="empty" style="grid-column:1/-1">No videos yet. Your coach\'s first session will show up here.</div>';
    } catch (e) { toast(e.message); }
  }

  /* ---------------- Lives ---------------- */

  async function loadLives() {
    try {
      const lives = await api('/api/lives');
      $('lives').innerHTML = lives.length
        ? lives.map((l) => {
          const badge = l.status === 'live' ? '<span class="badge live">LIVE</span>'
            : l.status === 'scheduled' ? '<span class="badge off">SOON</span>' : '<span class="badge off">ENDED</span>';
          const media = l.status === 'live'
            ? `<div class="media">${playerHtml('embed', l.embed_url, l.title)}</div>`
            : `<div class="media" style="display:grid;place-items:center;color:#fff;font:700 1.4rem var(--display)">${l.status === 'scheduled' ? 'Starts soon' : 'Live ended'}</div>`;
          return `<article class="card">${media}
            <div class="body"><h3>${esc(l.title)} ${badge}</h3><div class="meta">${timeAgo(l.created_at)}</div></div></article>`;
        }).join('')
        : '<div class="empty" style="grid-column:1/-1">No lives planned yet.</div>';
    } catch (e) { toast(e.message); }
  }

  /* ---------------- Messages with the coach ---------------- */

  const thread = $('thread');
  let threadLoaded = false;

  async function loadThread() {
    try {
      const msgs = await api('/api/messages');
      thread.innerHTML = msgs.length
        ? msgs.map((m) => renderBubble(m, m.sender === 'user')).join('')
        : '<div class="empty">Say hi to your coach. Messages appear here in real time.</div>';
      thread.scrollTop = thread.scrollHeight;
      threadLoaded = true;
    } catch (e) { toast(e.message); }
  }

  const socket = io({ auth: { token: getToken() } });
  socket.on('connect_error', (err) => { if (err.message === 'unauthorized') logout(); });

  let unread = 0;
  socket.on('message:new', (m) => {
    if (!threadLoaded) return;
    const empty = thread.querySelector('.empty');
    if (empty) empty.remove();
    thread.insertAdjacentHTML('beforeend', renderBubble(m, m.sender === 'user'));
    thread.scrollTop = thread.scrollHeight;
    if (m.sender === 'coach' && currentTab !== 'messages') {
      unread++; setBadge(); toast('New message from your coach');
    }
  });

  function setBadge() {
    const tab = document.querySelector('.tab[data-tab="messages"]');
    tab.innerHTML = 'Coach chat' + (unread ? `<span class="dot">${unread}</span>` : '');
  }

  $('msg-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('msg-input');
    const body = input.value.trim();
    if (!body) return;
    socket.emit('message:send', { body }, (r) => { if (r && r.error) toast(r.error); });
    input.value = '';
  });

  socket.on('video:new', (v) => { toast(`New video: ${v.title}`); loadHome(); });
  socket.on('video:removed', () => loadHome());
  socket.on('live:update', () => { loadHome(); if (currentTab === 'lives') loadLives(); });

  /* ---------------- AI assistant ---------------- */

  const botLog = $('bot-log');
  const botHistory = [];
  botLog.innerHTML = '<div class="bubble them">Hi! Ask me anything about training, recovery or nutrition.</div>';

  $('bot-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $('bot-input');
    const text = input.value.trim();
    if (!text) return;
    input.value = '';

    botHistory.push({ role: 'user', content: text });
    botLog.insertAdjacentHTML('beforeend', `<div class="bubble me">${esc(text)}</div>`);
    const typing = document.createElement('div');
    typing.className = 'bubble them';
    typing.textContent = '…';
    botLog.appendChild(typing);
    botLog.scrollTop = botLog.scrollHeight;

    const btn = e.target.querySelector('button');
    btn.disabled = true;
    try {
      const { reply } = await api('/api/chatbot', { method: 'POST', body: { messages: botHistory } });
      botHistory.push({ role: 'assistant', content: reply });
      typing.textContent = reply;
    } catch (err) {
      botHistory.pop();
      typing.textContent = err.message;
    } finally {
      btn.disabled = false;
      botLog.scrollTop = botLog.scrollHeight;
    }
  });

  /* ---------------- Tabs ---------------- */

  let currentTab = 'home';
  const showTab = setupTabs((name) => {
    currentTab = name;
    if (name === 'home') loadHome();
    if (name === 'lives') loadLives();
    if (name === 'messages') { unread = 0; setBadge(); loadThread(); }
  });
})();
