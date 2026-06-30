// ==UserScript==
// @name         KMITL-Conflict-Check
// @namespace    https://regis.reg.kmitl.ac.th/
// @version      1.0.0
// @description  Search subjects by name, auto-fetch the teach_table API, and find every maximum set of non-conflicting sections (class-time + exam-time) via DP. Lives on the registration page.
// @author       you
// @match        https://regis.reg.kmitl.ac.th/*
// @run-at       document-idle
// @noframes
// @grant        none
// ==/UserScript==

(function () {
  'use strict';
  if (window.__KMITL_SOLVER__) return;     // guard against double-injection
  window.__KMITL_SOLVER__ = true;

  /* ============================================================
   *  time / day helpers
   * ============================================================ */
  const DAY_TH = ['จ.', 'อ.', 'พ.', 'พฤ.', 'ศ.', 'ส.', 'อา.'];
  const DAY_EN = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];
  const COLORS = ['#2f6f8f', '#e8843b', '#6a4c93', '#2e7d57', '#b5476b', '#0f7d8c', '#9c6b1f', '#445a8f'];

  function toMin(t) {
    if (t == null) return null;
    const m = String(t).trim().match(/^(\d{1,2}):?(\d{2})/);
    return m ? (+m[1]) * 60 + (+m[2]) : null;
  }
  function fmtMin(x) { return String(Math.floor(x / 60)).padStart(2, '0') + ':' + String(x % 60).padStart(2, '0'); }
  function overlap(a1, a2, b1, b2) { return a1 < b2 && b1 < a2; }       // strict; touching is OK

  function meetingsConflict(A, B) {
    for (const x of A) for (const y of B)
      if (x.dayIdx === y.dayIdx && x.s != null && y.s != null && overlap(x.s, x.e, y.s, y.e)) return true;
    return false;
  }
  function examsConflict(A, B) {
    for (const x of A) for (const y of B)
      if (x.date && y.date && x.date === y.date && x.s != null && y.s != null && overlap(x.s, x.e, y.s, y.e)) return true;
    return false;
  }
  function sectionsConflict(a, b) { return meetingsConflict(a.meetings, b.meetings) || examsConflict(a.exams, b.exams); }

  /* ============================================================
   *  KMITL API adapter (exact schema) — validated against live data
   *  teach_day: 1=Sun..7=Sat. teachtime_str = extra blocks "5x14:45-16:15".
   *  sec_pair links a lecture (ท) to its lab (ป): one registrable unit.
   * ============================================================ */
  function stripDivs(html) {
    return String(html || '').replace(/<\/div>/gi, '\n').replace(/<[^>]+>/g, '')
      .split('\n').map(x => x.trim()).filter(Boolean).join(' / ');
  }
  function apiDayToIdx(d) { d = parseInt(d, 10); if (isNaN(d)) return null; return (d + 5) % 7; } // ->Mon0..Sun6
  function hhmm(t) { if (t == null) return null; const m = String(t).match(/(\d{1,2}):(\d{2})/); return m ? m[1].padStart(2, '0') + ':' + m[2] : null; }

  function apiRowMeetings(r) {
    const out = [];
    const di = apiDayToIdx(r.teach_day), s = hhmm(r.teach_time), e = hhmm(r.teach_time2);
    const kind = (r.lect_or_prac === 'ป' ? 'Lab' : (r.lect_or_prac === 'ท' ? 'Lecture' : ''));
    const room = r.room_no || r.classroom || '', building = r.building_no || r.classbuilding || '';
    const push = (d, a, b) => { if (d != null && a && b) out.push({ dayIdx: d, s: toMin(a), e: toMin(b), rawDay: DAY_TH[d], rawStart: a, rawEnd: b, type: kind, room, building }); };
    push(di, s, e);
    const re = /(\d)\s*x\s*(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})/g; let m;
    while ((m = re.exec(String(r.teachtime_str || '')))) push(apiDayToIdx(m[1]), hhmm(m[2]), hhmm(m[3]));
    return out;
  }
  function apiRowExams(r) {
    const out = [];
    const add = (kind, sdt, edt) => {
      if (!sdt) return; const sp = String(sdt).split(' '), ep = String(edt || '').split(' ');
      out.push({ kind, date: sp[0], s: toMin(hhmm(sp[1])), e: toMin(hhmm(ep[1] || sp[1])), rawStart: hhmm(sp[1]) || '', rawEnd: hhmm(ep[1]) || '' });
    };
    add('midterm', r.midterm_start_date_time, r.midterm_end_date_time);
    add('final', r.final_start_date_time, r.final_end_date_time);
    return out;
  }
  function normalizeRawApi(raw) {
    const views = Array.isArray(raw) ? raw : (raw && raw.teachtable ? [raw] : null);
    if (!views) throw new Error('Unexpected API shape (no teachtable views).');
    const rowsByKey = new Map();
    for (const v of views) for (const g of (v.teachtable || [])) for (const r of (g.data || [])) {
      const key = r.teach_table_id || [r.subject_id, r.section, r.teach_day, r.teach_time].join('|');
      if (!rowsByKey.has(key)) { r.__group = (g.subject_type_name_en || ''); rowsByKey.set(key, r); }
    }
    const bySub = new Map();
    for (const r of rowsByKey.values()) {
      const id = String(r.subject_id || '').trim(); if (!id) continue;
      if (!bySub.has(id)) bySub.set(id, []); bySub.get(id).push(r);
    }
    const subjects = [];
    for (const [id, rs] of bySub) {
      const bySection = new Map(rs.map(r => [String(r.section), r]));
      const seen = new Set(), units = [];
      for (const r of rs) {
        if (seen.has(r)) continue;
        const group = [r]; seen.add(r); const stack = [r];
        while (stack.length) {
          const cur = stack.pop(); const ps = cur.sec_pair != null ? String(cur.sec_pair) : null;
          if (ps && bySection.has(ps)) { const p = bySection.get(ps); if (!seen.has(p)) { seen.add(p); group.push(p); stack.push(p); } }
        }
        units.push(group);
      }
      const name = rs[0].subject_name_en || rs[0].subject_name_th || '';
      const nameTh = rs[0].subject_name_th || '';
      const credits = parseFloat(rs[0].credit) || (parseFloat(rs[0].credit_str) || null);
      const condition = stripDivs(rs[0].rules_en || rs[0].rules_th || '');
      const group = rs[0].__group || '';
      const sections = units.map(grp => {
        const lec = grp.find(x => x.lect_or_prac === 'ท') || grp[0];
        const meetings = []; const types = new Set(); let room = '', building = '', seats = null, closed = false;
        for (const x of grp) {
          if (String(x.closed) === '1') closed = true;
          types.add(x.lect_or_prac === 'ป' ? 'Lab' : (x.lect_or_prac === 'ท' ? 'Lecture' : (x.lect_or_prac || '')));
          for (const mt of apiRowMeetings(x)) meetings.push(mt);
          if (!room && (x.room_no || x.classroom)) { room = x.room_no || x.classroom; building = x.building_no || x.classbuilding || ''; }
          if (seats == null && (x.count != null || x.limit != null)) seats = `${x.count}/${x.limit}`;
        }
        const others = grp.filter(x => x !== lec).map(x => x.section);
        return {
          sec: others.length ? `${lec.section}+${others.join('/')}` : String(grp[0].section),
          meetings, exams: apiRowExams(lec), room, building, seats,
          kind: [...types].filter(Boolean).join('+'), closed, remark: String(lec.remark || '')
        };
      });
      subjects.push({ id, name, nameTh, credits, condition, group, sections });
    }
    return subjects;
  }

  /* ============================================================
   *  Solver — DP / backtracking over subjects, enumerating EVERY
   *  maximum-size selection of mutually non-conflicting sections.
   *  best(i,chosen)=max{ best(i+1,chosen),  1+best(i+1,chosen∪{sec}) ∀ compatible sec }
   * ============================================================ */
  function solve(subjects, MAXPLANS = 500) {
    const n = subjects.length; let best = 0, plans = [], nodes = 0;
    const chosen = [];
    const compatible = (sec) => { for (const c of chosen) if (sectionsConflict(c.sec, sec)) return false; return true; };
    (function rec(i, count) {
      nodes++;
      if (i === n) {
        if (count > best) { best = count; plans = count > 0 ? [chosen.slice()] : []; }
        else if (count === best && count > 0 && plans.length < MAXPLANS) plans.push(chosen.slice());
        return;
      }
      if (count + (n - i) < best) return;                       // branch & bound prune
      for (const sec of subjects[i].sections) if (compatible(sec)) { chosen.push({ si: i, sec }); rec(i + 1, count + 1); chosen.pop(); }
      rec(i + 1, count);                                        // skip subject i
    })(0, 0);
    return { best, plans, nodes, truncated: plans.length >= MAXPLANS };
  }

  /* ============================================================
   *  Corpus state + fetch (reads ONLY the current #/teach_table query)
   * ============================================================ */
  let CORPUS = [];                 // array of subjects (one per id), accumulated across loads
  let DATASET = new Map();         // id -> subject
  const SELECTED = [];             // ordered subject ids chosen as targets

  // The query string from the current #/teach_table route, or null if not on one.
  function teachTableQuery() {
    const m = (location.hash || '').match(/#\/?teach_table\?(.+)$/);
    return m ? m[1] : null;
  }
  // A short human label for the view the query points at.
  function viewLabel(q) {
    if (!q) return null;
    const p = new URLSearchParams(q);
    const bits = [];
    if (p.get('selected_year')) bits.push(p.get('selected_year') + '/' + (p.get('selected_semester') || '?'));
    if (p.get('selected_faculty')) bits.push('fac ' + p.get('selected_faculty'));
    if (p.get('selected_curriculum') && p.get('selected_curriculum') !== 'x') bits.push('curr ' + p.get('selected_curriculum'));
    if (p.get('selected_class_year') && p.get('selected_class_year') !== '0') bits.push('yr ' + p.get('selected_class_year'));
    if (p.get('search_all_curriculum') === 'true') bits.push('all curr');
    if (p.get('search_all_faculty') === 'true') bits.push('all fac');
    return bits.join(' · ') || 'teach_table view';
  }

  function mergeSubjects(subs) {
    for (const s of subs) {
      if (!DATASET.has(s.id)) { DATASET.set(s.id, s); continue; }
      const t = DATASET.get(s.id);                       // merge sections by signature
      const seen = new Set(t.sections.map(x => x.sec + '|' + JSON.stringify(x.meetings)));
      for (const sec of s.sections) { const k = sec.sec + '|' + JSON.stringify(sec.meetings); if (!seen.has(k)) { t.sections.push(sec); seen.add(k); } }
      if (!t.name && s.name) t.name = s.name;
    }
    CORPUS = [...DATASET.values()];
  }

  // Fetch exactly what this teach_table view would request, and merge it in.
  async function loadFromPage() {
    const q = teachTableQuery();
    if (!q) throw new Error('Open a #/teach_table view first.');
    const r = await fetch('/api/?function=get-teach-table-show&' + q, { headers: { Accept: 'application/json' }, credentials: 'include' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    const subs = normalizeRawApi(j);
    mergeSubjects(subs);
    return subs.length;
  }

  function searchSubjects(q) {
    q = q.trim().toLowerCase(); if (!q) return [];
    const words = q.split(/\s+/);
    const res = [];
    for (const s of CORPUS) {
      const id = s.id.toLowerCase(), nm = (s.name || '').toLowerCase(), nmTh = (s.nameTh || '').toLowerCase();
      let score = -1;
      if (id === q) score = 100;
      else if (id.startsWith(q)) score = 92;
      else if (id.includes(q)) score = 72;
      if (nm.startsWith(q)) score = Math.max(score, 88);
      else if (nm.includes(q)) score = Math.max(score, 64);
      if (nmTh.includes(q)) score = Math.max(score, 62);
      if (score < 0 && words.length > 1 && words.every(w => nm.includes(w) || nmTh.includes(w))) score = 50;
      if (score >= 0) res.push({ s, score });
    }
    res.sort((a, b) => b.score - a.score || (a.s.name || '').length - (b.s.name || '').length);
    return res.slice(0, 14).map(r => r.s);
  }

  /* ============================================================
   *  UI (Shadow DOM)
   * ============================================================ */
  // tiny hyperscript
  function h(tag, props, ...kids) {
    const e = document.createElement(tag);
    if (props) for (const k in props) {
      if (k === 'class') e.className = props[k];
      else if (k === 'html') e.innerHTML = props[k];
      else if (k === 'style' && typeof props[k] === 'object') Object.assign(e.style, props[k]);
      else if (k.startsWith('on') && typeof props[k] === 'function') e.addEventListener(k.slice(2), props[k]);
      else if (props[k] != null) e.setAttribute(k, props[k]);
    }
    for (const c of kids.flat()) { if (c == null) continue; e.append(c.nodeType ? c : document.createTextNode(String(c))); }
    return e;
  }
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const host = document.createElement('div');
  host.id = 'kmitl-solver-host';
  host.style.cssText = 'all:initial;position:fixed;z-index:2147483647;';
  document.documentElement.appendChild(host);
  const root = host.attachShadow({ mode: 'open' });

  // load a web font (best-effort; falls back to system stack)
  try {
    const fl = document.createElement('link');
    fl.rel = 'stylesheet';
    fl.href = 'https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=IBM+Plex+Sans+Thai:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500;600&display=swap';
    document.head.appendChild(fl);
  } catch (e) { /* ignore */ }

  root.appendChild(h('style', { html: STYLES() }));

  // ---- launcher ----
  const launcher = h('button', { class: 'launch', title: 'Section Solver', onclick: togglePanel }, '⌖ Solver');
  root.appendChild(launcher);

  // ---- dimmed backdrop (click to collapse) ----
  const backdrop = h('div', { class: 'backdrop', onclick: () => setOpen(false) });
  root.appendChild(backdrop);

  // ---- panel skeleton ----
  const els = {};
  const panel = h('div', { class: 'panel' },
    h('div', { class: 'phead' },
      h('div', { class: 'ttl' }, h('span', { class: 'dot' }), 'Section Solver'),
      els.fsBtn = h('button', { class: 'x fs', title: 'Toggle full width', onclick: toggleFull }, '⤢'),
      h('button', { class: 'x', title: 'Collapse', onclick: () => setOpen(false) }, '✕')
    ),
    h('div', { class: 'pbody' },
      // data source — reads ONLY the current teach_table query, on demand
      h('div', { class: 'source' },
        h('div', { class: 'srow' },
          h('div', { class: 'svue' }, 'Current view: ', els.view = h('span', { class: 'vlabel' }, '—')),
          els.loadBtn = h('button', { class: 'btn sm', onclick: () => doLoad() }, 'Load this view')
        ),
        h('div', { class: 'srow2' },
          els.loaded = h('span', { class: 'muted small' }, '0 subjects loaded'),
          h('button', { class: 'btn ghost sm', onclick: clearLoaded }, 'Clear loaded')
        )
      ),
      els.status = h('div', { class: 'status' }, ''),

      // search
      h('label', { class: 'lbl' }, 'Add subjects', h('span', { class: 'muted' }, ' — type a name or ID')),
      h('div', { class: 'searchwrap' },
        els.search = h('input', { class: 'in search', placeholder: 'e.g. data structure, calculus, 01006…', autocomplete: 'off' }),
        els.drop = h('div', { class: 'drop hidden' })
      ),
      els.chips = h('div', { class: 'chips' }),

      h('div', { class: 'row' },
        els.solve = h('button', { class: 'btn go', onclick: doSolve }, 'Find every optimal plan →'),
        h('button', { class: 'btn ghost', onclick: clearAll }, 'Clear targets')
      ),
      els.results = h('div', { class: 'results' })
    )
  );
  root.appendChild(panel);

  /* ---- panel behaviour ---- */
  let opened = false;
  function setOpen(v) {
    opened = v;
    panel.classList.toggle('open', v);
    backdrop.classList.toggle('open', v);
    launcher.classList.toggle('hide', v);
    if (v) refreshSource();
  }
  function togglePanel() { setOpen(!opened); }
  function toggleFull() { panel.classList.toggle('full'); els.fsBtn.textContent = panel.classList.contains('full') ? '⤡' : '⤢'; }
  window.addEventListener('keydown', e => { if (e.key === 'Escape' && opened) setOpen(false); });

  // reflect the current teach_table view + how much is loaded
  function refreshSource() {
    const q = teachTableQuery();
    els.view.textContent = q ? viewLabel(q) : 'not a teach_table page';
    els.loadBtn.disabled = !q;
    els.loadBtn.classList.toggle('disabled', !q);
    els.loaded.textContent = CORPUS.length + ' subject' + (CORPUS.length === 1 ? '' : 's') + ' loaded';
  }

  async function doLoad() {
    const q = teachTableQuery();
    if (!q) { setStatus('Navigate to a #/teach_table view, then press Load.', 'bad'); return; }
    setStatus('Loading this view…', '');
    els.loadBtn.disabled = true;
    try {
      const n = await loadFromPage();
      setStatus(`Added ${n} subject(s) from ${viewLabel(q)}. Search and select below.`, 'ok');
    } catch (e) {
      setStatus('Could not load (' + e.message + '). Make sure you are logged in on regis.', 'bad');
    } finally {
      refreshSource();
    }
  }
  function clearLoaded() { CORPUS = []; DATASET = new Map(); refreshSource(); setStatus('Cleared loaded subjects.', ''); }
  function setStatus(msg, cls) { els.status.className = 'status' + (cls ? ' ' + cls : ''); els.status.textContent = msg; }

  /* ---- search dropdown ---- */
  let activeIdx = -1, currentHits = [];
  els.search.addEventListener('input', renderDrop);
  els.search.addEventListener('focus', renderDrop);
  els.search.addEventListener('keydown', e => {
    if (els.drop.classList.contains('hidden')) return;
    if (e.key === 'ArrowDown') { activeIdx = Math.min(activeIdx + 1, currentHits.length - 1); paintActive(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { activeIdx = Math.max(activeIdx - 1, 0); paintActive(); e.preventDefault(); }
    else if (e.key === 'Enter') { const pick = currentHits[activeIdx < 0 ? 0 : activeIdx]; if (pick) addSubject(pick.id); e.preventDefault(); }
    else if (e.key === 'Escape') { hideDrop(); }
  });
  document.addEventListener('click', e => { if (!host.contains(e.target)) hideDrop(); });

  function renderDrop() {
    const q = els.search.value;
    currentHits = searchSubjects(q); activeIdx = -1;
    els.drop.innerHTML = '';
    if (!q.trim()) { hideDrop(); return; }
    if (!currentHits.length) {
      els.drop.appendChild(h('div', { class: 'nohit' }, CORPUS.length ? 'No match in loaded subjects.' : 'No subjects loaded yet — press “Load this view”.'));
    } else {
      currentHits.forEach((s, i) => {
        const restricted = /Only |เฉพาะ/i.test(s.condition || '');
        els.drop.appendChild(h('div', { class: 'opt', 'data-i': i, onclick: () => addSubject(s.id) },
          h('div', { class: 'oname' }, s.name || s.nameTh || '(no name)'),
          h('div', { class: 'ometa' },
            h('span', { class: 'oid' }, s.id),
            h('span', null, (s.credits != null ? s.credits + ' cr · ' : '') + s.sections.length + ' sec' + (s.sections.length !== 1 ? 's' : '')),
            restricted ? h('span', { class: 'orestrict' }, 'restricted') : null
          )
        ));
      });
    }
    els.drop.classList.remove('hidden');
  }
  function paintActive() { [...els.drop.querySelectorAll('.opt')].forEach((o, i) => o.classList.toggle('active', i === activeIdx)); }
  function hideDrop() { els.drop.classList.add('hidden'); activeIdx = -1; }

  function addSubject(id) {
    if (!SELECTED.includes(id)) SELECTED.push(id);
    els.search.value = ''; hideDrop(); els.search.focus();
    renderChips();
  }
  function removeSubject(id) { const i = SELECTED.indexOf(id); if (i >= 0) SELECTED.splice(i, 1); renderChips(); }
  function clearAll() { SELECTED.length = 0; renderChips(); els.results.innerHTML = ''; }

  function renderChips() {
    els.chips.innerHTML = '';
    if (!SELECTED.length) { els.chips.appendChild(h('div', { class: 'muted small' }, 'No subjects selected yet.')); return; }
    SELECTED.forEach((id, i) => {
      const s = DATASET.get(id);
      els.chips.appendChild(h('div', { class: 'chip', style: { '--c': COLORS[i % COLORS.length] } },
        h('span', { class: 'cid' }, id),
        h('span', { class: 'cnm' }, s ? (s.name || s.nameTh || '') : '(not in scope)'),
        h('button', { class: 'crm', title: 'remove', onclick: () => removeSubject(id) }, '✕')
      ));
    });
  }

  /* ============================================================
   *  Results rendering
   * ============================================================ */
  function doSolve() {
    if (!SELECTED.length) { setStatus('Add at least one subject to solve.', 'bad'); return; }
    renderResults(SELECTED.slice());
    if (els.results.scrollIntoView) els.results.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function renderResults(targets) {
    const out = els.results; out.innerHTML = '';
    let closedCount = 0;
    const subs = targets.map(id => DATASET.get(id)).filter(Boolean).map(s => {
      const open = s.sections.filter(x => { if (x.closed) { closedCount++; return false; } return true; });
      return Object.assign({}, s, { sections: open });
    });
    const offered = subs.filter(s => s.sections.length > 0);
    const notOffered = subs.filter(s => s.sections.length === 0).map(s => s.id);
    const missing = targets.filter(id => !DATASET.has(id));
    const colorOf = {}; targets.forEach((id, i) => colorOf[id] = COLORS[i % COLORS.length]);

    const res = solve(offered);

    const sum = h('div', { class: 'summary' });
    const cell = (k, v, cls) => sum.appendChild(h('div', { class: 'cell' }, h('div', { class: 'k' }, k), h('div', { class: 'v ' + (cls || '') , html: v })));
    cell('Targets', String(targets.length));
    cell('With sections', String(offered.length), 'blue');
    cell('Max', res.best + ' <small>subj</small>', 'accent');
    cell('Optimal plans', String(res.plans.length) + (res.truncated ? '+' : ''));
    out.appendChild(sum);

    if (missing.length) out.appendChild(banner('bad', 'Not in loaded scope: <b>' + missing.map(esc).join(', ') + '</b> — widen scope and reload.'));
    if (notOffered.length) out.appendChild(banner('warn', 'No open sections this term: <b>' + notOffered.map(esc).join(', ') + '</b>'));
    if (closedCount) out.appendChild(banner('info', closedCount + ' closed section(s) were skipped.'));
    const restricted = offered.filter(s => /Only |เฉพาะ/i.test(s.condition || ''));
    if (restricted.length) out.appendChild(banner('info', 'Has enrolment conditions — confirm eligibility: ' + restricted.map(s => '<b>' + esc(s.id) + '</b>').join(', ')));
    if (res.truncated) out.appendChild(banner('info', 'Showing first ' + res.plans.length + ' optimal plans (more exist).'));
    if (res.best === 0) { out.appendChild(banner('info', 'No registrable subjects in this selection.')); return; }
    if (res.best < offered.length) out.appendChild(banner('warn', 'At most <b>' + res.best + '</b> of these ' + offered.length + ' fit together; the rest collide in every combination.'));

    res.plans.forEach((plan, pi) => out.appendChild(renderPlan(plan, offered, pi, colorOf, res.plans.length)));
  }
  function banner(type, html) { return h('div', { class: 'banner ' + type, html }); }

  function renderPlan(plan, offered, pi, colorOf, total) {
    const inc = plan.map(c => offered[c.si]);
    let creds = 0; inc.forEach(s => { const n = parseFloat(s.credits); if (!isNaN(n)) creds += n; });
    const card = h('div', { class: 'plan' },
      h('div', { class: 'pbar' },
        h('span', { class: 'tag' }, 'PLAN ' + (pi + 1) + '/' + total),
        h('span', { class: 'pb-n' }, inc.length + ' subjects'),
        h('span', { class: 'sp' }),
        h('span', { class: 'pb-m' }, (creds ? creds + ' cr · ' : '') + 'no clashes')
      ),
      buildTimetable(plan, offered, colorOf)
    );
    // table
    const tbl = h('table', { class: 'dt' },
      h('thead', null, h('tr', null, h('th', null, 'Subject'), h('th', null, 'Sec'), h('th', null, 'Class meetings'), h('th', null, 'Exams'))),
    );
    const tb = h('tbody');
    plan.forEach(c => {
      const s = offered[c.si], col = colorOf[s.id];
      const meet = c.sec.meetings.length
        ? c.sec.meetings.map(m => `${DAY_TH[m.dayIdx]} ${fmtMin(m.s)}–${fmtMin(m.e)}${m.type ? ' (' + esc(m.type) + ')' : ''}`).join('<br>')
        : '<span class="muted">—</span>';
      const exam = c.sec.exams.length
        ? c.sec.exams.map(x => `${esc(x.kind)}: ${esc(x.date)}${x.s != null ? ' ' + fmtMin(x.s) + '–' + fmtMin(x.e) : ''}`).join('<br>')
        : '<span class="muted">none set</span>';
      const loc = [c.sec.room, c.sec.building].filter(Boolean).join(' · ');
      const extra = [c.sec.kind, loc, c.sec.seats ? 'seats ' + c.sec.seats : ''].filter(Boolean).map(esc).join('<br>');
      tb.appendChild(h('tr', null,
        h('td', { html: `<span class="sw" style="background:${col}"></span><span class="sid">${esc(s.id)}</span><br><span class="snm">${esc(s.name || '')}</span>` }),
        h('td', { html: `<span class="sec">${esc(c.sec.sec)}</span>${extra ? '<br><span class="xtra">' + extra + '</span>' : ''}` }),
        h('td', { class: 'when', html: meet }),
        h('td', { class: 'exam', html: exam })
      ));
    });
    tbl.appendChild(tb);
    card.appendChild(h('div', { class: 'tblwrap' }, tbl));

    const incIds = new Set(inc.map(s => s.id));
    const left = offered.filter(s => !incIds.has(s.id)).map(s => s.id);
    if (left.length) card.appendChild(h('div', { class: 'leftout' }, 'Left out of this plan: ' + left.map(esc).join(', ')));
    return card;
  }

  function buildTimetable(plan, offered, colorOf) {
    let minM = 8 * 60, maxM = 18 * 60; const used = new Set(); const items = [];
    plan.forEach(c => {
      const s = offered[c.si];
      c.sec.meetings.forEach(m => { used.add(m.dayIdx); minM = Math.min(minM, m.s); maxM = Math.max(maxM, m.e); items.push({ m, id: s.id, sec: c.sec.sec, col: colorOf[s.id] }); });
    });
    minM = Math.floor(minM / 60) * 60; maxM = Math.ceil(maxM / 60) * 60; if (maxM <= minM) maxM = minM + 60;
    const days = used.size ? [...used] : [0, 1, 2, 3, 4];
    const cols = [...new Set([0, 1, 2, 3, 4, ...days])].sort((a, b) => a - b);
    const PXH = 42, H = (maxM - minM) / 60 * PXH;

    const tt = h('div', { class: 'tt' }); tt.style.setProperty('--cols', cols.length);
    tt.appendChild(h('div', { class: 'corner' }));
    cols.forEach(d => tt.appendChild(h('div', { class: 'dhdr' }, DAY_EN[d])));
    const axis = h('div', { class: 'axis', style: { height: H + 'px' } });
    for (let t = minM; t <= maxM; t += 60) axis.appendChild(h('div', { class: 'tlab', style: { top: ((t - minM) / 60 * PXH) + 'px' } }, fmtMin(t)));
    tt.appendChild(axis);
    const byDay = {};
    cols.forEach(d => {
      const col = h('div', { class: 'col', style: { height: H + 'px' } });
      for (let t = minM; t <= maxM; t += 60) col.appendChild(h('div', { class: 'hr', style: { top: ((t - minM) / 60 * PXH) + 'px' } }));
      tt.appendChild(col); byDay[d] = col;
    });
    items.forEach(it => {
      const col = byDay[it.m.dayIdx]; if (!col) return;
      col.appendChild(h('div', {
        class: 'blk',
        style: { background: it.col, top: ((it.m.s - minM) / 60 * PXH) + 'px', height: Math.max(16, ((it.m.e - it.m.s) / 60 * PXH) - 2) + 'px' },
        html: `<span class="bid">${esc(it.id)}</span><span class="bsec">${esc(it.sec)} · ${fmtMin(it.m.s)}</span>`
      }));
    });
    return h('div', { class: 'ttwrap' }, tt);
  }

  /* ---- init ---- */
  renderChips();
  refreshSource();
  window.addEventListener('hashchange', () => { if (opened) refreshSource(); });   // keep the view hint current

  /* ============================================================
   *  Styles (scoped to shadow root)
   * ============================================================ */
  function STYLES() {
    return `
:host, * { box-sizing: border-box; }
:host {
  --ink:#15183a; --paper:#eef0f4; --card:#fff; --accent:#e8843b; --blue:#2f6f8f;
  --conflict:#d1495b; --ok:#2e7d57; --muted:#6b7280; --line:#d4d9e2; --line-soft:#e6e9ef;
  --mono:'IBM Plex Mono',ui-monospace,monospace;
  --body:'IBM Plex Sans Thai',system-ui,-apple-system,sans-serif;
  --disp:'Space Grotesk','IBM Plex Sans Thai',sans-serif;
}
button { font-family:var(--disp); cursor:pointer; }
.muted{ color:var(--muted); } .small{ font-size:12px; }

.launch{
  position:fixed; right:18px; bottom:18px; z-index:9;
  font-weight:600; font-size:13.5px; color:#fff; background:var(--ink);
  border:1.5px solid var(--ink); border-radius:999px; padding:10px 16px;
  box-shadow:0 6px 22px rgba(21,24,58,.28); transition:opacity .2s ease, transform .2s ease;
}
.launch:hover{ background:#23264f; }
.launch.hide{ opacity:0; transform:translateY(8px) scale(.96); pointer-events:none; }

.backdrop{
  position:fixed; inset:0; z-index:10; background:rgba(10,12,30,.5);
  opacity:0; pointer-events:none; transition:opacity .26s ease; backdrop-filter:blur(1px);
}
.backdrop.open{ opacity:1; pointer-events:auto; }

.panel{
  position:fixed; left:50%; top:50%; z-index:11;
  width:33.333vw; max-height:calc(100vh - 48px);   /* ~24px gap top & bottom */
  background:var(--paper); border:1.5px solid var(--ink);
  box-shadow:0 24px 70px rgba(21,24,58,.34); display:flex; flex-direction:column;
  font-family:var(--body); color:var(--ink);
  transform:translate(-50%,-48%) scale(.98); opacity:0; pointer-events:none;
  transition:opacity .24s ease, transform .26s cubic-bezier(.4,0,.2,1), width .25s ease;
}
.panel.open{ transform:translate(-50%,-50%) scale(1); opacity:1; pointer-events:auto; }
.panel.full{ width:calc(100vw - 48px); }
.phead .fs{ font-size:14px; margin-right:2px; }
@media (prefers-reduced-motion:reduce){ .panel,.backdrop,.launch{ transition:none; } }
.phead{ display:flex; align-items:center; gap:10px; padding:14px 16px; background:var(--ink); color:#fff; }
.phead .ttl{ font-family:var(--disp); font-weight:700; font-size:16px; flex:1; display:flex; align-items:center; gap:8px; }
.phead .dot{ width:10px; height:10px; background:var(--accent); border-radius:2px; display:inline-block; }
.phead .x{ background:none; border:none; color:#aeb4d6; font-size:16px; }
.phead .x:hover{ color:#fff; }
.pbody{ padding:14px 16px 40px; overflow-y:auto; flex:1; }

.lbl{ display:block; font-weight:600; font-size:13px; margin:14px 0 6px; }
.in{ width:100%; font-family:var(--mono); font-size:13px; color:var(--ink);
  border:1.5px solid var(--line); background:#fbfcfe; padding:9px 11px; }
.in:focus{ outline:none; border-color:var(--blue); }
.mono{ font-family:var(--mono); }
.row{ display:flex; gap:8px; flex-wrap:wrap; margin-top:12px; align-items:center; }
.btn{ font-weight:600; font-size:13px; border:1.5px solid var(--ink); background:var(--card); color:var(--ink); padding:9px 14px; }
.btn:hover{ background:var(--paper); }
.btn.go{ background:var(--accent); border-color:var(--accent); color:#fff; }
.btn.go:hover{ background:#d9742c; }
.btn.ghost{ border-color:var(--line); color:var(--muted); }

.source{ border:1px solid var(--line); background:var(--card); padding:9px 11px; margin-bottom:6px; }
.srow{ display:flex; align-items:center; gap:8px; }
.srow .svue{ flex:1; font-size:12.5px; color:#3b3f5c; }
.srow .vlabel{ font-family:var(--mono); font-weight:600; color:var(--ink); }
.srow2{ display:flex; align-items:center; justify-content:space-between; margin-top:7px; }
.btn.sm{ font-size:11.5px; padding:5px 10px; }
.btn.disabled, .btn:disabled{ opacity:.45; cursor:not-allowed; }

.status{ font-family:var(--mono); font-size:11.5px; color:var(--muted); margin:6px 0 4px; }
.status.ok{ color:var(--ok); } .status.bad{ color:var(--conflict); }

.searchwrap{ position:relative; }
.search{ font-family:var(--body); }
.drop{ position:absolute; left:0; right:0; top:calc(100% + 4px); z-index:6; background:var(--card);
  border:1.5px solid var(--ink); max-height:320px; overflow-y:auto; box-shadow:0 10px 30px rgba(21,24,58,.2); }
.drop.hidden{ display:none; }
.opt{ padding:8px 11px; border-bottom:1px solid var(--line-soft); cursor:pointer; }
.opt:last-child{ border-bottom:none; }
.opt:hover, .opt.active{ background:#f3f6fb; }
.oname{ font-size:13px; font-weight:600; line-height:1.25; }
.ometa{ display:flex; gap:8px; align-items:center; font-family:var(--mono); font-size:10.5px; color:var(--muted); margin-top:2px; }
.ometa .oid{ color:var(--blue); font-weight:600; }
.orestrict{ color:var(--accent); border:1px solid var(--accent); border-radius:3px; padding:0 4px; }
.nohit{ padding:10px 12px; font-size:12.5px; color:var(--muted); }

.chips{ display:flex; flex-wrap:wrap; gap:7px; margin-top:10px; }
.chip{ display:inline-flex; align-items:center; gap:7px; background:var(--card); border:1.5px solid var(--line);
  border-left:4px solid var(--c); padding:5px 7px 5px 9px; max-width:100%; }
.chip .cid{ font-family:var(--mono); font-weight:600; font-size:11.5px; }
.chip .cnm{ font-size:11.5px; color:#3b3f5c; max-width:200px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.chip .crm{ background:none; border:none; color:var(--muted); font-size:12px; padding:0 2px; }
.chip .crm:hover{ color:var(--conflict); }

.results{ margin-top:14px; }
.summary{ display:grid; grid-template-columns:repeat(4,1fr); gap:1px; background:var(--line); border:1.5px solid var(--ink); }
.summary .cell{ background:var(--card); padding:9px 10px; }
.summary .k{ font-family:var(--mono); font-size:9.5px; letter-spacing:.08em; text-transform:uppercase; color:var(--muted); }
.summary .v{ font-family:var(--disp); font-size:22px; font-weight:700; line-height:1.1; }
.summary .v.accent{ color:var(--accent); } .summary .v.blue{ color:var(--blue); } .summary .v small{ font-size:11px; color:var(--muted); font-weight:500; }

.banner{ margin-top:10px; padding:9px 11px; border:1.5px solid; font-size:12.5px; }
.banner.warn{ border-color:var(--accent); background:#fdf3ea; }
.banner.bad{ border-color:var(--conflict); background:#fbecef; }
.banner.info{ border-color:var(--line); background:#f4f6f9; color:#3b3f5c; }

.plan{ border:1.5px solid var(--ink); background:var(--card); margin-top:14px; }
.pbar{ display:flex; align-items:center; gap:9px; padding:9px 12px; background:var(--ink); color:#fff; font-family:var(--disp); font-weight:600; font-size:13px; }
.pbar .tag{ font-family:var(--mono); font-size:10px; background:var(--accent); padding:2px 7px; }
.pbar .sp{ flex:1; } .pbar .pb-m{ font-family:var(--mono); font-size:11px; color:#aeb4d6; font-weight:400; }

.ttwrap{ overflow-x:auto; padding:12px 12px 2px; }
.tt{ display:grid; grid-template-columns:40px repeat(var(--cols,6),minmax(58px,1fr)); min-width:100%; }
.dhdr{ font-family:var(--disp); font-weight:600; font-size:11px; text-align:center; padding-bottom:5px; border-bottom:1px solid var(--line); }
.axis{ position:relative; } .col{ position:relative; border-left:1px solid var(--line-soft); }
.col:last-child{ border-right:1px solid var(--line-soft); }
.hr{ position:absolute; left:0; right:0; border-top:1px dashed var(--line-soft); }
.tlab{ position:absolute; left:0; transform:translateY(-50%); font-family:var(--mono); font-size:9px; color:var(--muted); }
.blk{ position:absolute; left:2px; right:2px; border-radius:3px; padding:3px 4px; overflow:hidden; color:#fff;
  font-size:9.5px; line-height:1.2; border:1px solid rgba(0,0,0,.15); display:flex; flex-direction:column; }
.blk .bid{ font-family:var(--mono); font-weight:600; } .blk .bsec{ opacity:.92; }

.tblwrap{ overflow-x:auto; padding:4px 12px 14px; }
table.dt{ width:100%; border-collapse:collapse; font-size:12px; }
table.dt th, table.dt td{ border-top:1px solid var(--line); padding:7px 8px; text-align:left; vertical-align:top; }
table.dt thead th{ background:#f4f6f9; font-family:var(--mono); font-size:10px; letter-spacing:.04em; text-transform:uppercase; color:var(--muted); border-top:none; }
table.dt .sid{ font-family:var(--mono); font-weight:600; } .snm{ color:#3b3f5c; }
table.dt .sw{ display:inline-block; width:9px; height:9px; border-radius:2px; margin-right:5px; }
table.dt .sec{ font-family:var(--mono); background:var(--paper); padding:1px 6px; border:1px solid var(--line); }
table.dt .xtra{ color:var(--muted); font-size:10.5px; font-family:var(--mono); }
table.dt .when{ font-family:var(--mono); color:#3b3f5c; } table.dt .exam{ font-family:var(--mono); font-size:11px; color:var(--blue); }
.leftout{ font-size:11.5px; color:var(--muted); padding:0 12px 12px; }

/* 1/3 width only has room on wide screens; go full-width below */
@media (max-width:1000px){ .panel{ width:calc(100vw - 32px); } .panel.full{ width:calc(100vw - 16px); } }
@media (max-width:520px){ .panel{ width:calc(100vw - 16px); max-height:calc(100vh - 24px); } .summary{ grid-template-columns:repeat(2,1fr); } }
`;
  }
})();