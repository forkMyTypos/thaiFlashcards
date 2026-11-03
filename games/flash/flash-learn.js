/* Flash the Cat - the learning engine behind the word card.
 *
 * Dan: "the focus should be on, can the user recall the word, memory test,
 * not whether the user can find the word." One question at a time; each word
 * climbs steps on its own, separately in each direction, and comes back at
 * growing gaps, inside a session (counted in questions) and between sessions
 * (counted in days).
 *
 *   steps   0 meet     Thai + sound + romanization + meaning, one answer
 *           1 pick 2   two answers
 *           2 pick 4   four answers, the wrong ones from words already met
 *           3 recall   no answers: think, reveal, "I knew it" / "Not yet"
 *   dirs    th  Thai -> meaning
 *           en  meaning -> Thai        (starts once th reaches pick 4)
 *           au  sound only -> meaning  (starts once th reaches recall; words with a recording)
 *   boxes   reaching recall starts the day schedule: 1, 3, 7, 16, 35 days.
 *           Right when due = the next box; wrong = box 1 and back to pick 4.
 *
 * What a word's label means (per direction), never one made-up score:
 *   met         seen at least once
 *   recognises  answered right with 4 choices
 *   recalls     "I knew it" with no choices
 *   learned     recalled on two occasions at least learned_gap_h apart, latest answer right
 *   longterm    learned, and passed a review after a gap of 7 days or more
 *
 * The numbers are starting values to tune (Game settings), not science.
 * Pure logic: runs in the browser (window.FlashLearn) and in Node for tests.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.FlashLearn = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  const HOUR = 36e5, DAY = 24 * HOUR;
  const DEF = {
    meet_reps: 3,            // meetings before the first choice
    pick2_right: 2,          // right answers to leave pick of 2
    pick4_right: 2,          // right answers to leave pick of 4
    gaps: [2, 5, 10, 20],    // questions in between, after the 1st, 2nd, ... right answer this session
    meet_gap: 2,
    wrong_gap: 2,            // a wrong answer comes back after this many other questions
    max_new: 3,              // words in their first steps (meet / pick 2) at once
    max_new_good: 4,         // ... when the learner is doing very well
    low_acc: 0.7, high_acc: 0.9, acc_window: 10, acc_min: 5,
    slow_ms: 8000,           // a right answer slower than this doesn't move the word up
    box_days: [1, 3, 7, 16, 35],
    learned_gap_h: 20,
    longterm_box: 4,         // passed the 7-day review
    session_cap: 8,          // questions per word per direction per session, at most
    ready_share: 0.8,        // "next level" once this share of the level's words recognise
    reverse_from_step: 2, audio_from_step: 3,
    reverse: true, audio: true,
  };
  const DIRS = ["th", "en", "au"];
  const WORD_EXTRAS = ["img", "ch", "hook", "aid", "tones", "slow", "tone", "pos", "gender", "sents"];
  const LABELS = ["new", "met", "recognises", "recalls", "learned", "longterm"];
  const norm = t => String(t || "").replace(/\s*[\[(][^\])]*[\])]/g, "").split(/;|\s\/\s/)[0].replace(/\s*[\[(].*$/, "").split(/,\s*/)[0].trim().toLowerCase();
  const shuffle = (a, rnd) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

  // ------------------------------------------------------------ storage
  // Every store: load() -> { items, words }, putItems([...]), putWords([...]), log(attempt)
  function memStore() {
    const items = {}, words = {}, attempts = [];
    return {
      kind: "memory",
      load: async () => ({ items: Object.values(items), words: Object.values(words) }),
      putItems: list => { for (const i of list) items[i.k] = i; },
      putWords: list => { for (const w of list) words[w.id] = w; },
      log: a => { attempts.push(a); },
      attempts: async () => attempts.slice(),
    };
  }
  function lsStore(key) {
    key = key || "ftc.learn";
    const read = () => { try { return JSON.parse(localStorage.getItem(key) || "{}") || {}; } catch (e) { return {}; } };
    let d = read(); d.items = d.items || {}; d.words = d.words || {}; d.att = d.att || [];
    let t = null;
    const flush = () => { t = null; if (d.att.length > 1500) d.att = d.att.slice(-1500); try { localStorage.setItem(key, JSON.stringify(d)); } catch (e) {} };
    const soon = () => { if (!t) t = setTimeout(flush, 400); };
    return {
      kind: "localStorage",
      load: async () => ({ items: Object.values(d.items), words: Object.values(d.words) }),
      putItems: list => { for (const i of list) d.items[i.k] = i; soon(); },
      putWords: list => { for (const w of list) d.words[w.id] = w; soon(); },
      log: a => { d.att.push(a); soon(); },
      attempts: async () => d.att.slice(),
      flush,
    };
  }
  function dexieStore(name) {
    if (typeof Dexie === "undefined") return null;
    let db;
    try { db = new Dexie(name || "ftc-learn"); db.version(1).stores({ items: "k, id, due", words: "id", attempts: "++n, id, at" }); }
    catch (e) { return null; }
    const pend = { items: {}, words: {}, att: [] };
    let t = null, logged = 0;
    const flush = () => {
      t = null;
      const it = Object.values(pend.items), ws = Object.values(pend.words), at = pend.att.splice(0);
      pend.items = {}; pend.words = {};
      try {
        if (it.length) db.items.bulkPut(it).catch(() => {});
        if (ws.length) db.words.bulkPut(ws).catch(() => {});
        if (at.length) db.attempts.bulkAdd(at).catch(() => {});
        // keep the attempt log from growing forever
        if ((logged += at.length) > 500) { logged = 0; db.attempts.count().then(n => n > 20000 ? db.attempts.orderBy("n").limit(n - 20000).delete() : 0).catch(() => {}); }
      } catch (e) {}
    };
    const soon = () => { if (!t) t = setTimeout(flush, 400); };
    return {
      kind: "dexie",
      load: async () => {
        const go = Promise.all([db.items.toArray(), db.words.toArray()]).then(([items, words]) => ({ items, words }));
        return Promise.race([go, new Promise((_, rej) => setTimeout(() => rej(new Error("slow")), 2500))]);
      },
      putItems: list => { for (const i of list) pend.items[i.k] = i; soon(); },
      putWords: list => { for (const w of list) pend.words[w.id] = w; soon(); },
      log: a => { pend.att.push(a); soon(); },
      attempts: () => db.attempts.toArray(),
      flush,
    };
  }

  // ------------------------------------------------------------- engine
  function create(o) {
    o = o || {};
    const S = Object.assign({}, DEF, o.settings || {});
    const now = o.now || (() => Date.now());
    const rnd = o.random || Math.random;
    let store = o.store || memStore();
    const items = {}, words = {};
    let level = { id: "", title: "", ids: [] }, pool = [];        // pool: other words, for wrong answers
    let n = 0, lastId = null, focus = "new";                         // focus: "new" (new words + review) | "review"
    const recent = [];                                               // right/wrong of recent choice/recall answers
    const KEEP = ["k", "id", "dir", "step", "streak", "seen", "right", "wrong", "box", "due", "r4", "rc", "ok", "last", "lastOk", "ms", "slow"];
    const save = it => { const x = {}; for (const f of KEEP) x[f] = it[f]; store.putItems([x]); };
    const key = (id, dir) => id + "|" + dir;

    function item(id, dir, init) {
      const k = key(id, dir);
      let it = items[k];
      if (!it && init) {
        it = items[k] = Object.assign({ k, id, dir, step: 0, streak: 0, seen: 0, right: 0, wrong: 0, box: 0, due: 0,
                                        r4: false, rc: false, ok: [], last: 0, lastOk: false, ms: 0, slow: 0 }, init);
        it.sess = 0; it.sessRight = 0; it.nextN = 0; it.retry = false; it.doneSess = false; it.active = false;
        save(it);
      }
      return it || null;
    }
    function remember(list) {
      const fresh = [];
      for (const w of list || []) {
        if (!w || !w.id || !w.th || !w.en) continue;
        const was = words[w.id], x = { id: w.id, th: w.th, rom: w.rom || "", en: w.en, audio: w.audio || (was && was.audio) || "", lesson: w.lesson || (was && was.lesson) || "" };
        // what the course card adds: picture, emoji, memory hook, tones, slow recording (kept when a later list lacks them)
        for (const f of WORD_EXTRAS) { const v = w[f] !== undefined && w[f] !== "" ? w[f] : was ? was[f] : undefined; if (v !== undefined && v !== "") x[f] = v; }
        if (!was || JSON.stringify(was) !== JSON.stringify(x)) { words[w.id] = x; fresh.push(x); }
      }
      if (fresh.length) store.putWords(fresh);
    }
    const ready = (async () => {
      try {
        const d = await store.load();
        for (const w of d.words || []) if (w && w.id) words[w.id] = w;
        for (const i of d.items || []) if (i && i.k) items[i.k] = Object.assign(i, { ok: i.ok || [], sess: 0, sessRight: 0, nextN: 0, retry: false, doneSess: false });
      } catch (e) {
        if (o.fallback) { store = o.fallback; try { const d = await store.load(); for (const w of d.words || []) words[w.id] = w; for (const i of d.items || []) items[i.k] = Object.assign(i, { ok: i.ok || [], sess: 0, sessRight: 0, nextN: 0, retry: false, doneSess: false }); } catch (e2) {} }
      }
      return true;
    })();

    // ---- labels
    function learnedIt(it) {
      if (!it || !it.lastOk || !it.ok || it.ok.length < 2) return false;
      return it.ok[it.ok.length - 1] - it.ok[0] >= S.learned_gap_h * HOUR;
    }
    function label(it) {
      if (!it) return "new";
      if (learnedIt(it)) return it.box >= S.longterm_box ? "longterm" : "learned";
      if (it.rc) return "recalls";
      if (it.r4) return "recognises";
      return it.seen || it.step ? "met" : "new";
    }
    const atLeast = (lab, want) => LABELS.indexOf(lab) >= LABELS.indexOf(want);

    // ---- choosing the next question
    const acc = () => recent.length >= S.acc_min ? recent.filter(Boolean).length / recent.length : null;
    function newLimit() {
      const a = acc();
      if (a !== null && a < S.low_acc) return 0;
      return a !== null && a >= S.high_acc ? S.max_new_good : S.max_new;
    }
    const isDue = it => it.box >= 1 && it.due && it.due <= now();
    const usable = it => it && words[it.id] && (it.dir !== "au" || words[it.id].audio);
    function learning() {           // level words in their first steps, Thai -> meaning
      let c = 0;
      for (const id of level.ids) { const it = items[key(id, "th")]; if (it && it.seen && it.step < 2) c++; }
      return c;
    }
    function nextNew() {
      for (const id of level.ids) { if (!words[id]) continue; const it = items[key(id, "th")]; if (!it || (!it.seen && !it.step)) return id; }
      return null;
    }
    function choose() {
      const all = Object.values(items).filter(usable);
      const open = it => it.nextN <= n && it.sess < S.session_cap;
      const byTurn = list => list.sort((a, b) => a.nextN - b.nextN || a.step - b.step);
      const canNew = extra => focus !== "review" && learning() < newLimit() + (extra || 0);
      const fresh = () => { const id = nextNew(); return id ? [item(id, "th", {})] : []; };
      // in order of priority; the first word that isn't the one just asked wins
      const tiers = [
        () => byTurn(all.filter(x => x.retry && open(x))),                     // answered wrong, its turn has come
        () => byTurn(all.filter(x => isDue(x) && !x.sess && open(x))),         // due from earlier sessions (the warm-up)
        () => byTurn(all.filter(x => x.active && !x.doneSess && open(x))),     // being worked on this session
        () => canNew(0) ? fresh() : [],                                          // a new word from the level
        () => byTurn(all.filter(x => isDue(x) && x.sess < S.session_cap)),     // nothing ready: the nearest turn
        () => byTurn(all.filter(x => x.active && !x.doneSess && x.sess < S.session_cap)),
        () => canNew(1) ? fresh() : [],
        // mix in words already met, the level's first (interleaving)
        () => shuffle(level.ids.map(id => items[key(id, "th")]).filter(x => x && x.seen && usable(x) && x.sess < S.session_cap), rnd),
        () => shuffle(all.filter(x => x.seen && x.sess < S.session_cap), rnd),
      ];
      let first = null;
      for (const t of tiers) {
        const list = t();
        const it = list.find(x => x.id !== lastId);
        if (it) return it;
        if (!first && list.length) first = list[0];
      }
      return first;
    }
    function choices(w, dir, count) {
      if (count <= 1) return [w];
      const sameTh = new Set([w.th]), sameEn = new Set([norm(w.en)]);
      const ok = x => x && x.id !== w.id && x.th && x.en && !sameTh.has(x.th) && !sameEn.has(norm(x.en));
      const met = x => { const it = items[key(x.id, "th")]; return it && it.seen; };
      const lv = level.ids.map(id => words[id]).filter(Boolean);
      const others = Object.values(words);
      const tiers = [
        shuffle(lv.filter(x => ok(x) && met(x)), rnd),
        shuffle(others.filter(x => ok(x) && met(x) && x.lesson === w.lesson), rnd),
        shuffle(others.filter(x => ok(x) && met(x)), rnd),
        shuffle(lv.filter(ok), rnd),
        shuffle(pool.filter(ok), rnd),
        shuffle(others.filter(ok), rnd),
      ];
      const out = [w];
      for (const t of tiers) for (const x of t) {
        if (out.length >= count) break;
        if (!ok(x)) continue;
        out.push(x); sameTh.add(x.th); sameEn.add(norm(x.en));
      }
      return shuffle(out, rnd);
    }
    function next() {
      const it = choose();
      if (!it) return null;
      const w = words[it.id];
      const kind = it.step === 0 ? "meet" : it.step >= 3 ? "recall" : "pick";
      const count = kind === "meet" ? 1 : kind === "recall" ? 0 : it.step === 1 ? 2 : 4;
      const opts = kind === "recall" ? [] : choices(w, it.dir, count);
      if (kind === "pick" && opts.length < 2) {        // not enough other words yet: meet it again instead
        return { n, k: it.k, id: it.id, dir: it.dir, step: it.step, kind: "meet", word: w, choices: [w], review: isDue(it), isNew: false, label: label(it), t: now() };
      }
      return { n, k: it.k, id: it.id, dir: it.dir, step: it.step, kind, word: w, choices: opts, review: isDue(it), isNew: !it.seen, label: label(it), t: now() };
    }

    // ---- an answer
    // res: { right: bool, ms } ; recall: right = "I knew it"
    function answer(q, res) {
      const it = items[q.k]; if (!it) return null;
      res = res || {};
      const t = now(), right = q.kind === "meet" ? true : !!res.right, ms = Math.max(0, +res.ms || 0);
      const was = { step: it.step, box: it.box, label: label(it) }, due = isDue(it);
      n++; lastId = it.id;
      it.sess++; it.seen++; it.active = true; it.last = t; it.lastOk = right;
      if (q.kind !== "meet") { recent.push(right); if (recent.length > S.acc_window) recent.shift(); it.ms = it.ms ? Math.round(it.ms * 0.7 + ms * 0.3) : ms; }
      const slow = right && q.kind === "pick" && ms > S.slow_ms;
      let gap;
      if (q.kind === "meet") {
        it.streak++;
        if (it.streak >= S.meet_reps) { it.step = 1; it.streak = 0; }
        it.retry = false; gap = S.meet_gap;
      } else if (right) {
        it.right++; it.retry = false; it.sessRight++;
        if (q.kind === "pick") {
          if (q.step >= 2 && q.choices.length >= 4) it.r4 = true;
          if (slow) it.slow++;
          else {
            it.streak++;
            const need = it.step === 1 ? S.pick2_right : S.pick4_right;
            if (it.streak >= need) { it.step++; it.streak = 0; if (it.step === 3 && !it.box) { it.box = 1; it.due = t + S.box_days[0] * DAY; } }
          }
          if (due) { it.box = Math.max(1, it.box); it.due = t + S.box_days[Math.min(S.box_days.length, it.box) - 1] * DAY; }
        } else {                                          // recall: "I knew it"
          it.rc = true; it.ok.push(t); if (it.ok.length > 6) it.ok = it.ok.slice(-6);
          it.doneSess = true;
          if (due) it.box = Math.min(S.box_days.length, it.box + 1);
          it.box = Math.max(1, it.box);
          it.due = t + S.box_days[it.box - 1] * DAY;
        }
        gap = S.gaps[Math.min(S.gaps.length - 1, it.sessRight - 1)];
      } else {
        it.wrong++; it.streak = 0; it.retry = true;
        if (q.kind === "recall") it.step = 2;
        else if (it.step === 2) it.step = 1;
        if (it.box >= 1) { it.box = 1; it.due = t + S.box_days[0] * DAY; }
        gap = S.wrong_gap;
      }
      it.nextN = n + gap;
      // the other directions open up as Thai -> meaning gets stronger, and join this session's work
      const opened = [];
      if (it.dir === "th") {
        if (S.reverse && it.step >= S.reverse_from_step && !items[key(it.id, "en")]) { const x = item(it.id, "en", { step: 1 }); x.active = true; x.nextN = n + 3; opened.push("en"); }
        if (S.audio && it.step >= S.audio_from_step && words[it.id] && words[it.id].audio && !items[key(it.id, "au")]) { const x = item(it.id, "au", { step: 2 }); x.active = true; x.nextN = n + 4; opened.push("au"); }
      }
      save(it);
      const attempt = { id: it.id, dir: it.dir, step: q.step, kind: q.kind, choices: q.choices ? q.choices.length : 0, right, ms, at: t, review: !!q.review, slow };
      try { store.log(attempt); } catch (e) {}
      return { right, slow, item: Object.assign({}, it), was, now: { step: it.step, box: it.box, label: label(it) }, opened, retryIn: it.retry ? gap : 0 };
    }

    // ---- what the level looks like
    function levelProgress() {
      const ids = level.ids.filter(id => words[id]);
      const c = { total: ids.length, met: 0, recognises: 0, recalls: 0, learned: 0, longterm: 0 };
      for (const id of ids) {
        const lab = label(items[key(id, "th")]);
        for (const L of ["met", "recognises", "recalls", "learned", "longterm"]) if (atLeast(lab, L)) c[L]++;
      }
      c.ready = c.total >= 3 && c.recognises >= Math.ceil(c.total * S.ready_share);
      c.mastered = c.total >= 3 && c.recalls >= c.total;
      return c;
    }
    function summary() {
      const out = {};
      for (const d of DIRS) out[d] = { met: 0, recognises: 0, recalls: 0, learned: 0, longterm: 0 };
      for (const it of Object.values(items)) {
        if (!words[it.id]) continue;
        const lab = label(it);
        for (const L of ["met", "recognises", "recalls", "learned", "longterm"]) if (atLeast(lab, L)) out[it.dir][L]++;
      }
      out.due = Object.values(items).filter(it => usable(it) && isDue(it)).length;
      out.words = Object.keys(words).length;
      return out;
    }

    return {
      S, ready,
      storeKind: () => store.kind,
      // the level's words, in lesson order: new words are introduced in this order
      setLevel(list, info) {
        remember(list);
        const ids = []; const seen = new Set();
        for (const w of list || []) if (w && w.id && words[w.id] && !seen.has(w.id)) { seen.add(w.id); ids.push(w.id); }
        level = { id: (info && info.id) || "", title: (info && info.title) || "", ids };
      },
      level: () => ({ id: level.id, title: level.title, ids: level.ids.slice() }),
      // other words the learner has seen on the course (wrong answers, nothing more)
      setPool(list) { pool = (list || []).filter(w => w && w.id && w.th && w.en); },
      setFocus(f) { focus = f === "review" ? "review" : "new"; },
      focus: () => focus,
      next,
      answer,
      label: (id, dir) => label(items[key(id, dir || "th")]),
      item: (id, dir) => { const it = items[key(id, dir || "th")]; return it ? Object.assign({}, it) : null; },
      items: () => Object.values(items).map(it => Object.assign({}, it)),
      word: id => words[id] || null,
      levelProgress, summary,
      // "practise these": the words come up next, as if just answered wrong
      practise(ids) {
        for (const id of ids || []) for (const d of DIRS) { const it = items[key(id, d)]; if (it && usable(it)) { it.retry = true; it.active = true; it.doneSess = false; it.nextN = n; it.sess = Math.min(it.sess, S.session_cap - 3); } }
      },
      // reviews due now, and by the end of tomorrow (local time)
      dueSoon() {
        const t = now(), end = new Date(t); end.setHours(24, 0, 0, 0); const tomorrow = end.getTime() + DAY;
        let a = 0, b = 0;
        for (const it of Object.values(items)) { if (!usable(it) || !it.box || !it.due) continue; if (it.due <= t) a++; else if (it.due <= tomorrow) b++; }
        return { now: a, tomorrow: b };
      },
      // the words that went wrong most (Thai -> meaning and meaning -> Thai together)
      hardest(k) {
        const by = {};
        for (const it of Object.values(items)) { if (!words[it.id] || !it.wrong) continue; const x = by[it.id] || (by[it.id] = { id: it.id, wrong: 0, right: 0 }); x.wrong += it.wrong; x.right += it.right; }
        return Object.values(by).sort((a, b) => (b.wrong - b.right * 0.25) - (a.wrong - a.right * 0.25)).slice(0, k || 6).map(x => Object.assign(x, { word: words[x.id] }));
      },
      // words by label, most recently answered first (the share card's examples)
      recent(want, k) {
        return Object.values(items).filter(it => it.dir === "th" && words[it.id] && atLeast(label(it), want || "recognises"))
          .sort((a, b) => b.last - a.last).slice(0, k || 6).map(it => words[it.id]);
      },
      accuracy: acc,
      count: () => n,
      attempts: () => store.attempts ? store.attempts() : Promise.resolve([]),
      flush: () => { if (store.flush) store.flush(); },
    };
  }

  return { create, memStore, lsStore, dexieStore, DEF, LABELS, DIRS, norm };
});
