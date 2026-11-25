/* Flash the Cat - renderer + column UI.
 *
 *   FlashGame.mount(divElement, { base: "./" }) -> Promise<api>
 *
 * Loads the game's data (data/*.json from Gamebase, shared/*.json from the
 * Shared library), creates the simulation (flash-sim.js) and draws it with
 * Phaser using placeholder shapes. Listens for study rewards:
 *
 *   window.dispatchEvent(new CustomEvent("inaflash:reward", { detail: { kind, source, strength, streak, word, message } }))
 *
 * and announces its own state as "inaflash:game" events.
 */
(function () {
  "use strict";
  const TYPES = ["weapons", "stats_base", "enemies", "enemy_equipment", "reward_effects", "game_settings",
                 "enemy_scaling", "spawn_curve", "enemy_mix", "elite_modifiers", "upgrades", "items",
                 "passives", "rarities", "mega_waves", "icons", "spells", "status_effects", "bosses", "boss_schedule", "shop_stock",
                 "tags", "kits", "evolutions", "locations"];
  const SHARED = ["environments", "effects"];

  const PROJ_COLOUR = { returning_projectile: 0xf3ead2, explosive_projectile: 0xff8a3a, bouncing_projectile: 0x7ee0ff,
                        piercing_projectile: 0xd8dde6, spread_projectile: 0xf0f0ff, projectile: 0xffe08a };
  const RARITY_FALLBACK = { common: "#9aa2af", uncommon: "#34c98e", rare: "#4f9cf9", epic: "#a66cff",
                            legendary: "#f5b355", mythical: "#f2705f" };

  const h = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
  const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const fmtT = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
  const hexNum = s => parseInt(String(s || "#888888").slice(1), 16);
  const announce = state => { try { window.dispatchEvent(new CustomEvent("inaflash:game", { detail: { v: 1, state } })); } catch (e) {} };

  function loadScript(src) {
    return new Promise((res, rej) => { const s = document.createElement("script"); s.src = src; s.onload = res; s.onerror = () => rej(new Error("could not load " + src)); document.head.append(s); });
  }
  async function loadJSON(url) {
    try { const r = await fetch(url, { cache: "no-store" }); return r.ok ? await r.json() : []; } catch (e) { return []; }
  }

  async function mount(el, opts) {
    opts = opts || {};
    const base = opts.base || "";
    if (!window.Phaser) await loadScript(opts.phaserUrl || base + "lib/phaser.min.js");
    if (!window.FlashSim) await loadScript(base + "flash-sim.js");
    if (!window.FlashLearn) await loadScript(base + "flash-learn.js").catch(() => {});
    if (!document.querySelector('link[data-ftc]')) {
      const l = document.createElement("link"); l.rel = "stylesheet"; l.href = base + "flash-game.css"; l.dataset.ftc = "1"; document.head.append(l);
    }
    const data = {};
    await Promise.all(TYPES.map(async t => { data[t] = await loadJSON(base + (opts.dataPath || "data/") + t + ".json"); }));
    await Promise.all(SHARED.map(async t => { data["shared_" + t] = await loadJSON(base + (opts.sharedPath || "shared/") + t + ".json"); }));

    // The arena is always 1000 units tall; its width follows the column's shape,
    // so a wider column shows more arena instead of black bars.
    let arenaEl = null;
    const fitW = () => { const box = arenaEl || el, w = box.clientWidth, hh = box.clientHeight;
      return w > 50 && hh > 50 ? Math.max(FlashSim.WMIN, Math.min(FlashSim.WMAX, Math.round(FlashSim.H * w / hh))) : 600; };
    const sim = FlashSim.create(data, { source: opts.source || "human", width: fitW() });

    // ---------------------------------------------------------- telemetry
    // When opts.telemetry is a URL, every run is sent there (round ends, death,
    // every 20 s of play and when the page closes) so Gamebase can chart it.
    let telSent = 0;
    function sendTel(final) {
      if (!opts.telemetry) return;
      const t = sim.telemetry(); if (!t) return;
      if (opts.telemetryMeta) try { t.meta = opts.telemetryMeta(); } catch (e) {}
      // A function instead of a URL: the host keeps the record itself (the Thai
      // site saves it in the browser and offers it as a download).
      if (typeof opts.telemetry === "function") { try { opts.telemetry(t, !!final); } catch (e) {} telSent = Date.now(); return; }
      const body = JSON.stringify(t);
      try {
        if (final && navigator.sendBeacon) navigator.sendBeacon(opts.telemetry, new Blob([body], { type: "application/json" }));
        else fetch(opts.telemetry, { method: "POST", headers: { "Content-Type": "application/json" }, body, keepalive: body.length < 60000 }).catch(() => {});
        telSent = Date.now();
      } catch (e) {}
    }
    const onUnload = () => { if (sim.st.phase === "fight" || sim.st.phase === "break") sendTel(true); };
    window.addEventListener("pagehide", onUnload);
    const st = sim.st;
    const rarityColour = r => { const x = (data.rarities || []).find(q => q.id === r); return x ? x.colour : RARITY_FALLBACK[r] || "#888"; };
    const ICON = {};
    for (const r of data.icons || []) ICON[r.type + "." + r.target] = r.icon;
    const icon = (type, id, d) => ICON[type + "." + id] || d || "";
    const weaponIcon = w => (w.evo && icon("evolutions", w.evo, "")) || icon("weapons", w.id, "🗡️");
    // ---- the build (Round 3 step 4): tag chips on cards, what a pick would do, the recipe an item completes
    const tagChip = (id, extra) => { const r = sim.tagRow(id); return r ? `<span class="ftc-chip" style="--c:${r.colour || "#b59aff"}" title="${esc(r.name)}: ${esc(r.description || "")}">${r.icon} ${esc(r.name)}${extra || ""}</span>` : ""; };
    function buildLine(o) {
      const out = [], counts = st.build ? st.build.counts : {};
      // an item Flash already has adds no tag again: its chips are plain
      const adds = o.kind === "weapon" || o.kind === "spell" || o.kind === "kit" || (o.kind === "item" && !(st.items || {})[o.id]);
      for (const id of o.tags || []) {
        const r = sim.tagRow(id); if (!r) continue;
        const n = counts[id] || 0, hit = adds && o.kind !== "kit" ? (r.tiers || []).find(t => t.count === n + 1) : null;
        out.push(tagChip(id, adds && o.kind !== "kit" && o.kind !== "evolve" ? ` <b>${n}→${n + 1}</b>` : "") + (hit ? `<span class="ftc-chip up" title="${esc(hit.description || "")}">▲ ${esc(hit.name)}</span>` : ""));
      }
      if (o.evo) out.push(`<span class="ftc-chip evo" title="${esc(o.evo.weapon)} at level ${o.evo.min} + this = ${esc(o.evo.into)}">${o.evo.icon} ${esc(o.evo.weapon)} → ${esc(o.evo.into)}${o.evo.level < o.evo.min ? ` (Lv ${o.evo.level}/${o.evo.min})` : ""}</span>`);
      return out.length ? `<div class="ftc-chips">${out.join("")}</div>` : "";
    }
    const offerIcon = o => o.kind === "evolve" ? (o.icon || "✨") : o.kind === "weapon" ? icon("weapons", o.id, "🗡️")
      : o.kind === "wup" ? icon("upgrades", o.id, "⬆️") : o.kind === "item" ? icon("items", o.id, "🎒")
      : o.kind === "passive" ? icon("passives", o.id, "✨") : o.kind === "tail" ? "🐈"
      : o.kind === "spell" ? icon("spells", o.id, "🔮") : o.kind === "sup" ? icon("spells", o.sid, "🔮")
      : o.kind === "potion" ? "🧪" : icon("upgrades", o.id, "⬆️");
    const prefs = (() => { try { return JSON.parse(localStorage.getItem("ftc.prefs") || "{}"); } catch (e) { return {}; } })();
    const savePrefs = () => { try { localStorage.setItem("ftc.prefs", JSON.stringify(prefs)); } catch (e) {} };
    // What carries over between runs (the chosen mode, show-answers, bonus
    // items, best round): IndexedDB through Dexie when the page has it
    // ("ftc-game", table save), mirrored in localStorage so it survives
    // either one being cleared or blocked.
    async function openSave() {
      let data = {};
      try { data = JSON.parse(localStorage.getItem("ftc.save") || "{}") || {}; } catch (e) {}
      let db = null;
      try {
        if (window.Dexie) {
          db = new Dexie("ftc-game"); db.version(1).stores({ save: "k" });
          const row = await Promise.race([db.save.get("main"), new Promise(r => setTimeout(() => r(undefined), 1500))]);
          if (row && row.v && typeof row.v === "object") data = Object.assign({}, data, row.v);
        }
      } catch (e) { db = null; }
      return {
        get: () => JSON.parse(JSON.stringify(data)),
        set(v) {
          data = v || {};
          try { localStorage.setItem("ftc.save", JSON.stringify(data)); } catch (e) {}
          if (db) try { db.save.put({ k: "main", v: data, at: Date.now() }).catch(() => {}); } catch (e) {}
        },
        engine: () => db ? "dexie" : "localStorage",
      };
    }
    const SAVE = await openSave();
    const saveSet = (k, v) => { const d = SAVE.get(); d[k] = v; SAVE.set(d); };
    // Learn or Test (Dan: "What are they trying to do? learn, or test?")
    //   learn: the normal game, with the answers showing (Dan: "learn mode =
    //          normal mode but with all the answers, we don't need to make the
    //          game easier"). The whole lesson as gems, a found pair replaced at
    //          once; words still being learned show their English on the Thai
    //          gem and share a colour with their partner, then get a ✍ mini
    //          test (the word ladder). 👁 Show answers shows it on every word.
    //          A wrong pair lights up the right partner. 2-3 decoys.
    //   test:  no help, full decoys and timers.
    // Tuned in Game settings > modes.
    const MS = Object.assign({ learn_helped_strength: 1, learn_decoys_min: 2, learn_decoys_max: 3, learn_new_per_round: 0,
                               learn_pairs: 3, learn_shows: 5, learn_relearn_shows: 2, learned_after: 2,
                               learn_test_choices: 3, learn_test_after: 2 },
                             ((sim.D.settings || {}).modes || {}).values || {});
    let mode = SAVE.get().mode === "learn" ? "learn" : "test", showAll = !!SAVE.get().show_answers;
    sim.setMode(mode);
    // the learning engine behind the word card (flash-learn.js): each word's
    // steps and review days, in IndexedDB (Dexie "ftc-learn"), else localStorage
    let LE = null;
    // the question choices from ⚙ Options (like the course's quiz bar), kept in the save
    function qPrefs() { const d = SAVE.get(); return Object.assign({ shuffle: false, reverse: false, style: "mix", type: false, auto: true, wrong: 5,
                                                                    newday: 0, show: { pic: true, hook: true, tone: true, sents: true } }, d.q || {}, { show: Object.assign({ pic: true, hook: true, tone: true, sents: true }, (d.q || {}).show || {}) }); }
    function setQ(k, v) { const d = SAVE.get(); d.q = Object.assign(qPrefs(), { [k]: v }); SAVE.set(d); applyQ(); }
    function applyQ() { if (!LE) return; const q = qPrefs(); Object.assign(LE.S, { shuffle_new: !!q.shuffle, reverse_now: !!q.reverse, classic: q.style === "classic", max_wrong: Math.max(2, Math.min(5, +q.wrong || 5)) });
      if (+q.newday > 0) LE.S.new_per_day = +q.newday; }
    try {
      const st0 = window.FlashLearn && (FlashLearn.dexieStore("ftc-learn") || FlashLearn.lsStore("ftc.learn"));
      if (st0) LE = FlashLearn.create({ store: st0, fallback: FlashLearn.lsStore("ftc.learn"),
                                        settings: ((sim.D.settings || {}).recall || {}).values || {} });
      if (LE) { await Promise.race([LE.ready, new Promise(r => setTimeout(r, 3000))]); LE.setFocus(SAVE.get().focus); applyQ(); }
    } catch (e) { LE = null; }
    function setMode(m) {
      mode = m === "learn" ? "learn" : "test"; saveSet("mode", mode); sim.setMode(mode);
      if (opts.onMode) try { opts.onMode(mode); } catch (e) {}
    }

    // ----------------------------------------------- animation switchboard
    // Every visual flourish has an id, can be switched off, and counts how much
    // it's being used (per frame for sprite animations, per second for events).
    const ANIMS = [
      ["waddle", "Skeleton waddle", "Skeletons rock side to side while walking", "sprite", false],
      ["lunge", "Skeleton lunge", "Skeletons lunge at Flash when attacking", "sprite", true],
      ["hit_flash", "Hit flash", "Skeletons flash white when hit", "sprite", true],
      ["elite_pulse", "Elite ring pulse", "The gold ring around elites pulses", "sprite", true],
      ["flash_bob", "Flash breathing", "Flash gently bobs", "sprite", true],
      ["flash_squash", "Flash recoil", "Flash squashes each time a weapon fires", "event", true],
      ["flash_hurt", "Flash hurt tint", "Flash turns red when hit", "event", true],
      ["study_aura", "Study aura", "Glow around Flash that grows with study buffs", "sprite", true],
      ["projectile_spin", "Projectile spin", "Boomerangs and discs spin", "sprite", true],
      ["hit_sparks", "Hit sparks", "A spark on every hit", "event", true],
      ["damage_numbers", "Damage numbers", "Floating damage numbers", "event", true],
      ["death_particles", "Death burst", "Particles when a skeleton dies", "event", true],
      ["bone_shards", "Bone shards", "Spinning bones fly off dying skeletons", "event", true],
      ["explosion_rings", "Explosions", "Rings and particles for explosions", "event", true],
      ["chain_pops", "Chain pops", "Ring when a skeleton pops in a mega wave", "event", true],
      ["swing_arcs", "Sword arcs", "Arc drawn for sweeping melee weapons", "event", true],
      ["level_up_ring", "Level-up", "Ring and text on level up", "event", true],
      ["reward_fx", "Study reward pop", "Ring and floating text when a study reward arrives", "event", true],
      ["screen_shake", "Screen shake", "Camera shake on hits and wave starts", "event", true],
      ["banners", "Banners", "Round and wave banners", "event", true],
      ["combo_meter", "Combo meter", "Big combo counter during hordes", "event", true],
      ["flash_lean", "Flash lean", "Flash leans and faces the way he's running", "sprite", true],
      ["danger_alarm", "Danger alarm", "Red pulsing edges + 'answer a quiz' prompt when Flash is low", "event", true],
      ["spell_fx", "Spell effects", "Spell casts, zones, summons and the shield (summons on screen per frame)", "event", true],
      ["status_tints", "Status tints", "Frozen / burning / poisoned / cursed skeletons change colour, Death Mark reticles", "event", true],
      ["study_bolts", "Study bolts", "A blue bolt strikes Flash for every study reward, and lightning flashes in his eyes", "event", true],
      ["flash_dash", "Flash dash", "Blue shockwave when the quiz streak reaches 5, 10, 15 …", "event", true],
      ["word_gems", "Word gems", "Thai / English word pairs to match in the arena (pairs spawned per second)", "event", true],
      // Round 3 step 3 (9 Nov): elements and feel
      ["elements", "Element effects", "Flames on burning skeletons, ice on frozen ones, steam / overload / superconduct bursts, the nuke", "event", true],
      ["funny_deaths", "Funny deaths", "Ash, shatter, zapped dance, bowling pins, launched with a twinkle, rolling skulls, popping helmets", "event", true],
      ["paws", "Paws", "Flash's paw grabbing a skeleton and bowling it", "event", true],
      ["kitty_death", "Kitty death", "Slow motion and Flash curling up for a nap when he falls (tap to skip)", "event", true],
    ];
    const ANIM_DEF = {}; for (const a of ANIMS) ANIM_DEF[a[0]] = a[4];
    prefs.anim = prefs.anim || {};
    if (prefs.numbers === false) prefs.anim.damage_numbers = false;     // older settings
    if (prefs.shake === false) prefs.anim.screen_shake = false;
    const A = id => { const v = prefs.anim[id]; return v === undefined ? ANIM_DEF[id] : !!v; };
    // ⚙ Effects quality (Dan: "slowdown in late game.. limit showing spell effects?"):
    // how many skeletons on screen at once (a share of each wave's max_alive), how
    // many effects and numbers, and past how many skeletons they stop waddling,
    // lunging and flashing one by one. Auto starts at Medium (Low on a phone) and
    // moves with the frame rate.
    const QUAL = {
      // casts: spell effects drawn a second · allies: summons drawn · detail: zones with all their arcs and lines
      // cap: never more skeletons on screen than this (Dan's PC, 9 Nov: smooth at 55+ fps up to ~4,300)
      high: { label: "High", alive: 3, cap: 4000, fx: 600, texts: 6, bones: 120, lod: 4000, casts: 99, allies: 60, detail: true },
      medium: { label: "Medium", alive: 1.6, cap: 2200, fx: 320, texts: 4, bones: 60, lod: 1500, casts: 6, allies: 24, detail: true },
      low: { label: "Low", alive: 0.7, cap: 900, fx: 120, texts: 2, bones: 15, lod: 500, casts: 2, allies: 8, detail: false },
    };
    // Dan (9 Nov): "limit spell effects being displayed, if fps drops": the quality's
    // spell budget, and Low's at once whenever the frame rate is under 30 (the
    // spells still hit just as hard; only what's drawn is cut)
    const SQ = () => (game && game.loop && game.loop.actualFps && game.loop.actualFps < 30 && st.phase === "fight") ? QUAL.low : Q();
    let castTokens = 3, castAt = 0;
    function castOk() {
      const now = performance.now() / 1000, q = SQ();
      castTokens = Math.min(q.casts, castTokens + (now - castAt) * q.casts); castAt = now;
      if (castTokens < 1) return false;
      castTokens -= 1; return true;
    }
    const QORDER = ["low", "medium", "high"];
    const phoneish = () => window.matchMedia && matchMedia("(pointer: coarse)").matches && Math.min(screen.width, screen.height) < 700;
    let qAuto = phoneish() ? "low" : "medium";
    const qPick = () => prefs.quality && QUAL[prefs.quality] ? prefs.quality : "auto";
    const qNow = () => qPick() === "auto" ? qAuto : qPick();
    const Q = () => QUAL[qNow()];
    const usedSec = {}, usedFrame = {}, lastSec = {};
    const use = (id, n) => { usedSec[id] = (usedSec[id] || 0) + (n || 1); };
    const useF = (id, n) => { usedFrame[id] = (usedFrame[id] || 0) + (n || 1); };
    const secTimer = setInterval(() => { for (const k of Object.keys(lastSec)) lastSec[k] = 0; Object.assign(lastSec, usedSec); for (const k in usedSec) usedSec[k] = 0; }, 1000);
    // ⚙ Motion: Reduced (from the device's "reduce motion" until changed) means no
    // screen shake, no camera zoom and no screen flashes unless they're switched on
    const sysReduce = () => { try { return !!(window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches); } catch (e) { return false; } };
    const reducedMotion = () => prefs.motion === "reduced" || (prefs.motion !== "full" && sysReduce());
    // ⚙ Screen flashes on big hits (Dan: "flashes on big hits, with reduce flashing and a cap"):
    //   full  up to ~1.4 a second, gentle (at most 32% opacity), never red
    //   soft  up to ~0.7 a second, fainter
    //   off   none (the default with reduce motion)
    // Well under 3 a second (the seizure-safety line), and never a strobe.
    const flashMode = () => prefs.flashes === "full" || prefs.flashes === "soft" || prefs.flashes === "off" ? prefs.flashes : reducedMotion() ? "off" : "full";
    const FLASH = { full: { gap: 700, peak: 0.32 }, soft: { gap: 1400, peak: 0.14 } };
    let flashAt = -1e9; const flashLog = [];
    function screenFlash(colour, strength) {
      const m = flashMode(); if (m === "off" || !flashFxEl) return false;
      const now = performance.now(), c = FLASH[m];
      if (now - flashAt < c.gap) return false;
      flashAt = now; flashLog.push(now); if (flashLog.length > 50) flashLog.shift();
      flashFxEl.style.transition = "none";
      flashFxEl.style.background = "#" + (colour >>> 0).toString(16).padStart(6, "0");
      flashFxEl.style.opacity = String(c.peak * Math.max(0.2, Math.min(1, strength || 1)));
      void flashFxEl.offsetWidth;
      flashFxEl.style.transition = "opacity 420ms ease-out";
      flashFxEl.style.opacity = "0";
      return true;
    }
    let flashFxEl = null;
    // every camera shake goes through here: off with ⚙ Motion → Reduced
    function shake(ms, k) { if (!scene || reducedMotion() || !A("screen_shake")) return; use("screen_shake"); scene.cameras.main.shake(ms, k); }

    // ------------------------------------------------------------- DOM
    el.innerHTML = "";
    const root = h("div", "ftc"), canvasBox = h("div", "ftc-canvas"), hud = h("div", "ftc-hud"), overlay = h("div", "ftc-overlay");
    const top = h("div", "ftc-top"), stageEl = h("span"), timerEl = h("span", "ftc-timer"), goldEl = h("span");
    const pauseBtn = h("button", "ftc-btn", "⏸"); pauseBtn.title = "Pause";
    const eyeBtn = h("button", "ftc-btn ftc-eye", "👁"); eyeBtn.title = "Show answers on every word";
    // Dan (9 Nov): "kill counter", "dps, high dmg.."
    const killsEl = h("span", "ftc-kills"), dpsEl = h("span", "ftc-dps");
    killsEl.title = "Skeletons this run"; dpsEl.title = "Damage per second (the last 5 seconds)";
    top.append(stageEl, timerEl, goldEl, eyeBtn, pauseBtn);
    const tally = h("div", "ftc-tally");
    // 🐟 fish Flash carries (tap or H to eat one) and 😼 nine lives left
    const fishBtn = h("button", "ftc-fishbtn", "🐟 0"); fishBtn.title = "Eat a fish (H): heals Flash";
    const livesEl = h("span", "ftc-lives"); livesEl.title = "Nine Lives: Flash gets back up this many more times";
    fishBtn.onclick = e => { e.stopPropagation(); eatFish(); };
    tally.append(fishBtn, livesEl, killsEl, dpsEl);
    const bars = h("div", "ftc-bars"), hpBar = h("div", "ftc-bar hp", "<i></i><span></span>"), xpBar = h("div", "ftc-bar xp", "<i></i><span></span>");
    bars.append(hpBar, xpBar);
    const waveBar = h("div", "ftc-bar wave", "<i></i><span></span>"); waveBar.style.display = "none"; bars.append(waveBar);
    const bossBar = h("div", "ftc-bar boss", "<i></i><span></span>"); bossBar.style.display = "none"; bars.append(bossBar);
    // Dan: "mega bosses need to show hp": a big bar across the top of the arena,
    // for the boss and the two biggest elites on screen
    const bigBars = h("div", "ftc-bigbars");
    // Dan (9 Nov): "warnings about impending skellies from whatever side of the screen,
    // with like a red ... warning, like there's more to come": the side the horde is
    // coming from glows; the side it comes from next pulses (slowly: once a second, not
    // a strobe), with how many are still to come
    const edges = h("div", "ftc-edges", ["t", "r", "b", "l"].map(k => `<div class="ftc-edge ${k}"><span></span></div>`).join(""));
    const buffsEl = h("div", "ftc-buffs"), warnEl = h("div", "ftc-warn"), floatEl = h("div", "ftc-float"), bottom = h("div", "ftc-bottom");
    const bannerEl = h("div", "ftc-banner"), comboEl = h("div", "ftc-combo");
    const vignette = h("div", "ftc-vignette"), dangerEl = h("div", "ftc-danger", "❤️ Flash is in trouble! Answer a quiz to heal him");
    const learnEl = h("div", "ftc-learn"), ladderEl = h("div", "ftc-ladder"), masterEl = h("div", "ftc-learn ftc-master");
    hud.append(top, bars, tally, bigBars, ladderEl, buffsEl, warnEl, learnEl, masterEl, bottom);
    // the game's side of the screen; the study panel (the word card) sits beside it
    const arena = h("div", "ftc-arena"); arenaEl = arena;
    flashFxEl = h("div", "ftc-flashfx");
    const napEl = h("div", "ftc-nap");                         // the kitty death's "tap to skip"
    arena.append(canvasBox, flashFxEl, vignette, edges, hud, floatEl, comboEl, bannerEl, dangerEl, napEl, overlay);
    root.append(arena);
    let bannerT = null, lastWave = null;
    function banner(text, sub) {
      bannerEl.innerHTML = `<b>${esc(text)}</b>${sub ? `<small>${esc(sub)}</small>` : ""}`;
      bannerEl.classList.remove("show"); void bannerEl.offsetWidth; bannerEl.classList.add("show");
      clearTimeout(bannerT); bannerT = setTimeout(() => bannerEl.classList.remove("show"), 2600);
    }
    el.append(root);

    // ------------------------------------------------------------ sounds
    // Dan: "with game sounds, we will need a volume slider, only affecting
    // game sounds". Every effect is made in the browser (Web Audio, no files),
    // goes through one volume that never touches the lesson's audio or a Thai
    // gem's word, and is rate-limited so 500 skeletons don't become noise.
    // The browser only allows sound after a click, so it starts on the first one.
    const SFX = (() => {
      let ctx = null, master = null, noiseBuf = null;
      let vol = SAVE.get().sfx_volume ?? 0.5, muted = !!SAVE.get().sfx_muted;
      const last = {};
      const apply = () => { if (master) master.gain.value = muted ? 0 : vol * vol; };
      function unlock() {
        const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
        try {
          if (!ctx) { ctx = new AC(); master = ctx.createGain(); master.connect(ctx.destination); apply(); }
          if (ctx.state === "suspended") ctx.resume().catch(() => {});
        } catch (e) { ctx = null; }
      }
      function noise() {
        if (!noiseBuf) { noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 0.6, ctx.sampleRate); const d = noiseBuf.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1; }
        return noiseBuf;
      }
      function tone(f, t0, dur, type, g, f2) {
        const o = ctx.createOscillator(), a = ctx.createGain();
        o.type = type || "sine"; o.frequency.setValueAtTime(f, t0); if (f2) o.frequency.exponentialRampToValueAtTime(f2, t0 + dur);
        a.gain.setValueAtTime(0.0001, t0); a.gain.exponentialRampToValueAtTime(g, t0 + 0.01); a.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
        o.connect(a); a.connect(master); o.start(t0); o.stop(t0 + dur + 0.03);
      }
      function hiss(t0, dur, g, freq, q, kind) {
        const s = ctx.createBufferSource(), fl = ctx.createBiquadFilter(), a = ctx.createGain();
        s.buffer = noise(); fl.type = kind || "bandpass"; fl.frequency.value = freq || 1500; fl.Q.value = q || 1;
        a.gain.setValueAtTime(g, t0); a.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
        s.connect(fl); fl.connect(a); a.connect(master); s.start(t0); s.stop(t0 + dur + 0.03);
      }
      const notes = (fs, t, step, dur, type, g) => fs.forEach((f, i) => tone(f, t + i * step, dur, type, g));
      const SOUNDS = {
        hit: t => hiss(t, 0.04, 0.08, 2400, 2),
        kill: t => tone(480 + Math.random() * 320, t, 0.07, "triangle", 0.09, 170),
        pop: t => tone(900 + Math.random() * 500, t, 0.05, "sine", 0.06, 380),
        explode: t => { hiss(t, 0.35, 0.4, 420, 0.7, "lowpass"); tone(90, t, 0.3, "sine", 0.35, 40); },
        swing: t => hiss(t, 0.11, 0.12, 900, 0.8),
        hurt: t => tone(190, t, 0.12, "square", 0.1, 90),
        cast: t => { tone(620, t, 0.2, "sine", 0.1, 1300); hiss(t, 0.14, 0.05, 4200, 3); },
        match: t => notes([1046, 1318], t, 0.08, 0.22, "sine", 0.24),
        helped: t => tone(880, t, 0.16, "sine", 0.18),
        mismatch: t => notes([220, 196], t, 0.09, 0.15, "square", 0.08),
        learned: t => notes([784, 988, 1175, 1568], t, 0.07, 0.26, "triangle", 0.2),
        levelup: t => notes([523, 659, 784, 1046], t, 0.06, 0.2, "triangle", 0.18),
        reward: t => { tone(1800, t, 0.18, "sawtooth", 0.06, 300); hiss(t, 0.12, 0.1, 5000, 1.5); },
        dash: t => { hiss(t, 0.4, 0.3, 700, 0.6); tone(70, t, 0.35, "sine", 0.4, 35); tone(1500, t, 0.25, "sawtooth", 0.05, 200); },
        danger: t => notes([880, 660], t, 0.16, 0.14, "square", 0.1),
        question: t => notes([1318, 1760], t, 0.1, 0.32, "sine", 0.16),
        right: t => notes([784, 1175], t, 0.08, 0.26, "sine", 0.22),
        wrong: t => tone(150, t, 0.3, "sawtooth", 0.1, 100),
        boss: t => { tone(110, t, 0.9, "sawtooth", 0.14, 82); tone(55, t, 1.0, "sine", 0.3); },
        boss_down: t => notes([392, 523, 659, 784, 1046], t, 0.09, 0.3, "triangle", 0.2),
        coin: t => notes([988, 1319], t, 0.06, 0.14, "square", 0.08),
        round: t => notes([523, 784], t, 0.12, 0.25, "triangle", 0.16),
        over: t => notes([523, 440, 349, 262], t, 0.16, 0.3, "triangle", 0.18),
        // Round 3 step 3
        nap: t => notes([659, 523, 440, 392, 330], t, 0.28, 0.6, "sine", 0.14),
        strike: t => { for (let i = 0; i < 6; i++) hiss(t + i * 0.035, 0.07, 0.16, 1800 + Math.random() * 2400, 3); tone(140, t, 0.2, "triangle", 0.2, 70); },
        grab: t => tone(300, t, 0.09, "triangle", 0.12, 520),
        throw: t => hiss(t, 0.22, 0.14, 600, 0.7),
        fish: t => notes([1175, 1568], t, 0.05, 0.12, "sine", 0.12),
        eat: t => { tone(420, t, 0.08, "square", 0.08, 300); tone(470, t + 0.11, 0.08, "square", 0.08, 330); notes([784, 1046], t + 0.24, 0.07, 0.2, "triangle", 0.15); },
        revive: t => notes([392, 523, 659, 784, 1046, 1318], t, 0.07, 0.35, "triangle", 0.2),
        nuke: t => { hiss(t, 1.4, 0.5, 300, 0.5, "lowpass"); tone(60, t, 1.2, "sine", 0.45, 28); tone(120, t, 0.6, "sawtooth", 0.08, 40); },
        steam: t => hiss(t, 0.35, 0.12, 3600, 0.8, "highpass"),
        zap: t => { tone(1400, t, 0.08, "sawtooth", 0.05, 600); hiss(t, 0.06, 0.06, 5200, 2); },
        overload: t => { hiss(t, 0.2, 0.2, 900, 0.8); tone(200, t, 0.15, "square", 0.08, 90); },
        shatter: t => { for (let i = 0; i < 3; i++) tone(2600 + Math.random() * 1600, t + i * 0.025, 0.06, "sine", 0.05); },
      };
      const GAP = { hit: 0.07, kill: 0.06, pop: 0.05, swing: 0.1, hurt: 0.2, cast: 0.12, explode: 0.12, reward: 0.15, danger: 1,
                    strike: 0.3, grab: 0.25, throw: 0.25, fish: 0.12, steam: 0.18, zap: 0.12, overload: 0.15, shatter: 0.1, nuke: 0.8 };
      return {
        play(id) {
          if (muted || vol <= 0 || !ctx || ctx.state !== "running" || !SOUNDS[id]) return;
          const now = ctx.currentTime;
          if (now - (last[id] ?? -9) < (GAP[id] || 0.03)) return; last[id] = now;
          try { SOUNDS[id](now + 0.005); } catch (e) {}
        },
        unlock,
        volume(v) { if (v !== undefined) { vol = Math.max(0, Math.min(1, +v)); saveSet("sfx_volume", vol); apply(); } return vol; },
        mute(m) { if (m !== undefined) { muted = !!m; saveSet("sfx_muted", muted); apply(); } return muted; },
        state: () => ctx ? ctx.state : "locked",
        ids: () => Object.keys(SOUNDS),
      };
    })();
    root.addEventListener("pointerdown", () => SFX.unlock(), true);
    root.addEventListener("keydown", () => SFX.unlock(), true);
    // 🔊 in the top bar: the game's own volume and mute
    const volBtn = h("button", "ftc-btn ftc-volbtn", SFX.mute() ? "🔇" : "🔊"); volBtn.title = "Game sounds (not the lesson audio)";
    const volBox = h("div", "ftc-vol", `<label>🔊 Game sounds</label><input type="range" min="0" max="100" step="5">
      <label class="ftc-small"><input type="checkbox"> Mute</label><small>Only the game's effects. The lesson's audio and the Thai words keep their own volume.</small>`);
    const volRange = volBox.querySelector('input[type="range"]'), volMute = volBox.querySelector('input[type="checkbox"]');
    volRange.value = Math.round(SFX.volume() * 100); volMute.checked = SFX.mute();
    volRange.oninput = () => { SFX.volume(volRange.value / 100); if (SFX.mute() && +volRange.value > 0) { SFX.mute(false); volMute.checked = false; } volBtn.textContent = SFX.mute() || !+volRange.value ? "🔇" : "🔊"; };
    volRange.onchange = () => SFX.play("match");
    volMute.onchange = () => { SFX.mute(volMute.checked); volBtn.textContent = volMute.checked ? "🔇" : "🔊"; };
    volBtn.onclick = e => { e.stopPropagation(); volBox.classList.toggle("show"); };
    document.addEventListener("pointerdown", e => { if (!volBox.contains(e.target) && e.target !== volBtn) volBox.classList.remove("show"); });
    top.insertBefore(volBtn, top.lastChild);
    arena.append(volBox);

    // ----------------------------------------------------------- Phaser
    let scene = null;
    const pools = { enemies: [], rings: [], proj: [], eproj: [], blades: [], parts: [], bones: [], texts: [], allies: [], corpses: [], fish: [], paws: [] };
    let kick = 0;
    const fx = [];           // {kind, x, y, r, life, max, colour}
    let acc = 0, speed = 1, lastUi = 0, slowF = 1, slowTo = 1, dashT = 0, eyesT = 0;
    const perf = { sim: 0, draw: 0 };

    const env = (data.shared_environments || []).find(e => e.id === "dungeon");
    const pal = (env && env.palette) || ["#2a2a33", "#4a4a58", "#c48a3a"];
    // Studying is blue (the inaflash blue): every effect that comes from the
    // course uses it, so a learner sees "the blue stuff is me".
    const BLUE = 0x3b82f6, BLUE_HI = 0x9cc8ff;
    const fxColour = (id, d) => { const e = (data.shared_effects || []).find(x => x.id === id); return e ? hexNum(e.colour) : d; };
    const C = { impact: fxColour("impact", 0xffffff), explosion: fxColour("explosion", 0xffb03a), death: fxColour("death", 0xe8e2d0),
                healing: fxColour("healing", 0x5aff9a), aura: fxColour("aura", 0xc58aff), burning: fxColour("burning", 0xff7a1a) };

    function makeTextures(s) {
      const g = s.make.graphics({ x: 0, y: 0, add: false });
      // floor: stone tiles in the dungeon palette (Shared library > environments > dungeon)
      g.fillStyle(hexNum(pal[0])); g.fillRect(0, 0, FlashSim.WMAX, FlashSim.H);
      for (let y = 0; y < FlashSim.H; y += 50) for (let x = (y / 50) % 2 ? -25 : 0; x < FlashSim.WMAX; x += 50) {
        g.fillStyle(hexNum(pal[1]), 0.18 + Math.random() * 0.14); g.fillRect(x + 2, y + 2, 46, 46);
      }
      g.generateTexture("ftc-floor", FlashSim.WMAX, FlashSim.H); g.clear();
      // Flash: an orange cat-ish circle with ears (placeholder until the cutout rig has art)
      g.fillStyle(0xff9f5a); g.fillTriangle(6, 18, 14, 0, 22, 16); g.fillTriangle(42, 18, 34, 0, 26, 16);
      g.fillCircle(24, 28, 20); g.fillStyle(0xffffff); g.fillCircle(17, 25, 5); g.fillCircle(31, 25, 5);
      g.fillStyle(0x1a1010); g.fillCircle(18, 26, 2.6); g.fillCircle(32, 26, 2.6); g.fillStyle(0xff6a7a); g.fillTriangle(22, 32, 26, 32, 24, 35);
      g.generateTexture("ftc-flash", 48, 50); g.clear();
      // a lightning bolt for his eyes when he powers up (the site's bolt, blue-white with a blue edge)
      const bolt = [[12.67, 4.5], [6, 13.5], [12, 13.5], [11.33, 19.5], [18, 10.5], [12, 10.5]].map(([x, y]) => ({ x: (x - 3) * 0.75, y: (y - 2.5) * 0.75 }));
      g.fillStyle(0xeaf4ff, 1); g.fillPoints(bolt, true); g.lineStyle(1.4, BLUE, 1); g.strokePoints(bolt, true);
      g.generateTexture("ftc-eyebolt", 13, 14); g.clear();
      // a boss: a big skull with a gold crown (not tinted, so the crown stays gold)
      g.fillStyle(0xf2ede0); g.fillCircle(36, 44, 30); g.fillStyle(0x1a1418); g.fillCircle(25, 42, 7); g.fillCircle(47, 42, 7);
      g.fillStyle(0xff3a3a); g.fillCircle(25, 42, 2.5); g.fillCircle(47, 42, 2.5); g.fillStyle(0x1a1418); g.fillRect(28, 58, 16, 4);
      g.fillStyle(0xffd23a); g.fillTriangle(14, 18, 20, 2, 26, 18); g.fillTriangle(28, 18, 36, 0, 44, 18); g.fillTriangle(46, 18, 52, 2, 58, 18);
      g.fillRect(14, 16, 44, 7); g.fillStyle(0xff4a6a); g.fillCircle(36, 19, 3);
      g.generateTexture("ftc-boss", 72, 76); g.clear();
      // spirit wolf and ghost cat (summons), drawn white so they can be tinted
      g.fillStyle(0xffffff); g.fillTriangle(4, 10, 8, 0, 13, 9); g.fillTriangle(24, 10, 20, 0, 15, 9); g.fillCircle(14, 15, 10);
      g.fillTriangle(7, 18, 21, 18, 14, 27); g.fillStyle(0x203040); g.fillCircle(10, 13, 1.8); g.fillCircle(18, 13, 1.8);
      g.generateTexture("ftc-wolf", 28, 28); g.clear();
      g.fillStyle(0xffffff); g.fillTriangle(3, 9, 7, 0, 11, 8); g.fillTriangle(21, 9, 17, 0, 13, 8); g.fillCircle(12, 14, 10);
      g.fillStyle(0x203040); g.fillCircle(8.5, 13, 2); g.fillCircle(15.5, 13, 2);
      g.generateTexture("ftc-ghostcat", 24, 26); g.clear();
      // skeleton: white skull circle (tinted per type), dark eyes
      g.fillStyle(0xffffff); g.fillCircle(12, 12, 11); g.fillStyle(0x1a1418); g.fillCircle(8, 11, 2.6); g.fillCircle(16, 11, 2.6);
      g.fillRect(9, 17, 6, 2);
      g.generateTexture("ftc-skel", 24, 24); g.clear();
      g.lineStyle(2.5, 0xf5b355); g.strokeCircle(16, 16, 14); g.generateTexture("ftc-ring", 32, 32); g.clear();
      g.fillStyle(0xffffff); g.fillCircle(5, 5, 5); g.generateTexture("ftc-dot", 10, 10); g.clear();
      g.fillStyle(0xffffff); g.fillRect(0, 0, 16, 4); g.generateTexture("ftc-bolt", 16, 4); g.clear();
      g.fillStyle(0xdfe6ee); g.fillTriangle(0, 4, 16, 0, 16, 8); g.generateTexture("ftc-blade", 16, 8); g.clear();
      g.fillStyle(0xffffff); g.fillRect(2, 2, 8, 2); g.fillCircle(2, 2, 2); g.fillCircle(2, 4, 2); g.fillCircle(10, 2, 2); g.fillCircle(10, 4, 2);
      g.generateTexture("ftc-bone", 13, 7); g.clear();
      // 🐾 Flash's paw (orange, pink beans)
      g.fillStyle(0xff9f5a); g.fillEllipse(15, 19, 20, 16); g.fillCircle(6, 9, 5); g.fillCircle(12, 5, 5); g.fillCircle(19, 5, 5); g.fillCircle(25, 9, 5);
      g.fillStyle(0xff8fa6); g.fillEllipse(15, 20, 11, 8); g.fillCircle(6, 9, 2.4); g.fillCircle(12, 5, 2.4); g.fillCircle(19, 5, 2.4); g.fillCircle(25, 9, 2.4);
      g.generateTexture("ftc-paw", 31, 28); g.clear();
      // 🐟 a fish
      g.fillStyle(0x3f8fd8); g.fillTriangle(0, 2, 0, 14, 8, 8);
      g.fillStyle(0x7cc8ff); g.fillEllipse(17, 8, 20, 12); g.fillStyle(0xdff3ff); g.fillEllipse(18, 10, 13, 5);
      g.fillStyle(0x10202c); g.fillCircle(23, 6, 1.6);
      g.generateTexture("ftc-fish", 28, 16); g.clear();
      // Flash curled up for a nap: body, tail wrapped round, closed eyes
      g.fillStyle(0xff9f5a); g.fillEllipse(32, 30, 40, 26);
      g.lineStyle(7, 0xe8823e); g.beginPath(); g.arc(30, 30, 19, 0.2, 2.6); g.strokePath();
      g.fillStyle(0xff9f5a); g.fillTriangle(9, 16, 13, 4, 19, 14); g.fillTriangle(27, 14, 31, 3, 34, 15); g.fillCircle(20, 22, 13);
      g.lineStyle(2, 0x3a1a10); g.beginPath(); g.arc(15, 22, 3, 0.2, 2.9); g.strokePath(); g.beginPath(); g.arc(25, 22, 3, 0.2, 2.9); g.strokePath();
      g.fillStyle(0xff6a7a); g.fillTriangle(18, 27, 22, 27, 20, 29);
      g.generateTexture("ftc-flash-curl", 56, 46); g.clear();
      // a helmet that pops off, an ice shard, a twinkle, the hairball
      g.fillStyle(0x9aa4b2); g.fillEllipse(9, 8, 16, 14); g.fillStyle(0x6a7380); g.fillRect(0, 8, 18, 3);
      g.generateTexture("ftc-helmet", 18, 11); g.clear();
      g.fillStyle(0xffffff); g.fillTriangle(0, 10, 4, 0, 8, 10); g.generateTexture("ftc-shard", 8, 10); g.clear();
      g.fillStyle(0xffffff); g.fillTriangle(8, 0, 6, 8, 10, 8); g.fillTriangle(8, 16, 6, 8, 10, 8); g.fillTriangle(0, 8, 8, 6, 8, 10); g.fillTriangle(16, 8, 8, 6, 8, 10);
      g.fillCircle(8, 8, 2.2); g.generateTexture("ftc-star", 16, 16); g.clear();
      g.fillStyle(0x7f8a6a); g.fillCircle(11, 11, 9); g.fillStyle(0xb6ff5a, 0.9); g.fillCircle(11, 11, 4);
      for (let i = 0; i < 10; i++) { const a = i * 0.628; g.fillStyle(0x9aa38a); g.fillCircle(11 + Math.cos(a) * 9, 11 + Math.sin(a) * 9, 2.2); }
      g.generateTexture("ftc-hairball", 22, 22); g.clear();
      g.destroy();
    }
    // ---- locations (Round 3 step 5): each one's floor and edge props are drawn once into a
    // texture the size of the old floor, so a location costs nothing per frame. Only the
    // lights (torches, lanterns, neon) are sprites: a dozen, flickering gently (steady with
    // "reduce motion").
    let shownLoc;                      // the location id on screen (null = the old dungeon floor)
    const locKey = id => id ? "ftc-floor-" + id : "ftc-floor";
    function makeFloor(s, L) {
      const key = locKey(L.id), WW = FlashSim.WMAX, HH = FlashSim.H, f = L.floor || {};
      const base = hexNum(f.base || "#2a2430"), tile = hexNum(f.tile || "#4a4458"), acc = hexNum(f.accent || "#ffd23a");
      const lights = [];
      if (s.textures.exists(key)) return s.textures.get(key).customData.lights || [];
      const g = s.make.graphics({ x: 0, y: 0, add: false }), R = Math.random;
      g.fillStyle(base); g.fillRect(0, 0, WW, HH);
      const pat = f.pattern || "tiles";
      if (pat === "tiles") {
        for (let y = 0; y < HH; y += 50) for (let x = (y / 50) % 2 ? -25 : 0; x < WW; x += 50) {
          g.fillStyle(tile, 0.16 + R() * 0.16); g.fillRect(x + 2, y + 2, 46, 46);
          if (R() < 0.06) { g.lineStyle(1.5, 0x000000, 0.28); g.beginPath(); g.moveTo(x + 6 + R() * 20, y + 4); g.lineTo(x + 18 + R() * 14, y + 24); g.lineTo(x + 10 + R() * 30, y + 46); g.strokePath(); }
          if (R() < 0.035) { g.lineStyle(2, acc, 0.35); g.strokeRect(x + 6, y + 6, 38, 38); }
        }
      } else if (pat === "planks") {
        for (let y = 0; y < HH; y += 34) { let x = -R() * 120; while (x < WW) { const w = 120 + R() * 120; g.fillStyle(tile, 0.14 + R() * 0.16); g.fillRect(x + 1, y + 1, w - 2, 32); x += w; } }
      } else if (pat === "sand") {
        for (let i = 0; i < 2600; i++) { g.fillStyle(R() < 0.5 ? tile : 0x000000, R() < 0.5 ? 0.22 : 0.07); g.fillCircle(R() * WW, R() * HH, 1 + R() * 2.2); }
        for (let y = 60; y < HH; y += 46) { g.lineStyle(2, tile, 0.16); g.beginPath(); for (let x = 0; x <= WW; x += 24) { const yy = y + Math.sin(x / 70 + y) * 7; if (x) g.lineTo(x, yy); else g.moveTo(x, yy); } g.strokePath(); }
        // the sea, along the bottom
        g.fillStyle(acc, 0.30); g.fillRect(0, HH - 46, WW, 46); g.fillStyle(acc, 0.22); g.fillRect(0, HH - 60, WW, 14);
        g.lineStyle(3, 0xffffff, 0.35); g.beginPath(); for (let x = 0; x <= WW; x += 20) { const yy = HH - 60 + Math.sin(x / 45) * 5; if (x) g.lineTo(x, yy); else g.moveTo(x, yy); } g.strokePath();
      } else if (pat === "grass") {
        for (let i = 0; i < 90; i++) { g.fillStyle(0x000000, 0.10); g.fillEllipse(R() * WW, R() * HH, 60 + R() * 120, 40 + R() * 70); }
        for (let i = 0; i < 3200; i++) { const x = R() * WW, y = R() * HH; g.lineStyle(1.5, R() < 0.2 ? acc : tile, 0.22 + R() * 0.25); g.beginPath(); g.moveTo(x, y); g.lineTo(x + (R() - 0.5) * 5, y - 4 - R() * 6); g.strokePath(); }
      } else {       // concrete: big slabs, seams, puddles that catch the lights
        for (let y = 0; y < HH; y += 100) for (let x = 0; x < WW; x += 100) { g.fillStyle(tile, 0.10 + R() * 0.14); g.fillRect(x + 1.5, y + 1.5, 97, 97); }
        for (let i = 0; i < 26; i++) { const x = R() * WW, y = R() * HH; g.fillStyle(acc, 0.07); g.fillEllipse(x, y, 50 + R() * 80, 18 + R() * 26); g.fillStyle(0xffffff, 0.04); g.fillEllipse(x - 6, y - 2, 20, 6); }
        for (let i = 0; i < 500; i++) { g.fillStyle(0x000000, 0.14); g.fillCircle(R() * WW, R() * HH, 1 + R() * 1.6); }
      }
      // props: along the top (under the HUD's edge), the bottom and the left, so every column width shows some
      const props = (L.props || []).filter(Boolean), spots = [];
      if (props.length) {
        for (let x = 70; x < WW; x += 150) { spots.push([x + (R() - 0.5) * 30, 150, 0]); spots.push([x + 75 + (R() - 0.5) * 30, HH - (pat === "sand" ? 96 : 44), 2]); }
        for (let y = 260; y < HH - 140; y += 170) spots.push([20, y + (R() - 0.5) * 30, 3]);
      }
      const lightC = hexNum(L.light || f.accent || "#ffd27a");
      spots.forEach(([x, y, side], i) => {
        const k = props[i % props.length];
        g.fillStyle(0x000000, 0.22); g.fillEllipse(x, y + 12, 34, 10);                    // a soft shadow under everything
        if (k === "torch") { g.fillStyle(0x4a3424); g.fillRect(x - 2.5, y - 10, 5, 24); g.fillStyle(0xff8a2a); g.fillCircle(x, y - 14, 7); g.fillStyle(0xffe08a); g.fillCircle(x, y - 13, 3.5); lights.push([x, y - 14, 1]); }
        else if (k === "lantern") { g.lineStyle(1.5, 0x000000, 0.5); g.beginPath(); g.moveTo(x, y - 24); g.lineTo(x, y - 12); g.strokePath(); g.fillStyle(0xe23a3a); g.fillRoundedRect(x - 9, y - 12, 18, 20, 7); g.fillStyle(0xf5c542); g.fillRect(x - 6, y - 14, 12, 3); g.fillRect(x - 6, y + 7, 12, 3); lights.push([x, y - 2, 0.9]); }
        else if (k === "bell") { g.fillStyle(0x5a3d1e); g.fillRect(x - 16, y - 20, 32, 4); g.fillStyle(0xd9a52e); g.fillTriangle(x - 12, y + 8, x + 12, y + 8, x, y - 16); g.fillCircle(x, y - 8, 8); g.fillStyle(0x8a6418); g.fillCircle(x, y + 9, 3); }
        else if (k === "stall") { g.fillStyle(0x3a2c28); g.fillRect(x - 24, y - 4, 48, 14); for (let j = 0; j < 6; j++) { g.fillStyle(j % 2 ? 0xf2f2f2 : hexNum(f.accent || "#ff5a7a")); g.fillRect(x - 27 + j * 9, y - 18, 9, 12); } lights.push([x, y - 6, 0.7]); }
        else if (k === "palm") { g.fillStyle(0x6b4a2e); g.fillRect(x - 3, y - 14, 6, 26); g.fillStyle(0x2f8a4a); for (let j = 0; j < 6; j++) { const a = j * 1.05; g.fillEllipse(x + Math.cos(a) * 13, y - 16 + Math.sin(a) * 9, 22, 8); } g.fillStyle(0x3fae5e); g.fillCircle(x, y - 16, 5); }
        else if (k === "parasol") { for (let j = 0; j < 8; j++) { g.fillStyle(j % 2 ? 0xf2f2f2 : 0xff7a5a); g.slice(x, y, 18, j * 0.785, (j + 1) * 0.785); g.fillPath(); } g.fillStyle(0x444444); g.fillCircle(x, y, 2.5); }
        else if (k === "vine") { g.lineStyle(3, 0x2f7a3a, 0.9); g.beginPath(); g.moveTo(x - 14, y - 16); for (let j = 1; j <= 6; j++) g.lineTo(x - 14 + j * 5, y - 16 + Math.sin(j * 1.3) * 8 + j * 3); g.strokePath(); g.fillStyle(0x4fb35e); for (let j = 0; j < 4; j++) g.fillEllipse(x - 10 + j * 8, y - 10 + j * 5, 9, 5); }
        else if (k === "rock") { g.fillStyle(0x6c7078); g.fillEllipse(x, y + 2, 30, 20); g.fillStyle(0x8a8f98); g.fillEllipse(x - 4, y - 2, 16, 9); }
        else if (k === "neon") { g.lineStyle(3, lightC, 0.95); g.strokeRoundedRect(x - 20, y - 12, 40, 20, 5); g.lineStyle(2, 0xff5ad0, 0.9); g.beginPath(); g.moveTo(x - 12, y - 2); g.lineTo(x - 2, y - 6); g.lineTo(x + 4, y + 2); g.lineTo(x + 13, y - 3); g.strokePath(); lights.push([x, y - 2, 1.1]); }
        else if (k === "antenna") { g.lineStyle(2.5, 0x9aa4b4, 0.95); g.beginPath(); g.moveTo(x, y + 12); g.lineTo(x, y - 20); g.moveTo(x - 9, y - 12); g.lineTo(x + 9, y - 12); g.moveTo(x - 6, y - 5); g.lineTo(x + 6, y - 5); g.strokePath(); g.fillStyle(0xff3a3a); g.fillCircle(x, y - 21, 2.5); lights.push([x, y - 21, 0.45, 0xff3a3a]); }
        else if (k === "bones") { g.fillStyle(0xe8e2d0, 0.85); for (let j = 0; j < 5; j++) g.fillRoundedRect(x - 14 + R() * 20, y - 2 + R() * 10, 12, 3.5, 1.5); g.fillCircle(x + 2, y - 3, 5); }
      });
      g.generateTexture(key, WW, HH); g.destroy();
      s.textures.get(key).customData = { lights };
      return lights;
    }
    // put the right floor under the fight: the run's own location while one is going, else the lesson's
    function showLocation() {
      if (!scene || !scene.floorImg || !sim.location) return;
      const inRun = st.phase === "fight" || st.phase === "break";
      const id = inRun ? (sim.location() || {}).id || null : sim.locationWanted();
      if (id === shownLoc) return;
      shownLoc = id;
      const L = id ? sim.locations().find(l => l.id === id) : null;
      const lights = L ? makeFloor(scene, L) : [];
      scene.floorImg.setTexture(locKey(L ? id : null));
      for (const o of scene.locLights) o.setVisible(false);
      const c = L ? hexNum(L.light || (L.floor || {}).accent || "#ffd27a") : 0;
      lights.slice(0, 40).forEach(([x, y, k, own], i) => {
        const o = scene.locLights[i] || (scene.locLights[i] = scene.add.image(0, 0, "ftc-dot").setDepth(0.5).setBlendMode(Phaser.BlendModes.ADD));
        o.setPosition(x, y).setScale(7 * k).setTint(own || c).setAlpha(0.2).setVisible(true); o._k = i * 1.7;
      });
    }
    // the location's hazard on its way: a circle that fills up, or a band with the side it comes from
    function drawHazards(g, now) {
      const hz = st.haz && st.haz.list; if (!hz || !hz.length) return;
      for (const h of hz) {
        const k = Math.max(0, Math.min(1, 1 - (h.at - st.t) / (h.warn || 1.2)));
        if (h.k === "strike") {
          g.fillStyle(h.c, 0.10 + 0.24 * k); g.fillCircle(h.x, h.y, h.r * k);
          g.lineStyle(2.5, h.c, 0.85); g.strokeCircle(h.x, h.y, h.r);
          g.lineStyle(1.5, 0xffffff, 0.5); g.strokeCircle(h.x, h.y, h.r * 0.3);
        } else if (st.t < h.at) {
          g.fillStyle(h.c, 0.06 + 0.12 * k); g.fillRect(0, h.y - h.r, st.W, h.r * 2);
          g.lineStyle(2, h.c, 0.7); g.strokeRect(-4, h.y - h.r, st.W + 8, h.r * 2);
          const x0 = h.dir > 0 ? 14 : st.W - 14;                              // chevrons on the side it comes from
          g.lineStyle(4, 0xffffff, 0.35 + 0.4 * k);
          for (let i = 0; i < 3; i++) { const x = x0 + h.dir * i * 16; g.beginPath(); g.moveTo(x, h.y - 14); g.lineTo(x + h.dir * 10, h.y); g.lineTo(x, h.y + 14); g.strokePath(); }
        } else {
          g.fillStyle(h.c, 0.16); g.fillRect(h.dir > 0 ? h.x - 190 : h.x + 40, h.y - h.r, 150, h.r * 2);
          g.fillStyle(h.c, 0.42); g.fillRect(h.x - 40, h.y - h.r, 80, h.r * 2);
          g.lineStyle(4, 0xffffff, 0.6); g.beginPath();
          for (let y = -h.r; y <= h.r; y += 14) { const x = h.x + h.dir * (36 + Math.sin(y / 18 + now * 9) * 6); if (y === -h.r) g.moveTo(x, h.y + y); else g.lineTo(x, h.y + y); }
          g.strokePath();
        }
      }
    }
    const grab = (arr, factory) => { for (const o of arr) if (!o.visible) { o.setVisible(true); return o; } const o = factory(); arr.push(o); return o; };

    function sceneCreate() {
      scene = this;
      makeTextures(this);
      this.floorImg = this.add.image(0, 0, "ftc-floor").setOrigin(0);
      this.locLights = [];
      this.zonesG = this.add.graphics().setDepth(1);       // spell zones, under the horde
      this.aura = this.add.graphics();
      this.bossImg = this.add.image(0, 0, "ftc-boss").setDepth(4).setVisible(false);
      this.flash = this.add.image(st.W / 2, FlashSim.H / 2, "ftc-flash").setDepth(5);
      this.swings = this.add.graphics().setDepth(6);
      // lightning and the nuke's core glow, added on top of what's under them (so they shine)
      this.glowG = this.add.graphics().setDepth(6.2).setBlendMode(Phaser.BlendModes.ADD);
      this.hpG = this.add.graphics().setDepth(6);          // health bars over elites and the boss
      this.eyes = [0, 1].map(() => this.add.image(0, 0, "ftc-eyebolt").setDepth(5.5).setVisible(false));
      this.game.loop.targetFps = 60;
      // a click on empty ground lets go of a picked gem
      this.input.on("pointerdown", (p, over) => { if (!over || !over.length) deselect(); });
    }

    function handleEvents(events) {
      let texts = 0, deaths = 0;
      const tnow = performance.now();
      if (bulk.n && tnow - bulk.at > 450) { const n = bulk.n; spawnText(bulk.x / n, bulk.y / n - 24, "+" + fmtN(bulk.v), "#ffb35c", bulk.v >= 1000 ? 22 : 17); bulk = { v: 0, x: 0, y: 0, n: 0, at: tnow }; }
      for (const e of events) {
        if (e.t === "hit") {
          SFX.play("hit");
          // a few numbers a frame where they hit (crits big and gold, "!"); the
          // rest add up and show as one number now and then (Dan: "dps, high dmg..")
          // numbers coloured by element (crits stay big and gold)
          if (A("damage_numbers") && texts < Math.min(Q().texts, st.wave ? 3 : 6) && (e.crit || events.length < 60)) { texts++; use("damage_numbers"); spawnText(e.x, e.y - 10, e.crit ? fmtN(e.v) + "!" : fmtN(e.v), e.crit ? "#ffd23a" : EL_TXT[e.el] || "#ffffff", e.crit ? (e.v >= 100 ? 24 : 20) : e.el && EL_TXT[e.el] ? 14 : 13); }
          if (e.big) screenFlash(0xfff4d6, 0.6);
          else if (A("damage_numbers")) { bulk.v += e.v; bulk.x += e.x; bulk.y += e.y; bulk.n++; }
          if (A("hit_sparks") && fx.length < 400) { use("hit_sparks"); fx.push({ k: "spark", x: e.x, y: e.y, r: 3, life: 0.15, max: 0.15, c: C.impact }); }
        } else if (e.t === "death") {
          deaths++; if (!e.quiet) SFX.play("kill");
          // a funny death of its own, by what did it (within the quality's budget)
          if (!e.quiet && e.how && e.how !== "pop" && A("funny_deaths") && deaths < Q().bones && fx.length < Q().fx) { use("funny_deaths"); deathFx(e); continue; }
          if (deaths < 30 && !e.quiet && A("death_particles")) { use("death_particles"); for (let i = 0; i < 3; i++) burst(e.x, e.y, e.colour || C.death, 120); }
          if (A("bone_shards") && deaths < Q().bones) { use("bone_shards"); boneShard(e.x, e.y); if (deaths < 30) boneShard(e.x, e.y); }
          // skulls roll, helmets pop
          if (!e.quiet && A("funny_deaths") && deaths < Q().bones / 3 && fx.length < Q().fx) {
            if (e.type === "skeleton_armoured" || (e.elite && Math.random() < 0.5)) corpse("fly", e.x, e.y - 8, "ftc-helmet", 0xffffff, { vx: (Math.random() - 0.5) * 120, vy: -260 - Math.random() * 80, vr: (Math.random() - 0.5) * 14, life: 0.9, g: 700 });
            else if (Math.random() < 0.18) corpse("roll", e.x, e.y + 4, "ftc-skel", e.colour || 0xe8e2d0, { vx: (Math.random() < 0.5 ? -1 : 1) * (90 + Math.random() * 80), life: 1.1, sx: 0.6 });
          }
        } else if (e.t === "pop") {
          SFX.play("pop");
          if (A("chain_pops") && fx.length < 450) { use("chain_pops"); fx.push({ k: "ring", x: e.x, y: e.y, r: e.r, life: 0.22, max: 0.22, c: 0xffe6a0 }); }
        } else if (e.t === "fire") {
          if (A("flash_squash")) { kick = 0.08; use("flash_squash"); }
        } else if (e.t === "mega_start") {
          if (A("banners")) { use("banners"); banner(e.banner || `${e.name}!`, `${e.total.toLocaleString()} skeletons · mow them down!`); }
          shake(300, 0.006);
        } else if (e.t === "ambush") {
          // no warning: the banner comes with the ring already there
          banner(e.banner || "😱 AMBUSH!", `${e.total.toLocaleString()} skeletons · they're all around you!`);
          SFX.play("level");
          shake(450, 0.01);
        } else if (e.t === "mega_gap") {
          if (A("banners")) { use("banners"); banner(`Breathe! Wave ${e.part} of ${e.parts} in ${e.gap}s`, `☠ coming from ${SIDE_NAME[e.side] || "somewhere"}`); }
        } else if (e.t === "mega_part") {
          if (A("banners")) { use("banners"); banner(`💀 Wave ${e.part} of ${e.parts}`, `${e.total.toLocaleString()} more · keep going!`); }
          shake(250, 0.005);
        } else if (e.t === "mega_end") {
          if (e.ambush) { floatText(`😮‍💨 Ambush survived! ${e.total.toLocaleString()} skeletons`); continue; }
          lastWave = e;          // shown at the top of the break screen instead of a banner
        } else if (e.t === "explode") {
          SFX.play("explode");
          if (A("explosion_rings")) { use("explosion_rings");
            fx.push({ k: "ring", x: e.x, y: e.y, r: e.r, life: 0.35, max: 0.35, c: e.c || (e.enemy ? 0xff5a5a : C.explosion) });
            for (let i = 0; i < 6; i++) burst(e.x, e.y, e.c || C.explosion, 200); }
        } else if (e.t === "swing") {
          SFX.play("swing");
          if (A("swing_arcs")) { use("swing_arcs"); fx.push({ k: "arc", x: e.x, y: e.y, a: e.a, r: e.r, w: e.arc || 1.1, life: e.arc ? 0.22 : 0.16, max: e.arc ? 0.22 : 0.16, c: e.arc ? 0xffe7a8 : 0xffffff }); }
        } else if (e.t === "stab") {
          if (A("hit_sparks")) { use("hit_sparks"); fx.push({ k: "spark", x: e.x, y: e.y, r: 7, life: 0.12, max: 0.12, c: 0xffffff }); }
        } else if (e.t === "hurt") {
          SFX.play("hurt");
          shake(70, 0.0025);
          if (A("flash_hurt")) use("flash_hurt");
        } else if (e.t === "cast") {
          SFX.play("cast");
          if (A("spell_fx") && castOk()) { use("spell_fx"); spellFx(e); }
        } else if (e.t === "location") {
          if (e.id && A("banners")) { use("banners"); banner(`${e.icon} ${e.name}`, e.thai ? `${e.thai} · a new place` : "a new place"); }
        } else if (e.t === "hazard_warn") {
          floatText(`${e.icon} ${e.name}!`, true);
        } else if (e.t === "hazard") {
          SFX.play("explode");
          if (e.kind === "strike") {
            shake(140, 0.004);
            if (A("explosion_rings")) { use("explosion_rings");
              fx.push({ k: "ring", x: e.x, y: e.y, r: e.r, life: 0.4, max: 0.4, c: e.c });
              if (fx.length < Q().fx) for (let i = 0; i < 8; i++) burst(e.x, e.y, e.c, 220); }
          }
        } else if (e.t === "boss") {
          SFX.play("boss");
          if (A("banners")) { use("banners"); banner(`👑 ${e.name} approaches!`, e.encounter || "A boss fight: the round won't end until it falls"); }
          shake(400, 0.008);
        } else if (e.t === "boss_phase") {
          if (A("banners")) { use("banners"); banner(`${e.name} is furious!`, `Phase ${e.phase}`); }
        } else if (e.t === "boss_down") {
          SFX.play("boss_down");
          if (A("banners")) { use("banners"); banner(`👑 ${e.name} defeated!`, `+${e.picks} free picks`); }
          for (let i = 0; i < 40; i++) burst(e.x, e.y, i % 2 ? 0xffd23a : 0xffffff, 520);
          shake(300, 0.01);
        } else if (e.t === "shield_hit") {
          if (st.flash) fx.push({ k: "ring", x: st.flash.x, y: st.flash.y, r: 34, life: 0.2, max: 0.2, c: 0x9cc8ff });
        } else if (e.t === "dash") {
          SFX.play("dash");
          // "in a flash": a blue shockwave and bolts in every direction
          if (A("flash_dash")) {
            use("flash_dash");
            for (let i = 0; i < 3; i++) fx.push({ k: "ring", x: e.x, y: e.y, r: e.r * (0.55 + i * 0.25), life: 0.45 + i * 0.1, max: 0.45 + i * 0.1, c: i ? BLUE : 0xffffff });
            for (let i = 0; i < 10; i++) { const a = i / 10 * 6.283 + Math.random() * 0.3;
              fx.push({ k: "zap", pts: zigzag(e.x, e.y, e.x + Math.cos(a) * e.r, e.y + Math.sin(a) * e.r, 22), life: 0.3, max: 0.3 }); }
            for (let i = 0; i < 26; i++) burst(e.x, e.y, i % 2 ? BLUE : BLUE_HI, 420);
            shake(140, 0.006);
            floatText(`⚡ FLASH! ×${e.streak} in a row`, false, true);
            dashT = 0.35;
          }
        } else if (e.t === "combo") {
          // 🔥🧊 steam, ⚡🧊 superconduct, ⚡🔥 overload
          SFX.play(e.k === "steam" ? "steam" : e.k === "overload" ? "overload" : "shatter");
          if (A("elements") && fx.length < Q().fx) { use("elements"); comboFx(e); }
        } else if (e.t === "big") {
          // the screen flashes on big hits (capped, gentle, can be turned off)
          const col = { nuke: 0xfff6c8, strike: 0xffffff, revive: 0xffe08a, steam: 0xeef6fa, overload: 0xffc070, superconduct: 0xbfefff }[e.k] || 0xffffff;
          screenFlash(col, e.k === "nuke" || e.k === "revive" ? 1 : 0.55);
        } else if (e.t === "nuke") {
          SFX.play("nuke");
          if (A("elements")) { use("elements"); nukeFx(e); }
          shake(700, 0.016);
          if (A("banners")) banner("☢️ NUCLEAR HAIRBALL!", `${e.n.toLocaleString()} skeletons caught in it`);
        } else if (e.t === "paw") {
          SFX.play(e.k === "grab" ? "grab" : "throw");
          if (e.k === "throw" && A("paws")) { use("paws"); for (let i = 0; i < 5; i++) burst(e.x, e.y, 0xff9f5a, 160); }
        } else if (e.t === "strike") {
          SFX.play("strike");
          if (A("paws")) { use("paws"); spawnText(e.x, e.y - 30, e.n >= 10 ? `🎳 STRIKE ×${e.n}!!` : `🎳 STRIKE! ×${e.n}`, "#ffe7a8", e.n >= 10 ? 26 : 21); }
          if (e.n >= 10) shake(160, 0.006);
        } else if (e.t === "fish") {
          if (e.k === "got") { SFX.play("fish"); spawnText(e.x, e.y - 16, "+🐟", "#9fd8ff", 16); }
          else if (e.k === "eat") {
            SFX.play("eat");
            if (st.flash) { fx.push({ k: "ring", x: st.flash.x, y: st.flash.y, r: 46, life: 0.5, max: 0.5, c: C.healing }); for (let i = 0; i < 10; i++) burst(st.flash.x, st.flash.y, C.healing, 180);
              spawnText(st.flash.x, st.flash.y - 40, `🐟 +${e.heal}`, "#7dffb0", 18); }
            if (e.auto) floatText(`🐟 Flash ate a fish (${e.n} left)`);
          } else if (e.k === "scoop") floatText(`🐟 Scooped up ${e.got} fish (${e.n} in his arms)`);
          updateFish();
        } else if (e.t === "revive") {
          // 😼 Nine Lives: he gets back up
          SFX.play("revive");
          if (A("banners")) banner("😼 Nine lives!", e.left > 0 ? `Flash is back up · ${e.left} more` : "Flash is back up · that was the last one");
          for (let i = 0; i < 3; i++) fx.push({ k: "ring", x: e.x, y: e.y, r: e.r * (0.4 + i * 0.3), life: 0.5 + i * 0.12, max: 0.5 + i * 0.12, c: i ? 0xffd23a : 0xffffff });
          for (let i = 0; i < 30; i++) burst(e.x, e.y, i % 2 ? 0xffd23a : 0xfff4c0, 460);
          shake(250, 0.01);
        } else if (e.t === "tag") {
          // a tag's tier switched on
          SFX.play("levelup");
          if (A("banners")) { use("banners"); banner(`${e.icon} ${e.name} ${"I".repeat(e.tier)}: ${e.tname}`, e.desc); }
          else floatText(`${e.icon} ${e.name} ${"I".repeat(e.tier)}: ${e.tname}`);
        } else if (e.t === "evolved") {
          SFX.play("boss_down");
          if (A("banners")) { use("banners"); banner(`${e.icon} ${e.name}!`, `${e.from} evolved`); } else floatText(`${e.icon} ${e.from} evolved: ${e.name}!`);
          if (st.flash && st.phase === "fight") { for (let i = 0; i < 3; i++) fx.push({ k: "ring", x: st.flash.x, y: st.flash.y, r: 60 + i * 50, life: 0.5 + i * 0.12, max: 0.5 + i * 0.12, c: i ? 0xffd23a : 0xffffff });
            for (let i = 0; i < 24; i++) burst(st.flash.x, st.flash.y, i % 2 ? 0xffd23a : 0xfff4c0, 380); }
        } else if (e.t === "arc") {
          // ⚡ a weapon hit arcing to the skeletons next to it (within the spell-effects budget)
          if (A("elements") && fx.length < Q().fx && castOk()) { use("elements");
            for (let i = 1; i < e.pts.length; i++) { const a = e.pts[0], b = e.pts[i];
              fx.push({ k: "bolt", pts: zigzag(a.x, a.y, b.x, b.y, 12), br: [], life: 0.22, max: 0.22, c: 0xd8c8ff });
              fx.push({ k: "spark", glow: true, x: b.x, y: b.y, r: 7, life: 0.18, max: 0.18, c: 0xd8c8ff }); } }
        } else if (e.t === "levelup") {
          SFX.play("levelup");
          if (A("level_up_ring")) { use("level_up_ring"); floatText(`LEVEL ${e.level}!`); fx.push({ k: "ring", x: st.flash.x, y: st.flash.y, r: 90, life: 0.5, max: 0.5, c: 0x7cc4ff }); }
        } else if (e.t === "reward") {
          SFX.play(e.bad ? "wrong" : "reward");
          if (A("reward_fx")) { use("reward_fx"); floatText(e.text, e.bad, !e.bad);
            if (!e.bad) fx.push({ k: "ring", x: st.flash.x, y: st.flash.y, r: 60, life: 0.6, max: 0.6, c: BLUE }); }
          if (!e.bad && A("study_bolts") && st.flash) {
            use("study_bolts");
            fx.push({ k: "zap", pts: zigzag(st.flash.x + (Math.random() - 0.5) * 60, Math.max(0, st.flash.y - 520), st.flash.x, st.flash.y - 8, 34), life: 0.32, max: 0.32 });
            eyesT = 0.7;                                   // lightning in his eyes
          }
        } else if (e.t === "danger") {
          announce(e.on ? "danger" : "safe");       // the site can use this to nudge the learner towards a quiz
          if (e.on) maybeRescue();
          if (e.on && A("danger_alarm")) use("danger_alarm");
          if (e.on) SFX.play("danger");
        } else if (e.t === "rush") {
          if (A("banners")) { use("banners"); banner("The last ones charge!", ""); }
        } else if (e.t === "round_end") { SFX.play("round"); closeQuestion(); showBreak(); announce("round_end"); sendTel(); }
        else if (e.t === "resumed") { if (learn) { endLearnGems(); learn = null; } clearGems(); rescueChain = 0; runWords = {}; closeQuestion(); showBreak(); announce("round_end"); }
        else if (e.t === "over") {
          saveSet("run", null);                    // a run that's over can't be continued
          const best = SAVE.get().best || {};
          if ((st.round || 0) > (best[mode] || 0)) { best[mode] = st.round; saveSet("best", best); }
          clearGems(); closeQuestion(); announce("died"); sendTel();
          // a beautiful kitty death: slow motion, Flash curls up for a nap, then the run's words
          if (A("kitty_death") && !st.practice && st.flash) startNap(); else { SFX.play("over"); showOver(); }
        }
        else if (e.t === "practice") { if (e.on) { endNap(true); hideOverlay(); } }
        else if (e.t === "start" || e.t === "round_start") {
          if (e.t === "start") {
            endNap(true);
            if (learn) { endLearnGems(); learn = null; }
            clearGems(); rescueChain = 0; runWords = {};
            // a bonus item earned in learning mode (one per run)
            const sv = ftcSave.get(), b = (sv.bonus || []).filter(x => x && x.id);
            if (b.length) {
              const it = sim.grantItem(b[0].id);
              sv.bonus = b.slice(1); ftcSave.set(sv);
              if (it) setTimeout(() => { floatText(`🎁 Study bonus: ${it.name}`, false, true); if (A("banners")) banner(`🎁 ${it.name}`, "your study bonus"); }, 400);
            }
          }
          hideOverlay(); announce(e.t === "start" ? "started" : "round_start");
          newThisRound = 0;
          const loc = sim.location && sim.location();
          if (e.t === "round_start" && A("banners")) { use("banners"); banner(`Round ${e.round}`, ""); }
          else if (e.t === "start" && loc && A("banners")) { use("banners"); banner(`${loc.icon || "📍"} ${loc.name}`, loc.thai || ""); }
        }
      }
    }
    function burst(x, y, c, sp) {
      if (fx.length > 500) return;
      const a = Math.random() * 6.283, s = sp * (0.4 + Math.random() * 0.6);
      fx.push({ k: "part", x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, r: 2 + Math.random() * 2.5, life: 0.45, max: 0.45, c });
    }
    function boneShard(x, y) {
      if (fx.length > 520) return;
      const a = -Math.PI / 2 + (Math.random() - 0.5) * 2.4, s = 90 + Math.random() * 120;
      fx.push({ k: "bone", x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, rot: Math.random() * 6, vr: (Math.random() - 0.5) * 18,
                life: 0.6, max: 0.6, c: 0xece4d0 });
    }
    // ---- Round 3 step 3: elements, funny deaths, paws, fish, the kitty death
    // damage numbers by element (Dan: "colours by element come with Step 3")
    const EL_TXT = { fire: "#ffa04a", burn: "#ff8a3a", ice: "#a8ecff", shards: "#cdf6ff", lightning: "#d9c8ff", superconduct: "#7fe0ff",
                     overload: "#ffbe5c", steam: "#eef6fa", nuclear: "#c8ff5a", rad: "#9dff5a", poison: "#9fe36a", dark: "#c8a0ff",
                     holy: "#fff0a0", arcane: "#8fc8ff", earth: "#d8b080", wind: "#dff5ec" };
    // ⚡ lightning in several colours, thick and glowing (Dan: "chain lightning kinda difficult to see")
    const BOLT_COLOURS = [0x8fd0ff, 0xd8b8ff, 0xfff27a, 0x7affd4, 0xff9ce8];
    let boltI = 0;
    function corpse(mode, x, y, tex, c, o) {
      o = o || {};
      const life = o.life || 0.6;
      fx.push(Object.assign({ k: "corpse", mode, x, y, tex, c, vx: 0, vy: 0, rot: 0, vr: 0, sx: 1, sy: 1, g: 0, life, max: life }, o));
    }
    function deathFx(e) {
      const sz = e.size || 1, c = e.colour || 0xe8e2d0, rm = reducedMotion();
      if (e.how === "ash") {
        // 🔥 crumbles to ash (green when it was the nuke's glow)
        const ash = e.el === "rad" || e.el === "nuclear" ? 0x6a9a4a : 0x4a4440;
        corpse("ash", e.x, e.y, "ftc-skel", ash, { sx: sz, sy: sz, life: 0.55 });
        for (let i = 0; i < 4; i++) fx.push({ k: "part", rise: true, x: e.x + (Math.random() - 0.5) * 14, y: e.y, vx: (Math.random() - 0.5) * 20, vy: -30 - Math.random() * 40, r: 2.5, life: 0.7, max: 0.7, c: i ? 0x7a726a : 0xff8a3a });
      } else if (e.how === "shatter") {
        // 🧊 shatters into ice
        SFX.play("shatter");
        for (let i = 0; i < 7; i++) { const a = Math.random() * 6.283, sp = 120 + Math.random() * 160;
          corpse("fly", e.x, e.y, "ftc-shard", i % 3 ? 0xbfefff : 0xffffff, { vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 60, vr: (Math.random() - 0.5) * 20, rot: a, g: 380, life: 0.55, sx: 0.8 + Math.random() * 0.6 }); }
        fx.push({ k: "ring", x: e.x, y: e.y, r: 18 * sz, life: 0.2, max: 0.2, c: 0xe8fbff });
      } else if (e.how === "zap") {
        // ⚡ the zapped dance: it jitters, lit up like an x-ray, then drops
        SFX.play("zap");
        corpse("zap", e.x, e.y, "ftc-skel", c, { sx: sz, sy: sz, life: rm ? 0.3 : 0.6 });
      } else if (e.how === "pins") {
        // 🎳 knocked flying like a bowling pin
        const dir = Math.random() < 0.5 ? -1 : 1;
        corpse("fly", e.x, e.y, "ftc-skel", c, { vx: (e.dx || 0) * 160 + dir * (120 + Math.random() * 120), vy: -280 - Math.random() * 160, vr: dir * (14 + Math.random() * 10), g: 900, sx: sz, sy: sz, life: 0.85 });
        boneShard(e.x, e.y);
      } else if (e.how === "launch") {
        // launched off into the distance... with a twinkle
        const tx = (e.dx || 0) * 220 + (Math.random() - 0.5) * 80, ty = -420 - Math.random() * 140, life = 0.8;
        corpse("launch", e.x, e.y, "ftc-skel", c, { vx: tx / life, vy: ty / life, vr: 16, sx: sz, sy: sz, life });
        corpse("twinkle", e.x + tx, e.y + ty, "ftc-star", 0xffffff, { wait: life, life: 0.45, sx: 1.4 });
      }
    }
    function comboFx(e) {
      if (e.k === "steam") {
        for (let i = 0; i < 6; i++) { const a = Math.random() * 6.283, d = Math.random() * e.r * 0.5;
          fx.push({ k: "puff", x: e.x + Math.cos(a) * d, y: e.y + Math.sin(a) * d, r: e.r * (0.35 + Math.random() * 0.3), life: 0.7, max: 0.7, c: 0xeef6fa }); }
        maybeLabel("steam", e.x, e.y, "💨 Steam burst!", "#eef6fa");
      } else if (e.k === "overload") {
        fx.push({ k: "ring", x: e.x, y: e.y, r: e.r, life: 0.3, max: 0.3, c: 0xffa040 });
        for (let i = 0; i < 10; i++) burst(e.x, e.y, i % 2 ? 0xffd27a : 0xd8b8ff, 260);
        maybeLabel("overload", e.x, e.y, "⚡🔥 Overload!", "#ffbe5c");
      } else {
        fx.push({ k: "ring", x: e.x, y: e.y, r: 36, life: 0.3, max: 0.3, c: 0x7fe0ff });
        for (let i = 0; i < 4; i++) { const a = i * 1.571 + Math.random() * 0.4; fx.push({ k: "bolt", pts: zigzag(e.x, e.y, e.x + Math.cos(a) * 40, e.y + Math.sin(a) * 40, 10), br: [], life: 0.25, max: 0.25, c: 0x7fe0ff }); }
        maybeLabel("superconduct", e.x, e.y, "⚡🧊 Superconduct!", "#7fe0ff");
      }
    }
    const labelAt = {};
    function maybeLabel(k, x, y, text, colour) {
      const now = performance.now(); if (now - (labelAt[k] || 0) < 1800) return; labelAt[k] = now;
      spawnText(x, y - 28, text, colour, 15);
    }
    function nukeFx(e) {
      fx.push({ k: "glow", x: e.x, y: e.y, r: e.r * 0.8, life: 0.7, max: 0.7, c: 0xfff6c8 });
      for (let i = 0; i < 4; i++) fx.push({ k: "ring", x: e.x, y: e.y, r: e.r * (0.5 + i * 0.25), life: 0.6 + i * 0.15, max: 0.6 + i * 0.15, c: [0xffffff, 0xfff27a, 0xffa040, 0x9dff5a][i] });
      for (let i = 0; i < 46; i++) burst(e.x, e.y, [0xfff27a, 0xffa040, 0x9dff5a, 0xffffff][i % 4], 700);
    }
    // 🐟 eat one (the button, H, or the bench)
    function eatFish() {
      if (sim.eatFish()) return true;
      const f = st.flash;
      if (f && st.fish > 0 && f.hp >= f.maxHp() - 0.5) floatText("🐟 Flash is full: save it for later");
      else if (!st.fish && (st.phase === "fight" || st.phase === "break")) floatText("🐟 No fish yet: skeletons drop them now and then");
      return false;
    }
    let fishShown = -1, livesShown = -1;
    function updateFish() {
      const live = st.phase === "fight" || st.phase === "break";
      const n = live ? st.fish || 0 : 0;
      fishBtn.style.display = live ? "" : "none";
      if (n !== fishShown) {
        fishShown = n; fishBtn.textContent = `🐟 ${n}`;
        fishBtn.classList.remove("got"); void fishBtn.offsetWidth; if (n > 0) fishBtn.classList.add("got");
      }
      fishBtn.classList.toggle("empty", !n);
      const f = st.flash, low = live && f && f.hp / f.maxHp() < 0.35 && n > 0;
      fishBtn.classList.toggle("hungry", !!low);
      const lv = live && st.flash ? sim.livesLeft() : 0;
      if (lv !== livesShown) { livesShown = lv; livesEl.textContent = lv ? `😼 ×${lv}` : ""; }
    }
    // ---- the kitty death (Dan: "a beautiful kitty death"): slow motion, the
    // camera drifts in, Flash curls up for a nap, then the run's words
    let nap = null;
    function startNap() {
      const f = st.flash, rm = reducedMotion();
      nap = { t: 0, dur: rm ? 1.8 : 3.6, x: f.x, y: f.y, z: 0, rm };
      SFX.play("nap");
      napEl.innerHTML = "<span>💤 tap to skip</span>"; napEl.classList.add("show");
      napEl.onclick = () => finishNap();
      if (!rm && scene) { const cam = scene.cameras.main; cam.pan(f.x, f.y, 1400, "Sine.easeInOut"); cam.zoomTo(1.7, 1600, "Sine.easeInOut"); }
      root.classList.add("ftc-napping");
    }
    function finishNap() {
      if (!nap) return;
      nap.done = true;
      napEl.classList.remove("show"); napEl.onclick = null;
      if (st.phase === "over" && !optsOpen) showOver();
    }
    function endNap(resetCam) {
      nap = null; napEl.classList.remove("show"); napEl.onclick = null; root.classList.remove("ftc-napping");
      if (resetCam && scene) { const cam = scene.cameras.main; cam.resetFX(); cam.setZoom(1); cam.centerOn(st.W / 2, FlashSim.H / 2); }
      if (scene) scene.flash.setTexture("ftc-flash");
    }
    let bulk = { v: 0, x: 0, y: 0, n: 0, at: 0 };          // hits with no number of their own, added up
    function spawnText(x, y, text, colour, size) {
      if (!scene) return;
      const t = grab(pools.texts, () => scene.add.text(0, 0, "", { fontFamily: "Segoe UI, sans-serif", fontStyle: "bold", stroke: "#000", strokeThickness: 3 }).setDepth(20).setOrigin(0.5));
      t.setText(text).setPosition(x, y).setColor(colour).setFontSize(size).setAlpha(1);
      t.life = 0.6;
    }
    function floatText(text, bad, study) {
      const d = h("div", bad ? "bad" : study ? "study" : "", esc(text)); floatEl.append(d); setTimeout(() => d.remove(), 1600);
    }
    // ------------------------------------------------------- spell effects
    const lastName = {};
    function spellFx(e) {
      const f = st.flash, c = e.c || 0xb59aff;
      if (f && (lastName[e.s] || 0) < performance.now() - 4000 && sim.D && data.spells) {
        lastName[e.s] = performance.now();
        const sp = (data.spells || []).find(x => x.id === e.s);
        if (sp) spawnText(f.x, f.y - 46, `${icon("spells", sp.id, "")} ${sp.name}`.trim(), "#" + c.toString(16).padStart(6, "0"), 14);
      }
      if (e.k === "chain") {
        // thick and glowing, a different colour each cast, with little forks, and a flare on each skeleton it jumps to
        const bc = A("elements") ? BOLT_COLOURS[boltI++ % BOLT_COLOURS.length] : c;
        for (let i = 1; i < e.pts.length; i++) {
          const a = e.pts[i - 1], b = e.pts[i], pts = zigzag(a.x, a.y, b.x, b.y, 16), br = [];
          if (A("elements") && pts.length > 3) { const k = 1 + ((Math.random() * (pts.length - 2)) | 0), p = pts[k], ang = Math.atan2(b.y - a.y, b.x - a.x) + (Math.random() < 0.5 ? -0.8 : 0.8);
            br.push(zigzag(p.x, p.y, p.x + Math.cos(ang) * 34, p.y + Math.sin(ang) * 34, 9)); }
          fx.push({ k: "bolt", pts, br, life: 0.42, max: 0.42, c: bc });
          fx.push({ k: "spark", glow: true, x: b.x, y: b.y, r: 11, life: 0.3, max: 0.3, c: bc });
        }
      } else if (e.k === "nova" || e.k === "quake" || e.k === "holy" || e.k === "souls" || e.k === "slow") {
        fx.push({ k: "ring", x: e.x, y: e.y, r: e.r, life: 0.5, max: 0.5, c });
        fx.push({ k: "ring", x: e.x, y: e.y, r: e.r * 0.7, life: 0.4, max: 0.4, c: 0xffffff });
        for (let i = 0; i < 22; i++) { const a = Math.random() * 6.283, d = Math.random() * e.r; burst(e.x + Math.cos(a) * d, e.y + Math.sin(a) * d, c, 120); }
        if (e.k === "quake") shake(260, 0.008);
      } else if (e.k === "nuke") {
        // ☢️ the hairball, lobbed: a warning circle where it will land
        const life = Math.max(0.3, e.at - st.t);
        fx.push({ k: "warn", x: e.x, y: e.y, r: e.r, life, max: life, c: 0x9dff5a });
        if (f) corpse("lob", f.x, f.y, "ftc-hairball", 0xffffff, { tx: e.x, ty: e.y, x0: f.x, y0: f.y, life, sx: 1.3 });
        if (A("banners")) floatText("☢️ Nuclear Hairball incoming!");
      } else if (e.k === "meteors") {
        const now = st.t;
        for (const d of e.drops) fx.push({ k: "warn", x: d.x, y: d.y, r: e.r, life: Math.max(0.2, d.at - now), max: Math.max(0.2, d.at - now), c });
      } else if (e.k === "plague" || e.k === "curse" || e.k === "convert") {
        for (const p of e.pts || [{ x: e.x, y: e.y }]) for (let i = 0; i < 8; i++) burst(p.x, p.y, c, 140);
      } else if (e.k === "mark") {
        fx.push({ k: "ring", x: e.x, y: e.y, r: 40, life: 0.4, max: 0.4, c: 0xff4a6a });
      } else if (f && (e.k === "shield" || e.k === "heal" || e.k === "summon" || e.k === "drain" || e.k === "tornado")) {
        fx.push({ k: "ring", x: f.x, y: f.y, r: 50, life: 0.4, max: 0.4, c });
      }
    }
    // zones, telegraphs, the shield and summons are drawn every frame from the game state
    function drawSpells(s, dt) {
      const g = s.zonesG, now = performance.now() / 1000, sq = SQ();
      g.clear();
      for (const z of st.zones) {
        const left = Math.min(1, Math.max(0, (z.until - st.t) / 0.4));
        if (!sq.detail) { g.fillStyle(z.k === "heal" ? 0x5aff9a : z.k === "tornado" || z.k === "rad" ? z.c : 0x7c5cff, 0.12 * left); g.fillCircle(z.x, z.y, z.r || 40); continue; }
        if (z.k === "tornado") {
          for (let i = 0; i < 4; i++) {
            const a = now * 7 + i * 1.57, r = z.r * (0.35 + i * 0.18);
            g.lineStyle(3, z.c, 0.55 * left); g.beginPath(); g.arc(z.x, z.y, r, a, a + 2.2); g.strokePath();
          }
          g.fillStyle(z.c, 0.10 * left); g.fillCircle(z.x, z.y, z.r);
        } else if (z.k === "slow") {
          g.fillStyle(0x7c5cff, 0.12 * left); g.fillCircle(z.x, z.y, z.r);
          g.lineStyle(2, 0xb59aff, 0.5 * left); g.strokeCircle(z.x, z.y, z.r);
          const a = now * 1.2; g.lineStyle(2, 0xffffff, 0.4 * left); g.beginPath(); g.moveTo(z.x, z.y); g.lineTo(z.x + Math.cos(a) * z.r * 0.6, z.y + Math.sin(a) * z.r * 0.6); g.strokePath();
        } else if (z.k === "heal") {
          const p = (now * 1.6) % 1;
          g.lineStyle(3, 0x5aff9a, (1 - p) * 0.7 * left); g.strokeCircle(z.x, z.y, 24 + p * 46);
        } else if (z.k === "rad") {
          // ☢️ the glow left by a Nuclear Hairball: pulses slowly, motes rise
          const p2 = 0.5 + 0.5 * Math.sin(now * 3);
          g.fillStyle(0x9dff5a, (0.10 + 0.06 * p2) * left); g.fillCircle(z.x, z.y, z.r);
          g.lineStyle(3, 0xc8ff5a, (0.35 + 0.25 * p2) * left); g.strokeCircle(z.x, z.y, z.r);
          if (A("elements") && Math.random() < 0.5 && fx.length < Q().fx) { const a = Math.random() * 6.283, d = Math.random() * z.r;
            fx.push({ k: "part", rise: true, x: z.x + Math.cos(a) * d, y: z.y + Math.sin(a) * d, vx: 0, vy: -40, r: 2.2, life: 0.8, max: 0.8, c: 0xb6ff5a }); }
        } else if (z.k === "drain") {
          g.fillStyle(0xa66cff, 0.08 * left); g.fillCircle(z.x, z.y, z.r);
          for (const h of (z.hits || []).slice(0, 12)) { g.lineStyle(2, 0xc8a0ff, 0.6 * left); g.beginPath(); g.moveTo(h.x, h.y); g.lineTo(z.x, z.y); g.strokePath(); }
        }
      }
      drawHazards(g, now);
      // the location's lights flicker (steady with "reduce motion")
      if (s.locLights && s.locLights.length) { const still = reducedMotion(); for (const o of s.locLights) if (o.visible) o.setAlpha(still ? 0.2 : 0.17 + 0.06 * Math.sin(now * 5 + o._k) + 0.03 * Math.sin(now * 13 + o._k * 2)); }
      // boss attacks about to land: fill up, then hit
      for (const t of st.tele) {
        const tot = 1.15, k = Math.max(0, Math.min(1, 1 - (t.at - st.t) / tot));
        g.fillStyle(t.c || 0xff5a3a, 0.12 + 0.25 * k); g.fillCircle(t.x, t.y, t.r * k);
        g.lineStyle(2, t.c || 0xff5a3a, 0.8); g.strokeCircle(t.x, t.y, t.r);
      }
      // Magic Shield
      if (st.shield > 0 && st.shieldUntil > st.t && st.flash) {
        const k = st.shieldMax ? st.shield / st.shieldMax : 1;
        g.fillStyle(0x7cc4ff, 0.10 + 0.08 * k); g.fillCircle(st.flash.x, st.flash.y, 34);
        g.lineStyle(2, 0xbfe4ff, 0.5 + 0.4 * k); g.strokeCircle(st.flash.x, st.flash.y, 34 + Math.sin(now * 6) * 1.5);
      }
      // summons
      let i = 0;
      for (const a of st.allies) {
        if (i >= sq.allies) break;                 // the rest still fight, unseen
        const key = a.kind === "wolf" ? "ftc-wolf" : a.kind === "ghost_cat" ? "ftc-ghostcat" : "ftc-skel";
        let sp = pools.allies[i];
        if (!sp) sp = pools.allies[i] = s.add.image(0, 0, key).setDepth(4);
        if (sp.texture.key !== key) sp.setTexture(key);
        const fade = Math.min(1, (a.until - st.t) / 0.6);
        sp.setVisible(true).setPosition(a.x, a.y + Math.sin(now * 8 + a.id) * 2).setTint(a.kind === "bone" ? 0x9fe36a : a.c)
          .setAlpha((a.kind === "ghost_cat" ? 0.7 : 0.95) * fade).setScale((a.size || 1) * (a.face < 0 ? -1 : 1), a.size || 1);
        i++;
      }
      for (; i < pools.allies.length; i++) pools.allies[i].setVisible(false);
      if (st.allies.length) useF("spell_fx", st.allies.length);
    }

    // a jagged line from (x0,y0) to (x1,y1), for lightning
    function zigzag(x0, y0, x1, y1, seg) {
      const n = Math.max(2, Math.round(Math.hypot(x1 - x0, y1 - y0) / seg)), pts = [];
      const nx = -(y1 - y0), ny = x1 - x0, nl = Math.hypot(nx, ny) || 1;
      for (let i = 0; i <= n; i++) {
        const t = i / n, j = i === 0 || i === n ? 0 : (Math.random() - 0.5) * seg * 0.9;
        pts.push({ x: x0 + (x1 - x0) * t + nx / nl * j, y: y0 + (y1 - y0) * t + ny / nl * j });
      }
      return pts;
    }

    function draw(dt) {
      const s = scene; if (!s) return;
      // cleared first: the skeleton loop draws boss rings, elite health bars, Death Mark
      // reticles and ice blocks on these (they were cleared after it, so never showed)
      s.swings.clear(); s.hpG.clear(); s.glowG.clear();
      const W2 = st.flash ? st.flash.x : st.W / 2, H2 = st.flash ? st.flash.y : FlashSim.H / 2;
      // Flash
      for (const k in usedFrame) usedFrame[k] = 0;
      dashT = Math.max(0, dashT - dt);
      s.flash.setTint(dashT > 0 ? BLUE_HI : A("flash_hurt") && st.flash && st.flash.hurtT > 0 ? 0xff7a7a : 0xffffff).setVisible(st.phase !== "start");
      kick = Math.max(0, kick - dt);
      const bob = A("flash_bob") ? Math.sin(performance.now() / 300) * 0.03 : 0;
      if (bob) useF("flash_bob");
      const f0 = st.flash, lean = A("flash_lean") && f0 ? f0.vx / 400 : 0;
      if (lean) useF("flash_lean");
      s.flash.setPosition(W2, H2).setRotation(lean)
        .setScale((1 + bob + kick * 1.2) * (A("flash_lean") && f0 && f0.face < 0 ? -1 : 1), 1 + bob - kick * 1.5);
      // 😼 just revived: golden for a moment, can't be hurt
      if (f0 && st.safeUntil > st.t && st.phase === "fight") s.flash.setTint(Math.sin(performance.now() / 120) > 0 ? 0xffe08a : 0xfff4c0);
      // the kitty death: he tips over, then curls up and breathes slowly
      if (nap && st.phase === "over") {
        const k = nap.t / nap.dur, tip = Math.min(1, nap.t / 0.9);
        if (k < 0.3 && !nap.rm) { s.flash.setTexture("ftc-flash").setVisible(true).setTint(0xffd0b0).setRotation(tip * 1.3).setScale(1 - tip * 0.1).setPosition(nap.x, nap.y + tip * 4); }
        else { if (s.flash.texture.key !== "ftc-flash-curl") s.flash.setTexture("ftc-flash-curl");
          const br = 1 + Math.sin(performance.now() / 700) * 0.035;
          s.flash.setVisible(true).clearTint().setRotation(0).setPosition(nap.x, nap.y + 4).setScale(1.05 * br, 1.05 / br); }
      }
      // power-up: a lightning bolt over each eye, flickering, for a moment (longer after a Flash dash)
      eyesT = Math.max(eyesT - dt, dashT > 0 ? 0.35 : 0);
      const showEyes = eyesT > 0 && st.phase !== "start";
      for (let k = 0; k < 2; k++) {
        const ex = W2 + (k ? 7 : -7) * Math.cos(lean), ey = H2 + (k ? 7 : -7) * Math.sin(lean);
        const flick = 0.85 + Math.random() * 0.3;
        s.eyes[k].setVisible(showEyes).setPosition(ex, ey).setRotation(lean + (k ? 0.12 : -0.12))
          .setScale(flick * (0.9 + Math.min(1, eyesT) * 0.4)).setAlpha(Math.min(1, eyesT * 3));
      }
      // study aura grows with active buffs
      s.aura.clear();
      if (st.buffs.length && st.phase !== "start" && A("study_aura")) {
        useF("study_aura");
        const n = st.buffs.length, pulse = 0.5 + 0.5 * Math.sin(performance.now() / 250);
        s.aura.fillStyle(C.aura, 0.10 + 0.04 * pulse); s.aura.fillCircle(W2, H2, 30 + Math.min(n, 10) * 4 + pulse * 3);
        s.aura.lineStyle(2, 0xffd27a, 0.35 + 0.2 * pulse); s.aura.strokeCircle(W2, H2, 30 + Math.min(n, 10) * 4);
      }
      // enemies
      const es = st.enemies, now = performance.now();
      // past the quality's limit the crowd is drawn plainly: no waddle, lunge or
      // white flash one by one (elites keep theirs), so 10,000 stay smooth
      const crowd = st.enemies.length > Q().lod;
      const lunge = A("lunge") && !crowd, waddle = A("waddle") && !crowd, hitFlash = A("hit_flash"), elitePulse = A("elite_pulse");
      let i = 0, ri = 0, nL = 0, nW = 0, nH = 0, nE = 0, nPaw = 0, nFl = 0, nIce = 0;
      const napFade = nap ? Math.max(0.12, 1 - nap.t / 1.5 * 0.88) : 1;
      const elOn = A("elements") && !crowd, flameMax = Q().texts * 8, iceMax = Q().texts * 12;
      for (; i < es.length; i++) {
        const e = es[i];
        const sp = pools.enemies[i] || (pools.enemies[i] = s.add.image(0, 0, "ftc-skel").setDepth(3));
        const ph = now / 1000 * 9 + e.id * 1.7;
        if (e.attacking && lunge) {          // lunge at Flash
          const l = Math.max(0, Math.sin(ph * 1.4)) * 4, dx = W2 - e.x, dy = H2 - e.y, d = Math.hypot(dx, dy) || 1;
          sp.setPosition(e.x + dx / d * l, e.y + dy / d * l).setRotation(0).setScale(e.size * (1 + l * 0.015)); nL++;
        } else if (!e.attacking && waddle) { // waddle
          sp.setPosition(e.x, e.y + Math.abs(Math.sin(ph)) * -2).setRotation(Math.sin(ph) * 0.16).setScale(e.size); nW++;
        } else sp.setPosition(e.x, e.y).setRotation(0).setScale(e.size);
        // 🐾 in a paw: it wriggles; rolling: it spins
        if (e.held) { sp.setRotation(e.thrown ? now / 45 : Math.sin(now / 40) * 0.5).setScale(e.size * 1.12); nPaw++; }
        sp.setAlpha(napFade);
        if (e.boss) {                         // the boss is its own big sprite
          sp.setVisible(false);
          const bi = s.bossImg; bi.setVisible(true).setPosition(sp.x, sp.y).setScale(1 + Math.sin(now / 300) * 0.02);
          if (e.hitT > 0 && hitFlash) bi.setTintFill(0xffffff); else bi.clearTint();
          s.swings.lineStyle(3, e.colour, 0.7); s.swings.strokeCircle(e.x, e.y + 6, 40 + Math.sin(now / 200) * 2);
          drawHp(s.hpG, e.x, e.y - 58, 70, e.hp / e.max, 0xffd23a);
          continue;
        }
        sp.setVisible(true);
        const x = e.fx, tnow = st.t;
        if (e.hitT > 0 && hitFlash) { sp.setTintFill(0xffffff); nH++; }
        else if (x && A("status_tints")) {
          const frozen = (x.frozen || 0) > tnow, burning = x.burn && x.burn.until > tnow;
          const tint = frozen ? 0xbfefff : (x.stun || 0) > tnow ? 0xffffa0 : burning ? 0xff9a50
            : x.poison && x.poison.until > tnow ? 0x9fe36a : (x.curse || 0) > tnow ? 0xc08aff : (x.chill || 0) > tnow ? 0xd6f2ff : e.colour;
          sp.setTint(tint);
          // 🔥 burning ones give off flames, 🧊 frozen ones sit in a block of ice (a budget a frame)
          if (elOn && burning && nFl < flameMax && Math.random() < 0.35 && fx.length < Q().fx) { nFl++;
            fx.push({ k: "part", rise: true, x: e.x + (Math.random() - 0.5) * 12 * e.size, y: e.y - 6, vx: (Math.random() - 0.5) * 16, vy: -50 - Math.random() * 40, r: 2.2 + Math.random() * 2, life: 0.45, max: 0.45, c: Math.random() < 0.5 ? 0xffb347 : 0xff6a2a }); }
          if (elOn && frozen && nIce < iceMax) { nIce++; const r = 13 * e.size;
            s.swings.fillStyle(0xbfefff, 0.22); s.swings.fillRect(e.x - r, e.y - r, r * 2, r * 2);
            s.swings.lineStyle(1.5, 0xf0fdff, 0.85); s.swings.strokeRect(e.x - r, e.y - r, r * 2, r * 2);
            s.swings.lineBetween(e.x - r + 3, e.y - r + 3, e.x - r + 9, e.y - r + 3); }
          if ((x.mark || 0) > tnow) { s.swings.lineStyle(2, 0xff4a6a, 0.9); s.swings.strokeCircle(e.x, e.y, 16 * e.size); s.swings.lineBetween(e.x - 22, e.y, e.x - 10, e.y); s.swings.lineBetween(e.x + 10, e.y, e.x + 22, e.y); }
        } else sp.setTint(e.colour);
        if (e.elite) {      // rings only for elites, not one per skeleton
          const rg = pools.rings[ri] || (pools.rings[ri] = s.add.image(0, 0, "ftc-ring").setDepth(2)); ri++;
          rg.setVisible(true).setPosition(e.x, e.y).setScale(e.size * (elitePulse ? 0.95 + Math.sin(ph * 0.5) * 0.06 : 1));
          if (e.hp < e.max) drawHp(s.hpG, e.x, e.y - 20 * e.size - 6, Math.max(26, 26 * e.size), e.hp / e.max, 0xff5a5a);
          if (elitePulse) nE++;
        }
      }
      for (; i < pools.enemies.length; i++) pools.enemies[i].setVisible(false);
      if (!st.boss || !st.boss.alive) s.bossImg.setVisible(false);
      for (; ri < pools.rings.length; ri++) pools.rings[ri].setVisible(false);
      useF("lunge", nL); useF("waddle", nW); useF("hit_flash", nH); useF("elite_pulse", nE); useF("paws", nPaw); useF("elements", nFl + nIce);
      // 🐾 the paw reaching out to whatever it has grabbed
      let pi0 = 0;
      if (A("paws") && st.phase === "fight") for (const q of st.paws) {
        const e = q.e; if (!e || !e.alive) continue;
        const pw = pools.paws[pi0] || (pools.paws[pi0] = s.add.image(0, 0, "ftc-paw").setDepth(5.6)); pi0++;
        if (q.phase === "grab") {
          s.swings.lineStyle(9, 0xe8823e, 0.95); s.swings.lineBetween(W2, H2, e.x, e.y);
          s.swings.lineStyle(5, 0xff9f5a, 1); s.swings.lineBetween(W2, H2, e.x, e.y);
          pw.setVisible(true).setPosition(e.x, e.y - 4).setRotation(Math.atan2(e.y - H2, e.x - W2) + 1.57).setScale(1.4);
        } else {
          pw.setVisible(false);
          // a streak behind the ball
          s.swings.lineStyle(16, 0xffd27a, 0.18); s.swings.lineBetween(e.x - Math.cos(q.a) * 70, e.y - Math.sin(q.a) * 70, e.x, e.y);
          s.swings.lineStyle(6, 0xffffff, 0.35); s.swings.lineBetween(e.x - Math.cos(q.a) * 40, e.y - Math.sin(q.a) * 40, e.x, e.y);
        }
      }
      for (; pi0 < pools.paws.length; pi0++) pools.paws[pi0].setVisible(false);
      // 🐟 fish on the floor (blinking slowly when they're about to go)
      let fi0 = 0;
      for (const p of st.pickups) {
        const sp = pools.fish[fi0] || (pools.fish[fi0] = s.add.image(0, 0, "ftc-fish").setDepth(2.5)); fi0++;
        const left = p.until - st.t, blink = left < 4 && Math.floor(left * 2) % 2 === 0;
        sp.setVisible(st.phase === "fight").setPosition(p.x, p.y + Math.sin(now / 260 + p.id) * 3).setRotation(Math.sin(now / 400 + p.id) * 0.25).setAlpha(blink ? 0.45 : 1);
      }
      for (; fi0 < pools.fish.length; fi0++) pools.fish[fi0].setVisible(false);
      // projectiles
      i = 0;
      for (const p of st.proj) {
        const sp = pools.proj[i] || (pools.proj[i] = s.add.image(0, 0, "ftc-bolt").setDepth(4));
        const c = p.c || PROJ_COLOUR[p.b] || 0xffe08a;
        const spin = A("projectile_spin") && (p.b === "returning_projectile" || p.b === "bouncing_projectile");
        if (spin) useF("projectile_spin");
        sp.setVisible(true).setPosition(p.x, p.y).setTint(c)
          .setRotation(spin ? performance.now() / 60 : Math.atan2(p.vy, p.vx))
          .setScale(p.spell ? 1.4 : p.b === "explosive_projectile" ? 1.3 : 1, p.spell ? 2.8 : p.b === "explosive_projectile" ? 3 : spin ? 2 : 1);
        i++;
      }
      for (; i < pools.proj.length; i++) pools.proj[i].setVisible(false);
      i = 0;
      for (const p of st.eproj) {
        const sp = pools.eproj[i] || (pools.eproj[i] = s.add.image(0, 0, "ftc-dot").setDepth(4));
        sp.setVisible(true).setPosition(p.x, p.y).setTint(p.colour && p.src && p.src.boss ? p.colour : 0xff6a5a).setScale(p.src && p.src.boss ? 1.5 : 0.9); i++;
      }
      for (; i < pools.eproj.length; i++) pools.eproj[i].setVisible(false);
      // orbit blades
      i = 0;
      for (const w of st.weapons) for (const b of (w.blades || [])) {
        const sp = pools.blades[i] || (pools.blades[i] = s.add.image(0, 0, "ftc-blade").setDepth(5));
        sp.setVisible(st.phase === "fight").setPosition(b.x, b.y).setRotation(b.a + 1.57).setScale(1.4); i++;
      }
      for (; i < pools.blades.length; i++) pools.blades[i].setVisible(false);
      // effects
      // (s.swings and s.hpG are cleared at the top of draw(), before the skeletons draw their marks and bars)
      let pi = 0, bi = 0, ci = 0;
      const odt = dt;
      dt = nap ? dt * 0.3 : dt;                  // the kitty death: everything still moving goes slow-motion
      for (let k = fx.length - 1; k >= 0; k--) {
        const f = fx[k];
        if (f.wait > 0) { f.wait -= dt; continue; }
        f.life -= dt;
        if (f.life <= 0) { fx.splice(k, 1); continue; }
        const a = f.life / f.max;
        if (f.k === "ring") { s.swings.lineStyle(3, f.c, a); s.swings.strokeCircle(f.x, f.y, f.r * (1.15 - a * 0.6)); }
        else if (f.k === "arc") { s.swings.lineStyle(5, f.c, a * 0.8); s.swings.beginPath(); s.swings.arc(f.x, f.y, f.r * 0.8, f.a - (f.w || 1.1), f.a + (f.w || 1.1)); s.swings.strokePath(); }
        else if (f.k === "spark") { const g2 = f.glow ? s.glowG : s.swings; g2.fillStyle(f.c, a); g2.fillCircle(f.x, f.y, f.r * (1.5 - a * 0.5)); }
        else if (f.k === "warn") {
          s.swings.lineStyle(2, f.c, 0.9); s.swings.strokeCircle(f.x, f.y, f.r);
          s.swings.fillStyle(f.c, 0.25 * (1 - a)); s.swings.fillCircle(f.x, f.y, f.r * (1 - a));
        }
        else if (f.k === "zap") {
          s.swings.lineStyle(7, f.c || BLUE, a * 0.55); s.swings.strokePoints(f.pts, false);
          s.swings.lineStyle(2.5, 0xffffff, a); s.swings.strokePoints(f.pts, false);
        }
        else if (f.k === "bone") {
          f.x += f.vx * dt; f.y += f.vy * dt; f.vy += 420 * dt; f.vx *= 0.97; f.rot += f.vr * dt;
          const sp = pools.bones[bi] || (pools.bones[bi] = s.add.image(0, 0, "ftc-bone").setDepth(7));
          sp.setVisible(true).setPosition(f.x, f.y).setRotation(f.rot).setTint(f.c).setAlpha(Math.min(1, a * 1.6)); bi++;
        }
        else if (f.k === "part") {
          f.x += f.vx * dt; f.y += f.vy * dt;
          if (!f.rise) { f.vx *= 0.92; f.vy *= 0.92; }
          const sp = pools.parts[pi] || (pools.parts[pi] = s.add.image(0, 0, "ftc-dot").setDepth(7));
          sp.setVisible(true).setPosition(f.x, f.y).setTint(f.c).setAlpha(a).setScale(f.rise ? f.r / 5 * (0.4 + a * 0.6) : f.r / 5); pi++;
        }
        else if (f.k === "bolt") {
          // ⚡ thick and glowing: a wide soft glow, a coloured body, a white-hot core, flickering
          // full brightness for most of its life, then a quick fade; a gentle flicker (not a strobe)
          const fl = Math.min(1, a * 2.4) * (0.8 + Math.random() * 0.2), lite = !Q().detail, g2 = s.glowG;
          if (!lite) { g2.lineStyle(24, f.c, fl * 0.22); g2.strokePoints(f.pts, false); }
          g2.lineStyle(12, f.c, fl * 0.55); g2.strokePoints(f.pts, false);
          g2.lineStyle(5, 0xffffff, fl); g2.strokePoints(f.pts, false);
          for (const b of f.br || []) { g2.lineStyle(6, f.c, fl * 0.6); g2.strokePoints(b, false); g2.lineStyle(2, 0xffffff, fl); g2.strokePoints(b, false); }
        }
        else if (f.k === "puff") {               // steam
          s.swings.fillStyle(f.c, a * 0.32); s.swings.fillCircle(f.x, f.y - (1 - a) * 18, f.r * (0.6 + (1 - a) * 0.8));
        }
        else if (f.k === "glow") {               // the nuke's core
          s.glowG.fillStyle(0xfff27a, a * 0.35); s.glowG.fillCircle(f.x, f.y, f.r * (0.5 + (1 - a) * 1.1));
          s.glowG.fillStyle(0xffffff, a * 0.6); s.glowG.fillCircle(f.x, f.y, f.r * (0.3 + (1 - a) * 0.9));
        }
        else if (f.k === "corpse") {
          const sp = pools.corpses[ci] || (pools.corpses[ci] = s.add.image(0, 0, f.tex).setDepth(6.5)); ci++;
          if (sp.texture.key !== f.tex) sp.setTexture(f.tex);
          let x = f.x, y = f.y, sx = f.sx, sy = f.sy || f.sx, al = Math.min(1, a * 1.8), rot = f.rot, tint = f.c;
          if (f.mode === "ash") { sy = f.sy * a; y = f.y + (1 - a) * 9 * f.sy; sx = f.sx * (1 + (1 - a) * 0.3); al = Math.min(1, a * 2); }
          else if (f.mode === "zap") {
            const on = Math.floor(f.life * 14) % 2 === 0;
            if (!reducedMotion()) { x = f.x + (Math.random() - 0.5) * 5; rot = (Math.random() - 0.5) * 0.5; }
            tint = on ? 0xffffff : 0x8fd0ff; sx = f.sx * (on ? 1.08 : 0.96);
            if (f.life < 0.12 && !f.popped) { f.popped = true; for (let i = 0; i < 4; i++) burst(f.x, f.y, 0x8fd0ff, 140); boneShard(f.x, f.y); }
          }
          else if (f.mode === "fly") { f.x += f.vx * dt; f.y += f.vy * dt; f.vy += (f.g || 0) * dt; f.rot += f.vr * dt; x = f.x; y = f.y; rot = f.rot; }
          else if (f.mode === "roll") { f.x += f.vx * dt; f.vx *= Math.pow(0.35, dt); f.rot += f.vx / 9 * dt; x = f.x; rot = f.rot; }
          else if (f.mode === "launch") { f.x += f.vx * dt; f.y += f.vy * dt; f.rot += f.vr * dt; x = f.x; y = f.y; rot = f.rot; sx = f.sx * (0.15 + 0.85 * a); sy = sx; al = 1; }
          else if (f.mode === "twinkle") { const k2 = Math.sin((1 - a) * Math.PI); sx = f.sx * k2; sy = sx; rot = (1 - a) * 2; al = k2; tint = 0xffffff; }
          else if (f.mode === "lob") { const k2 = 1 - a; x = f.x0 + (f.tx - f.x0) * k2; y = f.y0 + (f.ty - f.y0) * k2 - Math.sin(k2 * Math.PI) * 160; rot = k2 * 9; al = 1; }
          sp.setVisible(true).setPosition(x, y).setRotation(rot).setScale(sx, sy).setTint(tint).setAlpha(al);
        }
      }
      for (; pi < pools.parts.length; pi++) pools.parts[pi].setVisible(false);
      for (; bi < pools.bones.length; bi++) pools.bones[bi].setVisible(false);
      for (; ci < pools.corpses.length; ci++) pools.corpses[ci].setVisible(false);
      for (const t of pools.texts) if (t.visible) { t.life -= dt; t.y -= 40 * dt; t.setAlpha(Math.max(0, t.life / 0.6)); if (t.life <= 0) t.setVisible(false); }
      // the nap: "z"s drift up from Flash
      if (nap && st.phase === "over") {
        nap.t += odt; nap.z -= odt;
        if (nap.t > nap.dur * 0.35 && nap.z <= 0) { nap.z = 0.7; spawnText(nap.x + 14 + Math.random() * 8, nap.y - 24, nap.t % 1.4 < 0.7 ? "z" : "Z", "#cfe0ff", 15 + Math.random() * 6); }
        // a warm pool of light under him, and soft motes drifting up
        const glow = Math.min(1, nap.t / 1.2);
        s.aura.clear();
        s.aura.fillStyle(0xffd9a0, (0.07 + 0.03 * Math.sin(nap.t * 2)) * glow); s.aura.fillCircle(nap.x, nap.y + 4, 90);
        s.aura.fillStyle(0xffe8c0, (0.12 + 0.04 * Math.sin(nap.t * 2)) * glow); s.aura.fillCircle(nap.x, nap.y + 4, 48);
        if (!nap.rm && Math.random() < 0.25 && fx.length < 300) { const a = Math.random() * 6.283, d = 20 + Math.random() * 90;
          fx.push({ k: "part", rise: true, x: nap.x + Math.cos(a) * d, y: nap.y + Math.sin(a) * d * 0.6, vx: (Math.random() - 0.5) * 30, vy: -60 - Math.random() * 40, r: 1.6 + Math.random() * 1.6, life: 1.6, max: 1.6, c: Math.random() < 0.5 ? 0xffe8c0 : 0xcfe0ff }); }
        if (nap.t >= nap.dur && !nap.done) finishNap();
      }
    }

    // Auto quality: down a step after ~4 s under 42 fps in a fight, up a step after
    // ~12 s over 57 (never above what was picked)
    let qLast = 0, qLow = 0, qHigh = 0;
    function qTick(time) {
      if (time - qLast < 2000) return; qLast = time;
      if (qPick() !== "auto" || st.phase !== "fight" || st.paused || document.hidden) { qLow = qHigh = 0; return; }
      const fps = game.loop.actualFps, i = QORDER.indexOf(qAuto);
      if (fps < 42) { qHigh = 0; if (++qLow >= 2 && i > 0) { qAuto = QORDER[i - 1]; qLow = 0; applyQuality(); } }
      else if (fps > 57) { qLow = 0; if (++qHigh >= 6 && i < QORDER.length - 1) { qAuto = QORDER[i + 1]; qHigh = 0; applyQuality(); } }
      else qLow = qHigh = 0;
    }
    function applyQuality() { sim.setAliveScale(Q().alive, Q().cap); }
    function sceneUpdate(time, delta) {
      const dt = Math.min(delta / 1000, 0.1);
      slowF += (slowTo - slowF) * Math.min(1, dt * 5);
      acc += dt * speed * slowF;
      let steps = 0;
      const t0 = performance.now();
      // catch up after a slow frame, but never by more than ~12 ms of work: a slow
      // frame used to queue up to 8 steps, which made the next frame slower still
      while (acc >= 1 / 60 && steps < 8 * speed) { sim.step(1 / 60); acc -= 1 / 60; steps++; if (performance.now() - t0 > 12 * Math.max(1, speed)) { acc = Math.min(acc, 1 / 60); break; } }
      if (steps >= 8 * speed) acc = 0;
      const t1 = performance.now();
      handleEvents(sim.drain());
      draw(dt);
      if (scene) { showLocation(); drawSpells(scene, dt); }
      updateGems(dt); updateCard();
      const t2 = performance.now();
      perf.sim = perf.sim * 0.9 + (t1 - t0) * 0.1; perf.draw = perf.draw * 0.9 + (t2 - t1) * 0.1;
      if (fx.length > Q().fx) fx.splice(0, fx.length - Q().fx);     // the effects budget: oldest go first
      qTick(time);
      if (time - lastUi > 100) { lastUi = time; updateHud(); }
    }

    const game = new Phaser.Game({
      type: Phaser.AUTO, parent: canvasBox, width: st.W, height: FlashSim.H, backgroundColor: "#14111a",
      scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
      scene: { create: sceneCreate, update: sceneUpdate }, banner: false, audio: { noAudio: true },
    });

    // ------------------------------------------------------------ word gems
    // Words the learner has been studying drift through the arena: Thai with
    // its romanization on one gem, the English on another. Click one, then
    // its partner. A Thai gem says its word when clicked. A match bursts both
    // for a reward; a wrong pair just shakes (it is noted for balancing, and
    // the site moves that word up its "practise this" list).
    // Dan: "word gems is too easy, we need some wrong answers in there also,
    // 3-6. You can make it progressive." So among the pairs drift decoys:
    // gems with no partner (other words from the lesson, Thai or English),
    // decoys_min of them at the start of a run and one more for every
    // decoys_every_matches pairs matched, up to decoys_max.
    // Tuned in Game settings > words.
    const WD = Object.assign({ enabled: true, max_pairs: 2, first_after: 4, spawn_every: 10, life: 45, speed: 16,
                               decoys_min: 3, decoys_max: 6, decoys_every_matches: 3, decoy_every: 2.5,
                               slow_motion: 0.35, rescue_chain: 3, rescue_cooldown: 25, rescue_time: 20 },
                             ((sim.D.settings || {}).words || {}).values || {});
    let words = [], extra = [], gems = [], gemAcc = WD.spawn_every - WD.first_after, decoyAcc = 0, matchesRun = 0,
        picked = null, matchRun = 0;
    const GEM_FONT = '"Noto Sans Thai", "Leelawadee UI", "Tahoma", "Segoe UI", sans-serif';
    // Every word this run met, and how it went: matched (right), paired wrong
    // or answered wrong (wrong), or left to drift away / time out (missed).
    // The learning mode after Flash falls is built from it.
    let runWords = {};
    function logWord(w, what) {
      if (!w || !w.id || !w.th || !w.en) return;
      const r = runWords[w.id] || (runWords[w.id] = { w: { id: w.id, th: w.th, rom: w.rom || "", en: w.en, audio: w.audio || "" }, seen: 0, right: 0, wrong: 0, missed: 0 });
      if (!r.w.audio && w.audio) r.w.audio = w.audio;
      r[what] = (r[what] || 0) + 1;
    }
    const wordById = id => words.find(w => w.id === id) || extra.find(w => w.id === id) || (runWords[id] && runWords[id].w) || null;
    // Gems keep clear of the HUD at the top (bars, buffs, warnings, the learn
    // panel) and the weapon/spell bar at the bottom, however tall they get.
    let band = { top: 150, bottom: 110 }, bandAt = 0;
    function gemBand() {
      const now = performance.now(); if (now - bandAt < 400) return band; bandAt = now;
      try {
        const r = game.canvas.getBoundingClientRect();
        if (r.height > 50) {
          const k = FlashSim.H / r.height;
          let tb = buffsEl.getBoundingClientRect().bottom;
          for (const x of [warnEl, learnEl]) if (x.offsetParent && x.offsetHeight) tb = Math.max(tb, x.getBoundingClientRect().bottom);
          band = { top: Math.max(110, (tb - r.top) * k + 8), bottom: Math.max(80, (r.bottom - bottom.getBoundingClientRect().top) * k + 8) };
        }
      } catch (e) {}
      return band;
    }
    const gemBox = g => { const b = gemBand(); return { x0: 30 + g.w / 2, x1: st.W - 30 - g.w / 2, y0: b.top + g.h / 2, y1: FlashSim.H - b.bottom - g.h / 2 }; };
    // ------------------------------------------------------------ the voice
    // Dan: "we need to absolutely guarantee sound with words/sentences works
    // perfectly." Every word and sentence the card, the gems and the
    // questions say goes through here. What could go wrong, and what's done:
    //   - A phone only lets a page make sound from a tap. The card says words by
    //     itself, from a timer, after the answer: on an iPhone each <audio>
    //     element played that way was refused, and the fallback voice too.
    //     So recordings are fetched, decoded and played through Web Audio,
    //     which the first tap unlocks for the rest of the visit.
    //   - Web Audio follows an iPhone's silent switch (an <audio> element
    //     doesn't): on iOS 17+ the page asks for "playback" (navigator.
    //     audioSession), which plays through it; older iOS uses the element.
    //   - The sound host may not allow fetching (CORS), or a file may not
    //     decode: then ONE shared <audio> element, unlocked on the first tap,
    //     plays it (an element that has played from a tap may play again).
    //   - A sound asked for before any tap waits for it ("🔊 Tap for sound"),
    //     rather than being lost.
    //   - No recording, or one that won't load or start within 4 s: the
    //     device's Thai voice. With no Thai voice either, the card says so
    //     once, instead of silence nobody can explain.
    //   - One thing speaks at a time; repeats ("Say each word") are scheduled
    //     exactly; a newer request always wins over a slower older one.
    const VOICE = (() => {
      const ua = navigator.userAgent || "";
      const isIOS = /iP(hone|ad|od)/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
      const useBuf = !!(window.AudioContext || window.webkitAudioContext) && !(isIOS && !("audioSession" in navigator));
      const SILENT = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=";
      let ctx = null, gate = false, token = 0, cur = null, pending = null, warnedVoice = false, onState = () => {};
      const BUF = new Map();                       // url -> Promise<AudioBuffer|null>, most recent last
      const el = new Audio(); el.preload = "auto"; let elReady = false;
      const stats = { buffer: 0, element: 0, tts: 0, waited: 0, failed: 0, blocked: 0, loadFail: 0, none: 0 }, failUrls = [];
      const src = url => (opts.keptAudio && opts.keptAudio(url)) || url;
      function context() {
        if (ctx || !useBuf) return ctx;
        try { const AC = window.AudioContext || window.webkitAudioContext; ctx = new AC(); } catch (e) { ctx = null; }
        return ctx;
      }
      const running = () => !!ctx && ctx.state === "running";
      function decode(ab) {
        return new Promise((ok, no) => { try { const p = ctx.decodeAudioData(ab, ok, no); if (p && p.then) p.then(ok, no); } catch (e) { no(e); } });
      }
      // fetched once, kept decoded; a copy the browser cached without the CORS
      // header is refused, so a failed first try goes again with no-store
      function load(url) {
        if (!url || !useBuf || !context()) return Promise.resolve(null);
        let p = BUF.get(url);
        if (p) { BUF.delete(url); BUF.set(url, p); return p; }
        const get = mode => fetch(src(url), { mode: "cors", credentials: "omit", cache: mode }).then(r => { if (!r.ok) throw new Error("HTTP " + r.status); return r.arrayBuffer(); });
        p = get("default").catch(() => get("no-store")).then(decode).catch(e => { stats.loadFail++; if (failUrls.length < 12) failUrls.push(url.split("/").slice(-2).join("/") + " " + ((e && (e.name || e.message)) || "")); return null; });
        BUF.set(url, p);
        if (BUF.size > 260) BUF.delete(BUF.keys().next().value);
        return p;
      }
      function stop() {
        token++;
        if (cur) { try { cur.stop(); } catch (e) {} cur = null; }
        try { if (!el.paused) el.pause(); el.onended = null; } catch (e) {}
        try { if (window.speechSynthesis && (speechSynthesis.speaking || speechSynthesis.pending)) speechSynthesis.cancel(); } catch (e) {}
      }
      function playBuf(buf, times) {
        const out = ctx.createGain(); out.connect(ctx.destination);
        const nodes = []; let t = ctx.currentTime + 0.02;
        for (let i = 0; i < times; i++) { const s = ctx.createBufferSource(); s.buffer = buf; s.connect(out); s.start(t); nodes.push(s); t += buf.duration + 0.45; }
        cur = { stop: () => nodes.forEach(n => { try { n.stop(); } catch (e) {} }) };
        stats.buffer++;
      }
      function playEl(url, th, times, my) {
        let left = times - 1, started = false;
        try { if (el.getAttribute("src") !== src(url)) el.src = src(url); el.currentTime = 0; } catch (e) {}
        el.onended = () => { if (my === token && left-- > 0) setTimeout(() => { if (my === token) { try { el.currentTime = 0; el.play().catch(() => {}); } catch (e) {} } }, 450); };
        const fail = why => { if (my !== token || started) return; stats.failed++; try { el.pause(); } catch (e) {} tts(th, times, my); };
        el.onplaying = () => { started = true; };
        el.onerror = () => fail("error");
        setTimeout(() => { if (!started && my === token && el.paused) fail("slow"); }, 4000);
        try {
          const p = el.play();
          if (p && p.then) p.then(() => { started = true; stats.element++; }, err => {
            if (my !== token) return;
            if (err && err.name === "NotAllowedError") { stats.blocked++; pending = { url, th, times, at: Date.now() }; onState("blocked"); started = true; return; }
            if (!err || err.name !== "AbortError") fail("refused");
          });
        } catch (e) { fail("throw"); }
      }
      function thaiVoice() { try { return speechSynthesis.getVoices().find(v => /^th(\b|[-_])/i.test(v.lang)) || null; } catch (e) { return null; } }
      function tts(th, times, my) {
        if (!th) return;
        const S = window.speechSynthesis;
        if (!S || !window.SpeechSynthesisUtterance) { stats.none++; onState("novoice"); return; }
        const v = thaiVoice();
        if (!v && S.getVoices().length && !warnedVoice) { warnedVoice = true; onState("novoice"); }
        stats.tts++;
        try { S.cancel(); } catch (e) {}
        // Chrome drops an utterance spoken in the same moment as cancel()
        setTimeout(() => {
          if (my !== undefined && my !== token) return;
          for (let i = 0; i < times; i++) { const u = new SpeechSynthesisUtterance(th); u.lang = "th-TH"; u.rate = 0.9; if (v) u.voice = v; try { S.speak(u); } catch (e) {} }
        }, 60);
      }
      function play(url, th, times) {
        times = Math.max(1, Math.min(5, times || 1));
        stop(); const my = token;
        if (!url) { tts(th, times, my); return; }
        if (!gate) { pending = { url, th, times, at: Date.now() }; stats.blocked++; onState("blocked"); load(url); return; }
        if (useBuf && context()) {
          const p = load(url); let done = false;
          p.then(buf => {
            if (done || my !== token) return; done = true;
            if (buf && running()) playBuf(buf, times); else playEl(url, th, times, my);
          });
          // still loading after 1.5 s: don't keep the learner waiting
          setTimeout(() => { if (!done && my === token) { done = true; stats.waited++; playEl(url, th, times, my); } }, 1500);
          return;
        }
        playEl(url, th, times, my);
      }
      // the first tap or key: unlock everything, and say what was waiting
      function unlock() {
        const first = !gate; gate = true;
        try { if (navigator.audioSession && navigator.audioSession.type !== "playback") navigator.audioSession.type = "playback"; } catch (e) {}
        if (context() && ctx.state !== "running") { try { ctx.resume().catch(() => {}); } catch (e) {} }
        if (!elReady) {
          elReady = true;
          try { el.src = SILENT; const p = el.play(); if (p && p.then) p.then(() => { try { el.pause(); } catch (e) {} }, () => { elReady = false; }); } catch (e) { elReady = false; }
        }
        // a Thai voice primed in the tap (iOS speaks only after one from a tap)
        if (first && window.speechSynthesis && isIOS) { try { const u = new SpeechSynthesisUtterance(" "); u.volume = 0; speechSynthesis.speak(u); } catch (e) {} }
        onState("ok");
        if (pending && Date.now() - pending.at < 8000) { const q = pending; pending = null; setTimeout(() => play(q.url, q.th, q.times), 30); }
        else pending = null;
      }
      ["pointerdown", "touchend", "keydown", "click"].forEach(ev => document.addEventListener(ev, unlock, true));
      // a tab coming back (a phone suspends sound when it's hidden)
      document.addEventListener("visibilitychange", () => { if (!document.hidden && ctx && ctx.state !== "running" && gate) { try { ctx.resume().catch(() => {}); } catch (e) {} } });
      try { if (window.speechSynthesis) speechSynthesis.addEventListener("voiceschanged", () => {}); speechSynthesis && speechSynthesis.getVoices(); } catch (e) {}
      return {
        play, stop, unlock, tts: (th, times) => { stop(); tts(th, Math.max(1, times || 1), token); },
        preload(urls) { for (const u of urls) if (u) load(u); },
        onState(fn) { onState = fn || (() => {}); },
        // ⚙ Options → Sound check: does each recording of this level load?
        async check(urls) {
          const list = [...new Set(urls.filter(Boolean))];
          if (!useBuf || !context()) return { mode: "element", total: list.length, ok: null, failed: [] };
          const res = await Promise.all(list.map(u => load(u).then(b => [u, !!b])));
          return { mode: "buffer", total: list.length, ok: res.filter(r => r[1]).length, failed: res.filter(r => !r[1]).map(r => r[0]) };
        },
        thaiVoice: () => !!thaiVoice(),
        stats: () => Object.assign({ mode: useBuf ? "buffer" : "element", unlocked: gate, ctx: ctx ? ctx.state : "none", cached: BUF.size, failUrls: failUrls.slice() }, stats),
      };
    })();
    function speak(th, times) { VOICE.tts(th, times); }
    // "🔊 Tap for sound": a word wanted to speak before the page was allowed to
    const sndHint = h("button", "ftc-sndhint", "🔊 Tap for sound"); sndHint.hidden = true;
    root.append(sndHint);
    VOICE.onState(stt => {
      if (stt === "blocked") sndHint.hidden = false;
      else if (stt === "ok") sndHint.hidden = true;
      else if (stt === "novoice") floatText("🔇 No Thai voice on this device: words without a recording stay quiet", true, true);
    });
    function preloadAudio(list) { VOICE.preload((list || []).filter(Boolean).map(w => w.audio)); }
    // times: Options > "Say each word" (1-3 times, a short gap between)
    function say(url, th, times) { VOICE.play(url, th, times); }
    // auto: the card saying a word by itself (repeats as set); a click says it once
    const sayWord = (w, auto) => { if (w) say(w.audio, w.th, auto ? sayTimes : 1); };
    // a word that can join the arena: not already there, and not one whose
    // Thai or meaning reads the same as a gem already there (two "to get"s
    // would make a fair match impossible)
    function free(w) {
      if (!w || !w.th || !w.en) return false;
      for (const g of gems) if (g.word.id === w.id || g.word.th === w.th || short(g.word.en) === short(w.en)) return false;
      return true;
    }
    // ---- the word ladder (Dan: "keep track of the number of times a word
    // has been shown, after 5 shows, we do test mode, if they get it right, the
    // word stays in test mode, if wrong the word goes back to learning mode")
    //   learn   the answer shows; each match with it showing is a "show"
    //   test    after learn_shows shows: no answer. Right = stays tested;
    //           wrong = back to learn for learn_relearn_shows more
    //   learned learned_after right in a row without help: ⭐, comes up less
    // A show counts when the learner matches the pair (copying it), not when
    // it merely drifts by. Kept per word here for the session, sent to the
    // course to save (newest wins both ways, by `lt`).
    const ladder = {};
    function rung(w) {
      let r = ladder[w.id];
      if (!r || (w.lt && w.lt > r.lt)) {
        r = ladder[w.id] = { stage: w.stage || (w.known ? "test" : "learn"), shows: w.shows || 0, trs: w.trs || 0, lt: w.lt || 0 };
      }
      return r;
    }
    function ladderSave(w, r, why) {
      r.lt = Date.now(); w.stage = r.stage; w.shows = r.shows; w.trs = r.trs; w.lt = r.lt;
      if (opts.onWord) try { opts.onWord({ result: "ladder", id: w.id, stage: r.stage, shows: r.shows, trs: r.trs, lt: r.lt, why,
                                       th: w.th, rom: w.rom || "", en: w.en, audio: w.audio || "" }); } catch (e) {}
    }
    function ladderRight(w, helped) {
      if (!w || !w.id) return;
      const r = rung(w), was = r.stage;
      if (helped) {
        if (r.stage !== "learn") return;                 // the answer was showing: nothing proved
        r.shows++;
        if (r.shows >= MS.learn_shows) { r.stage = "test"; r.trs = 0; dueAt[w.id] = matchesRun; floatText(`✍ ${w.th}: a mini test is coming up`); }
      } else {
        r.trs++; if (r.stage === "learn") r.stage = "test";
        if (r.trs >= MS.learned_after && r.stage !== "learned") { r.stage = "learned"; SFX.play("learned"); floatText(`⭐ ${w.th} = ${short(w.en)} learned!`, false, true); }
      }
      if (r.stage !== was || helped) ladderSave(w, r, helped ? "show" : "right"); else ladderSave(w, r, "right");
    }
    function ladderWrong(w) {
      if (!w || !w.id) return;
      const r = rung(w);
      if (r.stage === "learn") { r.trs = 0; return ladderSave(w, r, "wrong"); }
      r.stage = "learn"; r.trs = 0; r.shows = Math.max(0, MS.learn_shows - MS.learn_relearn_shows);
      floatText(`↩ ${w.th}: back to learning`, true);
      ladderSave(w, r, "wrong");
    }
    // ---- a lesson mastered (Dan: "if the player masters one lesson, we
    // should offer the option of moving onto the next lesson"): every word on
    // the lesson's page is ⭐ learned. The game keeps going; the course moves
    // on only if the learner says so. Once per lesson per visit, noted in the save.
    let lesson = null, masteredSeen = {};
    // the lesson's words: its word pack (words.json, from WordBase) when it has
    // arrived for this lesson, with what the page knows (ladder, kept picture) on top
    let pack = null;
    function lessonWords() {
      const page = extra.filter(w => w && w.id && w.th && w.en);
      if (!pack || !lesson || pack.lesson !== lesson.id) return page;
      const by = {}; for (const w of page) by[w.id] = w;
      return pack.words.filter(w => w && w.id && w.th && w.en).map(w => Object.assign({}, w, by[w.id] ? { stage: by[w.id].stage, shows: by[w.id].shows, trs: by[w.id].trs, lt: by[w.id].lt, known: by[w.id].known, imgNow: by[w.id].imgNow, level: by[w.id].level } : {}));
    }
    function checkMastered() {
      if (st.phase !== "fight" || st.practice || learn) return;
      const ws = lessonWords(), id = (lesson && lesson.id) || "bench";
      if (ws.length < 3 || masteredSeen[id]) return;
      if (!ws.every(w => rung(w).stage === "learned")) return;
      masteredSeen[id] = 1;
      const m = SAVE.get().mastered || {}; if (!m[id]) { m[id] = { at: Date.now(), words: ws.length, title: lesson && lesson.title || "" }; saveSet("mastered", m); }
      SFX.play("boss_down");
      if (A("banners")) banner("🏆 Lesson mastered!", `all ${ws.length} words ⭐ learned`);
      for (let i = 0; i < 30; i++) burst(st.flash.x, st.flash.y, i % 2 ? 0xffd23a : BLUE, 420);
      sim.applyReward({ v: 1, kind: "reward", source: "match", strength: 1, streak: 10, word: "🏆" });
      const nx = lesson && lesson.next;
      masterEl.innerHTML = `<b>🏆 Lesson mastered!</b><small>All ${ws.length} words${lesson && lesson.title ? ` in <i>${esc(lesson.title)}</i>` : ""} are ⭐ learned.${nx ? "" : " That's the last lesson, well done!"}</small>`;
      const row = h("div", "ftc-learn-row");
      if (nx && opts.goNextLesson) { const go = h("button", "ftc-btn primary", `➡ Next lesson${nx.title ? ": " + esc(nx.title) : ""}`);
        go.onclick = () => { masterEl.classList.remove("show"); bandAt = 0; try { opts.goNextLesson(); } catch (e) {} }; row.append(go); }
      const stay = h("button", "ftc-btn", nx ? "Keep practising here" : "OK"); stay.onclick = () => { masterEl.classList.remove("show"); bandAt = 0; };
      row.append(stay); masterEl.append(row); masterEl.classList.add("show"); bandAt = 0;
      sim.noteStudy("lesson_mastered");
    }
    let newThisRound = 0;
    // Learn mode: the whole lesson (Dan: "We can use all the words in the
    // current lesson"), words still being learned first, ⭐ learned ones now and then
    function learnPool() {
      const seen = new Set(), out = [];
      for (const w of extra.concat(words)) if (!seen.has(w.id)) { seen.add(w.id); out.push(w); }
      return out;
    }
    function pickWord() {
      let pool = (mode === "learn" ? learnPool().filter(w => !isDue(w)) : words).filter(free);
      if (mode === "learn" && MS.learn_new_per_round > 0 && newThisRound >= MS.learn_new_per_round) {
        const known = pool.filter(w => (w.level || 0) > 0 || runWords[w.id]);
        if (known.length) pool = known;
      }
      if (!pool.length) return null;
      const wt = w => (w.weight || 1) * (mode !== "learn" ? 1 : ({ learn: 3, test: 2, learned: 0.5 })[rung(w).stage] || 1);
      let sum = 0; for (const w of pool) sum += wt(w);
      let r = Math.random() * sum;
      for (const w of pool) { r -= wt(w); if (r <= 0) return w; }
      return pool[pool.length - 1];
    }
    // "plate, dish, classifier for plates; a course" -> "plate, dish"
    const short = (t, max = 22) => {
      // brackets first ("I, me [female informal/neutral; male poetic]" must not leave a half bracket)
      t = String(t || "").replace(/\s*[\[(][^\])]*[\])]/g, "").split(/;|\s\/\s/)[0].replace(/\s*[\[(].*$/, "").trim();
      const ps = t.split(/,\s*/); let out = ps[0] || t;
      for (let i = 1; i < ps.length && i < 3; i++) { if ((out + ", " + ps[i]).length > max) break; out += ", " + ps[i]; }
      return out.length > max + 6 ? out.slice(0, max + 5) + "…" : out;
    };
    // Learn mode: is this gem's help showing? (its English under the Thai,
    // and the pair's shared colour)
    const PAIR_COLOURS = [0xffd23a, 0x5cf0a0, 0xff8fd0, 0x7fd8ff, 0xffa25c, 0xc6a8ff];
    let pairN = 0;
    const needsHint = w => rung(w).stage === "learn";
    // live, so a gem stops helping the moment its word moves up the ladder
    const hintOn = g => mode === "learn" && !g.learn && !g.test && !g.noHint && (showAll || (!g.decoy && needsHint(g.word)));
    function makeGem(word, side, o = {}) {
      const s = scene;
      const c = s.add.container(0, 0).setDepth(40);
      // in Learn mode a Thai gem keeps room for its English underneath
      const room = side === "th" && mode === "learn" && !o.noHint;
      const off = room ? -10 : 0;
      const parts = side === "th"
        ? [s.add.text(0, (word.rom ? -9 : 0) + off, word.th, { fontFamily: GEM_FONT, fontSize: "30px", color: "#fff7e0" }).setOrigin(0.5)]
            .concat(word.rom ? [s.add.text(0, 19 + off, word.rom, { fontFamily: "Segoe UI, system-ui, sans-serif", fontSize: "15px", color: "#ffd27a" }).setOrigin(0.5)] : [])
        : [s.add.text(0, 0, short(word.en), { fontFamily: "Segoe UI, system-ui, sans-serif", fontSize: "19px", fontStyle: "bold",
                                               color: "#e6f3ff", align: "center", wordWrap: { width: 190 } }).setOrigin(0.5)];
      let hintText = null;
      if (room) {
        hintText = s.add.text(0, (word.rom ? 40 : 22) + off, "= " + short(word.en, 18), { fontFamily: "Segoe UI, system-ui, sans-serif",
          fontSize: "14px", fontStyle: "italic", color: "#bfe6ff" }).setOrigin(0.5).setVisible(false);
        parts.push(hintText);
      }
      const w = Math.max(...parts.map(t => t.width)) + 30, hh = side === "th" ? (word.rom ? 70 : 50) + (room ? 22 : 0) : parts[0].height + 24;
      const bg = s.add.graphics();
      const g = { word, side, c, bg, w, h: hh, x: 0, y: 0, vx: 0, vy: 0, age: 0, life: WD.life, shake: 0, hintText,
                  decoy: !!o.decoy, noHint: !!o.noHint, pc: o.pc || 0, _hint: null };
      g.paint = sel => {
        bg.clear();
        const hinting = hintOn(g), pc = g.mt ? 0xffd23a : hinting && g.pc && !g.decoy ? g.pc : 0;
        bg.fillStyle(side === "th" ? 0x3b2560 : 0x123a4c, 0.93).fillRoundedRect(-w / 2, -hh / 2, w, hh, 14);
        bg.lineStyle(sel ? 4 : pc ? 3.5 : 2, sel ? 0xffd23a : pc || (side === "th" ? 0xb98cff : 0x6cc8ff), 1).strokeRoundedRect(-w / 2, -hh / 2, w, hh, 14);
        if (pc && !sel) { bg.fillStyle(pc, 1).fillCircle(w / 2 - 9, -hh / 2 + 9, 5); }
        if (hintText) hintText.setVisible(hinting);
        g._sel = !!sel;
      };
      g.paint(false);
      c.add([bg, ...parts]);
      c.setSize(w, hh).setInteractive({ useHandCursor: true });
      c.on("pointerdown", () => clickGem(g));
      return g;
    }
    function placeGem(g) {
      const { x0, x1, y0, y1 } = gemBox(g);
      let best = null, bestD = -1;
      for (let i = 0; i < 12; i++) {
        const x = x0 + Math.random() * Math.max(1, x1 - x0), y = y0 + Math.random() * Math.max(1, y1 - y0);
        let d = 1e9;
        for (const o of gems) d = Math.min(d, Math.hypot(o.x - x, o.y - y));
        if (st.flash) d = Math.min(d, Math.hypot(st.flash.x - x, st.flash.y - y) * 1.5);
        if (d > bestD) { bestD = d; best = { x, y }; }
      }
      const a = Math.random() * 6.283, sp = WD.speed * (0.6 + Math.random() * 0.8) * (learn ? 0.6 : 1);
      Object.assign(g, best, { vx: Math.cos(a) * sp, vy: Math.sin(a) * sp });
      g.c.setPosition(g.x, g.y).setAlpha(0).setScale(0.6);
    }
    // ---- the mini test (Dan: "once we shown the user a word 5 times, we do a
    // mini test mode for that word. We should warn the user, when we start
    // test mode"). A word that has been matched learn_shows times with its
    // answer showing is due; after learn_test_after other matches (so it is
    // not just short-term memory) it comes back as a test: a banner and a
    // sound say so, the game goes into slow motion, and its Thai gem (no
    // answer, "✍ MINI TEST") waits with learn_test_choices English answers
    // under it. Right = it stays in testing (⭐ after learned_after in a row);
    // wrong = the right answer lights up and it goes back to learning.
    const dueAt = {};
    const isDue = w => { const r = rung(w); return r.stage === "test" && !r.trs; };
    const mtOn = () => gems.some(g => g.mt);
    function dueWord() {
      for (const w of learnPool()) {
        if (!isDue(w) || gems.some(g => g.word.id === w.id)) continue;
        if (dueAt[w.id] === undefined || matchesRun - dueAt[w.id] >= MS.learn_test_after) return w;
      }
      return null;
    }
    function spawnMiniTest(w) {
      if (!scene) return false;
      const b = gemBand(), x = st.W / 2;
      const thai = makeGem(w, "th", { noHint: true });
      thai.c.add(scene.add.text(0, -thai.h / 2 - 13, "✍ MINI TEST", { fontFamily: "Segoe UI, system-ui, sans-serif", fontSize: "15px",
        fontStyle: "bold", color: "#ffd23a" }).setOrigin(0.5));
      const opts2 = [makeGem(w, "en", { noHint: true })];
      const taken = new Set([short(w.en)]);
      for (const d of shuffle(learnPool().filter(o => o.id !== w.id))) {
        if (opts2.length >= MS.learn_test_choices) break;
        const e = short(d.en); if (taken.has(e) || gems.some(g => g.word.id === d.id)) continue;
        taken.add(e); opts2.push(makeGem(d, "en", { decoy: true, noHint: true }));
      }
      shuffle(opts2);
      const y0 = b.top + 70;
      Object.assign(thai, { x, y: y0 + thai.h / 2 });
      let y = y0 + thai.h + 40;
      for (const o of opts2) { Object.assign(o, { x, y: y + o.h / 2 }); y += o.h + 18; }
      for (const g of [thai, ...opts2]) {
        Object.assign(g, { mt: true, mtWord: w.id, fixed: true, vx: 0, vy: 0, life: 1e9 });
        g.c.setPosition(g.x, g.y).setAlpha(0); g.paint(false); gems.push(g);
      }
      SFX.play("question"); setSlow(true);
      if (A("banners")) banner("✍ Mini test!", `${w.th}: which one is it?`);
      floatText(`✍ Mini test: what is ${w.th}?`, false, true);
      sim.noteStudy("mini_test");
      return true;
    }
    function endMiniTest(after) {
      setTimeout(() => { for (const g of gems.filter(x => x.mt)) dropGem(g); if (!qOpen) setSlow(false); gemAcc = 1; }, after || 0);
    }
    function miniTestPair(a, g) {
      const thai = a.side === "th" ? a : g, en = thai === a ? g : a, w = thai.word;
      if (thai.word.id !== thai.mtWord) return;
      if (thai.done) return;
      thai.done = true;
      if (!en.decoy && en.word.id === w.id) {
        SFX.play("right"); ladderRight(w, false); logWord(w, "right"); matchesRun++;
        for (const x of [thai, en]) for (let i = 0; i < 18; i++) burst(x.x, x.y, 0xffd23a, 300);
        floatText(`✅ Passed! ${w.th} = ${short(w.en)}`, false, true);
        sim.applyReward({ v: 1, kind: "reward", source: "match", strength: 1, streak: ++matchRun, word: w.th });
        if (opts.onWord) try { opts.onWord({ result: "match", id: w.id }); } catch (e) {}
        endMiniTest(350);
      } else {
        SFX.play("wrong"); en.shake = thai.shake = 0.4; matchRun = 0;
        ladderWrong(w); logWord(w, "wrong");
        const right = gems.find(x => x.mt && !x.decoy && x.side === "en");
        if (right) teach = { a: thai, b: right, t: 2.2 };
        if (opts.onWord) try { opts.onWord({ result: "miss", id: w.id, other: en.word.id }); } catch (e) {}
        endMiniTest(2200);
      }
    }
    function spawnPair() {
      const w = pickWord(); if (!w || !scene) return false;
      if (!(w.level || 0) && !runWords[w.id]) newThisRound++;
      const pc = PAIR_COLOURS[pairN++ % PAIR_COLOURS.length];
      for (const side of ["th", "en"]) { const g = makeGem(w, side, { pc }); placeGem(g); gems.push(g); }
      use("word_gems"); logWord(w, "seen");
      return true;
    }
    const decoyTarget = () => {
      const lo = mode === "learn" ? MS.learn_decoys_min : WD.decoys_min, hi = mode === "learn" ? MS.learn_decoys_max : WD.decoys_max;
      return Math.min(hi, lo + Math.floor(matchesRun / Math.max(1, WD.decoys_every_matches)));
    };
    function spawnDecoy() {
      const seen = new Set(), cands = [];
      for (const w of extra.concat(words)) if (!seen.has(w.id)) { seen.add(w.id); if (free(w)) cands.push(w); }
      if (!cands.length || !scene) return false;
      const w = cands[Math.floor(Math.random() * cands.length)];
      const g = makeGem(w, Math.random() < 0.55 ? "en" : "th", { decoy: true });
      placeGem(g); gems.push(g);
      return true;
    }
    let teach = null, teachG = null;
    function drawTeach(dt) {
      if (!teachG && scene) teachG = scene.add.graphics().setDepth(41);
      if (!teachG) return;
      teachG.clear();
      if (!teach) return;
      teach.t -= dt;
      if (teach.t <= 0 || !gems.includes(teach.a) || !gems.includes(teach.b)) { teach = null; return; }
      const k = Math.min(1, teach.t / 0.5), pulse = 3 + 2.5 * (0.5 + 0.5 * Math.sin(teach.t * 12));
      teachG.lineStyle(6, 0x5cf0a0, k).lineBetween(teach.a.x, teach.a.y, teach.b.x, teach.b.y);
      for (const x of [teach.a, teach.b]) teachG.lineStyle(pulse, 0x5cf0a0, k).strokeRoundedRect(x.x - x.w / 2 - 6, x.y - x.h / 2 - 6, x.w + 12, x.h + 12, 16);
    }
    function dropGem(g) { try { g.c.destroy(); } catch (e) {} gems = gems.filter(x => x !== g); if (picked === g) picked = null; }
    function clearGems() { for (const g of gems.slice()) dropGem(g); picked = null; gemAcc = mode === "learn" ? 0 : WD.spawn_every - WD.first_after; decoyAcc = 0; matchesRun = 0; }
    function deselect() { if (!picked) return false; picked.paint(false); picked = null; return true; }
    let gemTips = +(prefs.gemTips || 0);
    function clickGem(g) {
      if (g.side === "th") sayWord(g.word);           // always, even paused or as a wrong answer
      if (st.phase !== "fight" || st.paused) return;
      if (learn && learn.mode === "learn") return learnClick(g);
      if (!picked) {
        picked = g; g.paint(true);
        if (gemTips < 3 && !learn) { gemTips++; prefs.gemTips = gemTips; savePrefs(); floatText("Now click its partner · click it again to let go"); }
        return;
      }
      if (picked === g) { g.paint(false); picked = null; return; }
      if (picked.side === g.side) { picked.paint(false); picked = g; g.paint(true); return; }
      const a = picked; picked = null; a.paint(false);
      if (learn && learn.mode === "test") return testPair(a, g);
      if (a.mt || g.mt) {
        if (a.mt && g.mt) return miniTestPair(a, g);
        a.shake = g.shake = 0.3; floatText("✍ Answer the mini test with one of its answers"); return;
      }
      if (!a.decoy && !g.decoy && a.word.id === g.word.id) {
        const helped = hintOn(a) || hintOn(g);
        SFX.play(helped ? "helped" : "match");
        logWord(a.word, helped ? "helped" : "right");
        if (helped) sim.noteStudy("match_helped");
        if (!helped) a.word.level = Math.min(5, (a.word.level || 0) + 1);
        ladderRight(a.word, helped);
        matchRun++; matchesRun++;
        for (const x of [a, g]) for (let i = 0; i < 14; i++) burst(x.x, x.y, x.side === "th" ? 0xc58aff : 0x6cc8ff, 260);
        floatText(`${a.word.th} = ${short(a.word.en)}${matchRun >= 3 ? `  ×${matchRun}!` : ""}`);
        sim.applyReward({ v: 1, kind: "reward", source: "match", strength: helped ? MS.learn_helped_strength : 1, streak: matchRun, word: a.word.th });
        dropGem(a); dropGem(g);
        if (mode === "learn") gemAcc = 1;                  // a new pair at once (Dan: "whenever a match is found, a new one should appear")
        if (opts.onWord) try { opts.onWord({ result: "match", id: a.word.id, helped }); } catch (e) {}
      } else {
        matchRun = 0; SFX.play("mismatch");
        a.shake = g.shake = 0.4;
        sim.noteStudy("mismatch");
        // the word the learner was trying to match is the real (non-decoy) one
        const real = [a, g].find(x => !x.decoy && x.side === "th") || [a, g].find(x => !x.decoy) || (a.side === "th" ? a : g);
        logWord(real.word, "wrong");
        real.word.level = Math.max(0, (real.word.level || 0) - 1);
        ladderWrong(!a.decoy ? a.word : real.word);        // the word the learner meant: the one picked first
        // Learn mode: show the right partner of the gem picked first
        if (mode === "learn" && !a.decoy) { const mate = gems.find(o => o !== a && !o.decoy && o.word.id === a.word.id && o.side !== a.side); if (mate) teach = { a, b: mate, t: 1.8 }; }
        if (opts.onWord) try { opts.onWord({ result: "miss", id: real.word.id, other: (real === a ? g : a).word.id }); } catch (e) {}
      }
    }
    // gems never sit on top of each other (a covered partner looked like a
    // pair with half missing)
    function spreadGems(dt) {
      for (let i = 0; i < gems.length; i++) for (let j = i + 1; j < gems.length; j++) {
        const a = gems[i], b = gems[j];
        if (a.fixed && b.fixed) continue;
        const dx = b.x - a.x, dy = b.y - a.y, ox = (a.w + b.w) / 2 + 12 - Math.abs(dx), oy = (a.h + b.h) / 2 + 12 - Math.abs(dy);
        if (ox <= 0 || oy <= 0) continue;
        const push = Math.min(ox < oy ? ox : oy, 140 * dt) / ((a.fixed || b.fixed) ? 1 : 2);
        const sx = ox < oy ? (dx >= 0 ? 1 : -1) : 0, sy = ox < oy ? 0 : (dy >= 0 ? 1 : -1);
        if (!a.fixed) { a.x -= sx * push; a.y -= sy * push; }
        if (!b.fixed) { b.x += sx * push; b.y += sy * push; }
      }
    }
    // learning-mode gems: no expiry; "fixed" ones (the learn cards) stay put
    function moveGem(g, dt) {
      g.age += dt;
      const { x0, x1, y0, y1 } = gemBox(g);
      if (!g.fixed) {
        g.x += g.vx * dt; g.y += g.vy * dt;
        if (g.x < x0 || g.x > x1) { g.vx = -g.vx; g.x = Math.max(x0, Math.min(x1, g.x)); }
        if (g.y < y0 || g.y > y1) { g.vy = -g.vy; g.y = Math.max(y0, Math.min(y1, g.y)); }
      } else { g.x = Math.max(x0, Math.min(x1, g.x)); }
      const sx = g.shake > 0 ? Math.sin(g.age * 60) * 7 * (g.shake / 0.4) : 0;
      g.shake = Math.max(0, g.shake - dt);
      const vis = g.delay ? g.age >= g.delay : true, a = vis ? Math.min(1, (g.age - (g.delay || 0)) / 0.4) : 0;
      g.c.setVisible(vis && st.phase === "fight").setPosition(g.x + sx, g.y + Math.sin(g.age * 1.7) * 3).setAlpha(a).setScale(0.7 + 0.3 * a);
    }
    function updateGems(dt) {
      if (!WD.enabled || !scene) return;
      if (learn) return updateLearn(dt);
      if (cardOn()) { if (gems.length) clearGems(); return; }    // the word card is on instead (Options > Words)
      if (!A("word_gems")) { if (gems.length) clearGems(); return; }
      const live = st.phase === "fight" && !st.paused;
      for (const g of gems) g.c.setVisible(st.phase === "fight");
      if (!live) return;
      gemAcc += dt;
      const pairs = gems.filter(g => !g.decoy).length / 2, decoys = gems.length - pairs * 2;
      if (mode === "learn") {
        const due = !mtOn() && gemAcc >= 0.3 ? dueWord() : null;
        if (due) { if (spawnMiniTest(due)) gemAcc = 0; }
        else if ((words.length || extra.length) && (gemAcc >= 0.6 || (pairs === 0 && gemAcc >= 0.3)) && pairs < MS.learn_pairs + (mtOn() ? 1 : 0)) { if (spawnPair()) gemAcc = pairs + 1 < MS.learn_pairs && pairs === 0 ? 0.45 : 0; }
      }
      else if (words.length && gemAcc >= WD.spawn_every && pairs < WD.max_pairs) { if (spawnPair()) gemAcc = 0; }
      decoyAcc += dt;
      if (pairs > 0 && decoys < decoyTarget() && decoyAcc >= WD.decoy_every) { if (spawnDecoy()) decoyAcc = 0; }
      spreadGems(dt); drawTeach(dt);
      for (const g of gems.slice()) {
        const hv = hintOn(g); if (hv !== g._hint) { g._hint = hv; g.paint(picked === g); }
        g.age += dt;
        const { x0, x1, y0, y1 } = gemBox(g);
        g.x += g.vx * dt; g.y += g.vy * dt;
        if (g.x < x0 || g.x > x1) { g.vx = -g.vx; g.x = Math.max(x0, Math.min(x1, g.x)); }
        if (g.y < y0 || g.y > y1) { g.vy = -g.vy; g.y = Math.max(y0, Math.min(y1, g.y)); }
        const sx = g.shake > 0 ? Math.sin(g.age * 60) * 7 * (g.shake / 0.4) : 0;
        g.shake = Math.max(0, g.shake - dt);
        const fadeIn = Math.min(1, g.age / 0.5), fadeOut = Math.min(1, (g.life - g.age) / 4);
        g.c.setPosition(g.x + sx, g.y + Math.sin(g.age * 1.7) * 3).setAlpha(Math.max(0, Math.min(fadeIn, fadeOut))).setScale(0.6 + 0.4 * fadeIn);
        if (g.age >= g.life) {
          // a pair leaves together
          const mate = g.decoy ? null : gems.find(o => o !== g && !o.decoy && o.word.id === g.word.id);
          if (!g.decoy) {                                // nobody matched it in time: a missed word
            logWord(g.word, "missed"); sim.noteStudy("gem_missed");
            if (opts.onWord) try { opts.onWord({ result: "expired", id: g.word.id }); } catch (e) {}
          }
          dropGem(g); if (mate) dropGem(mate);
        }
      }
    }

    // ----------------------------------------------------------- the word card
    // Dan: "the focus should be on, can the user recall the word, memory test,
    // not whether the user can find the word." One question at a time, always
    // in the same place, answers in a fixed row. What to ask, and how much
    // help to give, comes from the learning engine (flash-learn.js): each word
    // climbs meet -> pick of 2 -> pick of 4 -> recall, separately for Thai ->
    // meaning, meaning -> Thai and listening, and comes back at growing gaps.
    // A right answer powers Flash up like a matched pair; a wrong one shows
    // the answer, says the word and costs nothing. The classic gem hunt is
    // still there (Options > Words).
    const CM = Object.assign({ meet_strength: 0.6, recall_strength: 1, next_after_right: 0.55, next_after_wrong: 1.9, next_after_meet: 0.35, daily_goal: 20, sentence_strength: 1.3, next_after_sentence: 1.6 },
                             ((sim.D.settings || {}).recall || {}).values || {});
    let wordMode = SAVE.get().words === "gems" ? "gems" : "card";
    // Dan: "I think romanization should always be on: the default setting."
    let romMode = ["fade", "always", "never"].includes(SAVE.get().rom) ? SAVE.get().rom : "always";
    let sayTimes = [1, 2, 3].includes(SAVE.get().say_times) ? SAVE.get().say_times : 1;
    // Dan: "we keep the left side of the screen for the game, and the right side
    // for the language learning". On a wide screen the study panel is a column
    // on the right (the arena fits the rest); in a narrow column the card floats
    // above the weapon bar.
    const sideEl = h("div", "ftc-side"), sideHead = h("div", "ftc-side-head"), sideIdle = h("div", "ftc-side-idle");
    const cardEl = h("div", "ftc-wc");
    // Dan: "we should be able to just show cards from the site". The last word
    // answered (or the new one being met), the way the lesson page shows it:
    // its picture, the Thai with tones, the meaning, part of speech, both
    // recordings, the memory hook and the course's sentences.
    const sideWord = h("div", "ftc-word"), sideTip = h("div", "ftc-tip");
    sideEl.append(sideHead, sideTip, cardEl, sideIdle, sideWord); root.append(sideEl);
    // first-time tips: three short ones, each once, at the moment they're useful
    const TIPS = [
      ["start", "🐈 <b>Answer the word card to power Flash up.</b> He fights on his own: your job is the words."],
      ["keys", "⌨ <b>1–4</b> answers, <b>Space</b> shows the answer. A wrong answer costs nothing: the word just comes back."],
      ["days", "📅 <b>Words come back over the next days</b>, just before you'd forget them. 📊 shows what you've really learned."],
    ];
    function tip(id) {
      const done = SAVE.get().tips || {}; if (done[id]) return;
      const t = TIPS.find(x => x[0] === id); if (!t) return;
      done[id] = Date.now(); saveSet("tips", done);
      sideTip.innerHTML = t[1] + `<button class="ftc-tip-x" title="Got it">✕</button>`; sideTip.classList.add("show");
      sideTip.querySelector("button").onclick = () => sideTip.classList.remove("show");
      clearTimeout(sideTip._t); sideTip._t = setTimeout(() => sideTip.classList.remove("show"), 12000);
    }
    let infoW = null;
    let cTyped = null, cHeld = false;                     // ⌨ Type first: what was typed (null = not yet, " " = skipped)
    let cq = null, cState = "", cShown = 0, cNextAt = 0, cTimer = null, cStreak = 0, levelSeen = {};
    let cRun = { right: 0, wrong: 0, up: {}, best: 0 };
    const nowPic = {};                    // a picture from the reader's device, only while the lesson page is open
    const cardOn = () => wordMode === "card" && !!LE;
    const panelOn = () => cardOn() && root.classList.contains("panel");
    const stackOn = () => cardOn() && root.classList.contains("stack");
    // Dan: "If we have auto select mode on in the game we can continue answering
    // questions": the card stays up between rounds when the study panel has its
    // own side of the screen, or auto-pick runs the break by itself.
    const cardLive = () => cardOn() && !learn && !st.practice && !st.paused && !qOpen && !optsOpen
      && (st.phase === "fight" || (st.phase === "break" && (panelOn() || prefs.auto)));
    // the lesson's name, wherever it came from
    const levelTitle = () => (lesson && lesson.title) || (pack && pack.title) || (LE && LE.level().title) || "This lesson";
    function syncLevel() {
      if (!LE) return;
      const list = lessonWords();
      for (const w of list) { if (w.imgNow) nowPic[w.id] = w.imgNow; else delete nowPic[w.id]; }
      LE.setLevel(list.length ? list : words, lesson ? { id: lesson.id, title: lesson.title } : { id: "bench", title: "" });
      LE.setPool(words);
      preloadAudio(LE.level().ids.map(id => LE.word(id)));
    }
    // Dan's puns, each in its own spot (and only now and then, so they stay funny)
    const PUN = { kills: "That's a lot of bone-afide victories", slogan: "Purr-fect your Thai", review: "Paws and Recall", en_ask: "Meow do you say that in Thai?",
      encourage: ["You've got this in the bag... of cats", "Stay pawsome, keep learning"], progress: "Claw your way to fluency",
      wrong: "Fur-get me not!", streak: "Purr-sistence pays off", achievement: "Pawsitive progress!",
      challenge: ["Thai one on!", "No hiss-takes allowed!"], new_word: "Cat-ch those words!", course: "Whisker your way to fluency",
      check: "Feline fluent yet?", right: "That's the cat's meow!", revise: "Don't let those words slip through your paws" };
    const pick1 = a => Array.isArray(a) ? a[Math.floor(Math.random() * a.length)] : a;
    const DIR_ASK = { th: "What does it mean?", en: PUN.en_ask, au: "What did you hear?" };
    // ---- days: answers per local day (days in a row, the daily goal, the chart)
    const GOAL = Math.max(1, +(CM.daily_goal || 20));
    const dayKey = t => { const d = new Date(t || Date.now()); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); };
    const dayLog = () => SAVE.get().days || {};
    function noteDay(right, meet) {
      const days = dayLog(), k = dayKey(), d = days[k] || (days[k] = { n: 0, right: 0 });
      d.n++; if (right) d.right++;
      const ks = Object.keys(days).sort(); while (ks.length > 400) delete days[ks.shift()];
      saveSet("days", days);
      noteJourney(d, right, meet);
      if (d.n === GOAL) { SFX.play("levelup"); if (A("banners")) banner(`💪 ${GOAL} answers today!`, `${PUN.streak} · ${daysInRow()} day${daysInRow() === 1 ? "" : "s"} in a row`); sim.noteStudy("daily_goal"); }
    }
    // today counts once it has an answer; until then, yesterday's run is still alive
    function daysInRow() {
      const days = dayLog(); let n = 0; const t = new Date();
      if (!(days[dayKey(t)] || {}).n) t.setDate(t.getDate() - 1);
      while ((days[dayKey(t)] || {}).n) { n++; t.setDate(t.getDate() - 1); }
      return n;
    }
    // ---- every state machine in one read-only report (see STATE-MACHINES.md)
    function gameState() {
      const shown = overlay.classList.contains("show");
      return {
        phase: st.phase,                                             // start | fight | break | over   (flash-sim.js)
        mode: st.practice ? "practice" : "run",                      // a real run, or the learning mode after a fall
        paused: !!st.paused, pausedBy: [...pausedBy],                // why: player and / or menu
        screen: shown ? uiScreen : "none", menu: optsOpen,           // what the overlay shows; menu = one that closes back
        card: cq ? (cState || "idle") : "none", cardHeld: !!cHeld,   // the word card: think → ask → grade → done
        question: !!qOpen,                                           // a pop question is open
        nap: nap ? (nap.done ? "done" : "playing") : "none",         // the kitty death
        learning: !!learn,                                           // the learn-by-gems stage
        round: st.round, wave: st.wave ? "mega" : "normal", boss: !!st.boss, danger: !!st.danger,
        safe: st.safeUntil > st.t, paws: st.paws.map(q => q.phase), fish: st.fish || 0,
        words: wordMode, quality: Q().label || prefs.quality || "auto", motion: reducedMotion() ? "reduced" : "full", flashes: flashMode(),
      };
    }
    // combinations that must never happen; empty = healthy
    function checkState() {
      const s = gameState(), bad = [], shown = overlay.classList.contains("show");
      const no = (c, m) => { if (c) bad.push(m); };
      no(s.paused && s.phase !== "fight", "paused outside a fight");
      no(s.phase === "fight" && s.paused !== (pausedBy.size > 0) && !(s.paused && !pausedBy.size), "paused, but pausedBy says otherwise");
      no(s.phase === "fight" && !s.paused && s.menu, "the fight is running under an open menu");
      no(s.phase === "fight" && !s.paused && shown, "an overlay screen is up while the fight runs");
      no(s.menu && !shown, "a menu is marked open but nothing is showing");
      no(shown && uiScreen === "none", "the overlay shows a screen with no name");
      no(s.menu && !["options", "progress", "words", "share"].includes(uiScreen), "menu open, but the screen is " + uiScreen);
      no(!s.menu && ["options", "progress", "words", "share"].includes(s.screen), "a menu screen is showing but isn't marked open");
      no(s.nap === "playing" && shown, "the nap is playing behind a screen");
      no(s.nap !== "none" && s.phase !== "over", "napping while not over");
      no(s.question && s.phase !== "fight", "a pop question outside a fight");
      no(s.phase === "start" && !shown, "the start phase with no start screen");
      no(s.phase === "break" && !shown, "between rounds with no screen");
      no(s.phase === "over" && !shown && s.nap !== "playing" && s.mode !== "practice", "game over with no screen");
      return bad;
    }
    const stateLog = []; let stateKey = "";
    function noteState() {
      const s = gameState(), k = [s.phase, s.mode, s.paused ? "paused:" + s.pausedBy.join("+") : "", s.screen, s.menu ? "menu" : "", s.nap, s.question ? "question" : ""].filter(Boolean).join(" · ");
      if (k === stateKey) return;
      stateLog.push({ at: Math.round(performance.now()), from: stateKey, to: k }); if (stateLog.length > 60) stateLog.shift();
      stateKey = k;
    }
    // ---- the journey (Dan, 10 Nov: "detailed, sharable stats: time spent,
    // words learned, lessons studied. I need to be able to show my journey of
    // learning Thai"). Lifetime totals that never get trimmed, kept in the save:
    //   start     the first day
    //   secs      time studied (counted while the game is being played or a
    //             word was answered in the last 45 s, and the tab is showing)
    //   answers / right
    //   lessons   { id: { title, first, last, n } }  every lesson answered in
    // and per day (in "days"): s seconds, les {lesson ids}, met0 / learned0
    // (the totals when the day began, so "today: +6 words" is honest).
    const journey = () => { const j = SAVE.get().journey || {}; j.lessons = j.lessons || {}; return j; };
    let lastActive = 0; const siteLes = {};
    function noteJourney(d, right, meet) {
      const j = journey(), now = Date.now();
      if (!j.start) j.start = now;
      // meeting a new word isn't a test: it counts as an answer, not towards "% right"
      j.answers = (j.answers || 0) + 1; if (!meet) { j.tested = (j.tested || 0) + 1; d.t = (d.t || 0) + 1; } if (right) j.right = (j.right || 0) + 1;
      if (d.met0 == null && LE) { const sm = LE.summary(); d.met0 = Math.max(0, sm.th.met - 1); d.learned0 = sm.th.learned; }
      const id = lesson && lesson.id;
      if (id) {
        const L = j.lessons[id] || (j.lessons[id] = { title: lesson.title || "", first: now, n: 0 });
        L.n++; L.last = now; if (lesson.title) L.title = lesson.title;
        (d.les || (d.les = {}))[id] = 1;
      }
      lastActive = now; saveSet("journey", j); saveSet("days", Object.assign(dayLog(), { [dayKey()]: d }));
    }
    // time studied: one second at a time, only while something is really happening
    let pendS = 0;
    function flushStudy() {
      if (!pendS) return;
      const days = dayLog(), k = dayKey(), d = days[k] || (days[k] = { n: 0, right: 0 }), j = journey();
      d.s = (d.s || 0) + pendS; j.secs = (j.secs || 0) + pendS; if (!j.start) j.start = Date.now();
      pendS = 0; saveSet("days", days); saveSet("journey", j);
    }
    const studyTimer = setInterval(() => {
      if (document.hidden) return;
      const playing = (st.phase === "fight" && !st.paused) || !!learn;
      if (!playing && Date.now() - lastActive > 45000) return;
      if (++pendS >= 15) flushStudy();
    }, 1000);
    // someone who was already playing before today: the first day, the answers and a
    // fair estimate of the time (gaps of under 2 minutes between answers) from what's saved
    async function backfillJourney() {
      const j = journey(); if (j.filled || !LE) return;
      const days = dayLog(), ks = Object.keys(days).sort();
      let att = []; try { att = (await LE.attempts()) || []; } catch (e) {}
      att = att.filter(a => a && a.at).sort((a, b) => a.at - b.at);
      const first = Math.min(att.length ? att[0].at : Infinity, ks.length ? new Date(ks[0] + "T12:00").getTime() : Infinity, j.start || Infinity);
      if (isFinite(first)) j.start = first;
      const sumN = ks.reduce((a, k) => a + (days[k].n || 0), 0), sumR = ks.reduce((a, k) => a + (days[k].right || 0), 0);
      j.answers = Math.max(j.answers || 0, sumN, att.length); j.right = Math.max(j.right || 0, sumR);
      const tested = att.filter(a => a.kind !== "meet").length; if (!j.tested && tested) { j.tested = tested; j.right = att.filter(a => a.kind !== "meet" && a.right).length; }
      let est = 0;
      for (let i = 0; i < att.length; i++) {
        const gap = i ? att[i].at - att[i - 1].at : 0, add = i && gap < 120000 ? gap / 1000 : 8, k = dayKey(att[i].at);
        if (days[k]) days[k].est = (days[k].est || 0) + add;
        est += add;
      }
      for (const k of ks) if (days[k].est) { days[k].s = Math.max(days[k].s || 0, Math.round(days[k].est)); delete days[k].est; }
      if (est > (j.secs || 0)) { j.secs = Math.round(est); j.estimated = true; }
      j.filled = Date.now();
      saveSet("days", days); saveSet("journey", j);
    }
    const fmtDur = s => { s = Math.round(s || 0); const hh = Math.floor(s / 3600), mm = Math.floor(s % 3600 / 60); return hh ? `${hh}h ${String(mm).padStart(2, "0")}m` : mm ? `${mm} min` : s ? "under a minute" : "0 min"; };
    function bestDaysInRow() {
      const ks = Object.keys(dayLog()).filter(k => dayLog()[k].n).sort(); let best = 0, run = 0, prev = 0;
      for (const k of ks) { const t = new Date(k + "T12:00").getTime(); run = prev && Math.round((t - prev) / 864e5) === 1 ? run + 1 : 1; prev = t; if (run > best) best = run; }
      return best;
    }
    const LABEL_TXT = { new: "new", met: "met", recognises: "recognises", recalls: "recalls", learned: "learned", longterm: "long-term" };
    const TONE_TXT = { mid: "mid", low: "low", falling: "falling", high: "high", rising: "rising" };
    // romanization: always (the default), fading as a word gets stronger, or never
    const romOn = q => romMode === "always" || (romMode === "fade" && (q.kind === "meet" || q.step <= 1));
    // each syllable in its tone's colour (the course's colours), when the course sent the tones
    function romHtml(w) {
      const ts = Array.isArray(w.tones) ? w.tones.filter(x => x && x[0]) : [];
      if (!ts.length) return esc(w.rom || "");
      return ts.map(([syl, t]) => `<span class="tn t-${esc(t)}">${esc(syl)}</span>`).join(" ");
    }
    const toneNames = w => (Array.isArray(w.tones) ? w.tones.map(x => TONE_TXT[x[1]]).filter(Boolean) : []).join(" · ");
    function thaiHtml(w, big, rom, tones) {
      tones = tones && qPrefs().show.tone;
      return `<span class="ftc-wc-th${big ? " big" : ""}" lang="th">${esc(w.th)}</span>`
        + (rom && w.rom ? `<span class="ftc-wc-rom">${romHtml(w)}</span>` : "")
        + (tones && toneNames(w) ? `<span class="ftc-wc-tones">${esc(toneNames(w))} tone${(w.tones || []).length > 1 ? "s" : ""}</span>` : "");
    }
    // Dan: "If someone is having trouble remembering a word, can we show our
    // mnemonic img, or an img if we don't have one." The word's picture (the
    // reader's own first, then the course's, then its emoji) and, unless it
    // would give the answer away, its "Remember it by" hook.
    function struggling(q) { const it = LE.item(q.id, "th"), me = LE.item(q.id, q.dir); return (it && it.wrong >= 2) || (me && me.retry) || (me && me.wrong >= 2); }
    // Dan: "can we get our images into the game, either my actual art, or the
    // emoji basic art from wordbase". The same order as the course's card:
    // the reader's own picture, the word's photo, WordBase's drawn picture
    // (its recipe art, an SVG), then the emoji. A photo that won't load falls
    // back to the drawing or the emoji.
    const svgOk = v => typeof v === "string" && /^\s*<svg[\s>]/i.test(v) && !/<script|\son\w+\s*=|javascript:/i.test(v);
    function picHtml(w) {
      const src = nowPic[w.id] || w.img || "";
      const fallback = svgOk(w.vis) ? `<span class="ftc-wc-vis">${w.vis}</span>` : w.ch ? `<span class="ftc-wc-emoji">${esc(w.ch)}</span>` : "";
      if (src) return `<img src="${esc(src)}" alt="" data-id="${esc(w.id)}">`;
      return fallback;
    }
    const picOnly = (w, cls) => { const p = qPrefs().show.pic ? picHtml(w) : ""; return p ? `<div class="ftc-wc-aid pic ${cls || ""}">${p}</div>` : ""; };
    function aidHtml(w, withText) {
      const sh = qPrefs().show, pic = sh.pic ? picHtml(w) : "";
      const txt = withText && sh.hook && (w.hook || w.aid) ? `<div><b>💡 Remember it by${w.hook ? `: ${esc(w.hook)}` : ""}</b>${w.aid ? `<span>${esc(w.aid)}</span>` : ""}</div>` : "";
      if (!pic && !txt) return "";
      return `<div class="ftc-wc-aid${txt ? "" : " pic"}">${pic}${txt}</div>`;
    }
    function fixPics(box) {
      box.querySelectorAll("img[data-id]").forEach(im => im.onerror = () => {
        const w = LE && LE.word(im.dataset.id) || {};
        const e = svgOk(w.vis) ? h("span", "ftc-wc-vis", w.vis) : w.ch ? h("span", "ftc-wc-emoji", esc(w.ch)) : null;
        if (e) im.replaceWith(e); else im.remove(); });
    }
    function cardHide() { cardEl.classList.remove("show"); }
    // Dan: "include at least one sentence with each word, with romanization ...
    // a sentence section with a slider" (like the course's). One sentence at a
    // time: the word picked out in it, romanization, English, 🔊, ‹ 1 / 3 ›,
    // and a swipe on a phone.
    function sentSlider(w, cls) {
      const ss = (w && w.sents || []).filter(x => x && x.th).slice(0, 4);
      if (!ss.length || !qPrefs().show.sents) return "";
      return `<div class="ftc-ss ${cls || ""}" data-ss="0"><div class="ftc-ss-h"><b>In a sentence</b>${ss.length > 1 ? `<span class="ftc-ss-nav"><button class="ftc-ss-b" data-ssd="-1" aria-label="Previous sentence">‹</button><i>1 / ${ss.length}</i><button class="ftc-ss-b" data-ssd="1" aria-label="Next sentence">›</button></span>` : ""}</div><div class="ftc-ss-body">${sentSlide(w, ss[0])}</div></div>`;
    }
    function markWord(w, x) {
      // the word itself, picked out: from the sentence's own words when it has them
      const toks = Array.isArray(x.toks) ? x.toks : [];
      if (toks.length && toks.some(t => t && t[1] === w.id)) return toks.map(t => t[1] === w.id ? `<mark>${esc(t[0])}</mark>` : esc(t[0])).join("");
      const i = w.th && w.th.length > 1 ? x.th.indexOf(w.th) : -1;
      return i < 0 ? esc(x.th) : esc(x.th.slice(0, i)) + `<mark>${esc(w.th)}</mark>` + esc(x.th.slice(i + w.th.length));
    }
    // no recording and no Thai voice on this device: say so on the button, rather than a silent 🔊
    const sentSlide = (w, x) => `<div class="ftc-ss-th" lang="th">${markWord(w, x)} ${x.audio || VOICE.thaiVoice() ? `<button class="ftc-wc-say ftc-ss-say" title="Hear the sentence${x.audio ? "" : " (the device's Thai voice: no recording yet)"}">🔊</button>` : `<button class="ftc-wc-say ftc-ss-say off" title="No recording for this sentence yet, and this device has no Thai voice">🔇</button>`}</div>${x.rom ? `<div class="ftc-ss-rom">${esc(x.rom)}</div>` : ""}${x.en ? `<div class="ftc-ss-en">${esc(x.en)}</div>` : ""}`;
    function wireSlider(box, w) {
      const el = box && box.querySelector(".ftc-ss"); if (!el) return;
      const ss = (w.sents || []).filter(x => x && x.th).slice(0, 4);
      const show = i => {
        i = (i + ss.length) % ss.length; el.dataset.ss = i;
        el.querySelector(".ftc-ss-body").innerHTML = sentSlide(w, ss[i]);
        const c = el.querySelector(".ftc-ss-nav i"); if (c) c.textContent = `${i + 1} / ${ss.length}`;
        const b = el.querySelector(".ftc-ss-say"); if (b) b.onclick = e => { e.stopPropagation(); const x = ss[+el.dataset.ss];
          if (x.audio) say(x.audio, x.th, 1);
          else if (VOICE.thaiVoice()) speak(x.th, 1);
          else floatText("🔇 No recording for this sentence yet (and no Thai voice on this device)", true, true); };
      };
      el.querySelectorAll("[data-ssd]").forEach(b => b.onclick = e => { e.stopPropagation(); show(+el.dataset.ss + +b.dataset.ssd); });
      let x0 = null;
      el.addEventListener("pointerdown", e => { x0 = e.clientX; });
      el.addEventListener("pointerup", e => { if (x0 !== null && ss.length > 1 && Math.abs(e.clientX - x0) > 40) show(+el.dataset.ss + (e.clientX < x0 ? 1 : -1)); x0 = null; });
      show(0);
    }
    function showWordInfo(w, current) {
      if (!w || !panelOn()) return;
      infoW = w;
      const SH = qPrefs().show, pic = SH.pic ? picHtml(w) : "";
      const tn = toneNames(w);
      const sents = sentSlider(w, "side");
      sideWord.innerHTML = `<div class="ftc-word-k">📖 ${q0label(w, current)}</div>
        <div class="ftc-word-top">${pic ? `<div class="ftc-word-pic">${pic}</div>` : ""}
          <div class="ftc-word-main"><div class="ftc-word-th" lang="th">${esc(w.th)}</div>
            ${w.rom ? `<div class="ftc-word-rom">${romHtml(w)}</div>` : ""}
            ${tn && SH.tone ? `<div class="ftc-wc-tones">${esc(tn)} tone${(w.tones || []).length > 1 ? "s" : ""}</div>` : ""}
            ${w.pos ? `<div class="ftc-word-pos">${esc(w.pos)}${w.gender && w.gender !== "neutral" ? ` · said by ${esc(w.gender === "male" ? "men" : w.gender === "female" ? "women" : w.gender)}` : ""}</div>` : ""}
            <div class="ftc-word-btns"><button class="ftc-btn" data-say>🔊 Say it</button>${w.slow ? `<button class="ftc-btn" data-slow>🐢 Slowly</button>` : ""}</div></div></div>
        <div class="ftc-word-en">${esc(w.en)}</div>
        ${SH.hook && (w.hook || w.aid) ? `<div class="ftc-word-aid"><b>💡 Remember it by${w.hook ? `: ${esc(w.hook)}` : ""}</b>${w.aid ? `<span>${esc(w.aid)}</span>` : ""}</div>` : ""}
        ${sents}`;
      fixPics(sideWord);
      const sb = sideWord.querySelector("[data-say]"); if (sb) sb.onclick = () => sayWord(w);
      const sl = sideWord.querySelector("[data-slow]"); if (sl) sl.onclick = () => say(w.slow, w.th);
      wireSlider(sideWord, w);
      sideWord.classList.remove("hidden");
    }
    const q0label = (w, current) => { const lab = LE ? LE.label(w.id) : "new"; return `${current ? "New word" : "Last word"} · <span class="lab">${LABEL_TXT[lab] || lab}</span>`; };
    function cardNext() {
      clearTimeout(cTimer); cTimer = null; cq = null; cState = ""; cHeld = false;
      if (!cardLive()) { cardHide(); return; }
      const q = LE.next();
      if (!q && reviewHard) { endHard(); return cardNext(); }      // the hard words are done for now: back to what was on
      if (!q) { cardHide(); cNextAt = performance.now() + 2000; return; }
      cq = q; cShown = performance.now(); cState = q.kind === "recall" ? "think" : "ask"; cTyped = null;
      renderCard();
      const nAns = (dayLog()[dayKey()] || {}).n || 0;
      if (LE.count() === 0) tip("start"); else if (LE.count() === 4) tip("keys"); else if (q.kind === "recall" || LE.count() === 14) tip("days");
      // 🔊 Auto-play Thai off: Thai -> meaning stays quiet (🔊 still plays it); listening questions always play
      if ((q.dir === "th" && qPrefs().auto) || q.dir === "au" || q.dir === "tp") sayWord(q.word, true);
      else if (q.dir === "sm") saySentence(q);
      if (q.isNew && !cRun.newSaid) { cRun.newSaid = 1; floatText(`✨ ${PUN.new_word}`, false, true); }
      if (q.kind === "meet") showWordInfo(q.word, true);
      // the next few words' sounds, so they're ready when they come up; and
      // everything this question may say (its slow reading, its sentences,
      // the choices' words for meaning -> Thai, tone partners)
      preloadAudio(LE.level().ids.slice(0, 40).map(id => LE.word(id)));
      const w = q.word || {};
      VOICE.preload([w.slow, q.sentence && q.sentence.audio, ...(w.sents || []).map(x => x && x.audio),
                     ...(q.dir === "en" || q.dir === "tp" ? (q.choices || []).map(c => c && c.audio) : [])]);
    }
    // ---- sentences and tones (flash-learn.js: cx, sm, tp)
    const SPECIAL = { cx: "🧩 Fill the gap", sm: "💬 What does it mean?", tp: "🎧 Which word did you hear?" };
    const SDIR = { cx: "a word in a sentence", sm: "sentence meaning", tp: "tones" };
    function saySentence(q) { const x = q.sentence; if (x && x.audio) say(x.audio, x.th, 1); else if (x) speak(x.th, 1); }
    // the sentence with the word blanked out (or highlighted, once answered)
    function sentenceHtml(q, show) {
      const x = q.sentence, w = q.word, toks = Array.isArray(x.toks) ? x.toks : [];
      const mark = t => show ? `<b class="ftc-gap ok">${esc(t)}</b>` : `<b class="ftc-gap">${"\u00a0".repeat(Math.max(3, t.length))}</b>`;
      let html = "";
      if (toks.length && toks.some(t => t[1] === w.id)) html = toks.map(t => t[1] === w.id ? mark(t[0]) : esc(t[0])).join("");
      else { const i = x.th.indexOf(w.th); html = i < 0 ? esc(x.th) : esc(x.th.slice(0, i)) + mark(w.th) + esc(x.th.slice(i + w.th.length)); }
      // once answered (Dan, 9 Nov): a 🔊 to hear the whole sentence again, with its romanization
      // under it; 🔇 when there's no recording and no Thai voice on this device
      if (!show) return `<div class="ftc-sent" lang="th">${html}</div>`;
      const can = x.audio || VOICE.thaiVoice();
      return `<div class="ftc-sent" lang="th">${html} <button class="ftc-wc-say ftc-sent-say${can ? "" : " off"}" data-sentsay title="${can ? "Hear the sentence" : "No recording for this sentence yet, and this device has no Thai voice"}">${can ? "🔊" : "🔇"}</button></div>`
        + (x.rom ? `<div class="ftc-sent-more"><i>${esc(x.rom)}</i></div>` : "");          // (the meaning is already on the card, under 💬)
    }
    // the 🔊 on an answered sentence
    function wireSentSay(q) {
      const b = cardEl.querySelector("[data-sentsay]"); if (!b) return;
      b.onclick = e => { e.stopPropagation(); const x = q.sentence;
        holdCard();
        if (x.audio || VOICE.thaiVoice()) saySentence(q);
        else floatText("🔇 No recording for this sentence yet (and no Thai voice on this device)", true, true); };
    }
    // listening again: the card waits for "Next ▸" (or Space) instead of moving on by itself
    function holdCard() {
      if (cState !== "done" || !cTimer) return;
      clearTimeout(cTimer); cTimer = null; cHeld = true;
      if (!cardEl.querySelector("[data-next]")) {
        const nx = h("button", "ftc-btn primary ftc-wc-next", "Next ▸ <small>Space</small>"); nx.dataset.next = "1";
        nx.onclick = e => { e.stopPropagation(); releaseCard(); };
        cardEl.append(nx);
      }
    }
    function releaseCard() { if (!cHeld) return; cHeld = false; cq = null; cState = ""; cardNext(); }
    function renderSpecial(q) {
      const w = q.word, x = q.sentence;
      const head = `<div class="ftc-wc-tag"><b>${SPECIAL[q.dir]}</b>${q.review ? `<span class="ftc-wc-rev">🔁 review</span>` : ""}${cStreak >= 2 ? `<span class="ftc-wc-streak">🔥 ${cStreak}</span>` : ""}<span class="ftc-wc-dir">${SDIR[q.dir]}</span></div>`;
      let prompt = "", body = "";
      if (q.dir === "tp") {
        prompt = `<div class="ftc-wc-p"><button class="ftc-wc-listen" data-say>🔊</button></div>`;
        body = `<div class="ftc-wc-ask">They sound alike: only the tone is different. Listen again as often as you like.</div><div class="ftc-wc-opts n${q.choices.length}">` + q.choices.map((c, i) =>
          `<button class="ftc-wc-o" data-i="${i}"><i>${i + 1}</i><span>${thaiHtml(c, false, true, true)}</span></button>`).join("") + `</div>`;
      } else if (q.dir === "cx") {
        prompt = sentenceHtml(q, false) + (x.en ? `<div class="ftc-sent-en">💬 ${esc(x.en)}</div>` : "");
        body = q.kind === "pick"
          ? `<div class="ftc-wc-ask">Which word fits the gap?</div><div class="ftc-wc-opts n${q.choices.length}">` + q.choices.map((c, i) =>
              `<button class="ftc-wc-o" data-i="${i}"><i>${i + 1}</i><span>${thaiHtml(c, false, romOn(q))}</span></button>`).join("") + `</div>`
          : `<div class="ftc-wc-ask">Say the missing word in your head…</div><div class="ftc-wc-ans"></div><div class="ftc-wc-opts one"><button class="ftc-wc-o reveal" data-reveal><i>␣</i><span>Show the answer</span></button></div>`;
      } else {
        prompt = `<div class="ftc-wc-p"><div class="ftc-sent" lang="th">${esc(x.th)}</div>${x.rom && romMode !== "never" ? `<div class="ftc-sent-rom">${esc(x.rom)}</div>` : ""}${x.audio ? `<span class="ftc-wc-btns"><button class="ftc-wc-say" data-ssay title="Hear it">🔊</button></span>` : ""}</div>`;
        body = q.kind === "pick"
          ? `<div class="ftc-wc-ask">What does it mean?</div><div class="ftc-wc-opts one">` + q.choices.map((c, i) =>
              `<button class="ftc-wc-o" data-i="${i}"><i>${i + 1}</i><span>${esc(c.en)}</span></button>`).join("") + `</div>`
          : `<div class="ftc-wc-ask">Think of what it means…</div><div class="ftc-wc-ans"></div><div class="ftc-wc-opts one"><button class="ftc-wc-o reveal" data-reveal><i>␣</i><span>Show the answer</span></button></div>`;
      }
      cardEl.className = "ftc-wc show k-" + q.kind + " d-" + q.dir;
      cardEl.innerHTML = head + prompt + body;
      cardEl.querySelectorAll("[data-say]").forEach(b => b.onclick = e => { e.stopPropagation(); sayWord(w); });
      cardEl.querySelectorAll("[data-ssay]").forEach(b => b.onclick = e => { e.stopPropagation(); saySentence(q); });
      cardEl.querySelectorAll(".ftc-wc-o[data-i]").forEach(b => b.onclick = () => cardPick(+b.dataset.i));
      const rv = cardEl.querySelector("[data-reveal]"); if (rv) rv.onclick = () => cardReveal();
    }
    function renderCard() {
      const q = cq, w = q.word;
      if (SPECIAL[q.dir]) return renderSpecial(q);
      const tag = q.kind === "meet" ? (q.isNew ? "✨ New word" : "📖 Meet again") : q.kind === "recall" ? "🧠 Recall" : `Pick of ${q.choices.length}`;
      const head = `<div class="ftc-wc-tag"><b>${tag}</b>${q.review ? `<span class="ftc-wc-rev">🔁 review</span>` : ""}${cStreak >= 2 ? `<span class="ftc-wc-streak">🔥 ${cStreak}</span>` : ""}<span class="ftc-wc-dir">${q.dir === "th" ? "Thai → meaning" : q.dir === "en" ? "meaning → Thai" : "🎧 listening"}</span></div>`;
      const slowB = w.slow ? `<button class="ftc-wc-say slow" data-slow title="Slowly">🐢</button>` : "";
      let prompt;
      // meaning -> Thai: the picture says the same as the English, so it can show
      if (q.dir === "en") prompt = `<div class="ftc-wc-en big">${esc(short(w.en, 40))}</div>`;
      else if (q.dir === "au") prompt = `<div class="ftc-wc-p"><button class="ftc-wc-listen" data-say>🔊</button>${slowB}</div>`;
      else prompt = `<div class="ftc-wc-p">${thaiHtml(w, true, romOn(q), q.kind === "meet")}<span class="ftc-wc-btns"><button class="ftc-wc-say" data-say title="Hear it">🔊</button>${slowB}</span></div>`;
      let body = "";
      if (q.kind === "meet") {
        const ans = q.dir === "en" ? thaiHtml(w, false, true) : esc(short(w.en, 40));
        // on a wide screen the full word card under this one already shows the picture and hook
        body = (panelOn() ? picOnly(w, "big") : aidHtml(w, true)) + `<div class="ftc-wc-ask">${q.dir === "en" ? "In Thai it's…" : "It means…"}</div><div class="ftc-wc-opts one"><button class="ftc-wc-o" data-i="0"><i>1</i><span>${ans}</span></button></div>`
          + (panelOn() && !root.classList.contains("sideways") ? "" : sentSlider(w, "meet"));
      } else {
        // a word that keeps going wrong gets its picture as a hint (not the hook: that would give it away)
        // Dan: "We only show the picture when learning, don't need it in quiz mode": no picture on questions
        const hint = "";
        if (q.kind === "pick") {
          // ⌨ Type first: a go at typing it before the choices show (the course's quiz does the same)
          const typing = qPrefs().type && (q.dir === "th" || q.dir === "en") && cTyped === null;
          const miss = cTyped && cTyped.trim() ? `<div class="ftc-wc-miss">Not quite (“${esc(cTyped.trim())}”). Pick it from these:</div>` : "";
          body = hint + `<div class="ftc-wc-ask">${DIR_ASK[q.dir]}</div>` + miss
            + (typing ? `<div class="ftc-wc-type"><input type="text" class="ftc-wc-in" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="${q.dir === "en" ? "Type it — in Thai or in romanization" : "Type what it means"}"><div class="ftc-row"><button class="ftc-btn primary" data-check>Check</button><button class="ftc-btn" data-skip>Show the choices</button></div></div>` : "")
            + `<div class="ftc-wc-opts n${q.choices.length}"${typing ? " hidden" : ""}>` + q.choices.map((c, i) =>
            `<button class="ftc-wc-o" data-i="${i}"><i>${i + 1}</i><span>${q.dir === "en" ? thaiHtml(c, false, romOn(q)) : esc(short(c.en, 34))}</span></button>`).join("") + `</div>`;
        } else {
          body = hint + `<div class="ftc-wc-ask">${q.dir === "en" ? "Say it in Thai in your head…" : "Think of the meaning…"}</div>
            <div class="ftc-wc-ans"></div><div class="ftc-wc-opts one"><button class="ftc-wc-o reveal" data-reveal><i>␣</i><span>Show the answer</span></button></div>`;
        }
      }
      cardEl.className = "ftc-wc show k-" + q.kind + " d-" + q.dir;
      cardEl.innerHTML = head + prompt + body;
      fixPics(cardEl); wireSlider(cardEl, w);
      cardEl.querySelectorAll("[data-say]").forEach(b => b.onclick = e => { e.stopPropagation(); sayWord(w); });
      cardEl.querySelectorAll("[data-slow]").forEach(b => b.onclick = e => { e.stopPropagation(); say(w.slow, w.th); });
      cardEl.querySelectorAll(".ftc-wc-o[data-i]").forEach(b => b.onclick = () => cardPick(+b.dataset.i));
      const rv = cardEl.querySelector("[data-reveal]"); if (rv) rv.onclick = () => cardReveal();
      const inp = cardEl.querySelector(".ftc-wc-in");
      if (inp) {
        const go = () => { const v = inp.value; if (!v.trim()) return;
          if (typedRight(q, v)) { cTyped = v; cardDone(true, null, 3); floatText("⌨ Typed it! " + PUN.right, false, true); }
          else { cTyped = v; renderCard(); } };
        cardEl.querySelector("[data-check]").onclick = go;
        cardEl.querySelector("[data-skip]").onclick = () => { cTyped = " "; renderCard(); };
        inp.addEventListener("keydown", e => { e.stopPropagation(); if (e.key === "Enter") { e.preventDefault(); go(); } });
        setTimeout(() => { try { inp.focus({ preventScroll: true }); } catch (e) {} }, 30);
      }
    }
    // a typed answer, marked like the course's quiz: the meaning (any of them,
    // one or two letters off on a long word), or the Thai, or its romanization
    const normMean = t => String(t || "").toLowerCase().replace(/\[[^\]]*\]|\([^)]*\)/g, " ").replace(/^(to|a|an|the)\s+/, "").replace(/[^a-z0-9\s']/g, " ").replace(/\s+/g, " ").trim();
    const meaningsOf = m => String(m || "").replace(/\[[^\]]*\]|\([^)]*\)/g, " ").split(/[,;\/]| or /).map(normMean).filter(Boolean);
    const normRom = t => String(t || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/ɔ/g, "o").replace(/ɛ/g, "e").replace(/ʉ/g, "u").replace(/ə/g, "e").replace(/ŋ/g, "ng").replace(/[^a-z]/g, "");
    function lev(a, b) {
      if (Math.abs(a.length - b.length) > 2) return 9;
      const m = []; for (let i = 0; i <= a.length; i++) m[i] = [i]; for (let j = 0; j <= b.length; j++) m[0][j] = j;
      for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) m[i][j] = Math.min(m[i - 1][j] + 1, m[i][j - 1] + 1, m[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      return m[a.length][b.length];
    }
    function typedRight(q, raw) {
      const t = String(raw || "").trim(), w = q.word; if (!t) return false;
      if (q.dir === "th") { const n = normMean(t); return meaningsOf(w.en).some(c => n === c || (c.length >= 5 && lev(n, c) <= 1) || (c.length >= 9 && lev(n, c) <= 2)); }
      if (t.replace(/\s/g, "") === String(w.th || "").replace(/\s/g, "")) return true;
      return !!(w.rom && normRom(t) && normRom(t) === normRom(w.rom));
    }
    function cardReveal() {
      if (!cq || cState !== "think") return;
      const q = cq, w = q.word; cState = "grade";
      const ans = cardEl.querySelector(".ftc-wc-ans");
      if (q.dir === "cx") { const p = cardEl.querySelector(".ftc-sent"); if (p) p.outerHTML = sentenceHtml(q, true); wireSentSay(q); ans.innerHTML = thaiHtml(w, false, true, true) + ` = <b>${esc(short(w.en, 40))}</b>`; saySentence(q); }
      else if (q.dir === "sm") ans.innerHTML = `<span class="ftc-wc-en">${esc(q.sentence.en)}</span>`;
      else ans.innerHTML = q.dir === "en" ? thaiHtml(w, true, true, true) : `<span class="ftc-wc-en">${esc(short(w.en, 40))}</span>${q.dir === "au" ? thaiHtml(w, false, true, true) : ""}`;
      ans.classList.add("show");
      if (q.dir === "en") sayWord(w, true);
      const opts = cardEl.querySelector(".ftc-wc-opts");
      // three grades, for the scheduler (FSRS): knew it = Good (Easy when it was
      // fast), just about = Hard (comes back sooner), not yet = Again
      opts.className = "ftc-wc-opts n3 grade";
      opts.innerHTML = `<button class="ftc-wc-o yes" data-g="3"><i>1</i><span>✓ Knew it</span></button><button class="ftc-wc-o hard" data-g="2"><i>2</i><span>😅 Just about</span></button><button class="ftc-wc-o no" data-g="1"><i>3</i><span>✗ Not yet</span></button>`;
      opts.querySelectorAll("[data-g]").forEach(b => b.onclick = () => cardDone(b.dataset.g !== "1", b, +b.dataset.g));
    }
    function cardPick(i) {
      if (!cq || cState !== "ask") return;
      if (cardEl.querySelector(".ftc-wc-in")) return;          // typing first: the choices aren't out yet
      const c = cq.choices[i]; if (!c) return;
      // right after a typed miss = Hard for the scheduler
      cardDone(c.id === cq.id, cardEl.querySelectorAll(".ftc-wc-o")[i], cTyped && cTyped.trim() && c.id === cq.id ? 2 : undefined);
    }
    // Dan: "We can give the user question/answer streaks, which help flash."
    // Right answers in a row (meetings don't count, nor break it) make each
    // reward stronger, and every dash_every in a row Flash lets out his blue
    // shockwave. A wrong answer starts the count again.
    const STREAK_EVERY = Math.max(1, +(WD.dash_every || 5));
    function cardDone(right, btn, grade) {
      const q = cq; if (!q || cState === "done") return;
      cState = "done";
      const ms = Math.round(performance.now() - cShown);
      const r = LE.answer(q, { right, ms, grade });
      const w = q.word, meet = q.kind === "meet";
      cardEl.querySelectorAll(".ftc-wc-o").forEach(b => { b.disabled = true; const i = +b.dataset.i; if (!isNaN(i) && q.choices[i] && q.choices[i].id === q.id) b.classList.add("ok"); });
      if (btn && !right) btn.classList.add("bad");
      if (btn && right) btn.classList.add("ok");
      const spec = !!SPECIAL[q.dir];
      if (q.dir === "en" && q.kind !== "recall") sayWord(w, true);
      if (spec && q.kind === "pick") {
        // the whole sentence (or the tone pair), shown and heard, right or wrong
        if (q.dir === "cx") { const p = cardEl.querySelector(".ftc-sent"); if (p) p.outerHTML = sentenceHtml(q, true); wireSentSay(q); saySentence(q); }
        if (q.dir === "sm") saySentence(q);
        if (q.dir === "tp") {
          sayWord(w, false);
          // hearing them side by side is the lesson: each one can be played now
          const fb = h("div", "ftc-wc-fix ftc-tp", `<small>You heard <b lang="th">${esc(w.th)}</b>${toneNames(w) ? ` (${esc(toneNames(w))} tone)` : ""}. Compare them:</small><div class="ftc-tp-row">${q.choices.map((c, i) =>
            `<button class="ftc-btn" data-cmp="${i}"><span lang="th">${esc(c.th)}</span> <i>${romHtml(c)}</i> 🔊<small>${esc(short(c.en, 18))}</small></button>`).join("")}</div>`);
          fb.querySelectorAll("[data-cmp]").forEach(b => b.onclick = () => { const c = q.choices[+b.dataset.cmp]; if (c) say(c.audio, c.th); });
          cardEl.append(fb);
        }
      }
      if (right) {
        SFX.play(meet ? "helped" : "right");
        if (!meet) { cStreak++; cRun.right++; cRun.best = Math.max(cRun.best, cStreak); }
        const milestone = !meet && cStreak > 0 && cStreak % STREAK_EVERY === 0;
        // its own reward row (Rewards > card_right): the word card is the main way of studying now,
        // so it powers Flash like a quiz answer, not like the old floating gems
        sim.applyReward({ v: 1, kind: "reward", source: "card", strength: meet ? CM.meet_strength : spec ? CM.sentence_strength : q.kind === "recall" ? CM.recall_strength : 1,
                          streak: cStreak, word: w.th, dash: milestone });
        if (milestone) { SFX.play("dash"); if (A("banners")) banner(`🔥 ${cStreak} in a row!`, `Flash dash! ${cStreak % (STREAK_EVERY * 3) === 0 ? pick1(PUN.challenge) : cStreak % (STREAK_EVERY * 2) === 0 ? PUN.right : ""}`); sim.noteStudy("card_streak_" + cStreak); }
        else if (!meet && Math.random() < 0.12) floatText(`😺 ${PUN.right}`, false, true);
        logWord(w, meet ? "helped" : "right");
        if (!meet && st.flash) for (let i = 0; i < 10; i++) burst(st.flash.x, st.flash.y, BLUE_HI, 220);
        // the word and its picture, so every right answer ends on the picture too
        if (!meet && !spec) { const ok = h("div", "ftc-wc-fix good ftc-wc-okpic", `<div>${thaiHtml(w, false, true)} = <b>${esc(short(w.en, 40))}</b>${r.backIn ? ` <small class="ftc-back" title="when it's due for review (FSRS)">🗓 back in ${r.backIn} day${r.backIn > 1 ? "s" : ""}</small>` : ""}</div>`); cardEl.append(ok); }
      } else {
        SFX.play("wrong");
        if (cStreak >= 3) { floatText(`🔥 Streak of ${cStreak} ended`, true); setTimeout(() => floatText(pick1(PUN.encourage), false, true), 700); }
        cStreak = 0; cRun.wrong++;
        sim.noteStudy(q.kind === "recall" ? "card_notyet" : "card_wrong");
        logWord(w, "wrong");
        // the right answer, said and shown, with the word's picture and memory hook (corrective feedback)
        if (spec) { if (q.dir === "sm") cardEl.append(h("div", "ftc-wc-fix", `<div><b>${esc(q.sentence.en)}</b></div><small>${PUN.wrong} It comes back in a moment.</small>`)); }
        else {
        const fb = h("div", "ftc-wc-fix", `<div>${q.dir === "en" ? "" : thaiHtml(w, false, true, true) + " = "}<b>${esc(short(w.en, 40))}</b>${q.dir === "en" ? " = " + thaiHtml(w, false, true, true) : ""}</div>`
          + aidHtml(w, true) + `<small>${PUN.wrong} It comes back in a moment.</small>`);
        cardEl.append(fb); fixPics(fb); sayWord(w, true);
        }
      }
      sim.noteStudy("card_" + q.kind + (right ? "_right" : "_wrong"));
      if (r && r.now.label !== r.was.label && LABELS_UP[r.now.label] && right) {
        cRun.up[w.id] = r.now.label;
        floatText(`${LABELS_UP[r.now.label]} ${w.th} = ${short(w.en)}`, false, true);
        if (r.now.label === "learned" || r.now.label === "longterm") SFX.play("learned");
      }
      if (r && r.opened && r.opened.includes("en")) floatText(`🔄 ${w.th}: now the other way round too`, false, true);
      if (r && r.opened && r.opened.includes("cx")) floatText(`🧩 ${w.th}: now in sentences too`, false, true);
      if (r && r.opened && r.opened.includes("tp")) floatText(`🎧 ${w.th}: can you hear its tone?`, false, true);
      if (opts.onWord) try { opts.onWord({ result: right ? "match" : "miss", id: w.id, helped: meet }); } catch (e) {}
      noteDay(right && !meet, meet); checkLevel(); showWordInfo(w); drawSide(true);
      // a wrong answer with a memory aid to read gets a little longer
      const wait = meet ? CM.next_after_meet : spec && right ? CM.next_after_sentence + (q.dir === "cx" && q.sentence ? Math.min(2, q.sentence.th.length * 0.03) : 0) : right ? CM.next_after_right + 0.2 : CM.next_after_wrong + (w.aid && !spec ? 1.2 : 0) + (spec ? 0.8 : 0) + (q.dir === "tp" ? 1.5 : 0);
      cTimer = setTimeout(() => { cq = null; cState = ""; cardNext(); }, wait * 1000);
    }
    const LABELS_UP = { recognises: "👀 Recognised:", recalls: "🧠 Recalled:", learned: "⭐ Learned:", longterm: "🏆 Long-term:" };
    // ---- the top of the study panel (11 Nov, Dan: "too many icons, and they don't seem to
    // do anything ... a simple system"). What's there now: the lesson (a drop-down when the
    // host gives the list), today's new words against the number the learner chose, days in
    // a row, the two word lists (learning now / learnt) and a review (everything / hard words).
    const NEW_CHOICES = [5, 10, 15, 20, 30];
    let levelList = null, levelsAsked = false, goalOpen = false, revOpen = false;
    let reviewHard = null;                 // a "hard words only" review: { n, back }
    function askLevels() {
      if (levelsAsked || !opts.levels) return; levelsAsked = true;
      Promise.resolve().then(() => opts.levels()).then(l => { levelList = Array.isArray(l) ? l.filter(x => x && x.id && x.title) : []; syncLocation(); drawSide(true); }).catch(() => { levelList = []; });
    }
    // the lesson's place in the course (1, 2, 3 ...), when the host's list has it
    const lessonNumber = () => { const i = levelList && lesson ? levelList.findIndex(l => l.id === lesson.id) : -1; return i < 0 ? 0 : i + 1; };
    // Round 3 step 5: the location follows the lesson (a new one every 10). A run that's
    // going moves there when its next round starts.
    function syncLocation() {
      if (!sim.locationFor) return;
      const L = sim.locationFor(lessonNumber() || 1), was = sim.locationWanted();
      sim.setLocation(L ? L.id : null);
      if ((L ? L.id : null) !== was && st.phase !== "fight" && st.phase !== "break") { showLocation(); if (st.phase === "start" && !optsOpen && uiScreen === "start") showStart(); }
    }
    const newGoal = () => Math.max(1, +(LE.S.new_per_day || 20));
    const hardIds = () => LE.hardest(30).filter(x => x.wrong > 0).map(x => x.id);
    function endHard(quiet) {
      if (!reviewHard) return;
      LE.setOnly(null); LE.setFocus(reviewHard.back); reviewHard = null;
      if (!quiet) floatText("🔁 Hard words done: back to your words", false, true);
      drawSide(true);
    }
    // "all": everything met so far, no new words (the same switch as the start screen's
    // review mode). "hard": only the words that have gone wrong. "new": new words + review.
    function startReview(kind) {
      if (!LE) return;
      endHard(true);
      if (kind === "hard") {
        const ids = hardIds();
        if (!ids.length) { floatText("No hard words yet: nothing has gone wrong 😸"); revOpen = false; drawSide(true); return; }
        reviewHard = { n: ids.length, back: LE.focus() }; LE.setOnly(ids); LE.setFocus("review"); LE.practise(ids);
      } else { const f = kind === "all" ? "review" : "new"; LE.setFocus(f); saveSet("focus", f); }
      revOpen = false;
      if (cardLive() && cState !== "done") cardNext();
      if (st.phase === "start" && !optsOpen && uiScreen === "start") showStart();
      drawSide(true);
    }
    sideHead.addEventListener("click", e => {
      const b = e.target.closest ? e.target.closest("button") : null; if (!b || !sideHead.contains(b)) return;
      const d = b.dataset;
      if (d.prog !== undefined) showProgress();
      else if (d.words) { wordsFilter = d.words; showWords(); }
      else if (d.goal !== undefined) { goalOpen = !goalOpen; revOpen = false; drawSide(true); }
      else if (d.newday) { setQ("newday", +d.newday); goalOpen = false; floatText(`🎯 ${d.newday} new words a day`, false, true); drawSide(true); }
      else if (d.rev !== undefined) { revOpen = !revOpen; goalOpen = false; drawSide(true); }
      else if (d.review) startReview(d.review);
    });
    sideHead.addEventListener("change", e => {
      const t = e.target; if (!t || t.dataset.level === undefined) return;
      const id = t.value; t.blur();
      if (id && opts.goLevel && (!lesson || id !== lesson.id)) { endHard(true); try { opts.goLevel(id); } catch (err) {} }
    });
    let sideAt = 0;
    function drawSide(now) {
      if (!panelOn() && !stackOn()) return;
      const t = performance.now(); if (!now && t - sideAt < 400) return; sideAt = t;
      askLevels();
      // a drop-down that's open would close if the bar were redrawn under it
      const ae = document.activeElement; if (ae && ae.tagName === "SELECT" && sideHead.contains(ae)) return;
      const p = LE.levelProgress(), sm = LE.summary(), k = p.total ? p.recognises / p.total : 0;
      const goal = newGoal(), met = LE.newToday ? LE.newToday() : 0, days = daysInRow();
      const learnt = sm.th.learned, nowN = Math.max(0, sm.th.met - learnt), asked = +qPrefs().newday > 0;
      const rev = reviewHard ? "hard" : LE.focus() === "review" ? "all" : "";
      const sel = levelList && levelList.length && opts.goLevel ? (() => {
        const cur = lesson && lesson.id, groups = {}, mast = SAVE.get().mastered || {};
        for (const l of levelList) (groups[l.catName || l.cat || "Lessons"] = groups[l.catName || l.cat || "Lessons"] || []).push(l);
        const og = Object.entries(groups), opt = l => `<option value="${esc(l.id)}"${l.id === cur ? " selected" : ""}>${esc(l.title)}${mast[l.id] ? " 🏆" : ""}</option>`;
        return `<select class="ftc-side-sel" data-level title="Switch lesson: the game carries on">${cur && !levelList.some(l => l.id === cur) ? `<option selected>${esc(levelTitle())}</option>` : ""}${og.length > 1 ? og.map(([g, ls]) => `<optgroup label="${esc(g)}">${ls.map(opt).join("")}</optgroup>`).join("") : levelList.map(opt).join("")}</select>`;
      })() : "";
      const goalBtn = `<button class="ftc-side-chip" data-goal title="New words met today, out of the number you chose. Tap to change it">🎯 ${Math.min(met, 999)}/${goal} new today</button>`;
      const daysChip = `<span class="ftc-side-chip" title="days in a row with at least one answer">📅 ${days} day${days === 1 ? "" : "s"} in a row</span>`;
      const pickGoal = goalOpen || (!asked && !stackOn()) ? `<div class="ftc-side-pick"><span>${asked ? "New words a day" : "How many new words a day?"}</span>${NEW_CHOICES.map(n => `<button data-newday="${n}"${asked && n === goal ? ' class="on"' : ""}>${n}</button>`).join("")}</div>` : "";
      const hardN = revOpen ? hardIds().length : 0;
      const pickRev = revOpen ? `<div class="ftc-side-pick"><span>Review</span><button data-review="all"${rev === "all" ? ' class="on"' : ""} title="Every word you've met, the ones due first. No new words">Everything (${sm.th.met})</button><button data-review="hard"${rev === "hard" ? ' class="on"' : ""} title="Only the words you've got wrong">Hard words only (${hardN})</button>${rev ? `<button data-review="new" title="New words, with the reviews that are due">Back to new words</button>` : ""}</div>`
        : rev ? `<div class="ftc-side-pick on"><span>🔁 Reviewing: ${rev === "hard" ? `hard words (${reviewHard.n})` : "everything, no new words"}</span><button data-review="new">Back to new words</button></div>` : "";
      const html = stackOn() ? `<div class="ftc-side-mini"><b>${esc(short(levelTitle(), 26))}</b>${goalBtn}<span>📅 ${days}</span><button class="ftc-btn" data-words="now" title="The words you're learning now, and the ones you've learnt">Words</button><button class="ftc-btn" data-rev title="Start a review">🔁</button></div>${pickGoal}${pickRev}`
        : `<div class="ftc-side-lv"><span>Lesson</span>${sel || `<b>${esc(levelTitle())}</b>`}</div>
        <div class="ftc-side-bar" title="${p.recognises} of ${p.total} recognised · next level at ${Math.round(LE.S.ready_share * 100)}%"><i style="width:${Math.round(k * 100)}%"></i><em style="left:${Math.round(LE.S.ready_share * 100)}%"></em></div>
        <div class="ftc-side-day">${goalBtn}${daysChip}</div>${pickGoal}
        <div class="ftc-side-acts"><button class="ftc-btn" data-words="now" title="Words you've met and are still learning">Learning now <b>${nowN}</b></button><button class="ftc-btn" data-words="learnt" title="Words you've remembered on two different days">Learnt <b>${learnt}</b></button><button class="ftc-btn${rev ? " on" : ""}" data-rev title="Start a review: everything, or only the hard words">🔁 Review</button><button class="ftc-btn" data-prog title="${PUN.check}">Progress</button></div>${pickRev}
        <div class="ftc-side-streak${cStreak >= STREAK_EVERY ? " hot" : ""}">🔥 <b>${cStreak}</b> in a row<small>${cStreak % STREAK_EVERY === 0 && cStreak ? "Flash dash!" : `${STREAK_EVERY - (cStreak % STREAK_EVERY)} more for a Flash dash`} · best ${cRun.best}</small></div>`;
      if (sideHead._h !== html) { sideHead._h = html; sideHead.innerHTML = html; }
      const live = cardLive();
      const idle = live ? "" : st.phase === "start" ? "Pick a weapon to start: the words come here." : st.paused || optsOpen ? "⏸ Paused" :
        qOpen ? "❤️ Answer the Save Flash question" : st.phase === "break" ? "Between rounds. Tick <b>Auto-pick</b> to keep answering here." : st.phase === "over" ? "Flash fell. Play again to keep studying." : "";
      sideIdle.innerHTML = idle; sideIdle.style.display = idle && !cardEl.classList.contains("show") ? "" : "none";
      // the word card from the course hides while that same word is being asked
      const hideInfo = !!(cq && infoW && cq.id === infoW.id && cq.kind !== "meet" && cState !== "done");
      sideWord.classList.toggle("hidden", hideInfo);
    }
    // Dan: "if every word in the lesson is at 80%, can probably offer the choice to move on"
    function checkLevel() {
      if (!LE || !lesson) return;
      const p = LE.levelProgress(), id = lesson.id;
      const s = levelSeen[id] || (levelSeen[id] = {});
      if (p.mastered && !s.mastered) { s.mastered = 1; s.ready = 1; levelPanel(p, true); }
      else if (p.ready && !s.ready) { s.ready = 1; levelPanel(p, false); }
    }
    function levelPanel(p, all) {
      const nx = lesson && lesson.next;
      SFX.play(all ? "boss_down" : "levelup");
      if (A("banners")) banner(all ? "🏆 Level mastered!" : `✅ Level ready! ${PUN.achievement}`, all ? `you recall all ${p.total} words` : `${p.recognises} of ${p.total} words recognised`);
      if (all) { const m = SAVE.get().mastered || {}; if (!m[lesson.id]) { m[lesson.id] = { at: Date.now(), words: p.total, title: lesson.title || "" }; saveSet("mastered", m); } sim.noteStudy("lesson_mastered"); }
      masterEl.innerHTML = `<b>${all ? "🏆 Level mastered!" : "✅ Ready for the next level"}</b><small>${all ? `You recall all ${p.total} words` : `You recognise ${p.recognises} of ${p.total} words`}${lesson.title ? ` in <i>${esc(lesson.title)}</i>` : ""}.
        ${all ? "" : " Keep going here to recall them without choices, or move on: these words keep coming back to review."}${nx ? "" : " That's the last lesson in the course."}</small>`;
      const row = h("div", "ftc-learn-row");
      if (nx && opts.goNextLesson) { const go = h("button", "ftc-btn primary", `➡ Next level${nx.title ? ": " + esc(nx.title) : ""}`);
        go.onclick = () => { masterEl.classList.remove("show"); try { opts.goNextLesson(); } catch (e) {} }; row.append(go); }
      const stay = h("button", "ftc-btn", nx ? "Keep practising here" : "OK"); stay.onclick = () => masterEl.classList.remove("show");
      const sh = h("button", "ftc-btn", "📣 Share"); sh.onclick = () => shareCard(all ? "mastered" : "ready");
      row.append(stay, sh); masterEl.append(row); masterEl.classList.add("show");
    }
    function updateCard() {
      if (!cardOn()) { if (cardEl.classList.contains("show")) cardHide(); return; }
      drawSide(false);
      // hidden while paused or under a "Save Flash!" question; the same question comes back
      if (!cardLive()) { if (cardEl.classList.contains("show")) cardHide(); return; }
      if (cq && !cardEl.classList.contains("show")) { const g = cState === "grade"; if (cState !== "done") { cState = cq.kind === "recall" ? "think" : "ask"; renderCard(); if (g) cardReveal(); } else cardEl.classList.add("show"); return; }
      if (!cq && !cTimer && performance.now() >= cNextAt) cardNext();
    }
    function cardKey(e) {
      if (!cq || !cardEl.classList.contains("show")) return false;
      if (e.key === " " || e.key === "Enter") {
        if (cState === "done" && cHeld) { releaseCard(); return true; }
        if (cState === "think") { cardReveal(); return true; }
        if (cState === "ask" && cq.kind === "meet") { cardPick(0); return true; }
        return false;
      }
      if (/^[1-6]$/.test(e.key)) {
        const i = +e.key - 1;
        if (cState === "ask") { cardPick(i); return true; }
        if (cState === "grade" && i < 3) { const b = cardEl.querySelectorAll(".ftc-wc-o")[i]; if (b) { cardDone(i < 2, b, +b.dataset.g); return true; } }
      }
      return false;
    }
    function setWordMode(m) {
      wordMode = m === "gems" ? "gems" : "card"; saveSet("words", wordMode);
      if (wordMode === "card") { clearGems(); } else { clearTimeout(cTimer); cTimer = null; cq = null; cardHide(); }
    }

    // ------------------------------------------- learning mode (after a fall)
    // Dan: "When a player dies, we should have a learning mode, very few
    // skeletons, we show the user the correct answers Thai <-> English, 2/3
    // times for each word, then test mode, if the user gets above 80% they get
    // a bonus item next run."
    //   learn: each word shown as a joined pair, Thai first one time, English
    //          first the next (2 times; 3 for words that went wrong twice or
    //          more). The Thai says itself; tap the English (or wait) to go on.
    //   test:  the same words as gems, 3 pairs at a time, no decoys. A word is
    //          right if it was matched without a wrong try starting from it.
    //   pass (80%): one bonus item, kept in this browser (ftc.save), given at
    //          the start of the next run.
    // Tuned in Game settings > learn.
    const LM = Object.assign({ enabled: true, min_words: 4, max_words: 8, reps: 2, reps_hard: 3, show_seconds: 5,
                               test_pairs: 3, pass: 0.8, max_bonus: 3 }, ((sim.D.settings || {}).learn || {}).values || {});
    let learn = null, learnAttempts = 0;
    const ftcSave = SAVE;
    const bonusWaiting = () => (ftcSave.get().bonus || []).filter(b => b && b.id);
    const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
    function learnList() {
      const all = Object.values(runWords).filter(r => r.w && r.w.th && r.w.en);
      const bad = r => (r.wrong || 0) * 2 + (r.missed || 0);
      const out = [], have = new Set(), ths = new Set(), ens = new Set();
      const add = r => {
        if (out.length >= LM.max_words || !r || !r.w || !r.w.th || !r.w.en || have.has(r.w.id)) return;
        const en = short(r.w.en);
        if (ths.has(r.w.th) || ens.has(en)) return;           // two "to get"s would make the test unfair
        have.add(r.w.id); ths.add(r.w.th); ens.add(en); out.push(r);
      };
      all.filter(r => bad(r) > 0).sort((a, b) => bad(b) - bad(a)).forEach(add);
      const fill = list => { for (const r of list) { if (out.length >= LM.min_words) break; add(r); } };
      fill(all.slice().sort((a, b) => (a.right || 0) - (b.right || 0)));
      fill(words.slice().sort((a, b) => (b.weight || 1) - (a.weight || 1)).map(w => ({ w, seen: 0, right: 0, wrong: 0, missed: 0 })));
      return out;
    }
    function learnPanel(html, buttons) {
      learnEl.innerHTML = html;
      const row = h("div", "ftc-learn-row");
      for (const [label, fn, cls] of buttons || []) { const b = h("button", "ftc-btn" + (cls ? " " + cls : ""), label); b.onclick = fn; row.append(b); }
      learnEl.append(row);
      learnEl.classList.add("show"); bandAt = 0;
    }
    function startLearn() {
      const list = learnList();
      if (!list.length || !sim.startPractice()) return;
      hideOverlay(); clearGems(); closeQuestion();
      const rounds = [];
      for (let rep = 0; rep < Math.max(LM.reps, LM.reps_hard); rep++) {
        const r = shuffle(list.filter(x => rep < ((x.wrong || 0) + (x.missed || 0) >= 2 ? LM.reps_hard : LM.reps)));
        const prev = rounds.length && rounds[rounds.length - 1];
        if (prev && r.length > 1 && r[0] === prev.r) [r[0], r[1]] = [r[1], r[0]];   // never the same word twice in a row
        for (const x of r) rounds.push({ r: x, rep });
      }
      learn = { mode: "learn", list, queue: rounds, i: -1, item: null, started: performance.now(), attempt: ++learnAttempts, link: scene.add.graphics().setDepth(39) };
      announce("learning");
      nextLearn();
    }
    function nextLearn() {
      if (!learn) return;
      for (const g of gems.slice()) dropGem(g);
      learn.i++;
      if (learn.i >= learn.queue.length) return startTest();
      const it = learn.queue[learn.i], w = it.r.w, first = it.rep % 2 ? "en" : "th";
      const b = gemBand(), mid = (b.top + FlashSim.H - b.bottom) / 2, x = st.W / 2;
      const g1 = makeGem(w, first, { noHint: true }), g2 = makeGem(w, first === "th" ? "en" : "th", { noHint: true });
      Object.assign(g1, { x, y: mid - 85, fixed: true, learn: true }); Object.assign(g2, { x, y: mid + 85, fixed: true, learn: true, delay: 0.9 });
      for (const g of [g1, g2]) { g.paint(true); g.c.setAlpha(0); gems.push(g); }
      learn.item = { w, g1, g2, t: 0, said: false, done: false };
      if (first === "th") { sayWord(w); learn.item.said = true; }
      learnPanel(`<b>📚 Learning</b> <span>${learn.i + 1} / ${learn.queue.length}</span><i class="ftc-learn-bar"><i style="width:${Math.round(learn.i / learn.queue.length * 100)}%"></i></i>
        <small>Look, listen, remember. Tap the Thai to hear it again, the English to go on.</small>`,
        [["⏭ Skip to the test", () => startTest()], ["✕ Stop", () => stopLearn()]]);
    }
    function learnClick(g) {
      const it = learn.item; if (!it || it.done) return;
      if (g.side === "th") return;                              // it has just spoken
      it.done = true; ladderRight(it.w, true);
      for (const x of [it.g1, it.g2]) for (let i = 0; i < 10; i++) burst(x.x, x.y, x.side === "th" ? 0xc58aff : 0x6cc8ff, 200);
      setTimeout(nextLearn, 250);
    }
    function startTest() {
      if (!learn) return;
      for (const g of gems.slice()) dropGem(g); picked = null;
      if (learn.link) learn.link.clear();
      Object.assign(learn, { mode: "test", order: shuffle(learn.list.slice()), next: 0, right: 0, done: 0, bad: new Set(), item: null });
      fillTest(); drawTestPanel();
    }
    function fillTest() {
      while (learn.next < learn.order.length && gems.length / 2 < LM.test_pairs) {
        const w = learn.order[learn.next++].w;
        for (const side of ["th", "en"]) { const g = makeGem(w, side, { noHint: true }); g.test = true; placeGem(g); gems.push(g); }
      }
    }
    function drawTestPanel() {
      learnPanel(`<b>✍ Test</b> <span>${learn.done} / ${learn.order.length}</span><i class="ftc-learn-bar"><i style="width:${Math.round(learn.done / learn.order.length * 100)}%"></i></i>
        <small>Match each Thai word to its English. ${Math.round(LM.pass * 100)}% right first time wins a bonus item for the next run.</small>`,
        [["✕ Stop", () => stopLearn()]]);
    }
    function testPair(a, g) {
      if (a.word.id === g.word.id && a.side !== g.side) {
        if (!learn.bad.has(a.word.id)) { learn.right++; logWord(a.word, "right"); ladderRight(a.word, false); }
        SFX.play("match");
        learn.done++;
        for (const x of [a, g]) for (let i = 0; i < 14; i++) burst(x.x, x.y, x.side === "th" ? 0xc58aff : 0x6cc8ff, 260);
        floatText(`${a.word.th} = ${short(a.word.en)}`);
        if (opts.onWord) try { opts.onWord({ result: "match", id: a.word.id }); } catch (e) {}
        dropGem(a); dropGem(g);
        fillTest(); drawTestPanel();
        if (learn.done >= learn.order.length) setTimeout(finishTest, 600);
      } else {
        // the wrong try counts against the word it started from
        a.shake = g.shake = 0.4; SFX.play("mismatch");
        if (!learn.bad.has(a.word.id)) { learn.bad.add(a.word.id); logWord(a.word, "wrong"); ladderWrong(a.word); }
        if (opts.onWord) try { opts.onWord({ result: "miss", id: a.word.id, other: g.word.id }); } catch (e) {}
      }
    }
    function endLearnGems() { for (const g of gems.slice()) dropGem(g); picked = null; if (learn && learn.link) learn.link.destroy(); learnEl.classList.remove("show"); learnEl.innerHTML = ""; bandAt = 0; }
    function stopLearn() {
      if (!learn) return;
      const r = { words: learn.list.length, stopped: true, stage: learn.mode, seconds: Math.round((performance.now() - learn.started) / 1000), attempt: learn.attempt };
      endLearnGems(); learn = null;
      sim.endPractice(r); sendTel(); showOver();
    }
    function finishTest() {
      if (!learn || learn.mode !== "test") return;
      const total = learn.order.length, score = total ? learn.right / total : 0, passed = score >= LM.pass - 1e-9;
      let item = null, full = false;
      if (passed) {
        const sv = ftcSave.get(), b = (sv.bonus || []).filter(x => x && x.id);
        if (b.length < LM.max_bonus) { item = sim.bonusItem(); if (item) { b.push({ id: item.id, name: item.name, at: Date.now() }); sv.bonus = b; ftcSave.set(sv); } }
        else full = true;
      }
      const res = { words: total, right: learn.right, score: Math.round(score * 100), passed, item: item ? item.id : null,
                    seconds: Math.round((performance.now() - learn.started) / 1000), attempt: learn.attempt };
      const missed = learn.order.filter(r => learn.bad.has(r.w.id)).map(r => r.w);
      endLearnGems(); learn = null;
      sim.endPractice(res); sendTel();
      overlay.innerHTML = "";
      overlay.append(h("h2", "", passed ? "🎉 Test passed!" : "✍ Test done"),
        h("p", "ftc-learn-score", `<b>${res.right} / ${total}</b> right first time · <b>${res.score}%</b>`));
      if (item) overlay.append(h("p", "ftc-learn-prize", `🎁 Flash starts the next run with <b>${icon("items", item.id, "🎁")} ${esc(item.name)}</b>`));
      else if (full) overlay.append(h("p", "", `🎁 You already have ${LM.max_bonus} bonus items waiting, so this one is just for the glory.`));
      else overlay.append(h("p", "", `${Math.round(LM.pass * 100)}% wins a bonus item for the next run. So close, try again?`));
      if (missed.length) overlay.append(h("p", "ftc-small", "Still tricky: " + missed.map(w => `<span lang="th">${esc(w.th)}</span> = ${esc(short(w.en))}`).join(" · ")));
      const row = h("div", "ftc-row");
      if (!passed) { const b = h("button", "ftc-btn", "📚 Learn again"); b.onclick = () => startLearn(); row.append(b); }
      const again = h("button", "ftc-btn big", "Play again"); again.onclick = showStart; row.append(again);
      overlay.append(row); overlay.classList.add("show");
    }
    function updateLearn(dt) {
      if (st.phase !== "fight" || st.paused) { for (const g of gems) g.c.setVisible(false); return; }
      spreadGems(dt);
      for (const g of gems.slice()) moveGem(g, dt);
      if (learn.mode === "learn" && learn.item) {
        const it = learn.item;
        it.t += dt;
        if (!it.said && it.t >= it.g2.delay) { it.said = true; sayWord(it.w); }
        // the gold link between the pair
        learn.link.clear();
        const a = Math.min(1, Math.max(0, it.t - it.g2.delay) / 0.4);
        if (a > 0) {
          const top = it.g1.y < it.g2.y ? it.g1 : it.g2, bot = top === it.g1 ? it.g2 : it.g1;
          learn.link.lineStyle(4, 0xffd23a, 0.85 * a).lineBetween(top.x, top.y + top.h / 2, bot.x, bot.y - bot.h / 2);
          learn.link.fillStyle(0xffd23a, a).fillCircle((top.x + bot.x) / 2, (top.y + top.h / 2 + bot.y - bot.h / 2) / 2, 13);
        }
        if (!it.done && it.t >= it.g2.delay + LM.show_seconds) { it.done = true; ladderRight(it.w, true); nextLearn(); }
      }
    }

    // --------------------------------------------- questions in the column
    // "Save Flash!": when he's in danger the game asks the host (the Thai
    // site) for a question about words the learner has seen, and shows it
    // here, in slow motion. Right = a big heal (and maybe another question);
    // wrong just shows the answer. opts.askQuestion(kind) -> Promise<question>
    //   question: { id, prompt: "th"|"en", th, rom, en, audio, options: [{ id, label, sub, audio }], right, can_quiz }
    const qEl = h("div", "ftc-q"); arena.append(qEl);
    let qOpen = null, rescueChain = 0, rescueAt = -1e9;
    function setSlow(on) { slowTo = on ? Math.max(0.1, Math.min(1, +WD.slow_motion || 0.35)) : 1; root.classList.toggle("ftc-slowmo", !!on); }
    function closeQuestion() { if (!qOpen) return; clearInterval(qOpen._tick); qOpen = null; qEl.classList.remove("show"); qEl.innerHTML = ""; setSlow(false); }
    async function maybeRescue() {
      if (!opts.askQuestion || qOpen || st.phase !== "fight" || st.god) return;
      if (performance.now() - rescueAt < WD.rescue_cooldown * 1000) return;
      rescueAt = performance.now();
      rescueChain = 0;
      ask();
    }
    // with the word card, "Save Flash!" asks about a word the learner has met
    // in the game (the course out of sight may not know many words yet)
    function cardRescueQ() {
      if (!cardOn()) return null;
      const met = LE.items().filter(it => it.dir === "th" && it.seen && LE.word(it.id)).map(it => LE.word(it.id));
      if (met.length < 2) return null;
      const w = met[Math.floor(Math.random() * met.length)], seenEn = new Set([short(w.en)]);
      const others = shuffle(met.filter(x => x.id !== w.id)).filter(x => { const e = short(x.en); if (seenEn.has(e)) return false; seenEn.add(e); return true; }).slice(0, 3);
      if (!others.length) return null;
      return { id: w.id, prompt: "th", th: w.th, rom: romMode === "never" ? "" : w.rom, en: short(w.en), audio: w.audio || "", right: w.id, time: WD.rescue_time,
               options: shuffle([w, ...others]).map(x => ({ id: x.id, label: short(x.en) })) };
    }
    async function ask() {
      let q = cardRescueQ();
      if (!q) try { q = await opts.askQuestion("rescue"); } catch (e) { q = null; }
      if (!q || !q.options || q.options.length < 2 || st.phase !== "fight") return;
      showQuestion(q);
    }
    function showQuestion(q) {
      qOpen = q; setSlow(true); SFX.play("question");
      const head = rescueChain ? `❤️ Again! Keep Flash going (${rescueChain + 1}/${WD.rescue_chain})` : "❤️ Save Flash! He needs the power of the quiz";
      const prompt = q.prompt === "th"
        ? `<div class="ftc-q-th" lang="th">${esc(q.th)}</div>${q.rom ? `<div class="ftc-q-rom">${esc(q.rom)}</div>` : ""}<div class="ftc-q-ask">means…?</div>`
        : `<div class="ftc-q-en">${esc(q.en)}</div><div class="ftc-q-ask">in Thai is…?</div>`;
      const secs = Math.max(3, Math.round(q.time || WD.rescue_time || 20));
      qEl.innerHTML = `<div class="ftc-q-card"><button class="ftc-q-x" title="Close (Esc)">✕</button><div class="ftc-q-head">${head}</div>
        <div class="ftc-q-t"><i></i><em>${secs}s</em></div>${prompt}
        <div class="ftc-q-opts"></div><div class="ftc-q-foot"></div></div>`;
      const box = qEl.querySelector(".ftc-q-opts");
      q.options.forEach((o, i) => {
        const b = h("button", "ftc-q-opt", `<i>${i + 1}</i>` + (o.sub ? `<span lang="th">${esc(o.label)}</span><small>${esc(o.sub)}</small>` : esc(o.label)));
        b.onclick = () => answer(q, o, b);
        box.append(b);
      });
      if (q.prompt === "th" && q.audio) { say(q.audio); const sp = h("button", "ftc-q-say", "🔊"); sp.onclick = () => say(q.audio); qEl.querySelector(".ftc-q-th").append(sp); }
      const foot = qEl.querySelector(".ftc-q-foot");
      if (opts.goQuiz && q.can_quiz) { const gq = h("button", "ftc-btn", "❓ Go to quiz mode"); gq.onclick = () => { closeQuestion(); opts.goQuiz(); }; foot.append(gq); }
      qEl.querySelector(".ftc-q-x").onclick = () => { if (opts.onAnswer) try { opts.onAnswer(q, null); } catch (e) {} sim.noteStudy("rescue_closed"); closeQuestion(); };
      qEl.classList.add("show");
      // the countdown runs in real time, not game time
      const bar = qEl.querySelector(".ftc-q-t i"), sec = qEl.querySelector(".ftc-q-t em"), t0 = performance.now();
      bar.style.transition = "none"; bar.style.width = "100%"; void bar.offsetWidth;
      bar.style.transition = `width ${secs}s linear`; bar.style.width = "0%";
      q._tick = setInterval(() => {
        if (qOpen !== q) { clearInterval(q._tick); return; }
        const left = Math.max(0, Math.ceil(secs - (performance.now() - t0) / 1000));
        sec.textContent = left + "s"; qEl.classList.toggle("hurry", left <= 3);
        if (left <= 0) { clearInterval(q._tick); timeUp(q); }
      }, 250);
    }
    const qWord = q => ({ id: q.right || q.id, th: q.th, rom: q.rom, en: q.en, audio: q.audio });
    function timeUp(q) {
      if (qOpen !== q) return;
      qEl.querySelectorAll(".ftc-q-opt").forEach((b, i) => { b.disabled = true; if (q.options[i].id === q.right) b.classList.add("ok"); });
      qOpen = Object.assign({}, q, { done: true });       // keys and clicks are over
      sim.noteStudy("rescue_timeout");
      logWord(qWord(q), "missed");
      if (opts.onAnswer) try { opts.onAnswer(q, false); } catch (e) {}
      setTimeout(closeQuestion, 1800);
    }
    window.addEventListener("keydown", e => {
      const tg = e.target; if (tg && /^(INPUT|TEXTAREA|SELECT)$/.test(tg.tagName) && tg.type !== "range" && tg.type !== "checkbox") return;
      if (optsOpen && e.key === "Escape") { e.preventDefault(); closeOptions(); return; }
      // 🐟 H eats a fish
      if ((e.key === "h" || e.key === "H") && !optsOpen && !e.ctrlKey && !e.metaKey && !e.altKey && (st.phase === "fight" || st.phase === "break")) { e.preventDefault(); eatFish(); return; }
      if (!qOpen && cardKey(e)) { e.preventDefault(); return; }
      if (!qOpen && e.key === "Escape" && deselect()) { e.preventDefault(); return; }
      if (!qOpen || qOpen.done) return;
      if (e.key === "Escape") { const x = qEl.querySelector(".ftc-q-x"); if (x) { e.preventDefault(); x.click(); } }
      else if (/^[1-9]$/.test(e.key)) { const b = qEl.querySelectorAll(".ftc-q-opt")[+e.key - 1]; if (b && !b.disabled) { e.preventDefault(); b.click(); } }
    });
    function answer(q, o, btn) {
      if (qOpen !== q) return;
      clearInterval(q._tick);
      const tb = qEl.querySelector(".ftc-q-t i"); if (tb) { tb.style.width = getComputedStyle(tb).width; tb.style.transition = "none"; }
      const right = o.id === q.right;
      qEl.querySelectorAll(".ftc-q-opt").forEach((b, i) => { b.disabled = true; if (q.options[i].id === q.right) b.classList.add("ok"); });
      if (!right) btn.classList.add("no");
      SFX.play(right ? "right" : "wrong");
      if (o.audio) say(o.audio);
      if (opts.onAnswer) try { opts.onAnswer(q, right); } catch (e) {}
      logWord(qWord(q), right ? "right" : "wrong");
      if (right) sim.applyReward({ v: 1, kind: "reward", source: "rescue", strength: 1, word: q.th });
      else sim.noteStudy("rescue_wrong");
      setTimeout(() => {
        if (qOpen !== q) return;
        closeQuestion();
        const f = st.flash;
        rescueChain++;
        if (right && f && st.phase === "fight" && f.hp / f.maxHp() < 0.45 && rescueChain < WD.rescue_chain) ask();
      }, right ? 900 : 1800);
    }

    // the column was resized (the divider in game mode, or the window)
    let resizeT = 0;
    const ro = window.ResizeObserver ? new ResizeObserver(() => {
      clearTimeout(resizeT);
      resizeT = setTimeout(() => {
        const w = fitW();
        if (Math.abs(w - st.W) < 6) return;
        sim.setWidth(w);
        try { game.scale.setGameSize(st.W, FlashSim.H); if (scene) scene.cameras.resize(st.W, FlashSim.H); } catch (e) {}
      }, 120);
    }) : null;
    if (ro) { ro.observe(el); ro.observe(arena); }

    // -------------------------------------------------------------- HUD
    // Dan: "put the game fully on the left side of the screen ... 60% game, 40%
    // words+stats+info" and "a basic version for phones, just less info".
    //   panel  a wide screen: the arena on the left, at most 60% and never
    //          wider than its 1200x1000 shape (so no black bars), the study
    //          side gets the rest
    //   stack  a phone or a narrow column: the arena on top, the word card
    //          under it with one line of stats
    let layoutKey = "";
    function layoutSide() {
      const W = root.clientWidth, H = root.clientHeight;
      let mode = "", key;
      // a phone held sideways counts as wide too: side by side, half each
      const sideways = W < 900 && W >= 560 && W > H * 1.3;
      if (cardOn() && (W >= 900 || sideways)) {
        const aw = Math.round(Math.min(W * (sideways ? 0.5 : 0.6), H * FlashSim.WMAX / FlashSim.H));
        mode = "panel"; key = mode + (W - aw) + (sideways ? "s" : "");
        if (key !== layoutKey) { root.style.setProperty("--side", (W - aw) + "px"); root.classList.toggle("sideways", sideways); }
      } else if (cardOn()) {
        // a phone: the word card gets about half (more on a short screen,
        // where a pick of 4 with long meanings needs ~290px), the arena keeps
        // at least 190px
        const sh = Math.round(Math.max(260, Math.min(470, H * (H < 640 ? 0.56 : 0.5), H - 190)));
        mode = "stack"; key = mode + sh + (H < 640 ? "s" : "");
        if (key !== layoutKey) { root.style.setProperty("--stack", sh + "px"); root.classList.toggle("short", H < 640); }
      } else key = "none";
      if (key === layoutKey) return;
      layoutKey = key; bandAt = 0;
      root.classList.toggle("panel", mode === "panel"); root.classList.toggle("stack", mode === "stack");
      sideAt = 0; drawSide(true);
    }
    function updateHud() {
      noteState();
      const f = st.flash;
      // the word card: docked on the right when there's room, else above the weapon bar
      layoutSide();
      // on a phone the start, game-over and options screens get the whole height
      // ...and so do the level-up picks and the shop between rounds, unless
      // Auto-pick is on (then the card keeps going and those are skipped)
      root.classList.toggle("nocard", (stackOn() || (cardOn() && root.classList.contains("sideways") && root.classList.contains("panel"))) && (st.phase === "start" || st.phase === "over" || optsOpen || (st.phase === "break" && !prefs.auto)));
      stageEl.textContent = st.phase === "start" ? "" : st.practice ? "📚 Learning mode"
        : `${cardOn() ? "" : mode === "learn" ? "📚 " : "✍ "}Round ${st.round} · Stage ${st.stage}`;
      const wv = st.wave;
      timerEl.textContent = st.phase !== "fight" || st.practice ? "" : wv ? `💀 ${(wv.total - wv.killed).toLocaleString()} left` : fmtT(Math.max(0, sim.S.roundLen - st.roundT));
      waveBar.style.display = wv ? "" : "none";
      if (wv) { waveBar.querySelector("i").style.width = `${wv.killed / wv.total * 100}%`;
                const left = wv.total - wv.spawned;
                waveBar.querySelector("span").textContent = `${wv.row.name}${wv.parts > 1 ? ` · wave ${wv.part}/${wv.parts}` : ""} · ${wv.killed.toLocaleString()} / ${wv.total.toLocaleString()}${left > 0 ? ` · ☠ ${fmtN(left)} to come` : ""}`; }
      drawEdges(wv);
      const hpFrac = f ? Math.max(0, f.hp / f.maxHp()) : 1;
      const alarm = A("danger_alarm") && st.phase === "fight" && !st.god;
      vignette.style.opacity = alarm && hpFrac < 0.5 ? String(Math.min(1, (0.5 - hpFrac) * 2.4)) : "0";
      vignette.classList.toggle("pulse", alarm && hpFrac < 0.3);
      dangerEl.classList.toggle("show", alarm && st.danger);
      // with fish in his arms, say how to eat one
      const dTxt = st.fish > 0 && !st.autoEat ? "❤️ Flash is in trouble! Answer a quiz, or tap 🐟 (H) to eat a fish" : "❤️ Flash is in trouble! Answer a quiz to heal him";
      if (dangerEl.textContent !== dTxt) dangerEl.textContent = dTxt;
      updateFish();
      if (st.combo >= 25 && st.phase === "fight" && A("combo_meter")) {
        use("combo_meter");
        comboEl.innerHTML = `<b>×${st.combo.toLocaleString()}</b><small>combo</small>`;
        comboEl.classList.add("show");
        comboEl.style.fontSize = `${Math.min(34, 16 + Math.log10(st.combo) * 6)}px`;
      } else comboEl.classList.remove("show");
      goldEl.textContent = st.phase === "start" ? "" : `💰 ${st.gold}`;
      pauseBtn.style.visibility = st.phase === "fight" ? "visible" : "hidden";
      eyeBtn.style.display = !cardOn() && mode === "learn" && !st.practice && (st.phase === "fight" || st.phase === "break") ? "" : "none";
      eyeBtn.classList.toggle("on", showAll);
      // Learn mode: where the lesson's words are on the ladder
      const levelOn = cardOn() && !panelOn() && !stackOn() && !st.practice && (st.phase === "fight" || st.phase === "break");
      const ladderOn = !cardOn() && mode === "learn" && !st.practice && st.phase === "fight";
      ladderEl.style.display = ladderOn || levelOn ? "" : "none";
      if (levelOn) {
        const p = LE.levelProgress();
        const html = `<span class="lv" title="This level: a lesson of the course. ⚙ Options to change it">📘 ${esc(lesson && lesson.title ? short(lesson.title, 34) : "Words")}</span>`
          + `<span title="answered right with 4 choices">👀 ${p.recognises}/${p.total}</span><span title="remembered with no choices">🧠 ${p.recalls}</span>`
          + (p.learned ? `<span title="recalled on two different days">⭐ ${p.learned}</span>` : "");
        if (ladderEl._h !== html) { ladderEl._h = html; ladderEl.innerHTML = html; }
      } else ladderEl._h = "";
      if (!cardOn()) checkMastered();
      if (ladderOn) {
        const n = { learn: 0, test: 0, learned: 0 };
        for (const w of learnPool()) n[rung(w).stage] = (n[rung(w).stage] || 0) + 1;
        ladderEl.innerHTML = `<span title="the answer shows until a word has been matched ${MS.learn_shows} times">📚 ${n.learn} learning</span>`
          + `<span title="no answer: right = stays, wrong = back to learning">✍ ${n.test} testing</span><span title="${MS.learned_after} right in a row without help">⭐ ${n.learned} learned</span>`;
      }
      pauseBtn.textContent = st.paused ? "▶" : "⏸";
      if (f) {
        const mx = f.maxHp();
        hpBar.querySelector("i").style.width = `${Math.max(0, f.hp / mx * 100)}%`;
        hpBar.querySelector("span").textContent = `${Math.max(0, Math.ceil(f.hp))} / ${Math.round(mx)}`;
      }
      xpBar.querySelector("i").style.width = `${st.xp / st.xpNext * 100}%`;
      xpBar.querySelector("span").textContent = st.pending ? `Lv ${st.level} · ${st.pending} pick${st.pending > 1 ? "s" : ""} waiting` : `Lv ${st.level}`;
      bars.style.visibility = st.phase === "start" ? "hidden" : "visible";
      // study buffs
      const groups = {};
      for (const b of st.buffs) { const g = groups[b.source] || (groups[b.source] = { n: 0, left: 0 }); g.n++; g.left = Math.max(g.left, b.until - st.fightT); }
      const label = { quiz: `${icon("reward_sources", "quiz", "✍")} Quiz`, lesson: `${icon("reward_sources", "lesson", "📖")} Lesson`,
                      audio: `${icon("reward_sources", "audio", "🔊")} Audio`, flashcard: `${icon("reward_sources", "flashcard", "🃏")} Cards` };
      buffsEl.innerHTML = Object.entries(groups).map(([k, g]) =>
        `<span class="ftc-buff ${k}">${label[k] || k}${g.n > 1 ? " ×" + g.n : ""} · ${Math.ceil(g.left)}s</span>`).join("");
      warnEl.style.display = st.warning ? "block" : "none";
      if (st.warning) warnEl.textContent = st.warning.text;
      // weapon slots
      const slots = sim.S.slots + (st.tail ? 1 : 0), parts = [];
      for (let i = 0; i < slots; i++) {
        const w = st.weapons[i];
        parts.push(w ? `<span class="ftc-slot${i >= sim.S.slots ? " tail" : ""}" title="${esc(w.def.name)}"><span class="ftc-ico">${weaponIcon(w)}</span><span class="nm"> ${esc(w.def.name)}</span> <b>${w.level}</b></span>`
                     : `<span class="ftc-slot empty${i >= sim.S.slots ? " tail" : ""}">${i >= sim.S.slots ? "tail" : "empty"}</span>`);
      }
      if (!st.tail) parts.push(`<span class="ftc-slot empty tail">🔒 tail</span>`);
      // spells: unlimited, each with a little cooldown bar
      for (const sp of st.spells) {
        const cd = sim.spp(sp).cooldown, k = Math.max(0, Math.min(1, 1 - sp.cd / cd));
        parts.push(`<span class="ftc-slot spell" title="${esc(sp.def.name)} · level ${sp.level}"><span class="ftc-ico">${icon("spells", sp.id, "🔮")}</span><b>${sp.level}</b><i style="width:${Math.round(k * 100)}%"></i></span>`);
      }
      // tags with a tier on: a small chip each (the break screen has the whole build)
      if (sim.build) for (const b of sim.build()) if (b.tier > 0) {
        const on = b.tiers[b.tier - 1];
        parts.push(`<span class="ftc-slot tagc" style="--c:${b.colour || "#b59aff"}" title="${esc(b.name)} ${b.n}: ${esc(on.name)} · ${esc(on.desc)}">${b.icon}<b>${"I".repeat(b.tier)}</b></span>`);
      }
      bottom.innerHTML = st.phase === "start" ? "" : parts.join("");
      // the boss's health: the big bars across the top (the old thin one stays hidden)
      bossBar.style.display = "none";
      drawBigBars();
      // kills and damage per second
      const live = st.phase !== "start";
      killsEl.textContent = live ? `💀 ${fmtN(st.kills)}` : "";
      if (live && st.phase === "fight" && !st.paused) {
        dpsLog.push([st.fightT, st.damageDone]);
        while (dpsLog.length > 2 && st.fightT - dpsLog[0][0] > 5) dpsLog.shift();
      }
      const dt = dpsLog.length > 1 ? dpsLog[dpsLog.length - 1][0] - dpsLog[0][0] : 0;
      const dps = dt > 0.5 ? (dpsLog[dpsLog.length - 1][1] - dpsLog[0][1]) / dt : 0;
      dpsEl.textContent = live && dps > 0 ? `⚔ ${fmtN(dps)}/s` : "";
      if (dps > dpsBest) dpsBest = dps;
      // milestones: "1,000 skellies!"
      while (live && st.kills >= KILL_MARKS[killMark]) { const n = KILL_MARKS[killMark++]; banner(`💀 ${n.toLocaleString()} skellies!`, PUN.kills || "Bone-anza!"); SFX.play("level"); }
    }
    const fmtN = n => n >= 1e6 ? (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M" : n >= 1e4 ? Math.round(n / 1e3) + "k" : n >= 1000 ? (n / 1e3).toFixed(1).replace(/\.0$/, "") + "k" : String(Math.round(n));
    const KILL_MARKS = [100, 500, 1000, 2500, 5000, 10000, 25000, 50000, 100000, 250000, 500000, 1e6, Infinity];
    let dpsLog = [], dpsBest = 0, killMark = 0;
    function resetRunHud() { dpsLog = []; dpsBest = 0; killMark = 0; while (KILL_MARKS[killMark] <= st.kills) killMark++; }
    const SIDE = ["t", "r", "b", "l"], SIDE_NAME = ["the top", "the right", "the bottom", "the left"];
    function drawEdges(wv) {
      const on = wv && st.phase === "fight" && !wv.ambush && wv.spawned < wv.total;
      edges.classList.toggle("show", !!on);
      if (!on) return;
      const soon = wv.pause > 0 || wv.sideEvery - wv.sideT < 1.6;          // the next front is about to start
      SIDE.forEach((k, i) => {
        const el = edges.children[i];
        const now = i === wv.side && !(wv.pause > 0), next = !(wv.pause > 0) && soon && i === wv.nextSide && wv.nextSide !== wv.side;
        el.classList.toggle("now", now); el.classList.toggle("next", next || (wv.pause > 0 && i === wv.side));
        const label = wv.pause > 0 && i === wv.side ? `⚠ Wave ${wv.part + 1} in ${Math.ceil(wv.pause)}…` : "";      // 11 Nov, Dan: no "More from the right" text, the red glow says it
        const sp = el.firstChild; if (sp.textContent !== label) sp.textContent = label;
      });
    }
    function drawBigBars() {
      const list = [];
      if (st.boss && st.boss.alive) list.push(st.boss);
      if (st.phase === "fight") {
        const el = st.enemies.filter(e => e.alive && e.elite && !e.boss && e.max >= 400).sort((a, b) => b.max - a.max).slice(0, list.length ? 1 : 2);
        list.push(...el);
      }
      const key = list.map(e => e.uid || e.id).join(",");
      if (bigBars.dataset.k !== key) {
        bigBars.dataset.k = key;
        bigBars.innerHTML = list.map(e => `<div class="ftc-bb${e.boss ? " boss" : ""}"><div class="ftc-bb-name">${e.boss ? "👑 " + esc(e.boss.name) : "💀 " + esc(e.name || "Elite " + (e.type || "skeleton").replace(/_/g, " "))}<span></span></div><div class="ftc-bb-bar"><b></b><i></i>${e.boss && e.phases > 1 ? Array.from({ length: e.phases - 1 }, (_, k) => `<u style="left:${(k + 1) / e.phases * 100}%"></u>`).join("") : ""}</div></div>`).join("");
      }
      list.forEach((e, i) => {
        const row = bigBars.children[i]; if (!row) return;
        const k = Math.max(0, e.hp / e.max);
        row.querySelector("i").style.width = (k * 100) + "%";
        // the white trail: what was just lost, catching up
        const tr = row.querySelector("b"), was = +(tr.dataset.k || 1);
        const nk = Math.max(k, was - 0.012); tr.dataset.k = nk; tr.style.width = (nk * 100) + "%";
        row.querySelector(".ftc-bb-name span").textContent = `${fmtN(Math.max(0, e.hp))} / ${fmtN(e.max)}${e.boss && e.phases > 1 ? ` · phase ${e.phase}/${e.phases}` : ""}`;
      });
    }

    // a small health bar over a sprite (elites, the boss)
    function drawHp(g, x, y, w, k, colour) {
      k = Math.max(0, Math.min(1, k));
      g.fillStyle(0x000000, 0.65); g.fillRoundedRect(x - w / 2 - 1, y - 1, w + 2, 6, 3);
      g.fillStyle(colour, 1); if (k > 0) g.fillRoundedRect(x - w / 2, y, Math.max(2, w * k), 4, 2);
    }
    // ---------------------------------------------------------- screens
    // ---- state machines, made explicit (10 Nov; the full list is in STATE-MACHINES.md)
    // The game always had these, but as loose flags that had to agree with each other.
    // Now each has one owner:
    //   uiScreen   which screen the overlay shows: none | start | break | over | paused |
    //              options | progress | words | share. Set by the show…() functions only.
    //   pausedBy   WHY the fight is paused: "player" (⏸, the tab was hidden, the site asked)
    //              and / or "menu" (a menu is open). The fight runs only when it's empty,
    //              so closing a menu can't un-pause a game the player paused, and ⏸ can't
    //              start the fight under an open menu. Only setPause() calls sim.pause().
    // ftc.state() reports every machine, ftc.check() lists anything that doesn't add up,
    // and ftc.stateLog() is the last 60 changes: for tests, the bench, and whoever debugs next.
    let uiScreen = "none";
    const pausedBy = new Set();
    function syncPause() {
      // rounds, restarts and the bench change the sim's pause directly: believe the sim
      if (st.phase !== "fight" || !st.paused) pausedBy.clear();
      else if (!pausedBy.size) pausedBy.add("player");
    }
    function setPause(why, on) {
      syncPause();
      if (st.phase !== "fight") return;
      if (on) pausedBy.add(why); else pausedBy.delete(why);
      const want = pausedBy.size > 0;
      if (st.paused !== want) sim.pause(want);
    }
    // closing this menu will carry on the fight (so its button says "Back to the game")
    const menuResumes = () => pausedBy.has("menu") && pausedBy.size === 1;
    function openMenu(name) {
      setPause("menu", true);
      if (nap && !nap.done) { nap.done = true; napEl.classList.remove("show"); napEl.onclick = null; }   // the nap gives way to a menu
      optsOpen = true; uiScreen = name; cardHide();
    }
    function hideOverlay() { overlay.classList.remove("show", "ftc-optsov"); overlay.innerHTML = ""; uiScreen = "none"; }
    function card(o, onClick) {
      const c = h("div", "ftc-card");
      c.style.borderColor = rarityColour(o.rarity);
      c.innerHTML = `${o.icon ? `<span class="ftc-cardico">${o.icon}</span>` : ""}<span class="ftc-tag" style="color:${rarityColour(o.rarity)}">${esc(o.tag || o.rarity || "")}</span>
        <div class="ftc-name">${esc(o.name)}</div><div class="ftc-desc">${esc(o.desc || "")}</div>${o.stats ? `<div class="ftc-stats">${esc(o.stats)}</div>` : ""}${buildLine(o)}`;
      if (o.kind === "evolve") c.classList.add("evolve");
      c.onclick = onClick;
      return c;
    }
    function showStart() {
      uiScreen = "start";
      overlay.innerHTML = "";
      overlay.append(h("h2", "", "🐈 Flash the Cat"));
      const sr = savedRun();
      if (sr) {
        const box = h("div", "ftc-learn-offer ftc-saved", `<b>💾 Your saved run</b><span>Round ${sr.n.round} · level ${sr.n.level} · 💰 ${sr.n.gold}${sr.show && sr.show.weapons ? ` · ${esc(sr.show.weapons.join(", "))}` : ""}</span>
          <small>Saved at the end of round ${sr.n.round}, ${ago(sr.at || Date.now())}${sr.show && sr.show.lesson ? ` · ${esc(sr.show.lesson)}` : ""}. Picking a class below starts a new run instead.</small>`);
        const row = h("div", "ftc-row"), go = h("button", "ftc-btn big primary", `▶ Continue round ${sr.n.round + 1}`);
        go.onclick = () => continueRun(); row.append(go); box.append(row); overlay.append(box);
      }
      if (cardOn()) {
        const p = LE.levelProgress(), sm = LE.summary();
        overlay.append(h("p", "ftc-slogan", `${PUN.slogan} ⚡`));
        overlay.append(h("p", "ftc-lvline", `📘 Level: <b>${esc(lesson && lesson.title ? lesson.title : "these words")}</b>${p.total ? ` · 👀 ${p.recognises}/${p.total} recognised` : ""}${sm.due ? ` · 🔁 ${sm.due} to review` : ""}`));
        const loc0 = sim.locationWanted && sim.locationWanted(), locR = loc0 ? sim.locations().find(l => l.id === loc0) : null;
        if (locR) overlay.append(h("p", "ftc-small ftc-locline", `${esc(locR.icon || "📍")} <b>${esc(locR.name)}</b>${locR.thai ? ` · <span lang="th">${esc(locR.thai)}</span>` : ""}${locR.hazard ? ` · watch out for ${esc(locR.hazard.icon || "")} ${esc(String(locR.hazard.name || "").toLowerCase())}` : ""}`));
        if (sm.due) overlay.append(h("p", "ftc-small", `🔁 ${PUN.revise}`));
        const td = LE.todo();
        if (td.due + td.ready + td.forgot) overlay.append(h("p", "ftc-small ftc-todo-line", `😼 Flash's to-do: ${[td.due ? `${td.due} to review` : "", td.ready ? `${td.ready} ready for a harder test` : "", td.forgot ? `${td.forgot} slipping` : "", td.fresh ? `${td.fresh} new in this level` : ""].filter(Boolean).join(" · ")}`));
        const pick = h("div", "ftc-mode");
        for (const [f, label, sub] of [["new", "📚 New words + review", "Meet this level's words, with the reviews that are due"], ["review", `🔁 ${PUN.review}`, "Review only: no new words, just the ones you've met"]]) {
          const b = h("button", "ftc-mode-b" + (LE.focus() === f ? " on" : ""), `<b>${label}</b><small>${sub}</small>`);
          b.onclick = () => { LE.setFocus(f); saveSet("focus", f); showStart(); };
          pick.append(b);
        }
        overlay.append(pick);
      }
      // what is the learner here for? (the classic gem hunt)
      const pick = h("div", "ftc-mode");
      if (!cardOn()) for (const [m, label, sub] of [["learn", "📚 Learn", "I'm new to these words: show me the answers"], ["test", "✍ Test", "I know them: no help, full power"]]) {
        const b = h("button", "ftc-mode-b" + (mode === m ? " on" : ""), `<b>${label}</b><small>${sub}</small>`);
        b.onclick = () => { setMode(m); showStart(); };
        pick.append(b);
      }
      if (!cardOn()) overlay.append(pick);
      if (!cardOn() && mode === "learn") {
        const sa = h("label", "ftc-small ftc-showall", `<input type="checkbox" ${showAll ? "checked" : ""}> 👁 Show answers on every word (otherwise only on words you're still learning)`);
        sa.querySelector("input").onchange = e => { showAll = e.target.checked; saveSet("show_answers", showAll); };
        overlay.append(sa);
      }
      const best = SAVE.get().best || {};
      const kits = sim.kits ? sim.kits() : [];
      overlay.append(h("p", "", `${kits.length ? "Pick a class" : "Pick a starting weapon"}. Study to keep Flash alive!${best[mode] ? ` <span class="ftc-small">Best (${mode === "learn" ? "Learn" : "Test"}): round ${best[mode]}</span>` : ""}`));
      const waiting = bonusWaiting();
      if (waiting.length) overlay.append(h("p", "ftc-learn-prize", `🎁 Study bonus for this run: <b>${icon("items", waiting[0].id, "🎁")} ${esc(waiting[0].name || waiting[0].id)}</b>`));
      const begin = (wid, kid) => { cRun = { right: 0, wrong: 0, up: {}, best: 0 }; cStreak = 0; saveSet("run", null); sim.startRun(wid, kid); resetRunHud(); };
      // classes (data type: kits): a weapon, usually a spell, a tag and a perk that point at a build
      if (kits.length) {
        const kc = h("div", "ftc-cards ftc-kits"); let grp = null;
        for (const k of kits) {
          if ((k.group || "") !== grp && (grp = k.group || "")) kc.append(h("div", "ftc-kit-h", esc(grp)));
          const has = [...(k.weapons || []).map(id => sim.D.weapons[id] ? `${icon("weapons", id, "🗡️")} ${sim.D.weapons[id].name}` : ""),
                       ...(k.spells || []).map(id => { const sp = (data.spells || []).find(x => x.id === id); return sp ? `${icon("spells", id, "🔮")} ${sp.name}` : ""; }),
                       ...(k.items || []).map(id => { const it = (data.items || []).find(x => x.id === id); return it ? `${icon("items", id, "🎒")} ${it.name}` : ""; })].filter(Boolean);
          const c = card({ kind: "kit", icon: k.icon || "🐈", name: k.name, desc: k.description, rarity: "rare", tag: "Class", stats: has.join(" · "), tags: k.tags }, () => begin(null, k.id));
          c.dataset.kit = k.id; kc.append(c);
        }
        overlay.append(kc);
      }
      const cards = h("div", "ftc-cards");
      for (const w of sim.startingWeapons())
        cards.append(card({ icon: icon("weapons", w.id, "🗡️"), name: w.name, desc: w.description, rarity: w.rarity, tag: w.behaviour.replace(/_/g, " "),
          stats: `${w.damage} dmg · ${w.cooldown}s · range ${w.range}`, kind: "kit", tags: w.tags }, () => begin(w.id)));
      if (kits.length) {
        // one weapon and nothing else: the old way to start, still there for whoever wants it harder
        const det = h("details", "ftc-classic"); det.open = !!prefs.classicOpen;
        det.append(h("summary", "", "…or no class: just one weapon (harder)"), cards);
        det.ontoggle = () => { prefs.classicOpen = det.open; savePrefs(); };
        overlay.append(det);
      } else overlay.append(cards);
      const ob = h("button", "ftc-btn", "⚙ Options"), orow = h("div", "ftc-row"); ob.onclick = () => showOptions(); orow.append(ob); overlay.append(orow);
      if (cardOn()) { const pb = h("button", "ftc-btn", `📊 ${PUN.check}`); pb.onclick = () => showProgress(); orow.append(pb); }
      if (LE) { const jb = h("button", "ftc-btn", "📣 Share my journey"); jb.title = "Your stats as a post ready to paste into x.com"; jb.onclick = () => shareCard("journey"); orow.append(jb); }
      overlay.classList.add("show");
    }
    // Dan: "do we have a way to save the game state? ... in learning mode, the
    // game might last longer". The run is saved between rounds (the arena is
    // empty then): at the end of each round and after every pick or purchase.
    // Close the tab mid-round and it comes back at the last break.
    function saveRun() {
      const r = sim.exportRun && sim.exportRun();
      if (!r) return;
      r.study = { right: cRun.right, wrong: cRun.wrong, best: cRun.best, up: cRun.up };
      r.show = { weapons: st.weapons.map(w => w.def.name), spells: st.spells.map(x => x.def.name), lesson: lesson && lesson.title || "" };
      saveSet("run", r);
    }
    function savedRun() { const r = SAVE.get().run; return r && r.v === 1 && r.start && r.n ? r : null; }
    function continueRun() {
      const r = savedRun(); if (!r) return;
      cRun = Object.assign({ right: 0, wrong: 0, up: {}, best: 0 }, r.study || {}); cStreak = 0;
      if (!sim.restoreRun(r)) { saveSet("run", null); floatText("That saved run couldn't be loaded", true); showStart(); return; }
      resetRunHud();
      SFX.play("round"); floatText(`💾 Welcome back! Round ${st.round} · level ${st.level}`, false, true);
    }
    const ago = t => { const m = Math.round((Date.now() - t) / 60000); return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} day${m < 2880 ? "" : "s"} ago`; };
    // this round's damage, by who did it (Dan: "dps, high dmg..")
    const SRC_NAME = { arc: "⚡ Arcs", flash_dash: "⚡ Flash dash", explosion: "💥 Explosions", thorns: "🌵 Thorns", chain: "⛓ Chains", other: "Other" };
    function srcName(id) {
      const ow = st.owned && st.owned[id]; if (ow) return `${weaponIcon(ow)} ${ow.def.name}`;
      const w = sim.D.weapons[id]; if (w) return `${icon("weapons", id, "🗡️")} ${w.name}`;
      const sp = st.spells.find(x => x.id === id); if (sp) return `${icon("spells", id, "🔮")} ${sp.def.name}`;
      return SRC_NAME[id] || String(id).replace(/_/g, " ").replace(/^./, c => c.toUpperCase());
    }
    function dmgBreakdown() {
      const rows = Object.entries(st.rDmgBy || {}).filter(r => r[1] > 0).sort((a, b) => b[1] - a[1]);
      const box = h("div", "ftc-dmg");
      if (!rows.length) return box;
      const total = rows.reduce((a, r) => a + r[1], 0), top = rows[0][1];
      box.innerHTML = `<div class="ftc-dmg-h">⚔ This round's damage <b>${fmtN(total)}</b></div>` + rows.slice(0, 6).map(([id, v]) =>
        `<div class="ftc-dmg-r"><span>${srcName(id)}</span><i style="width:${Math.max(3, v / top * 100)}%"></i><b>${fmtN(v)} · ${Math.round(v / total * 100)}%</b></div>`).join("");
      return box;
    }
    // 🧬 the build so far: each tag, how many, which tiers are on and what the next one gives;
    // and for each weapon that can evolve, what it still needs
    function buildPanel() {
      const box = h("div", "ftc-build");
      if (!sim.build) return box;
      const tags = sim.build().sort((a, b) => b.n - a.n), evos = sim.evolutions();
      if (!tags.length && !evos.length) return box;
      const kit = st.kit && sim.kits().find(k => k.id === st.kit);
      let html = `<div class="ftc-build-h">🧬 Your build${kit ? ` · ${kit.icon || ""} ${esc(kit.name)}` : ""}</div>`;
      html += tags.map(b => {
        const pips = b.tiers.map(t => `<i class="${t.on ? "on" : ""}" title="${t.count}: ${esc(t.name)} · ${esc(t.desc)}"></i>`).join("");
        const on = b.tiers.filter(t => t.on).pop(), nx = b.tiers.find(t => !t.on);
        return `<div class="ftc-build-r" style="--c:${b.colour || "#b59aff"}" data-tag="${b.id}"><span class="t">${b.icon} ${esc(b.name)}</span><span class="n">${b.n}${b.next ? "/" + b.next : ""}</span><span class="p">${pips}</span>
          <span class="d">${on ? `<b>${esc(on.name)}</b>` : ""}${on && nx ? " · " : ""}${nx ? `<small>at ${nx.count}: ${esc(nx.desc)}</small>` : on ? ` <small>${esc(on.desc)}</small>` : ""}</span></div>`;
      }).join("");
      html += evos.map(e => `<div class="ftc-build-e${e.ready ? " ready" : ""}" data-evo="${e.id}">${e.icon} <b>${esc(e.name)}</b> = ${esc(e.weapon)} <span class="${e.level >= e.min ? "ok" : ""}">Lv ${e.level}/${e.min}</span> + ${e.needs.map(n => `<span class="${n.have ? "ok" : ""}">${icon("items", n.id, "") || icon("spells", n.id, "")} ${esc(n.name)}${n.have ? " ✓" : ""}</span>`).join(" + ")}${e.ready ? " · <b>ready ✨</b>" : ""}</div>`).join("");
      box.innerHTML = html;
      return box;
    }
    function showBreak() {
      if (st.phase === "break") saveRun();
      uiScreen = "break";
      overlay.innerHTML = "";
      bannerEl.classList.remove("show");
      if (lastWave) overlay.append(h("h2", "ftc-wavewin", `💀 ${esc(lastWave.name)} cleared!`),
        h("p", "", `${lastWave.total.toLocaleString()} skeletons in ${Math.round(lastWave.time)}s · best combo ×${st.comboMax.toLocaleString()}`));
      else overlay.append(h("h2", "", `Round ${st.round} cleared!`));
      overlay.append(h("p", "", `${st.kills.toLocaleString()} skeletons · Level ${st.level} · 💰 ${st.gold}${dpsBest ? ` · best ⚔ ${fmtN(dpsBest)}/s` : ""}`));
      overlay.append(dmgBreakdown());
      overlay.append(buildPanel());
      if (st.offer) {
        overlay.append(h("p", "", `<b>Level up!</b> Pick ${st.pending > 1 ? `(${st.pending} picks)` : "one"}:`));
        const cards = h("div", "ftc-cards");
        st.offer.forEach((o, i) => cards.append(card(Object.assign({ icon: offerIcon(o) }, o), () => { sim.choose(i); showBreak(); })));
        overlay.append(cards);
        const row = h("div", "ftc-row");
        const skip = h("button", "ftc-btn", `Skip (+${sim.S.skipGold} gold)`); skip.onclick = () => { sim.skip(); showBreak(); };
        row.append(skip); overlay.append(row);
      } else {
        const next = (data.mega_waves || []).filter(w => st.round + 1 === w.from_round || (w.every_rounds > 0 && st.round + 1 > w.from_round && (st.round + 1 - w.from_round) % w.every_rounds === 0)).sort((a, b) => b.total - a.total)[0];
        if (next) overlay.append(h("p", "ftc-tease", `${icon("mega_waves", next.id, "💀")} Next: <b>${esc(next.name)}</b> · ${next.total.toLocaleString()} skeletons`));
        const go = h("button", "ftc-btn big", `Start round ${st.round + 1}`); go.onclick = () => { if (autoBuyOn()) autoShop(); saveRun(); lastWave = null; sim.nextRound(); };
        overlay.append(go);
      }
      // the shop: spend gold between rounds
      if (st.shop && st.shop.items.length) {
        const shop = h("div", "ftc-shop");
        shop.append(h("div", "ftc-shop-h", `<b>🛒 Shop</b><span>💰 ${st.gold}</span>`));
        const grid = h("div", "ftc-shop-grid");
        st.shop.items.forEach((o, i) => {
          const can = !o.sold && st.gold >= o.price;
          const c = h("button", "ftc-shop-item" + (o.sold ? " sold" : can ? "" : " poor") + (o.row === "vault" ? " vault" : o.kind === "wup" ? " wup" : ""),
            `${o.tag && o.tag !== "Shop" ? `<span class="ftc-shop-tag">${esc(o.tag)}</span>` : ""}<span class="ftc-cardico">${offerIcon(o)}</span><span class="ftc-name">${esc(o.name)}</span><span class="ftc-desc">${esc(o.desc || "")}</span>${buildLine(o)}
             <span class="ftc-price">${o.sold ? "bought ✓" : `💰 ${o.price}`}</span>`);
          c.style.borderColor = rarityColour(o.rarity);
          c.disabled = !can;
          c.onclick = () => { if (sim.buy(i)) { SFX.play("coin"); floatText(`Bought ${o.name}`); showBreak(); } };
          grid.append(c);
        });
        shop.append(grid);
        const rp = sim.rerollPrice();
        const rr = h("button", "ftc-btn", `🎲 Reroll (💰 ${rp})`); rr.disabled = st.gold < rp;
        rr.onclick = () => { if (sim.reroll()) showBreak(); };
        shop.append(h("div", "ftc-row"), rr);
        overlay.append(shop);
      }
      const auto = h("label", "ftc-small", `<input type="checkbox" ${prefs.auto ? "checked" : ""}> Auto-pick, auto-shop & continue (for when you're busy studying)`);
      auto.querySelector("input").onchange = e => { prefs.auto = e.target.checked; savePrefs(); if (prefs.auto) autoBreak(); };
      // Dan (9 Nov): "autobuy doesn't work" - it only ran with Auto-pick on. Now its own switch:
      // whatever gold is left when the next round starts is spent
      const ab = h("label", "ftc-small", `<input type="checkbox" ${autoBuyOn() ? "checked" : ""}> 🛒 Auto-buy: spend spare gold when the round starts`);
      ab.querySelector("input").onchange = e => { prefs.autobuy = e.target.checked; savePrefs(); };
      overlay.append(auto, ab);
      overlay.classList.add("show");
      if (prefs.auto) autoBreak();
    }
    let autoTimer = null;
    // Auto-pick used to skip the shop altogether: Dan's word-card runs (3 Nov)
    // all died to the first boss with up to 1,182 gold unspent, while his
    // gem runs, where he shopped, beat it. So auto mode shops too: a potion if
    // Flash is below 60%, then the best item it can afford (rarest first,
    // then dearest), until the gold runs out.
    const RANK = { common: 1, uncommon: 2, rare: 3, epic: 4, legendary: 5 };
    const autoBuyOn = () => prefs.autobuy !== false;        // on unless switched off
    // what's worth gold first: a potion when hurt, the vault, a weapon upgrade,
    // then the rarest; with lots left over and everything bought, a reroll or two
    function autoShop() {
      if (!st.shop || !st.shop.items) return 0;
      let n = 0, potion = false, rerolls = 0;
      const score = o => o.kind === "potion" ? 100 : o.row === "vault" ? 50 : o.kind === "wup" ? 40 : (RANK[o.rarity] || 1) * 5 + (o.kind === "weapon" || o.kind === "spell" ? 3 : 0);
      for (let guard = 0; guard < 30; guard++) {
        const f = st.flash, low = !!f && f.hp / f.maxHp() < 0.6;
        const c = st.shop.items.map((o, i) => ({ o, i })).filter(x => !x.o.sold && st.gold >= x.o.price && (x.o.kind !== "potion" || (low && !potion)));
        if (!c.length) {
          const rp = sim.rerollPrice();
          if (rerolls < 2 && st.shop.items.every(o => o.sold || o.kind === "potion") && st.gold >= rp * 4) { if (sim.reroll()) { rerolls++; continue; } }
          break;
        }
        c.sort((a, b) => score(b.o) - score(a.o) || b.o.price - a.o.price);
        if (!sim.buy(c[0].i)) break;
        if (c[0].o.kind === "potion") potion = true;
        n++;
      }
      if (n) { SFX.play("coin"); floatText(`🛒 Auto-bought ${n} thing${n > 1 ? "s" : ""}${rerolls ? ` (${rerolls} reroll${rerolls > 1 ? "s" : ""})` : ""}`); }
      return n;
    }
    function autoBreak() {
      clearTimeout(autoTimer);
      autoTimer = setTimeout(() => {
        if (st.phase !== "break" || !prefs.auto) return;
        if (optsOpen) { autoBreak(); return; }
        if (st.offer) { sim.choose(Math.floor(Math.random() * st.offer.length)); showBreak(); }
        else { autoShop(); saveRun(); lastWave = null; sim.nextRound(); }
      }, 1500);
    }
    function showOver() {
      const r = st.runStats || {};
      uiScreen = "over";
      overlay.innerHTML = "";
      // the kitty death's ending: he's curled up for a nap, and here's what you learned together
      const learned = Object.values(runWords).filter(x => (x.right || 0) + (x.helped || 0) > 0).sort((a, b) => (b.right || 0) - (a.right || 0));
      overlay.append(h("h2", "ftc-naph", "Flash curled up for a nap 💤"),
        h("p", "ftc-small ftc-napsub", `He fell in round ${r.round || 1}${st.livesUsed ? ` (after using ${st.livesUsed === 1 ? "one of his nine lives" : st.livesUsed + " of his nine lives"})` : ""}. ${learned.length ? "Look what you learned together:" : "Sweet dreams, little warrior."}`));
      if (learned.length) {
        const box = h("div", "ftc-napwords", learned.slice(0, 12).map((x, i) => `<button class="ftc-napw" data-i="${i}" style="animation-delay:${reducedMotion() ? 0 : i * 70}ms"><b lang="th">${esc(x.w.th)}</b>${x.w.rom ? `<i>${esc(x.w.rom)}</i>` : ""}<small>${esc(short(x.w.en, 28))}</small></button>`).join("")
          + (learned.length > 12 ? `<span class="ftc-small">+${learned.length - 12} more</span>` : ""));
        box.querySelectorAll(".ftc-napw").forEach(b => b.onclick = () => { const x = learned[+b.dataset.i]; if (x) try { sayWord(x.w); } catch (e) {} });
        overlay.append(box);
      }
      overlay.append(
        h("div", "ftc-statgrid", `<span>Round</span><b>${r.round}</b><span>Stage</span><b>${r.stage}</b><span>Level</span><b>${r.level}</b>
          <span>Skeletons</span><b>${r.kills}</b><span>Gold</span><b>${r.gold}</b><span>Time</span><b>${fmtT(r.time || 0)}</b>
          <span>Damage</span><b>${(r.damage || 0).toLocaleString()}</b><span>Best combo</span><b>×${(r.comboMax || 0).toLocaleString()}</b>
          <span>Mega waves</span><b>${r.waves || 0}</b>`),
        h("p", "ftc-small", esc((r.weapons || []).join(" · "))));
      if (cardOn()) {
        const up = Object.entries(cRun.up).slice(0, 10).map(([id, lab]) => { const w = LE.word(id); return w ? `<li><b lang="th">${esc(w.th)}</b> = ${esc(short(w.en))}<em>${LABEL_TXT[lab]}</em></li>` : ""; }).filter(Boolean);
        if (cRun.right + cRun.wrong) overlay.append(h("div", "ftc-learn-offer ftc-run", `<b>🧠 This run</b><span>${cRun.right} right · ${cRun.wrong} to practise · best streak 🔥 ${cRun.best}</span>${up.length ? `<span>Moved up:</span><ul>${up.join("")}</ul>` : ""}`));
        overlay.append(h("p", "ftc-small", `${pick1(PUN.encourage)} 😺`));
      }
      const list = LM.enabled && !cardOn() ? learnList() : [];
      const row = h("div", "ftc-row");
      if (list.length) {
        const bad = list.filter(x => x.wrong || x.missed).length;
        const box = h("div", "ftc-learn-offer",
          `<b>📚 Learning mode</b><span>${bad ? `${bad} word${bad === 1 ? "" : "s"} you missed or got wrong this run` : "Words from this run"}${list.length > bad ? (bad ? `, plus ${list.length - bad} more` : "") : ""}:
           ${list.slice(0, 8).map(x => `<span lang="th">${esc(x.w.th)}</span>`).join(" · ")}</span>
           <small>See each one with its English, then a quick test. ${Math.round(LM.pass * 100)}% or more and Flash starts the next run with a bonus item.</small>`);
        overlay.append(box);
        const lb = h("button", "ftc-btn big primary", "📚 Learn the words"); lb.onclick = () => startLearn(); row.append(lb);
      }
      const waiting = bonusWaiting();
      if (waiting.length) overlay.append(h("p", "ftc-small", `🎁 Waiting for your next run: ${waiting.map(b => esc(b.name || b.id)).join(", ")}`));
      const again = h("button", "ftc-btn big", "Play again"); again.onclick = showStart; row.append(again);
      if (cardOn()) { const pb = h("button", "ftc-btn", "📊 My progress"); pb.onclick = () => showProgress(); row.append(pb); }
      if (LE) { const sb = h("button", "ftc-btn", "📣 Share my journey"); sb.onclick = () => shareCard("run"); row.append(sb); }
      overlay.append(row);
      overlay.classList.add("show");
    }
    function showPaused() {
      uiScreen = "paused";
      overlay.innerHTML = "";
      overlay.append(h("h2", "", "Paused"), h("p", "", "While Flash is paused, studying doesn't power him up. Resume to earn rewards again."),
        h("p", "ftc-small", "💾 Your run is saved at the end of every round, and your words after every answer, so you can close the game and carry on later."));
      const go = h("button", "ftc-btn big", "Resume"); go.onclick = () => togglePause(false);
      overlay.append(go); overlay.classList.add("show");
    }
    function togglePause(on) {
      if (st.phase !== "fight") return;
      syncPause();
      const was = st.paused;
      setPause("player", on === undefined ? !pausedBy.has("player") : !!on);
      if (st.paused !== was) announce(st.paused ? "paused" : "resumed");      // the site hears about the player's pause only, as before
      // with a menu open the menu keeps the screen; the player's pause is remembered under it
      if (!optsOpen) { if (st.paused) showPaused(); else hideOverlay(); }
      updateHud();
    }
    pauseBtn.onclick = () => togglePause();

    // ------------------------------------------------------------- options
    // Dan: "full screen will be the default option, but we should have an
    // option screen where the user can go back to split mode". Everything a
    // learner might want to change, in one place; the fight waits while it's open.
    let optsOpen = false;
    const gearBtn = h("button", "ftc-btn ftc-gear", "⚙"); gearBtn.title = "Options";
    top.insertBefore(gearBtn, pauseBtn);
    gearBtn.onclick = e => { e.stopPropagation(); optsOpen ? closeOptions() : showOptions(); };
    function seg(title, items, cur, onPick, note) {
      const box = h("div", "ftc-opt", `<label class="t">${title}</label>`), row = h("div", "ftc-seg");
      for (const [v, label] of items) {
        const b = h("button", "ftc-seg-b" + (v === cur ? " on" : ""), label);
        b.onclick = () => { onPick(v); showOptions(true); };
        row.append(b);
      }
      box.append(row); if (note) box.append(h("small", "", note));
      return box;
    }
    function showOptions(redraw) {
      openMenu("options");
      const scroll = redraw ? overlay.scrollTop : 0;
      overlay.innerHTML = ""; overlay.classList.add("show", "ftc-optsov");
      overlay.append(h("h2", "", "⚙ Options"));
      const grid = h("div", "ftc-opts");
      // a phone has no room for the course beside the game (game.html keeps it game-only)
      if (opts.setLayout && window.innerWidth >= 700) grid.append(seg("Screen", [["full", "⛶ Game only"], ["split", "◫ Game + course"]], opts.layout ? opts.layout() : "full",
        v => { try { opts.setLayout(v); } catch (e) {} }, "Game + course puts the lessons beside the game, with pop quizzes over them."));
      grid.append(seg("Words", [["card", "🃏 Word card"], ["gems", "💎 Classic gem hunt"]], wordMode, v => setWordMode(v),
        wordMode === "card" ? "One word at a time: can you remember it? Help fades as each word gets stronger." : "Match Thai and English gems drifting in the arena."));
      if (cardOn()) {
        grid.append(seg("Study", [["new", "📚 New words + review"], ["review", `🔁 ${PUN.review}`]], LE.focus(), v => { LE.setFocus(v); saveSet("focus", v); }));
        grid.append(seg("Romanization", [["always", "Always"], ["fade", "Fade as I learn"], ["never", "Never"]], romMode, v => { romMode = v; saveSet("rom", v); },
          "Coloured by tone, like the course. Fade as I learn hides it once a word reaches Pick of 4."));
        grid.append(seg("Say each word", [[1, "Once"], [2, "2 times"], [3, "3 times"]], sayTimes, v => { sayTimes = v; saveSet("say_times", v); },
          "How many times the card says a word by itself. 🔊 says it again, 🐢 slowly."));
        // Dan (4 Nov): the course's quiz bar, here: ⇄ Shuffle ⇋ Reverse ↺ Reset · Mixed / Classic ·
        // ⌨ Type first · 🔊 Auto-play Thai · Wrong answers 2-5 · ⚙ Show
        const Q = qPrefs(), qb = h("div", "ftc-opt ftc-qbar", `<label class="t">Questions</label>`);
        const tog = (on, label, title, fn) => { const b = h("button", "ftc-seg-b" + (on ? " on" : ""), label); b.title = title; b.setAttribute("aria-pressed", on ? "true" : "false"); b.onclick = () => { fn(); showOptions(true); }; return b; };
        const r1 = h("div", "ftc-seg");
        r1.append(tog(Q.shuffle, "⇄ Shuffle", "New words in a random order, not the lesson's", () => setQ("shuffle", !Q.shuffle)),
                  tog(Q.reverse, "⇋ Reverse", "Ask it the other way round (meaning → Thai) from the start", () => setQ("reverse", !Q.reverse)));
        const rs = h("button", "ftc-seg-b ftc-reset", "↺ Reset"); rs.title = "This level's words from the start";
        rs.onclick = () => {
          if (!rs.classList.contains("sure")) { rs.classList.add("sure"); rs.textContent = "↺ Tap again: forget this level's words?"; return; }
          const n = LE.resetLevel(); cq = null; cState = ""; rs.classList.remove("sure"); rs.textContent = n ? "↺ Done: this level starts again" : "↺ Nothing to reset yet"; drawSide(true);
        };
        r1.append(rs); qb.append(r1);
        const r2 = h("div", "ftc-seg");
        r2.append(tog(Q.style === "mix", "Mixed", "Every kind of question: both ways, listening, sentences, tones", () => setQ("style", "mix")),
                  tog(Q.style === "classic", "Classic", "Only: what does it mean?", () => setQ("style", "classic")),
                  tog(Q.type, "⌨ Type first", "Type your answer before you see the choices", () => setQ("type", !Q.type)),
                  tog(Q.auto, "🔊 Auto-play Thai", "Play the Thai word as soon as a question shows it", () => setQ("auto", !Q.auto)));
        qb.append(r2);
        const r3 = h("div", "ftc-seg", `<span class="ftc-seg-l">Wrong answers</span>`);
        for (const n of [2, 3, 4, 5]) r3.append(tog(+Q.wrong === n, String(n), `At most ${n} wrong answers to choose from`, () => setQ("wrong", n)));
        qb.append(r3);
        const r4 = h("div", "ftc-seg", `<span class="ftc-seg-l">⚙ Show</span>`);
        for (const [k, label] of [["pic", "Picture"], ["hook", "Memory hook"], ["tone", "Tone names"], ["sents", "Sentences"]])
          r4.append(tog(Q.show[k], label, "Show it on the card", () => setQ("show", Object.assign({}, Q.show, { [k]: !Q.show[k] }))));
        qb.append(r4);
        qb.append(h("small", "", "Words climb from 2 choices to 6, then no choices at all; Wrong answers caps the choices. Romanization is above."));
        grid.append(qb);
      }
      // level: the course's lessons, grouped by course
      if (opts.levels) {
        const box = h("div", "ftc-opt", `<label class="t">Level</label>`), sel = h("select", "ftc-sel");
        sel.innerHTML = `<option>${esc(lesson && lesson.title || "…")}</option>`; box.append(sel);
        box.append(h("small", "", "Each lesson of the course is a level. Words from levels you've left keep coming back to review."));
        Promise.resolve(opts.levels()).then(list => {
          if (!list || !list.length) return;
          const cur = lesson && lesson.id, groups = {};
          for (const l of list) (groups[l.catName || l.cat || "Lessons"] = groups[l.catName || l.cat || "Lessons"] || []).push(l);
          sel.innerHTML = Object.entries(groups).map(([g, ls]) => `<optgroup label="${esc(g)}">` + ls.map(l =>
            `<option value="${esc(l.id)}"${l.id === cur ? " selected" : ""}>${esc(l.title)}${l.w ? ` (${l.w})` : ""}${(SAVE.get().mastered || {})[l.id] ? " 🏆" : ""}</option>`).join("") + "</optgroup>").join("");
          sel.onchange = () => { try { opts.goLevel(sel.value); } catch (e) {} closeOptions(); };
        }).catch(() => {});
        grid.append(box);
      }
      // where this level's words and pictures come from (to check pictures arrive)
      if (LE && cardOn()) {
        const ws = LE.level().ids.map(id => LE.word(id)).filter(Boolean);
        const ph = ws.filter(w => nowPic[w.id] || w.img), dr = ws.filter(w => svgOk(w.vis)), em = ws.filter(w => w.ch);
        const box = h("div", "ftc-opt", `<label class="t">Pictures in this level</label><small class="ftc-picinfo">${ws.length} words, from ${pack && lesson && pack.lesson === lesson.id ? (pack.from === "page" ? "the lesson page (rebuild the course for the word file)" : "the lesson's word file") : "the lesson page"} · ${ph.length} photos · ${dr.length} drawings · ${em.length} emoji<span class="ftc-pictest"></span></small>`);
        const ex = ph[0];
        if (ex) { const im = new Image(), t = box.querySelector(".ftc-pictest"); im.onload = () => t.textContent = " · photos load ✓"; im.onerror = () => t.textContent = ` · photos don't load ✗ (${(nowPic[ex.id] || ex.img).slice(0, 70)})`; im.src = nowPic[ex.id] || ex.img; }
        grid.append(box);
      }
      // Dan: "absolutely guarantee sound with words/sentences works": check it on this device
      if (LE && cardOn()) {
        const ws = LE.level().ids.map(id => LE.word(id)).filter(Boolean);
        const sents = ws.flatMap(w => (w.sents || []).filter(x => x && x.th)), sRec = sents.filter(x => x.audio);
        const urls = ws.flatMap(w => [w.audio, w.slow]).concat(sRec.map(x => x.audio)).filter(Boolean);
        const box = h("div", "ftc-opt", `<label class="t">Sound in this level</label><small class="ftc-sndinfo">${ws.length} words, ${ws.filter(w => w.audio).length} with a recording (${ws.filter(w => w.slow).length} slow) · ${sents.length} sentences, ${sRec.length} recorded · Thai voice for the rest: ${VOICE.thaiVoice() ? "yes ✓" : "<b>none on this device</b>"}<span class="ftc-sndres"> · checking…</span></small><div class="ftc-row"><button class="ftc-btn" data-sndtest>▶ Test a word</button><button class="ftc-btn" data-sndsent>▶ Test a sentence</button></div>`);
        const out = box.querySelector(".ftc-sndres");
        VOICE.check(urls).then(r => {
          if (r.mode === "element") out.textContent = ` · ${r.total} recordings (this device plays them one at a time, as they're asked)`;
          else out.innerHTML = r.failed.length ? ` · <b>${r.failed.length} of ${r.total} recordings don't load</b> (they fall back to the Thai voice): ${esc(r.failed.slice(0, 3).map(u => u.split("/").pop()).join(", "))}` : ` · all ${r.total} recordings load ✓`;
        }).catch(() => { out.textContent = " · couldn't check"; });
        box.querySelector("[data-sndtest]").onclick = () => { const w = ws.find(x => x.audio) || ws[0]; if (w) sayWord(w); };
        box.querySelector("[data-sndsent]").onclick = () => { const x = sRec[0] || sents[0]; if (x) { if (x.audio) say(x.audio, x.th, 1); else speak(x.th, 1); } };
        grid.append(box);
      }
      grid.append(seg("Effects", [["auto", "Auto"], ["high", "High"], ["medium", "Medium"], ["low", "Low"]], qPick(), v => { prefs.quality = v === "auto" ? null : v; savePrefs(); applyQuality(); showOptions(true); },
        `How many skeletons on screen at once and how many effects. Auto${qPick() === "auto" ? ` (now ${QUAL[qAuto].label}, ${Math.round(game.loop.actualFps || 0)} fps)` : ""} follows the frame rate.`));
      // Round 3 step 3: screen flashes (seizure-safe), motion, fish
      grid.append(seg("Screen flashes", [["full", "Full"], ["soft", "Soft"], ["off", "Off (reduce flashing)"]], flashMode(), v => { prefs.flashes = v; savePrefs(); },
        "A gentle flash on big hits: a nuke, a strike, a boss blow. Never more than about one a second, never a strobe, never red."));
      grid.append(seg("Motion", [["full", "Full"], ["reduced", "Reduced"]], reducedMotion() ? "reduced" : "full", v => { prefs.motion = v; savePrefs(); },
        `Reduced: no screen shake, no camera zoom when Flash falls, and no screen flashes unless you switch them on.${sysReduce() ? " Your device asks for reduced motion." : ""}`));
      const fo = h("div", "ftc-opt", `<label class="t">🐟 Fish</label><label class="ftc-small"><input type="checkbox"${prefs.autoeat ? " checked" : ""}> Auto-eat a fish when Flash drops below ${Math.round((((sim.D.settings.fish || {}).values || {}).auto_eat_below || 0.3) * 100)}% health</label>
        <small>Skeletons drop fish now and then (elites and bosses more). Flash carries up to ${sim.fishCarry()}; tap 🐟 at the top or press H to eat one.</small>`);
      fo.querySelector("input").onchange = e => { prefs.autoeat = e.target.checked; savePrefs(); sim.setAutoEat(prefs.autoeat); };
      grid.append(fo);
      // game sounds (the same as the 🔊 popover)
      const sb = h("div", "ftc-opt", `<label class="t">Game sounds</label><div class="ftc-row"><input type="range" min="0" max="100" step="5" value="${Math.round(SFX.volume() * 100)}">
        <label class="ftc-small"><input type="checkbox"${SFX.mute() ? " checked" : ""}> Mute</label></div>`);
      sb.querySelector('input[type="range"]').oninput = e => { SFX.volume(e.target.value / 100); volRange.value = e.target.value; volBtn.textContent = SFX.mute() || !+e.target.value ? "🔇" : "🔊"; };
      sb.querySelector('input[type="checkbox"]').onchange = e => { SFX.mute(e.target.checked); volMute.checked = e.target.checked; volBtn.textContent = e.target.checked ? "🔇" : "🔊"; };
      grid.append(sb);
      const ap = h("div", "ftc-opt", `<label class="t">Level-ups</label><label class="ftc-small"><input type="checkbox"${prefs.auto ? " checked" : ""}> Auto-pick, auto-shop &amp; continue between rounds</label>
        <small>With it on, Flash picks his own upgrades, spends his gold in the shop, and you can keep answering words without stopping.</small>`);
      ap.querySelector("input").onchange = e => { prefs.auto = e.target.checked; savePrefs(); };
      grid.append(ap);
      overlay.append(grid);
      // what the learner knows, by direction, in words that mean something
      if (LE) {
        const sm = LE.summary(), rows = [["th", "Thai → meaning"], ["en", "meaning → Thai"], ["au", "🎧 Listening"], ["cx", "🧩 In a sentence"], ["sm", "💬 Sentence meaning"], ["tp", "🎧 Tones"]];
        const cols = [["met", "Met", "seen at least once"], ["recognises", "Recognises", "right with 4 choices"], ["recalls", "Recalls", "remembered with no choices"],
                      ["learned", "Learned", "recalled on two different days, latest right"], ["longterm", "Long-term", "still remembered after a week or more"]];
        overlay.append(h("div", "ftc-prog", `<label>Your words${sm.due ? ` · 🔁 ${sm.due} due for review` : ""}</label><table><tr><th></th>${cols.map(c => `<th title="${c[2]}">${c[1]}</th>`).join("")}</tr>`
          + rows.map(([d, t]) => `<tr><td>${t}</td>${cols.map(c => `<td>${sm[d][c[0]] || ""}</td>`).join("")}</tr>`).join("") + `</table>
          <small>Each direction is tracked on its own: knowing what a word means and being able to say it are different skills.</small>`));
      }
      const close = h("button", "ftc-btn big", menuResumes() ? "▶ Back to the game" : "Done"); close.onclick = () => closeOptions();
      overlay.append(close);
      overlay.scrollTop = scroll;
    }
    // ---------------------------------------------------------- 📊 My progress
    // Dan: "we need some more polish on ... stats we give the user". What the
    // learner knows, in words that mean something: learned is the strict
    // "recalled on two different days", the rest is said for what it is.
    function progTable() {
      const sm = LE.summary(), rows = [["th", "Thai → meaning"], ["en", "meaning → Thai"], ["au", "🎧 Listening"]];
      const cols = [["met", "Met", "seen at least once"], ["recognises", "Recognises", "right with 4 choices"], ["recalls", "Recalls", "remembered with no choices"],
                    ["learned", "Learned", "recalled on two different days, latest right"], ["longterm", "Long-term", "still remembered after a week or more"]];
      return `<table><tr><th></th>${cols.map(c => `<th title="${c[2]}">${c[1]}</th>`).join("")}</tr>`
        + rows.map(([d, t]) => `<tr><td>${t}</td>${cols.map(c => `<td>${sm[d][c[0]] || ""}</td>`).join("")}</tr>`).join("") + `</table>`;
    }
    function showProgress() {
      if (!LE) return;
      openMenu("progress");
      overlay.innerHTML = ""; overlay.classList.add("show", "ftc-optsov");
      const sm = LE.summary(), due = LE.dueSoon(), days = dayLog(), today = days[dayKey()] || { n: 0, right: 0 };
      overlay.append(h("h2", "", "📊 My progress"), h("p", "ftc-slogan", PUN.progress));
      overlay.append(h("div", "ftc-tiles", `
        <div title="recalled on two different days, the latest answer right"><b>⭐ ${sm.th.learned}</b><span>words learned</span><small>${sm.th.recognises} recognised · ${sm.th.met} met</small></div>
        <div title="days in a row with at least one answer"><b>📅 ${daysInRow()}</b><span>day${daysInRow() === 1 ? "" : "s"} in a row</span><small>${daysInRow() >= 3 ? PUN.streak : "come back tomorrow to keep it going"}</small></div>
        <div><b>🎯 ${Math.min(today.n, GOAL)}/${GOAL}</b><span>answers today</span><small>${today.n ? Math.round(today.right / today.n * 100) + "% right" : "not started yet"}</small></div>
        <div title="words from earlier sessions, due for a review"><b>🔁 ${due.now}</b><span>to review now</span><small>${due.tomorrow} more by tomorrow night</small></div>
        <div title="right answers on reviews: words asked again after days away" class="ftc-ret"><b>🧠 …</b><span>remembered on reviews</span><small>&nbsp;</small></div>`));
      // retention: how often a word asked again after time away was still remembered
      Promise.resolve(LE.attempts()).then(a => {
        const rv = (a || []).filter(x => x && x.review && x.kind !== "meet"), el = overlay.querySelector(".ftc-ret"); if (!el) return;
        const wk = rv.filter(x => x.at > Date.now() - 7 * 864e5);
        el.innerHTML = rv.length >= 5 ? `<b>🧠 ${Math.round(rv.filter(x => x.right).length / rv.length * 100)}%</b><span>remembered on reviews</span><small>${rv.length} reviews${wk.length >= 5 ? ` · ${Math.round(wk.filter(x => x.right).length / wk.length * 100)}% this week` : ""}</small>`
          : `<b>🧠 —</b><span>remembered on reviews</span><small>after your first reviews (they start tomorrow)</small>`;
      }).catch(() => {});
      // answers per day, the last 14 days
      const keys = []; for (let i = 13; i >= 0; i--) { const t = new Date(); t.setDate(t.getDate() - i); keys.push(dayKey(t)); }
      const mx = Math.max(GOAL, ...keys.map(k => (days[k] || {}).n || 0));
      overlay.append(h("div", "ftc-prog", `<label>Answers per day, the last two weeks · the yellow line is the daily goal</label>
        <div class="ftc-days"><div class="bars">${keys.map(k => { const d = days[k] || { n: 0, right: 0 };
          return `<div title="${k}: ${d.n} answers, ${d.right} right"><i style="height:${Math.round(d.n / mx * 100)}%"></i></div>`; }).join("")}<span class="goal" style="bottom:${Math.round(GOAL / mx * 100)}%"></span></div>
        <div class="lbls">${keys.map((k, i) => `<em>${i === 13 ? "today" : new Date(k + "T12:00").toLocaleDateString(undefined, { weekday: "narrow" })}</em>`).join("")}</div></div>`));
      overlay.append(h("div", "ftc-prog", `<label>Each direction on its own</label>${progTable()}<small>Knowing what a word means and being able to say it are different skills.</small>`));
      // the hardest words, with their picture and memory hook
      const hard = LE.hardest(6);
      if (hard.length) {
        const box = h("div", "ftc-prog", `<label>Your trickiest words · ${PUN.revise.toLowerCase()}</label><div class="ftc-hard">${hard.map(x => `<div class="ftc-wc">${aidHtml(x.word, true) || ""}<div class="ftc-hard-w"><span lang="th">${esc(x.word.th)}</span> <i>${romHtml(x.word)}</i> = <b>${esc(short(x.word.en, 34))}</b><small>${x.wrong} wrong · ${x.right} right</small></div></div>`).join("")}</div>`);
        fixPics(box);
        const pr = h("button", "ftc-btn primary", `🧠 Practise these ${hard.length} next`);
        pr.onclick = () => { LE.practise(hard.map(x => x.id)); floatText(`🧠 ${PUN.wrong} Your trickiest words are up next`, false, true); closeOptions(); };
        box.append(pr); overlay.append(box);
      }
      const ms = Object.values(SAVE.get().mastered || {});
      if (ms.length) overlay.append(h("div", "ftc-prog", `<label>🏆 Levels mastered (${ms.length})</label><div class="ftc-small">${ms.map(m => esc(m.title || "a level")).join(" · ")}</div>`));
      const row = h("div", "ftc-row");
      const mw = h("button", "ftc-btn primary", "📚 My words"); mw.onclick = () => showWords();
      const sh = h("button", "ftc-btn", "📣 Share my progress"); sh.onclick = () => shareCard("progress");
      row.append(mw);
      const close = h("button", "ftc-btn big", menuResumes() ? "▶ Back to the game" : "Done"); close.onclick = () => closeOptions();
      row.append(sh, close); overlay.append(row);
      overlay.scrollTop = 0;
    }

    // ------------------------------------------------------------ 📚 My words
    // "Give every word its own little progress bar ... which words are just
    // discovered, getting familiar, recognised, remembered, truly mastered."
    const STAGE = { met: ["🌱", "just met"], recognises: ["🐾", "getting familiar"], recalls: ["😸", "remembered"], learned: ["🧠", "learned"], longterm: ["👑", "mastered"] };
    const STAGE_N = { new: 0, met: 1, recognises: 2, recalls: 3, learned: 4, longterm: 5 };
    let wordsFilter = "now";
    function showWords() {
      if (!LE) return;
      openMenu("words");
      overlay.innerHTML = ""; overlay.classList.add("show", "ftc-optsov");
      const all = LE.vocab(), lv = new Set(LE.level().ids);
      const sn0 = v => STAGE_N[v.dirs.th || "met"] || 1;
      const list = all.filter(v => wordsFilter === "all" ? true : wordsFilter === "tricky" ? v.wrong > 0 : wordsFilter === "learnt" ? sn0(v) >= 4 : wordsFilter === "level" ? lv.has(v.id) : sn0(v) < 4)
        .sort((a, b) => wordsFilter === "tricky" ? (b.wrong - b.right * 0.25) - (a.wrong - a.right * 0.25) : STAGE_N[a.dirs.th || "new"] - STAGE_N[b.dirs.th || "new"] || b.last - a.last);
      const counts = {}; for (const v of all) { const k = v.dirs.th || "met"; counts[k] = (counts[k] || 0) + 1; }
      overlay.append(h("h2", "", "📚 My words"), h("p", "ftc-slogan", PUN.progress),
        h("div", "ftc-stagekey", Object.entries(STAGE).map(([k, [ic, t]]) => `<span>${ic} ${t} <b>${counts[k] || 0}</b></span>`).join("")));
      const seg = h("div", "ftc-seg");
      for (const [v, t] of [["now", `Learning now (${all.filter(x => sn0(x) < 4).length})`], ["learnt", `Learnt (${all.filter(x => sn0(x) >= 4).length})`], ["tricky", "Hard words"], ["level", "This lesson"], ["all", `All (${all.length})`]]) {
        const b = h("button", "ftc-seg-b" + (wordsFilter === v ? " on" : ""), t); b.onclick = () => { wordsFilter = v; showWords(); }; seg.append(b);
      }
      overlay.append(h("div", "ftc-opt", ""), seg);
      const DIRL = [["th", "Thai → meaning"], ["en", "meaning → Thai"], ["au", "listening"], ["cx", "in a sentence"], ["sm", "sentence meaning"], ["tp", "tone"]];
      const box = h("div", "ftc-vocab");
      if (!list.length) box.append(h("p", "ftc-small", wordsFilter === "level" ? "No words from this lesson yet: start a run and they'll appear here." : wordsFilter === "learnt" ? "Nothing here yet. A word is learnt once you've remembered it on two different days." : wordsFilter === "tricky" ? "No hard words: nothing has gone wrong yet 😸" : "Nothing here yet."));
      for (const v of list.slice(0, 300)) {
        const w = v.word, sn = STAGE_N[v.dirs.th || "met"] || 1, ic = (STAGE[v.dirs.th] || STAGE.met)[0];
        const row = h("button", "ftc-vrow", `<span class="ftc-vpic">${picHtml(w)}</span>
          <span class="ftc-vw"><b lang="th">${esc(w.th)}</b> <i>${romHtml(w)}</i><small>${esc(short(w.en, 40))}</small></span>
          <span class="ftc-vbar" title="${(STAGE[v.dirs.th] || STAGE.met)[1]}">${[1, 2, 3, 4, 5].map(i => `<i class="${i <= sn ? "on" : ""}"></i>`).join("")}<em>${ic}</em></span>
          <span class="ftc-vdirs">${DIRL.filter(([d]) => v.dirs[d]).map(([d, t]) => `<i title="${t}: ${LABEL_TXT[v.dirs[d]]}" class="s${STAGE_N[v.dirs[d]]}">${{ th: "👁", en: "✍", au: "🎧", cx: "🧩", sm: "💬", tp: "♪" }[d]}</i>`).join("")}</span>`);
        row.onclick = () => { if (panelOn()) { showWordInfo(w); sayWord(w); } else sayWord(w); };
        box.append(row);
      }
      fixPics(box);
      overlay.append(box, h("p", "ftc-small", "The bar is Thai → meaning: 🌱 met · 🐾 recognised with 4 choices · 😸 remembered with none · 🧠 remembered on two different days · 👑 still remembered after a week. The small letters are the other skills. Tap a word to hear it" + (panelOn() ? " and see its card." : ".")));
      const row = h("div", "ftc-row");
      const back = h("button", "ftc-btn", "📊 My progress"); back.onclick = () => showProgress();
      const close = h("button", "ftc-btn big", menuResumes() ? "▶ Back to the game" : "Done"); close.onclick = () => closeOptions();
      if (wordsFilter === "tricky" && list.length) { const rv = h("button", "ftc-btn primary", "🔁 Review these"); rv.onclick = () => { closeOptions(); startReview("hard"); }; row.append(rv); }
      row.append(back, close); overlay.append(row);
    }

    // ------------------------------------------------------------ share card
    // Dan: "social media promotion, I learned x words playing flash the cat".
    // A square picture drawn in this browser (nothing is uploaded), with
    // honest numbers: "learned" only for words recalled on two different
    // days, otherwise what was practised.
    function shareFacts() {
      const sm = LE.summary(), learned = sm.th.learned, met = sm.th.met, ws = LE.recent(learned ? "learned" : "recognises", 6);
      return { learned, met, recognised: sm.th.recognises, days: daysInRow(), words: ws.length ? ws : LE.recent("met", 6),
               best: cRun.best, url: String(opts.siteUrl || location.origin + "/").replace(/\/+$/, "") };
    }
    function shareText(f) {
      const what = f.learned ? `I've learned ${f.learned} Thai word${f.learned === 1 ? "" : "s"}` : `I've practised ${f.met} Thai word${f.met === 1 ? "" : "s"}`;
      return `${what} playing Flash the Cat 🐈⚡${f.days >= 2 ? ` · ${f.days} days in a row 🔥` : ""} · ${PUN.slogan}: ${f.url.replace(/^https?:\/\//, "")}`;
    }
    function drawShare(f) {
      const S = 1080, c = document.createElement("canvas"); c.width = S; c.height = S;
      const g = c.getContext("2d"), TH = '"Leelawadee UI", "Noto Sans Thai", Tahoma, sans-serif', UI = '"Segoe UI", system-ui, sans-serif';
      const bg = g.createLinearGradient(0, 0, S, S); bg.addColorStop(0, "#16121f"); bg.addColorStop(1, "#2a1d40"); g.fillStyle = bg; g.fillRect(0, 0, S, S);
      // Flash: the in-game cat, big, with lightning in his eyes
      const cx = 200, cy = 220, r = 120;
      g.fillStyle = "#ff9f5a"; g.beginPath(); g.moveTo(cx - 105, cy - 45); g.lineTo(cx - 70, cy - 175); g.lineTo(cx - 20, cy - 95); g.fill();
      g.beginPath(); g.moveTo(cx + 105, cy - 45); g.lineTo(cx + 70, cy - 175); g.lineTo(cx + 20, cy - 95); g.fill();
      g.beginPath(); g.arc(cx, cy, r, 0, 7); g.fill();
      g.fillStyle = "#fff"; for (const x of [-42, 42]) { g.beginPath(); g.arc(cx + x, cy - 15, 30, 0, 7); g.fill(); }
      g.fillStyle = "#3b82f6"; for (const x of [-42, 42]) { g.beginPath(); g.moveTo(cx + x + 6, cy - 40); g.lineTo(cx + x - 12, cy - 10); g.lineTo(cx + x + 2, cy - 10); g.lineTo(cx + x - 6, cy + 14); g.lineTo(cx + x + 14, cy - 18); g.lineTo(cx + x, cy - 18); g.closePath(); g.fill(); }
      g.fillStyle = "#ff6a7a"; g.beginPath(); g.moveTo(cx - 12, cy + 30); g.lineTo(cx + 12, cy + 30); g.lineTo(cx, cy + 44); g.fill();
      g.textBaseline = "alphabetic"; g.fillStyle = "#9cc8ff"; g.font = `700 34px ${UI}`; g.fillText("⚡ Flash the Cat", 370, 150);
      g.fillStyle = "#fff"; g.font = `800 ${f.learned ? 86 : 76}px ${UI}`;
      g.fillText(f.learned ? `${f.learned} Thai word${f.learned === 1 ? "" : "s"}` : `${f.met} Thai word${f.met === 1 ? "" : "s"}`, 370, 250);
      g.fillStyle = "#ffb57d"; g.font = `600 40px ${UI}`; g.fillText(f.learned ? "learned, and remembered" : "practised so far", 370, 305);
      g.fillStyle = "#c9c2b8"; g.font = `500 32px ${UI}`;
      g.fillText([f.days >= 2 ? `🔥 ${f.days} days in a row` : "", f.recognised ? `👀 ${f.recognised} recognised` : ""].filter(Boolean).join("   "), 370, 360);
      // the words: Thai big, English under it
      const ws = f.words.slice(0, 6);
      ws.forEach((w, i) => {
        const col = i % 2, row = Math.floor(i / 2), x = 70 + col * 480, y = 470 + row * 160;
        g.fillStyle = "rgba(255,255,255,.06)"; g.beginPath(); (g.roundRect ? g.roundRect(x, y, 450, 135, 22) : g.rect(x, y, 450, 135)); g.fill();
        g.fillStyle = "#fff7e0"; g.font = `500 54px ${TH}`; g.fillText(w.th, x + 28, y + 66);
        g.fillStyle = "#e6f3ff"; g.font = `600 28px ${UI}`; g.fillText(short(w.en, 26), x + 28, y + 112);
      });
      g.fillStyle = "#3b82f6"; g.fillRect(0, S - 120, S, 120);
      g.fillStyle = "#fff"; g.font = `800 42px ${UI}`; g.fillText(`${PUN.slogan} 😺`, 70, S - 50);
      g.font = `600 32px ${UI}`; g.textAlign = "right"; g.fillText(f.url.replace(/^https?:\/\//, ""), S - 70, S - 50); g.textAlign = "left";
      return c;
    }
    // ---- the journey, as posts ready to paste into x.com (Dan, 10 Nov).
    // Honest numbers: "learned" is the strict one (recalled on two different
    // days); time is what the game counted (or, before 10 Nov, a fair estimate).
    async function journeyFacts() {
      flushStudy();
      const f = shareFacts(), j = journey(), sm = LE.summary(), days = dayLog(), td = days[dayKey()] || { n: 0, right: 0 };
      let att = []; try { att = (await LE.attempts()) || []; } catch (e) {}
      const rv = att.filter(x => x && x.review && x.kind !== "meet"), wk = rv.filter(x => x.at > Date.now() - 7 * 864e5), rvT = rv.filter(x => dayKey(x.at) === dayKey());
      const start = j.start || Date.now(), d0 = new Date(start); d0.setHours(0, 0, 0, 0);
      const t0 = new Date(); t0.setHours(0, 0, 0, 0);
      const ls = Object.values(j.lessons).filter(L => L.title || L.n);
      return Object.assign(f, {
        day: Math.round((t0 - d0) / 864e5) + 1, since: new Date(start).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }),
        daysStudied: Object.keys(days).filter(k => days[k].n || days[k].s > 60).length,
        secs: j.secs || 0, estimated: !!j.estimated, answers: j.answers || 0, acc: j.tested ? Math.min(100, Math.round((j.right || 0) / j.tested * 100)) : null,
        recalls: sm.th.recalls, longterm: sm.th.longterm, speak: sm.en ? sm.en.recalls : 0, listen: sm.au ? sm.au.recognises : 0,
        lessons: ls.length, lessonNames: ls.sort((a, b) => (b.last || 0) - (a.last || 0)).map(L => L.title).filter(Boolean),
        mastered: Object.keys(SAVE.get().mastered || {}).length,
        retention: rv.length >= 5 ? Math.round(rv.filter(x => x.right).length / rv.length * 100) : null, reviews: rv.length,
        retentionWeek: wk.length >= 5 ? Math.round(wk.filter(x => x.right).length / wk.length * 100) : null,
        newToday: [...new Set(att.filter(x => x && x.kind === "meet" && x.dir === "th" && dayKey(x.at) === dayKey()).map(x => x.id))].map(id => LE.word(id)).filter(Boolean),
        bestDays: Math.max(bestDaysInRow(), f.days), bestRound: Math.max((SAVE.get().best || {}).test || 0, (SAVE.get().best || {}).learn || 0),
        today: { n: td.n || 0, acc: td.t ? Math.min(100, Math.round((td.right || 0) / td.t * 100)) : null, secs: td.s || 0,
                 met: td.met0 == null ? 0 : Math.max(0, sm.th.met - td.met0), learned: td.learned0 == null ? 0 : Math.max(0, sm.th.learned - td.learned0),
                 lessons: Object.keys(td.les || {}).length, reviews: rvT.length, retention: rvT.length ? Math.round(rvT.filter(x => x.right).length / rvT.length * 100) : null },
      });
    }
    const pl = (n, w, ws) => `${n.toLocaleString()} ${n === 1 ? w : ws || w + "s"}`;
    // Dan, 10 Nov: "we don't need to worry about hashtags or links. We just need to
    // document my language learning journey. Time spent, words learned, retention
    // etc, new words today". So: numbers and words only.
    function journeyPosts(f) {
      const wl = ws => ws.map(w => `${w.th} (${short(w.en, 14)})`).join(" · ");
      const t = f.today, SPC = "\u0001";
      const words = f.learned ? `⭐ ${pl(f.learned, "word")} learned` : `🌱 ${pl(f.met, "word")} met`;
      const ret = f.retention != null ? `🧠 ${f.retention}% retention` : "";
      const short1 = [`Day ${f.day} of learning Thai 🇹🇭`,
        [words, f.secs >= 60 ? `⏱ ${fmtDur(f.secs)}` : "", ret, f.lessons ? `📚 ${pl(f.lessons, "lesson")}` : "", f.days >= 2 ? `🔥 ${f.days} days in a row` : ""].filter(Boolean).join(" · "),
        t.n ? "Today: " + [t.met ? `${pl(t.met, "new word")}` : "", t.secs >= 60 ? fmtDur(t.secs) : "", `${pl(t.n, "answer")}${t.acc != null ? ` (${t.acc}% right)` : ""}`].filter(Boolean).join(" · ") : ""].filter(Boolean).join("\n");
      const L = [`My Thai journey 🇹🇭 Day ${f.day} (since ${f.since})`, SPC,
        `⏱ Time: ${fmtDur(f.secs)}${f.estimated ? " (about)" : ""} over ${pl(f.daysStudied, "day")}${f.daysStudied > 1 ? ` · ${fmtDur(f.secs / f.daysStudied)} a day` : ""}`,
        f.learned ? `⭐ Words learned: ${f.learned}` : "",
        `👀 Recognised: ${f.recognised} · 🌱 met: ${f.met}`,
        f.longterm ? `👑 Remembered after a week or more: ${f.longterm}` : "",
        f.speak ? `✍ Can say from the English: ${f.speak}` : "",
        f.retention != null ? `🧠 Retention: ${f.retention}% of ${pl(f.reviews, "review")}${f.retentionWeek != null ? ` (${f.retentionWeek}% this week)` : ""}` : "🧠 Retention: after my first reviews",
        f.lessons ? `📚 Lessons studied: ${f.lessons}${f.mastered ? ` · ${f.mastered} mastered` : ""}` : "",
        f.answers ? `🎯 Answers: ${f.answers.toLocaleString()}${f.acc != null ? ` · ${f.acc}% right` : ""}` : "",
        `🔥 Days in a row: ${f.days}${f.bestDays > f.days ? ` (best ${f.bestDays})` : ""}`,
        t.n ? SPC : "", t.n ? `Today: ${[t.met ? pl(t.met, "new word") : "", t.learned ? `+${t.learned} learned` : "", t.secs >= 60 ? fmtDur(t.secs) : "", pl(t.n, "answer") + (t.acc != null ? `, ${t.acc}% right` : "")].filter(Boolean).join(" · ")}` : "",
        f.newToday.length ? `New today: ${wl(f.newToday.slice(0, 6))}${f.newToday.length > 6 ? ` +${f.newToday.length - 6}` : ""}` : ""];
      const T = [`Thai, day ${f.day} 🇹🇭 Today:`, SPC,
        t.secs >= 60 ? `⏱ ${fmtDur(t.secs)} studied` : "",
        `🌱 ${pl(t.met, "new word")}${t.learned ? ` · ⭐ +${t.learned} learned` : ""}`,
        `🎯 ${pl(t.n, "answer")}${t.acc != null ? ` · ${t.acc}% right` : ""}`,
        t.reviews >= 3 ? `🧠 ${t.retention}% remembered on ${pl(t.reviews, "review")}` : "",
        t.lessons ? `📚 ${pl(t.lessons, "lesson")}${f.lessonNames[0] ? `: ${short(f.lessonNames[0], 40)}` : ""}` : "", f.days >= 2 ? `🔥 ${f.days} days in a row` : "",
        f.newToday.length ? SPC : "", f.newToday.length ? `New words: ${wl(f.newToday.slice(0, 8))}${f.newToday.length > 8 ? ` +${f.newToday.length - 8}` : ""}` : "", SPC,
        `So far: ${f.learned ? pl(f.learned, "word") + " learned" : pl(f.met, "word") + " met"}${f.secs >= 60 ? ` · ${fmtDur(f.secs)}` : ""}${f.retention != null ? ` · ${f.retention}% retention` : ""}`];
      const tidy = a => a.filter(Boolean).map(x => x === SPC ? "" : x).join("\n").replace(/\n{3,}/g, "\n\n").trim();
      return { short: short1, detailed: tidy(L), today: tidy(T) };
    }
    // how x.com counts a post: most letters (Thai too) 1, emoji and CJK 2, a link 23
    function xLength(text) {
      let n = 0; const noUrl = text.replace(/(https?:\/\/|\b)[a-z0-9.-]+\.(cards|com|org|net|io|app)(\/\S*)?/gi, () => { n += 23; return ""; });
      for (const ch of noUrl) { const c = ch.codePointAt(0); n += (c <= 0x10ff || (c >= 0x2000 && c <= 0x200d) || (c >= 0x2010 && c <= 0x201f) || (c >= 0x2032 && c <= 0x2037)) ? 1 : 2; }
      return n;
    }
    let shareStyle = "short";
    async function shareCard(kind) {
      if (!LE) return;
      openMenu("share");
      const f = await journeyFacts(), c = drawShare(f), posts = journeyPosts(f);
      let text = posts[shareStyle] || posts.short;
      overlay.innerHTML = ""; overlay.classList.add("show", "ftc-optsov");
      overlay.append(h("h2", "", "📣 Share my journey"), h("p", "ftc-small", "Made in your browser. Nothing is sent anywhere until you paste or post it."));
      // the numbers, at a glance
      overlay.append(h("div", "ftc-tiles ftc-jtiles", `
        <div><b>📆 Day ${f.day}</b><span>since ${esc(f.since)}</span><small>${pl(f.daysStudied, "day")} studied</small></div>
        <div title="recalled on two different days, the latest answer right"><b>⭐ ${f.learned}</b><span>words learned</span><small>${f.recognised} recognised · ${f.met} met</small></div>
        <div><b>📚 ${f.lessons}</b><span>lesson${f.lessons === 1 ? "" : "s"} studied</span><small>${f.mastered ? f.mastered + " mastered 🏆" : esc(short(f.lessonNames[0] || "", 24)) || "&nbsp;"}</small></div>
        <div title="${f.estimated ? "Before 10 Nov the game didn't time you: that part is worked out from when you answered" : "Counted while you play or answer, with the tab showing"}"><b>⏱ ${fmtDur(f.secs)}</b><span>studied${f.estimated ? " (about)" : ""}</span><small>${fmtDur(f.today.secs)} today</small></div>
        <div><b>🎯 ${f.answers.toLocaleString()}</b><span>answers</span><small>${f.acc != null ? f.acc + "% right" : "&nbsp;"}</small></div>
        <div><b>🔥 ${f.days}</b><span>day${f.days === 1 ? "" : "s"} in a row</span><small>best ${f.bestDays}</small></div>
        <div title="right answers on reviews: words asked again after days away"><b>🧠 ${f.retention != null ? f.retention + "%" : "—"}</b><span>retention</span><small>${f.retention != null ? pl(f.reviews, "review") : "after your first reviews"}</small></div>
        <div><b>🌱 ${f.today.met}</b><span>new word${f.today.met === 1 ? "" : "s"} today</span><small>${f.today.learned ? "+" + f.today.learned + " learned today" : esc(f.newToday.slice(0, 3).map(w => w.th).join(" · ")) || "&nbsp;"}</small></div>`));
      // the post: three styles, editable, counted the way x.com counts
      const seg = h("div", "ftc-seg ftc-share-seg");
      for (const [v, t] of [["short", "Short (fits a post)"], ["detailed", "Detailed"], ["today", "Today"]]) {
        const b = h("button", "ftc-seg-b" + (shareStyle === v ? " on" : ""), t); b.onclick = () => { shareStyle = v; shareCard(kind); }; seg.append(b);
      }
      const ta = h("textarea", "ftc-share-ta"); ta.value = text; ta.rows = Math.min(18, text.split("\n").length + 1); ta.spellcheck = false;
      const cnt = h("p", "ftc-small ftc-share-cnt", "");
      const count = () => { text = ta.value; const n = xLength(text); cnt.innerHTML = `<b class="${n > 280 ? "over" : "ok"}">${n} / 280</b> ${n > 280 ? "· too long for a standard post: fine with X Premium, or trim it (you can edit the text)" : "· fits in one post · you can edit the text before copying"}`; };
      ta.oninput = count; count();
      overlay.append(seg, ta, cnt);
      const row0 = h("div", "ftc-row"), msg = h("p", "ftc-small", "");
      const copy = h("button", "ftc-btn primary big", "📋 Copy for X");
      copy.onclick = async () => {
        let ok = false;
        try { await navigator.clipboard.writeText(text); ok = true; } catch (e) { try { ta.focus(); ta.select(); ok = document.execCommand("copy"); } catch (e2) {} }
        msg.textContent = ok ? "✅ Copied. Paste it into x.com (add the picture below if you like)." : "Couldn't copy by itself: the text is selected, press Ctrl+C.";
        if (ok) sim.noteStudy("shared_copy_" + shareStyle);
      };
      const xb = h("button", "ftc-btn", "𝕏 Open in X");
      xb.title = "Opens x.com with this text ready to post";
      xb.onclick = () => { window.open("https://x.com/intent/post?text=" + encodeURIComponent(text), "_blank", "noopener"); sim.noteStudy("shared_x_" + shareStyle); };
      row0.append(copy, xb); overlay.append(row0, msg);
      const img = h("img", "ftc-share-img"); img.src = c.toDataURL("image/png"); img.alt = shareText(f); overlay.append(img);
      const row = h("div", "ftc-row");
      const blob = () => new Promise(r => c.toBlob(r, "image/png"));
      if (navigator.share) {
        const b = h("button", "ftc-btn primary", "📤 Share");
        b.onclick = async () => {
          try {
            const file = new File([await blob()], "flash-the-cat.png", { type: "image/png" });
            if (navigator.canShare && navigator.canShare({ files: [file] })) await navigator.share({ files: [file], text, url: f.url });
            else await navigator.share({ text, url: f.url });
            sim.noteStudy("shared_" + kind);
          } catch (e) {}
        };
        row.append(b);
      }
      const ci = h("button", "ftc-btn", "🖼 Copy picture");
      ci.onclick = async () => { try { await navigator.clipboard.write([new ClipboardItem({ "image/png": await blob() })]); msg.textContent = "✅ Picture copied: paste it into your post."; } catch (e) { msg.textContent = "This browser can't copy pictures: use Save image."; } };
      const sv = h("button", "ftc-btn", "💾 Save image");
      sv.onclick = async () => { const a = document.createElement("a"); a.href = URL.createObjectURL(await blob()); a.download = "flash-the-cat-" + dayKey() + ".png"; document.body.append(a); a.click(); a.remove(); sim.noteStudy("shared_save"); };
      const close = h("button", "ftc-btn big", menuResumes() ? "▶ Back to the game" : "Done"); close.onclick = () => closeOptions();
      row.append(ci, sv, close); overlay.append(row);
      overlay.scrollTop = 0;
    }
    function closeOptions() {
      if (!optsOpen) return;
      optsOpen = false; overlay.classList.remove("ftc-optsov");
      setPause("menu", false);
      if (st.phase === "fight" && !st.paused) hideOverlay();
      else if (st.phase === "start") showStart();
      else if (st.phase === "break") showBreak();
      else if (st.phase === "over") showOver();
      else if (st.paused) showPaused();
      else hideOverlay();
      updateHud();
    }
    eyeBtn.onclick = () => { showAll = !showAll; saveSet("show_answers", showAll); updateHud(); floatText(showAll ? "👁 Answers showing on every word" : "👁 Answers only on words you're learning"); };

    // ------------------------------------------------------------ rewards
    // nothing counts while paused (Dan: "when the game is paused, flash shouldn't get any xp/bonuses")
    const onReward = e => {
      // studying on the site counts as time studied, and its lesson as a lesson studied
      lastActive = Date.now();
      const lk = lesson && lesson.id ? lesson.id + "|" + dayKey() : "";
      if (lk && !siteLes[lk]) {
        siteLes[lk] = 1;
        const j = journey(), L = j.lessons[lesson.id] || (j.lessons[lesson.id] = { title: lesson.title || "", first: Date.now(), n: 0 });
        L.last = Date.now(); if (lesson.title) L.title = lesson.title; if (!j.start) j.start = Date.now();
        const days = dayLog(), d = days[dayKey()] || (days[dayKey()] = { n: 0, right: 0 }); (d.les || (d.les = {}))[lesson.id] = 1;
        saveSet("journey", j); saveSet("days", days);
      }
      if ((st.phase === "fight" || st.phase === "break") && !st.paused && !st.practice) sim.applyReward(e.detail || {});
    };
    window.addEventListener("inaflash:reward", onReward);
    // pause when the tab is hidden, so the flashcards never fight the game for the CPU
    const onVis = () => { if (document.hidden && st.phase === "fight" && !st.paused) togglePause(true); };
    document.addEventListener("visibilitychange", onVis);

    const telTimer = setInterval(() => { if (st.phase === "fight" && !st.paused && Date.now() - telSent > 20000) sendTel(); }, 5000);

    applyQuality();
    sim.setAutoEat(!!prefs.autoeat);
    backfillJourney();
    showStart();
    updateHud();
    announce("ready");

    return {
      sim, game,
      reward: d => onReward({ detail: d }),
      pause: on => togglePause(on),
      setSpeed: n => { speed = Math.max(0.25, Math.min(8, n)); },
      spawn: (n, elite, defId) => sim.spawn(n, elite, defId),
      megaWave: n => sim.megaWave(n),
      waveNow: id => sim.waveNow(id),
      onScreenCap: () => Q().cap,
      stats: () => ({ fps: game.loop.actualFps, enemies: st.enemies.length, projectiles: st.proj.length + st.eproj.length, fx: fx.length,
                      simMs: perf.sim, drawMs: perf.draw, intensity: st.intensity,
                      hp: st.flash ? st.flash.hp / st.flash.maxHp() : 1, surge: !!st.surge }),
      anims: () => ANIMS.map(([id, name, desc, kind]) => ({ id, name, desc, kind, on: A(id),
                      used: kind === "sprite" ? (usedFrame[id] || 0) : (lastSec[id] || 0) })),
      setAnim: (id, on) => { prefs.anim[id] = !!on; savePrefs(); },
      setAllAnims: on => { for (const a of ANIMS) prefs.anim[a[0]] = !!on; savePrefs(); },
      stressWave: n => sim.stressWave(n),
      // Round 3 step 3
      state: () => gameState(),
      check: () => checkState(),
      stateLog: () => stateLog.slice(),
      eatFish: () => eatFish(),
      journey: async () => { const f = await journeyFacts(); return { facts: f, posts: journeyPosts(f), len: Object.fromEntries(Object.entries(journeyPosts(f)).map(([k, v]) => [k, xLength(v)])) }; },
      share: k => shareCard(k || "progress"),
      flashes: () => ({ mode: flashMode(), reduced: reducedMotion(), log: flashLog.slice() }),
      napping: () => nap ? { t: nap.t, dur: nap.dur, done: !!nap.done } : null,
      skipNap: () => finishNap(),
      setGod: on => sim.setGod(on),
      // Round 3 step 5: the location on screen (its floor texture and how many lights are lit), for the tests
      floor: () => ({ id: shownLoc || null, texture: scene && scene.floorImg ? scene.floorImg.texture.key : null, lights: scene ? scene.locLights.filter(o => o.visible).length : 0 }),
      setWeapons: on => sim.setWeapons(on),
      setMove: on => sim.setMove(on),
      setDirector: on => sim.setDirector(on),
      clearEnemies: () => sim.clearEnemies(),
      telemetry: () => sim.telemetry(),
      // words: [{ id, th, rom, en, audio, weight }] from the host
      // extra: more words (the rest of the lesson) to use as wrong answers
      setWords: (list, more) => {
        const ok = w => w && w.id && w.th && w.en;
        words = Array.isArray(list) ? list.filter(ok) : [];
        if (more !== undefined) extra = Array.isArray(more) ? more.filter(ok) : [];
        syncLevel();
      },
      // the lesson on the page: { id, title, next: { title } | null }
      setLesson: l => { const was = lesson && lesson.id; lesson = l && l.id ? l : null; if ((lesson && lesson.id) !== was) { masterEl.classList.remove("show"); endHard(true); syncLevel(); syncLocation(); if (st.phase === "start" && !optsOpen) showStart(); } },
      wordSettings: () => Object.assign({}, WD, { game_mode: mode, learn_shows: MS.learn_shows, learn_relearn_shows: MS.learn_relearn_shows, learned_after: MS.learned_after }),
      mode: () => mode,
      setMode: m => { setMode(m); if (st.phase === "start") showStart(); },
      showAnswers: on => { if (on !== undefined) { showAll = !!on; saveSet("show_answers", showAll); } return showAll; },
      save: () => SAVE.get(),
      saveEngine: () => SAVE.engine(),
      questionOpen: () => !!qOpen,
      // the word card is up (it takes the 1-4 keys)
      cardOpen: () => !!cq && cardEl.classList.contains("show"),
      // the lesson's word pack (words.json): { lesson, title, words: [...] }
      setPack: d => { pack = d && Array.isArray(d.words) ? d : null; syncLevel(); },
      progress: () => showProgress(),
      myWords: () => showWords(),
      share: k => shareCard(k || "run"),
      voice: () => VOICE.stats(),
      card: () => cq ? { id: cq.id, dir: cq.dir, kind: cq.kind, step: cq.step, state: cState, choices: (cq.choices || []).map(c => c.id) } : null,
      learn: LE,
      wordMode: () => wordMode,
      setWordMode: m => setWordMode(m),
      options: on => on === false ? closeOptions() : showOptions(),
      // a gem is picked: Esc / a click on empty ground lets go of it
      hasPick: () => !!picked,
      ladder: () => JSON.parse(JSON.stringify(ladder)),
      sfx: SFX,
      deselect: () => deselect(),
      // a word result from the host (pop quizzes), for learning mode: "right" | "wrong" | "missed"
      noteWord: (w, what) => logWord(w, what),
      runWords: () => JSON.parse(JSON.stringify(runWords)),
      learnState: () => learn ? { mode: learn.mode, i: learn.i, queue: learn.queue.length, done: learn.done, right: learn.right, total: learn.list.length } : null,
      startLearn: () => startLearn(),
      bonusWaiting: () => bonusWaiting(),
      savedRun: () => savedRun(),
      continueRun: () => continueRun(),
      gems: () => gems.map(g => ({ id: g.word.id, side: g.side, x: g.x, y: g.y, w: g.w, h: g.h, mt: !!g.mt, decoy: !!g.decoy })),
      setSlow: on => setSlow(on),
      showQuestion: q => showQuestion(q),
      rescue: () => { rescueAt = -1e9; maybeRescue(); },
      sendTelemetry: () => sendTel(),
      destroy() {
        clearInterval(secTimer); clearInterval(studyTimer); flushStudy(); clearInterval(telTimer); sendTel(true); if (ro) ro.disconnect();
        window.removeEventListener("pagehide", onUnload);
        window.removeEventListener("inaflash:reward", onReward);
        document.removeEventListener("visibilitychange", onVis);
        game.destroy(true); el.innerHTML = "";
      },
    };
  }

  window.FlashGame = { mount };
})();
