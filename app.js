/* Cook Again 料理筆記 — 前端（純 JavaScript，不需要安裝任何套件） */
(() => {
  'use strict';

  /* ---------------- 小工具 ---------------- */
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const LS = {
    get(k, d) { try { const v = localStorage.getItem('cookagain.' + k); return v ? JSON.parse(v) : d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem('cookagain.' + k, JSON.stringify(v)); return true; } catch { return false; } },
    del(k) { try { localStorage.removeItem('cookagain.' + k); } catch { /* ignore */ } },
  };
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const norm = s => String(s || '').replace(/\s+/g, '').toLowerCase();
  const today = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };
  const stars = n => n ? '★'.repeat(n) + '☆'.repeat(5 - n) : '未評分';
  const photoSrc = p => p.dataUrl || `https://drive.google.com/thumbnail?id=${encodeURIComponent(p.fileId)}&sz=w800`;
  let toastTimer;
  function toast(msg, ms = 2600) {
    const t = $('#toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), ms);
  }

  /* ---------------- 狀態 ---------------- */
  let settings = LS.get('settings', { url: '', token: '' });
  let records = LS.get('cache', []);        // 從試算表讀回的紀錄（離線也能看）
  let pending = LS.get('pending', []);      // 尚未上傳的紀錄
  let current = blankRecord();
  let filterCat = '全部';

  function blankRecord() {
    return { ingredients: [{ name: '', amount: '' }], steps: [{ text: '', tip: '', photos: [] }], finalPhotos: [], rating: 0 };
  }

  /* ---------------- 分頁切換 ---------------- */
  function show(view) {
    $$('.tab').forEach(b => b.classList.toggle('active', b.dataset.view === view));
    $$('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + view));
    if (view === 'list') renderList();
    if (view === 'settings') renderSettings();
    window.scrollTo(0, 0);
  }
  $$('.tab').forEach(b => b.addEventListener('click', () => show(b.dataset.view)));
  document.addEventListener('click', e => {
    const g = e.target.closest('[data-goto]'); if (g) { e.preventDefault(); show(g.dataset.goto); }
  });

  /* ---------------- 照片壓縮（手機照片動輒 5MB，壓到約 200KB 再上傳） ---------------- */
  async function compress(file, max = 1280, quality = 0.8) {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image(); img.src = url; await img.decode();
      const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement('canvas');
      c.width = Math.round(img.naturalWidth * scale); c.height = Math.round(img.naturalHeight * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      return c.toDataURL('image/jpeg', quality);
    } finally { URL.revokeObjectURL(url); }
  }
  async function addPhotos(files, target) {
    for (const f of files) {
      try { target.push({ dataUrl: await compress(f), caption: '' }); }
      catch { toast('有一張照片無法讀取，請改用 JPG/PNG'); }
    }
  }

  /* ---------------- 表單：讀寫 ---------------- */
  const form = $('#recipe-form');

  function fillForm(rec) {
    current = structuredClone(rec);
    if (!current.ingredients?.length) current.ingredients = [{ name: '', amount: '' }];
    if (!current.steps?.length) current.steps = [{ text: '', tip: '', photos: [] }];
    current.finalPhotos ||= [];
    for (const k of ['dishName', 'category', 'date', 'servings', 'timeMinutes', 'source', 'resultNotes', 'improvements', 'nextTime'])
      form.elements[k].value = rec[k] ?? '';
    form.elements.category.value = rec.category || '中式';
    form.elements.date.value = rec.date || today();
    form.elements.tags.value = (rec.tags || []).join(', ');
    renderIngredients(); renderSteps(); renderFinalPhotos(); renderStars();
    $('#edit-banner').classList.toggle('hidden', !rec.id);
    if (rec.id) $('#edit-banner').textContent = `✏️ 正在編輯：${rec.dishName}（第 ${rec.attempt || 1} 次，${rec.date}）`;
    showImproveHint();
  }

  function readForm() {
    const f = form.elements;
    syncRows();
    return {
      ...current,
      dishName: f.dishName.value.trim(),
      category: f.category.value,
      date: f.date.value || today(),
      servings: f.servings.value.trim(),
      timeMinutes: f.timeMinutes.value ? Number(f.timeMinutes.value) : '',
      source: f.source.value.trim(),
      resultNotes: f.resultNotes.value.trim(),
      improvements: f.improvements.value.trim(),
      nextTime: f.nextTime.value.trim(),
      tags: f.tags.value.split(/[,，、]/).map(s => s.trim()).filter(Boolean),
      ingredients: current.ingredients.filter(x => x.name.trim()),
      steps: current.steps.filter(s => s.text.trim() || s.photos.length),
    };
  }

  // 把食材/步驟輸入框的內容寫回 current
  function syncRows() {
    $$('#ingredients .row').forEach((r, i) => {
      current.ingredients[i].name = $('[data-k=name]', r).value;
      current.ingredients[i].amount = $('[data-k=amount]', r).value;
    });
    $$('#steps .step').forEach((r, i) => {
      current.steps[i].text = $('[data-k=text]', r).value;
      current.steps[i].tip = $('[data-k=tip]', r).value;
    });
  }

  /* ---- 食材 ---- */
  function renderIngredients() {
    $('#ingredients').innerHTML = current.ingredients.map((x, i) => `
      <div class="row">
        <input data-k="name" placeholder="食材 / 調味料" value="${esc(x.name)}">
        <input data-k="amount" placeholder="份量" value="${esc(x.amount)}">
        <button type="button" class="icon-btn" data-del-ing="${i}" aria-label="刪除">✕</button>
      </div>`).join('');
  }
  $('#add-ingredient').onclick = () => {
    syncRows(); current.ingredients.push({ name: '', amount: '' }); renderIngredients();
    $$('#ingredients [data-k=name]').at(-1).focus();
  };
  $('#ingredients').addEventListener('click', e => {
    const i = e.target.dataset.delIng; if (i == null) return;
    syncRows(); current.ingredients.splice(+i, 1);
    if (!current.ingredients.length) current.ingredients.push({ name: '', amount: '' });
    renderIngredients(); saveDraft();
  });
  $('#bulk-add').onclick = () => {
    syncRows();
    const lines = $('#bulk-ingredients').value.split('\n').map(s => s.trim()).filter(Boolean);
    current.ingredients = current.ingredients.filter(x => x.name.trim());
    for (const l of lines) {
      const m = l.replace(/^[・\-*•]\s*/, '').match(/^(.+?)[\s:：]+([\d½¼¾一二三四五六七八九十半少適].*)$/);
      current.ingredients.push(m ? { name: m[1].trim(), amount: m[2].trim() } : { name: l, amount: '' });
    }
    if (!current.ingredients.length) current.ingredients.push({ name: '', amount: '' });
    $('#bulk-ingredients').value = ''; renderIngredients(); saveDraft();
  };

  /* ---- 步驟 ---- */
  function renderSteps() {
    $('#steps').innerHTML = current.steps.map((s, i) => `
      <div class="step" data-i="${i}">
        <div class="step-head">步驟 ${i + 1}
          <span class="tools">
            <button type="button" class="icon-btn" data-move="-1" aria-label="上移" ${i === 0 ? 'disabled' : ''}>↑</button>
            <button type="button" class="icon-btn" data-move="1" aria-label="下移" ${i === current.steps.length - 1 ? 'disabled' : ''}>↓</button>
            <button type="button" class="icon-btn" data-del-step aria-label="刪除步驟">✕</button>
          </span>
        </div>
        <textarea data-k="text" rows="2" placeholder="做了什麼？例如：牛腱切塊，冷水下鍋汆燙">${esc(s.text)}</textarea>
        <input data-k="tip" placeholder="火候 / 時間 / 小提醒（選填）例如：中小火 3 分鐘" value="${esc(s.tip)}">
        <div class="photo-box">${s.photos.map((p, j) => thumb(p, `data-del-sp="${j}"`)).join('')}</div>
        <label class="btn ghost file-btn">📷 加過程照片<input type="file" accept="image/*" multiple hidden data-step-photo></label>
      </div>`).join('');
  }
  const thumb = (p, attr) => `<div class="thumb"><img src="${esc(photoSrc(p))}" alt="" loading="lazy"><button type="button" ${attr} aria-label="移除照片">✕</button></div>`;

  $('#add-step').onclick = () => {
    syncRows(); current.steps.push({ text: '', tip: '', photos: [] }); renderSteps();
    $$('#steps [data-k=text]').at(-1).focus();
  };
  $('#steps').addEventListener('click', e => {
    const step = e.target.closest('.step'); if (!step) return;
    const i = +step.dataset.i;
    if (e.target.matches('[data-del-step]')) {
      if (!confirm(`刪除步驟 ${i + 1}？`)) return;
      syncRows(); current.steps.splice(i, 1);
      if (!current.steps.length) current.steps.push({ text: '', tip: '', photos: [] });
    } else if (e.target.dataset.move) {
      syncRows(); const j = i + +e.target.dataset.move;
      [current.steps[i], current.steps[j]] = [current.steps[j], current.steps[i]];
    } else if (e.target.dataset.delSp != null) {
      syncRows(); current.steps[i].photos.splice(+e.target.dataset.delSp, 1);
    } else return;
    renderSteps(); saveDraft();
  });
  $('#steps').addEventListener('change', async e => {
    if (!e.target.matches('[data-step-photo]')) return;
    const i = +e.target.closest('.step').dataset.i;
    syncRows(); await addPhotos(e.target.files, current.steps[i].photos); renderSteps(); saveDraft();
  });

  /* ---- 成品照片 ---- */
  function renderFinalPhotos() {
    $('#final-photos').innerHTML = current.finalPhotos.map((p, j) => thumb(p, `data-del-fp="${j}"`)).join('');
  }
  $('#final-photo-input').addEventListener('change', async e => {
    await addPhotos(e.target.files, current.finalPhotos); e.target.value = ''; renderFinalPhotos(); saveDraft();
  });
  $('#final-photos').addEventListener('click', e => {
    if (e.target.dataset.delFp == null) return;
    current.finalPhotos.splice(+e.target.dataset.delFp, 1); renderFinalPhotos(); saveDraft();
  });

  /* ---- 評分 ---- */
  function renderStars() { $$('#stars button').forEach(b => b.classList.toggle('on', +b.dataset.v <= current.rating)); }
  $('#stars').addEventListener('click', e => {
    const v = +e.target.dataset.v; if (!v) return;
    current.rating = current.rating === v ? 0 : v; renderStars(); saveDraft();
  });

  /* ---- 草稿自動暫存（不怕手機誤關分頁） ---- */
  let draftTimer;
  function saveDraft() {
    clearTimeout(draftTimer);
    draftTimer = setTimeout(() => {
      const rec = readForm();
      if (!LS.set('draft', rec)) { // 照片太多塞不下時，只存文字
        LS.set('draft', { ...rec, finalPhotos: rec.finalPhotos.filter(p => p.fileId), steps: rec.steps.map(s => ({ ...s, photos: s.photos.filter(p => p.fileId) })) });
      }
    }, 600);
  }
  form.addEventListener('input', e => { saveDraft(); if (e.target.name === 'dishName') showImproveHint(); });

  $('#reset-btn').onclick = () => {
    if (!confirm('確定要清空目前的表單？')) return;
    LS.del('draft'); fillForm({ ...blankRecord(), date: today() });
  };

  /* ---------------- 「上次怎麼做、該怎麼改」提醒 ---------------- */
  function attemptsOf(name, excludeId) {
    return records.filter(r => norm(r.dishName) === norm(name) && r.id !== excludeId)
      .sort((a, b) => (b.date + b.createdAt).localeCompare(a.date + a.createdAt));
  }
  function showImproveHint() {
    const box = $('#improve-banner');
    const name = form.elements.dishName.value;
    const prev = name.trim() ? attemptsOf(name, current.id) : [];
    if (!prev.length) { box.classList.add('hidden'); return; }
    const last = prev[0];
    box.innerHTML = `
      <h3>💡 你做過 ${prev.length} 次「${esc(last.dishName)}」，上次（${esc(last.date)}，${stars(last.rating)}）的筆記：</h3>
      ${last.improvements ? `<p><b>問題／改進：</b>${esc(last.improvements)}</p>` : ''}
      ${last.nextTime ? `<p><b>下次調整：</b>${esc(last.nextTime)}</p>` : ''}
      ${!last.improvements && !last.nextTime ? '<p>（上次沒有寫改進建議）</p>' : ''}
      ${current.id ? '' : `<button type="button" class="btn ghost" data-copy-from="${esc(last.id)}">↪︎ 帶入上次的食材和步驟</button>`}`;
    box.classList.remove('hidden');
  }
  $('#improve-banner').addEventListener('click', e => {
    const id = e.target.dataset.copyFrom; if (!id) return;
    const r = records.find(x => x.id === id); if (r) cookAgain(r);
  });

  // 以舊紀錄為基礎「再做一次」：帶入食材、步驟（不含照片和心得）
  function cookAgain(r) {
    fillForm({
      ...blankRecord(), dishName: r.dishName, category: r.category, servings: r.servings, timeMinutes: r.timeMinutes,
      source: r.source, tags: r.tags, date: today(),
      ingredients: structuredClone(r.ingredients || []),
      steps: (r.steps || []).map(s => ({ text: s.text, tip: s.tip, photos: [] })),
    });
    show('new'); saveDraft();
    toast('已帶入上次的食譜，記得參考上方的改進提醒 👆');
  }

  /* ---------------- 產生文字食譜 ---------------- */
  function recipeText(r) {
    const L = [];
    L.push(`【${r.dishName}】第 ${r.attempt || 1} 次 ｜ ${r.category}`);
    const meta = [`日期：${r.date}`];
    if (r.servings) meta.push(`份量：${r.servings}`);
    if (r.timeMinutes) meta.push(`時間：${r.timeMinutes} 分鐘`);
    L.push(meta.join('　'));
    L.push(`評分：${stars(r.rating)}`);
    if (r.source) L.push(`參考：${r.source}`);
    if (r.ingredients?.length) {
      L.push('', '▍食材');
      r.ingredients.forEach(x => L.push(`・${x.name}${x.amount ? '　' + x.amount : ''}`));
    }
    if (r.steps?.length) {
      L.push('', '▍步驟');
      r.steps.forEach((s, i) => {
        L.push(`${i + 1}. ${s.text}`);
        if (s.tip) L.push(`   ⏱ ${s.tip}`);
        if (s.photos?.length) L.push(`   📷 照片 ${s.photos.length} 張`);
      });
    }
    if (r.resultNotes) L.push('', '▍成品心得', r.resultNotes);
    if (r.improvements) L.push('', '▍問題／改進建議', r.improvements);
    if (r.nextTime) L.push('', '▍下次調整', r.nextTime);
    if (r.tags?.length) L.push('', r.tags.map(t => '#' + t).join(' '));
    return L.join('\n');
  }
  function withAttempt(rec) {
    if (!rec.id) rec.attempt = attemptsOf(rec.dishName).length + 1;
    rec.recipeText = recipeText(rec);
    return rec;
  }

  $('#preview-btn').onclick = () => {
    const rec = readForm();
    if (!rec.dishName) { toast('請先填料理名稱'); form.elements.dishName.focus(); return; }
    withAttempt(rec);
    openModal(rec.dishName + '（預覽）', `<pre class="recipe-text">${esc(rec.recipeText)}</pre>`,
      [btn('📋 複製文字', () => copy(rec.recipeText))]);
  };

  /* ---------------- 與 Google Apps Script 溝通 ---------------- */
  async function api(payload, method = 'POST') {
    if (!settings.url) throw new Error('尚未設定 Apps Script 網址');
    let res;
    try {
      if (method === 'GET') {
        const u = new URL(settings.url);
        Object.entries({ ...payload, token: settings.token }).forEach(([k, v]) => u.searchParams.set(k, v));
        res = await fetch(u);
      } else {
        // 用 text/plain 避免瀏覽器的 CORS 預檢（Apps Script 不支援 OPTIONS）
        res = await fetch(settings.url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: JSON.stringify({ ...payload, token: settings.token }) });
      }
    } catch {
      throw new Error('連不上 Apps Script：請確認網址正確、部署的「誰可以存取」選了「所有人」，以及網路正常');
    }
    let data;
    try { data = await res.json(); } catch { throw new Error('Apps Script 回傳的不是資料（可能是存取權限設定錯誤，請看教學的「常見問題」）'); }
    if (!data.ok) throw new Error(data.error || '未知錯誤');
    return data;
  }

  async function loadRecords(quiet) {
    if (!settings.url) { $('#list-status').innerHTML = '尚未連接 Google 試算表，請到 <a href="#" data-goto="settings">⚙️ 設定</a>。'; return; }
    $('#list-status').textContent = '讀取中…';
    try {
      const { records: rs } = await api({ action: 'list' }, 'GET');
      records = rs; LS.set('cache', records);
      refreshDishList(); renderList();
    } catch (err) {
      $('#list-status').innerHTML = `<span class="err">⚠️ ${esc(err.message)}</span>（顯示的是上次的暫存資料）`;
      if (!quiet) toast(err.message, 4000);
    }
  }


  form.addEventListener('submit', async e => {
    e.preventDefault();
    const rec = withAttempt(readForm());
    if (!rec.dishName) { toast('請填料理名稱'); return; }
    const saveBtn = $('#save-btn'); saveBtn.disabled = true; saveBtn.textContent = '上傳中…（照片多會久一點）';
    try {
      if (!settings.url) throw Object.assign(new Error('尚未設定'), { offline: true });
      const { record } = await api({ action: 'save', record: rec });
      upsert(record);
      afterSaved(record, '✅ 已儲存到 Google 試算表');
    } catch (err) {
      // 上傳失敗 → 先存在這台裝置，之後再上傳
      const local = { ...rec, _localId: rec._localId || 'local-' + Date.now() };
      pending = pending.filter(p => p._localId !== local._localId); pending.push(local);
      if (!LS.set('pending', pending)) {
        pending.pop();
        toast('⚠️ 上傳失敗，而且照片太多無法暫存在手機：' + err.message, 6000);
      } else {
        afterSaved(local, err.offline ? '📱 已暫存在這台裝置（設定好試算表後可上傳）' : '📱 上傳失敗，已先暫存在這台裝置：' + err.message);
      }
    } finally {
      saveBtn.disabled = false; saveBtn.textContent = '💾 儲存紀錄';
    }
  });

  function afterSaved(rec, msg) {
    LS.del('draft');
    toast(msg, 4000);
    fillForm({ ...blankRecord(), date: today() });
    openDetail(rec);
  }

  function upsert(rec) {
    records = records.filter(r => r.id !== rec.id); records.unshift(rec);
    LS.set('cache', records); refreshDishList();
  }

  async function syncPending() {
    if (!pending.length) { toast('沒有待上傳的紀錄'); return; }
    const b = $('#sync-btn'); b.disabled = true;
    let ok = 0;
    for (const p of [...pending]) {
      try {
        const { _localId, ...rec } = p;
        const { record } = await api({ action: 'save', record: withAttempt(rec) });
        upsert(record); ok++;
        pending = pending.filter(x => x._localId !== _localId); LS.set('pending', pending);
      } catch (err) { toast('上傳失敗：' + err.message, 4000); break; }
    }
    b.disabled = false; renderSettings();
    if (ok) toast(`已上傳 ${ok} 筆`);
  }

  /* ---------------- 列表 ---------------- */
  function refreshDishList() {
    const names = [...new Map(records.map(r => [norm(r.dishName), r.dishName])).values()];
    $('#dish-list').innerHTML = names.map(n => `<option value="${esc(n)}">`).join('');
  }

  function renderList() {
    const cats = ['全部', ...new Set(records.map(r => r.category).filter(Boolean))];
    if (!cats.includes(filterCat)) filterCat = '全部';
    $('#category-chips').innerHTML = cats.map(c => `<button class="chip ${c === filterCat ? 'on' : ''}" data-cat="${esc(c)}">${esc(c)}</button>`).join('');

    if (settings.url && !$('#list-status .err')) $('#list-status').textContent = `共 ${records.length} 筆紀錄${pending.length ? `，另有 ${pending.length} 筆待上傳` : ''}`;
    const q = norm($('#search').value);
    const all = [...records, ...pending.map(p => ({ ...p, _pending: true }))];
    const hit = all.filter(r => (filterCat === '全部' || r.category === filterCat) &&
      (!q || norm([r.dishName, r.tags?.join(), r.ingredients?.map(x => x.name).join(), r.resultNotes, r.improvements].join()).includes(q)));

    const groups = new Map();
    hit.forEach(r => { const k = norm(r.dishName); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); });
    const sorted = [...groups.values()].map(g => g.sort((a, b) => (b.date + (b.createdAt || '')).localeCompare(a.date + (a.createdAt || ''))))
      .sort((a, b) => b[0].date.localeCompare(a[0].date));

    $('#dish-groups').innerHTML = sorted.length ? sorted.map(g => {
      const latest = g[0];
      const cover = g.flatMap(r => r.finalPhotos || [])[0];
      const best = Math.max(...g.map(r => r.rating || 0));
      return `<div class="dish">
        <div class="dish-head">
          ${cover ? `<img src="${esc(photoSrc(cover))}" alt="" loading="lazy">` : '<div class="noimg">🍽️</div>'}
          <div style="flex:1;min-width:0">
            <h3>${esc(latest.dishName)}</h3>
            <div><span class="badge">${esc(latest.category)}</span><span class="badge">做過 ${g.length} 次</span>${best ? `<span class="badge">最高 ${best}★</span>` : ''}</div>
          </div>
          <button class="btn ghost" data-again="${esc(latest.id || latest._localId)}">🔁 再做</button>
        </div>
        <div class="attempts">${g.map(r => `
          <div class="attempt" data-open="${esc(r.id || r._localId)}">
            <div style="min-width:0">
              <div>${r._pending ? '📱 ' : ''}${esc(r.date)}　第 ${r.attempt || '?'} 次</div>
              <div class="note">${esc(r.nextTime || r.improvements || r.resultNotes || '')}</div>
            </div>
            <span class="star-s">${stars(r.rating)}</span>
          </div>`).join('')}</div>
      </div>`;
    }).join('') : `<p class="muted">${records.length ? '找不到符合的料理' : '還沒有紀錄，到「✏️ 記錄」寫下第一道料理吧！'}</p>`;
  }
  const findAny = id => records.find(r => r.id === id) || pending.find(r => r._localId === id);

  $('#category-chips').addEventListener('click', e => { if (e.target.dataset.cat) { filterCat = e.target.dataset.cat; renderList(); } });
  $('#search').addEventListener('input', renderList);
  $('#refresh-btn').onclick = () => loadRecords();
  $('#dish-groups').addEventListener('click', e => {
    const a = e.target.closest('[data-again]'); if (a) { const r = findAny(a.dataset.again); if (r) cookAgain(r); return; }
    const o = e.target.closest('[data-open]'); if (o) { const r = findAny(o.dataset.open); if (r) openDetail(r); }
  });

  /* ---------------- 詳細內容 ---------------- */
  const modal = $('#modal');
  const btn = (label, fn, cls = 'ghost') => { const b = document.createElement('button'); b.className = 'btn ' + cls; b.textContent = label; b.onclick = fn; return b; };
  function openModal(title, html, buttons = []) {
    $('#modal-title').textContent = title; $('#modal-body').innerHTML = html;
    $('#modal-actions').replaceChildren(...buttons);
    modal.showModal();
  }
  $('#modal-close').onclick = () => modal.close();
  modal.addEventListener('click', e => { if (e.target === modal) modal.close(); });

  function openDetail(r) {
    const photos = [
      ...(r.finalPhotos || []).map(p => ({ ...p, cap: '成品' })),
      ...(r.steps || []).flatMap((s, i) => (s.photos || []).map(p => ({ ...p, cap: `步驟 ${i + 1}` }))),
    ];
    const text = r.recipeText || recipeText(r);
    const html = `
      ${photos.length ? `<div class="gallery">${photos.map(p => `<figure><a href="${esc(p.fileId ? 'https://drive.google.com/file/d/' + p.fileId + '/view' : p.dataUrl)}" target="_blank"><img src="${esc(photoSrc(p))}" alt="${esc(p.cap)}" loading="lazy"></a><figcaption>${esc(p.cap)}</figcaption></figure>`).join('')}</div>` : ''}
      <pre class="recipe-text">${esc(text)}</pre>
      ${r.folderUrl ? `<p class="muted"><a href="${esc(r.folderUrl)}" target="_blank">📁 在 Google 雲端硬碟開啟照片資料夾</a></p>` : ''}
      ${r._localId ? '<p class="muted">📱 這筆還沒上傳，到「設定」按「全部上傳」。</p>' : ''}`;
    const buttons = [
      btn('📋 複製文字', () => copy(text)),
      btn('🔁 再做一次', () => { modal.close(); cookAgain(r); }, 'primary'),
    ];
    if (r.id) {
      buttons.push(btn('✏️ 編輯', () => { modal.close(); fillForm(r); show('new'); }));
      buttons.push(btn('🗑 刪除', async () => {
        if (!confirm(`確定刪除「${r.dishName}」${r.date} 這筆紀錄？（照片會保留在雲端硬碟）`)) return;
        try { await api({ action: 'delete', id: r.id }); records = records.filter(x => x.id !== r.id); LS.set('cache', records);
          modal.close(); renderList(); toast('已刪除'); } catch (err) { toast(err.message, 4000); }
      }, 'ghost danger'));
    }
    openModal(`${r.dishName}　第 ${r.attempt || '?'} 次`, html, buttons);
  }

  async function copy(text) {
    try { await navigator.clipboard.writeText(text); }
    catch { const t = document.createElement('textarea'); t.value = text; document.body.append(t); t.select(); document.execCommand('copy'); t.remove(); }
    toast('已複製，可以貼到 LINE、筆記或社群 ✨');
  }

  /* ---------------- 設定 ---------------- */
  function renderSettings() {
    $('#api-url').value = settings.url; $('#api-token').value = settings.token;
    $('#pending-list').innerHTML = pending.length
      ? pending.map(p => `<div class="pending"><span>${esc(p.date)} ${esc(p.dishName)}</span><button class="btn link" data-open-pending="${esc(p._localId)}">查看</button></div>`).join('')
      : '<p class="muted">沒有待上傳的紀錄 👍</p>';
    $('#sync-btn').classList.toggle('hidden', !pending.length);
  }
  $('#pending-list').addEventListener('click', e => { const id = e.target.dataset.openPending; if (id) openDetail(findAny(id)); });
  function readSettings() { return { url: $('#api-url').value.trim(), token: $('#api-token').value.trim() }; }
  $('#save-settings').onclick = () => {
    settings = readSettings(); LS.set('settings', settings);
    $('#setup-hint').classList.toggle('hidden', !!settings.url);
    toast('設定已儲存'); loadRecords(true);
  };
  $('#test-btn').onclick = async () => {
    const old = settings; settings = readSettings();
    const st = $('#settings-status'); st.textContent = '測試中…';
    try { const d = await api({ action: 'ping' }, 'GET'); st.innerHTML = `<p class="ok">✅ ${esc(d.message)} 記得按「儲存設定」</p>`; }
    catch (err) { st.innerHTML = `<p class="err">❌ ${esc(err.message)}</p>`; }
    finally { settings = old; }
  };
  $('#sync-btn').onclick = syncPending;

  /* ---------------- 啟動 ---------------- */
  $('#setup-hint').classList.toggle('hidden', !!settings.url);
  const draft = LS.get('draft');
  fillForm(draft ? draft : { ...blankRecord(), date: today() });
  if (draft?.dishName) toast('已還原上次未完成的草稿');
  refreshDishList();
  loadRecords(true).then(showImproveHint);
})();
