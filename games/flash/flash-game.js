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
                 "passives", "rarities", "mega_waves", "icons"];
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
    if (!document.querySelector('link[data-ftc]')) {
      const l = document.createElement("link"); l.rel = "stylesheet"; l.href = base + "flash-game.css"; l.dataset.ftc = "1"; document.head.append(l);
    }
    const data = {};
    await Promise.all(TYPES.map(async t => { data[t] = await loadJSON(base + (opts.dataPath || "data/") + t + ".json"); }));
    await Promise.all(SHARED.map(async t => { data["shared_" + t] = await loadJSON(base + (opts.sharedPath || "shared/") + t + ".json"); }));

    // The arena is always 1000 units tall; its width follows the column's shape,
    // so a wider column shows more arena instead of black bars.
    const fitW = () => { const w = el.clientWidth, hh = el.clientHeight;
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
    const offerIcon = o => o.kind === "weapon" ? icon("weapons", o.id, "🗡️")
      : o.kind === "wup" ? icon("upgrades", o.id, "⬆️") : o.kind === "item" ? icon("items", o.id, "🎒")
      : o.kind === "passive" ? icon("passives", o.id, "✨") : o.kind === "tail" ? "🐈" : icon("upgrades", o.id, "⬆️");
    const prefs = (() => { try { return JSON.parse(localStorage.getItem("ftc.prefs") || "{}"); } catch (e) { return {}; } })();
    const savePrefs = () => { try { localStorage.setItem("ftc.prefs", JSON.stringify(prefs)); } catch (e) {} };

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
      ["word_gems", "Word gems", "Thai / English word pairs to match in the arena (pairs spawned per second)", "event", true],
    ];
    const ANIM_DEF = {}; for (const a of ANIMS) ANIM_DEF[a[0]] = a[4];
    prefs.anim = prefs.anim || {};
    if (prefs.numbers === false) prefs.anim.damage_numbers = false;     // older settings
    if (prefs.shake === false) prefs.anim.screen_shake = false;
    const A = id => { const v = prefs.anim[id]; return v === undefined ? ANIM_DEF[id] : !!v; };
    const usedSec = {}, usedFrame = {}, lastSec = {};
    const use = (id, n) => { usedSec[id] = (usedSec[id] || 0) + (n || 1); };
    const useF = (id, n) => { usedFrame[id] = (usedFrame[id] || 0) + (n || 1); };
    const secTimer = setInterval(() => { for (const k of Object.keys(lastSec)) lastSec[k] = 0; Object.assign(lastSec, usedSec); for (const k in usedSec) usedSec[k] = 0; }, 1000);

    // ------------------------------------------------------------- DOM
    el.innerHTML = "";
    const root = h("div", "ftc"), canvasBox = h("div", "ftc-canvas"), hud = h("div", "ftc-hud"), overlay = h("div", "ftc-overlay");
    const top = h("div", "ftc-top"), stageEl = h("span"), timerEl = h("span", "ftc-timer"), goldEl = h("span");
    const pauseBtn = h("button", "ftc-btn", "⏸"); pauseBtn.title = "Pause";
    top.append(stageEl, timerEl, goldEl, pauseBtn);
    const bars = h("div", "ftc-bars"), hpBar = h("div", "ftc-bar hp", "<i></i><span></span>"), xpBar = h("div", "ftc-bar xp", "<i></i><span></span>");
    bars.append(hpBar, xpBar);
    const waveBar = h("div", "ftc-bar wave", "<i></i><span></span>"); waveBar.style.display = "none"; bars.append(waveBar);
    const buffsEl = h("div", "ftc-buffs"), warnEl = h("div", "ftc-warn"), floatEl = h("div", "ftc-float"), bottom = h("div", "ftc-bottom");
    const bannerEl = h("div", "ftc-banner"), comboEl = h("div", "ftc-combo");
    const vignette = h("div", "ftc-vignette"), dangerEl = h("div", "ftc-danger", "❤️ Flash is in trouble! Answer a quiz to heal him");
    hud.append(top, bars, buffsEl, warnEl, bottom);
    root.append(canvasBox, vignette, hud, floatEl, comboEl, bannerEl, dangerEl, overlay);
    let bannerT = null, lastWave = null;
    function banner(text, sub) {
      bannerEl.innerHTML = `<b>${esc(text)}</b>${sub ? `<small>${esc(sub)}</small>` : ""}`;
      bannerEl.classList.remove("show"); void bannerEl.offsetWidth; bannerEl.classList.add("show");
      clearTimeout(bannerT); bannerT = setTimeout(() => bannerEl.classList.remove("show"), 2600);
    }
    el.append(root);

    // ----------------------------------------------------------- Phaser
    let scene = null;
    const pools = { enemies: [], rings: [], proj: [], eproj: [], blades: [], parts: [], bones: [], texts: [] };
    let kick = 0;
    const fx = [];           // {kind, x, y, r, life, max, colour}
    let acc = 0, speed = 1, lastUi = 0, slowF = 1, slowTo = 1;
    const perf = { sim: 0, draw: 0 };

    const env = (data.shared_environments || []).find(e => e.id === "dungeon");
    const pal = (env && env.palette) || ["#2a2a33", "#4a4a58", "#c48a3a"];
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
      g.destroy();
    }
    const grab = (arr, factory) => { for (const o of arr) if (!o.visible) { o.setVisible(true); return o; } const o = factory(); arr.push(o); return o; };

    function sceneCreate() {
      scene = this;
      makeTextures(this);
      this.add.image(0, 0, "ftc-floor").setOrigin(0);
      this.aura = this.add.graphics();
      this.flash = this.add.image(st.W / 2, FlashSim.H / 2, "ftc-flash").setDepth(5);
      this.swings = this.add.graphics().setDepth(6);
      this.game.loop.targetFps = 60;
    }

    function handleEvents(events) {
      let texts = 0, deaths = 0;
      for (const e of events) {
        if (e.t === "hit") {
          if (A("damage_numbers") && texts < (st.wave ? 3 : 6) && (e.crit || events.length < 60)) { texts++; use("damage_numbers"); spawnText(e.x, e.y - 10, String(e.v), e.crit ? "#ffd23a" : "#ffffff", e.crit ? 18 : 13); }
          if (A("hit_sparks") && fx.length < 400) { use("hit_sparks"); fx.push({ k: "spark", x: e.x, y: e.y, r: 3, life: 0.15, max: 0.15, c: C.impact }); }
        } else if (e.t === "death") {
          deaths++;
          if (deaths < 30 && !e.quiet && A("death_particles")) { use("death_particles"); for (let i = 0; i < 3; i++) burst(e.x, e.y, e.colour || C.death, 120); }
          if (A("bone_shards") && deaths < 120) { use("bone_shards"); boneShard(e.x, e.y); if (deaths < 30) boneShard(e.x, e.y); }
        } else if (e.t === "pop") {
          if (A("chain_pops") && fx.length < 450) { use("chain_pops"); fx.push({ k: "ring", x: e.x, y: e.y, r: e.r, life: 0.22, max: 0.22, c: 0xffe6a0 }); }
        } else if (e.t === "fire") {
          if (A("flash_squash")) { kick = 0.08; use("flash_squash"); }
        } else if (e.t === "mega_start") {
          if (A("banners")) { use("banners"); banner(e.banner || `${e.name}!`, `${e.total.toLocaleString()} skeletons · mow them down!`); }
          if (scene && A("screen_shake")) { use("screen_shake"); scene.cameras.main.shake(300, 0.006); }
        } else if (e.t === "mega_end") {
          lastWave = e;          // shown at the top of the break screen instead of a banner
        } else if (e.t === "explode") {
          if (A("explosion_rings")) { use("explosion_rings");
            fx.push({ k: "ring", x: e.x, y: e.y, r: e.r, life: 0.35, max: 0.35, c: e.enemy ? 0xff5a5a : C.explosion });
            for (let i = 0; i < 6; i++) burst(e.x, e.y, C.explosion, 200); }
        } else if (e.t === "swing") {
          if (A("swing_arcs")) { use("swing_arcs"); fx.push({ k: "arc", x: e.x, y: e.y, a: e.a, r: e.r, life: 0.16, max: 0.16, c: 0xffffff }); }
        } else if (e.t === "stab") {
          if (A("hit_sparks")) { use("hit_sparks"); fx.push({ k: "spark", x: e.x, y: e.y, r: 7, life: 0.12, max: 0.12, c: 0xffffff }); }
        } else if (e.t === "hurt") {
          if (scene && A("screen_shake")) { use("screen_shake"); scene.cameras.main.shake(70, 0.0025); }
          if (A("flash_hurt")) use("flash_hurt");
        } else if (e.t === "levelup") {
          if (A("level_up_ring")) { use("level_up_ring"); floatText(`LEVEL ${e.level}!`); fx.push({ k: "ring", x: st.flash.x, y: st.flash.y, r: 90, life: 0.5, max: 0.5, c: 0x7cc4ff }); }
        } else if (e.t === "reward") {
          if (A("reward_fx")) { use("reward_fx"); floatText(e.text, e.bad);
            if (!e.bad) fx.push({ k: "ring", x: st.flash.x, y: st.flash.y, r: 60, life: 0.6, max: 0.6, c: C.healing }); }
        } else if (e.t === "danger") {
          announce(e.on ? "danger" : "safe");       // the site can use this to nudge the learner towards a quiz
          if (e.on) maybeRescue();
          if (e.on && A("danger_alarm")) use("danger_alarm");
        } else if (e.t === "rush") {
          if (A("banners")) { use("banners"); banner("The last ones charge!", ""); }
        } else if (e.t === "round_end") { closeQuestion(); showBreak(); announce("round_end"); sendTel(); }
        else if (e.t === "over") { clearGems(); closeQuestion(); showOver(); announce("died"); sendTel(); }
        else if (e.t === "start" || e.t === "round_start") {
          if (e.t === "start") { clearGems(); rescueChain = 0; }
          hideOverlay(); announce(e.t === "start" ? "started" : "round_start");
          if (e.t === "round_start" && A("banners")) { use("banners"); banner(`Round ${e.round}`, ""); }
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
    function spawnText(x, y, text, colour, size) {
      if (!scene) return;
      const t = grab(pools.texts, () => scene.add.text(0, 0, "", { fontFamily: "Segoe UI, sans-serif", fontStyle: "bold", stroke: "#000", strokeThickness: 3 }).setDepth(20).setOrigin(0.5));
      t.setText(text).setPosition(x, y).setColor(colour).setFontSize(size).setAlpha(1);
      t.life = 0.6;
    }
    function floatText(text, bad) {
      const d = h("div", bad ? "bad" : "", esc(text)); floatEl.append(d); setTimeout(() => d.remove(), 1600);
    }

    function draw(dt) {
      const s = scene; if (!s) return;
      const W2 = st.flash ? st.flash.x : st.W / 2, H2 = st.flash ? st.flash.y : FlashSim.H / 2;
      // Flash
      for (const k in usedFrame) usedFrame[k] = 0;
      s.flash.setTint(A("flash_hurt") && st.flash && st.flash.hurtT > 0 ? 0xff7a7a : 0xffffff).setVisible(st.phase !== "start");
      kick = Math.max(0, kick - dt);
      const bob = A("flash_bob") ? Math.sin(performance.now() / 300) * 0.03 : 0;
      if (bob) useF("flash_bob");
      const f0 = st.flash, lean = A("flash_lean") && f0 ? f0.vx / 400 : 0;
      if (lean) useF("flash_lean");
      s.flash.setPosition(W2, H2).setRotation(lean)
        .setScale((1 + bob + kick * 1.2) * (A("flash_lean") && f0 && f0.face < 0 ? -1 : 1), 1 + bob - kick * 1.5);
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
      const lunge = A("lunge"), waddle = A("waddle"), hitFlash = A("hit_flash"), elitePulse = A("elite_pulse");
      let i = 0, ri = 0, nL = 0, nW = 0, nH = 0, nE = 0;
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
        sp.setVisible(true);
        if (e.hitT > 0 && hitFlash) { sp.setTintFill(0xffffff); nH++; } else sp.setTint(e.colour);
        if (e.elite) {      // rings only for elites, not one per skeleton
          const rg = pools.rings[ri] || (pools.rings[ri] = s.add.image(0, 0, "ftc-ring").setDepth(2)); ri++;
          rg.setVisible(true).setPosition(e.x, e.y).setScale(e.size * (elitePulse ? 0.95 + Math.sin(ph * 0.5) * 0.06 : 1));
          if (elitePulse) nE++;
        }
      }
      for (; i < pools.enemies.length; i++) pools.enemies[i].setVisible(false);
      for (; ri < pools.rings.length; ri++) pools.rings[ri].setVisible(false);
      useF("lunge", nL); useF("waddle", nW); useF("hit_flash", nH); useF("elite_pulse", nE);
      // projectiles
      i = 0;
      for (const p of st.proj) {
        const sp = pools.proj[i] || (pools.proj[i] = s.add.image(0, 0, "ftc-bolt").setDepth(4));
        const c = PROJ_COLOUR[p.b] || 0xffe08a;
        const spin = A("projectile_spin") && (p.b === "returning_projectile" || p.b === "bouncing_projectile");
        if (spin) useF("projectile_spin");
        sp.setVisible(true).setPosition(p.x, p.y).setTint(c)
          .setRotation(spin ? performance.now() / 60 : Math.atan2(p.vy, p.vx))
          .setScale(p.b === "explosive_projectile" ? 1.3 : 1, p.b === "explosive_projectile" ? 3 : spin ? 2 : 1);
        i++;
      }
      for (; i < pools.proj.length; i++) pools.proj[i].setVisible(false);
      i = 0;
      for (const p of st.eproj) {
        const sp = pools.eproj[i] || (pools.eproj[i] = s.add.image(0, 0, "ftc-dot").setDepth(4));
        sp.setVisible(true).setPosition(p.x, p.y).setTint(0xff6a5a).setScale(0.9); i++;
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
      s.swings.clear();
      let pi = 0, bi = 0;
      for (let k = fx.length - 1; k >= 0; k--) {
        const f = fx[k]; f.life -= dt;
        if (f.life <= 0) { fx.splice(k, 1); continue; }
        const a = f.life / f.max;
        if (f.k === "ring") { s.swings.lineStyle(3, f.c, a); s.swings.strokeCircle(f.x, f.y, f.r * (1.15 - a * 0.6)); }
        else if (f.k === "arc") { s.swings.lineStyle(5, f.c, a * 0.8); s.swings.beginPath(); s.swings.arc(f.x, f.y, f.r * 0.8, f.a - 1.1, f.a + 1.1); s.swings.strokePath(); }
        else if (f.k === "spark") { s.swings.fillStyle(f.c, a); s.swings.fillCircle(f.x, f.y, f.r * (1.5 - a * 0.5)); }
        else if (f.k === "bone") {
          f.x += f.vx * dt; f.y += f.vy * dt; f.vy += 420 * dt; f.vx *= 0.97; f.rot += f.vr * dt;
          const sp = pools.bones[bi] || (pools.bones[bi] = s.add.image(0, 0, "ftc-bone").setDepth(7));
          sp.setVisible(true).setPosition(f.x, f.y).setRotation(f.rot).setTint(f.c).setAlpha(Math.min(1, a * 1.6)); bi++;
        }
        else if (f.k === "part") {
          f.x += f.vx * dt; f.y += f.vy * dt; f.vx *= 0.92; f.vy *= 0.92;
          const sp = pools.parts[pi] || (pools.parts[pi] = s.add.image(0, 0, "ftc-dot").setDepth(7));
          sp.setVisible(true).setPosition(f.x, f.y).setTint(f.c).setAlpha(a).setScale(f.r / 5); pi++;
        }
      }
      for (; pi < pools.parts.length; pi++) pools.parts[pi].setVisible(false);
      for (; bi < pools.bones.length; bi++) pools.bones[bi].setVisible(false);
      for (const t of pools.texts) if (t.visible) { t.life -= dt; t.y -= 40 * dt; t.setAlpha(Math.max(0, t.life / 0.6)); if (t.life <= 0) t.setVisible(false); }
    }

    function sceneUpdate(time, delta) {
      const dt = Math.min(delta / 1000, 0.1);
      slowF += (slowTo - slowF) * Math.min(1, dt * 5);
      acc += dt * speed * slowF;
      let steps = 0;
      const t0 = performance.now();
      while (acc >= 1 / 60 && steps < 8 * speed) { sim.step(1 / 60); acc -= 1 / 60; steps++; }
      if (steps >= 8 * speed) acc = 0;
      const t1 = performance.now();
      handleEvents(sim.drain());
      draw(dt);
      updateGems(dt);
      const t2 = performance.now();
      perf.sim = perf.sim * 0.9 + (t1 - t0) * 0.1; perf.draw = perf.draw * 0.9 + (t2 - t1) * 0.1;
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
    // Tuned in Game settings > words.
    const WD = Object.assign({ enabled: true, max_pairs: 3, first_after: 4, spawn_every: 10, life: 45, speed: 16,
                               slow_motion: 0.35, rescue_chain: 3, rescue_cooldown: 25 },
                             ((sim.D.settings || {}).words || {}).values || {});
    let words = [], gems = [], gemAcc = WD.spawn_every - WD.first_after, picked = null, sayEl = null, matchRun = 0;
    const GEM_FONT = '"Noto Sans Thai", "Leelawadee UI", "Tahoma", "Segoe UI", sans-serif';
    function say(url) {
      if (!url) return;
      try { if (!sayEl) sayEl = new Audio(); sayEl.src = url; sayEl.currentTime = 0; const p = sayEl.play(); if (p && p.catch) p.catch(() => {}); } catch (e) {}
    }
    function pickWord() {
      const live = new Set(gems.map(g => g.word.id));
      const pool = words.filter(w => !live.has(w.id) && w.th && w.en);
      if (!pool.length) return null;
      let sum = 0; for (const w of pool) sum += w.weight || 1;
      let r = Math.random() * sum;
      for (const w of pool) { r -= w.weight || 1; if (r <= 0) return w; }
      return pool[pool.length - 1];
    }
    // "plate, dish, classifier for plates; a course" -> "plate, dish"
    const short = (t, max = 22) => {
      t = String(t || "").split(/;|\s\/\s/)[0].replace(/\s*[\[(][^\])]*[\])]/g, "").trim();
      const ps = t.split(/,\s*/); let out = ps[0] || t;
      for (let i = 1; i < ps.length && i < 3; i++) { if ((out + ", " + ps[i]).length > max) break; out += ", " + ps[i]; }
      return out.length > max + 6 ? out.slice(0, max + 5) + "…" : out;
    };
    function makeGem(word, side) {
      const s = scene;
      const c = s.add.container(0, 0).setDepth(40);
      const parts = side === "th"
        ? [s.add.text(0, word.rom ? -9 : 0, word.th, { fontFamily: GEM_FONT, fontSize: "30px", color: "#fff7e0" }).setOrigin(0.5)]
            .concat(word.rom ? [s.add.text(0, 19, word.rom, { fontFamily: "Segoe UI, system-ui, sans-serif", fontSize: "15px", color: "#ffd27a" }).setOrigin(0.5)] : [])
        : [s.add.text(0, 0, short(word.en), { fontFamily: "Segoe UI, system-ui, sans-serif", fontSize: "19px", fontStyle: "bold",
                                               color: "#e6f3ff", align: "center", wordWrap: { width: 190 } }).setOrigin(0.5)];
      const w = Math.max(...parts.map(t => t.width)) + 30, hh = side === "th" ? (word.rom ? 70 : 50) : parts[0].height + 24;
      const bg = s.add.graphics();
      const g = { word, side, c, bg, w, h: hh, x: 0, y: 0, vx: 0, vy: 0, age: 0, life: WD.life, shake: 0 };
      g.paint = sel => {
        bg.clear();
        bg.fillStyle(side === "th" ? 0x3b2560 : 0x123a4c, 0.93).fillRoundedRect(-w / 2, -hh / 2, w, hh, 14);
        bg.lineStyle(sel ? 4 : 2, sel ? 0xffd23a : (side === "th" ? 0xb98cff : 0x6cc8ff), 1).strokeRoundedRect(-w / 2, -hh / 2, w, hh, 14);
      };
      g.paint(false);
      c.add([bg, ...parts]);
      c.setSize(w, hh).setInteractive({ useHandCursor: true });
      c.on("pointerdown", () => clickGem(g));
      return g;
    }
    function placeGem(g) {
      const x0 = 30 + g.w / 2, x1 = st.W - 30 - g.w / 2, y0 = 150 + g.h / 2, y1 = FlashSim.H - 110 - g.h / 2;
      let best = null, bestD = -1;
      for (let i = 0; i < 12; i++) {
        const x = x0 + Math.random() * Math.max(1, x1 - x0), y = y0 + Math.random() * Math.max(1, y1 - y0);
        let d = 1e9;
        for (const o of gems) d = Math.min(d, Math.hypot(o.x - x, o.y - y));
        if (st.flash) d = Math.min(d, Math.hypot(st.flash.x - x, st.flash.y - y) * 1.5);
        if (d > bestD) { bestD = d; best = { x, y }; }
      }
      const a = Math.random() * 6.283, sp = WD.speed * (0.6 + Math.random() * 0.8);
      Object.assign(g, best, { vx: Math.cos(a) * sp, vy: Math.sin(a) * sp });
      g.c.setPosition(g.x, g.y).setAlpha(0).setScale(0.6);
    }
    function spawnPair() {
      const w = pickWord(); if (!w || !scene) return false;
      for (const side of ["th", "en"]) { const g = makeGem(w, side); placeGem(g); gems.push(g); }
      use("word_gems");
      return true;
    }
    function dropGem(g) { try { g.c.destroy(); } catch (e) {} gems = gems.filter(x => x !== g); if (picked === g) picked = null; }
    function clearGems() { for (const g of gems.slice()) dropGem(g); picked = null; gemAcc = WD.spawn_every - WD.first_after; }
    function clickGem(g) {
      if (st.phase !== "fight" || st.paused) return;
      if (g.side === "th") say(g.word.audio);
      if (!picked) { picked = g; g.paint(true); return; }
      if (picked === g) { g.paint(false); picked = null; return; }
      if (picked.side === g.side) { picked.paint(false); picked = g; g.paint(true); return; }
      const a = picked; picked = null; a.paint(false);
      if (a.word.id === g.word.id) {
        matchRun++;
        for (const x of [a, g]) for (let i = 0; i < 14; i++) burst(x.x, x.y, x.side === "th" ? 0xc58aff : 0x6cc8ff, 260);
        floatText(`${a.word.th} = ${short(a.word.en)}${matchRun >= 3 ? `  ×${matchRun}!` : ""}`);
        sim.applyReward({ v: 1, kind: "reward", source: "match", strength: 1, streak: matchRun, word: a.word.th });
        dropGem(a); dropGem(g);
        if (opts.onWord) try { opts.onWord({ result: "match", id: a.word.id }); } catch (e) {}
      } else {
        matchRun = 0;
        a.shake = g.shake = 0.4;
        sim.noteStudy("mismatch");
        const th = a.side === "th" ? a : g;
        if (opts.onWord) try { opts.onWord({ result: "miss", id: th.word.id, other: (th === a ? g : a).word.id }); } catch (e) {}
      }
    }
    function updateGems(dt) {
      if (!WD.enabled || !scene) return;
      if (!A("word_gems")) { if (gems.length) clearGems(); return; }
      const live = st.phase === "fight" && !st.paused;
      for (const g of gems) g.c.setVisible(st.phase === "fight");
      if (!live) return;
      gemAcc += dt;
      if (words.length && gemAcc >= WD.spawn_every && gems.length / 2 < WD.max_pairs) { if (spawnPair()) gemAcc = 0; }
      for (const g of gems.slice()) {
        g.age += dt;
        const x0 = 30 + g.w / 2, x1 = st.W - 30 - g.w / 2, y0 = 150 + g.h / 2, y1 = FlashSim.H - 110 - g.h / 2;
        g.x += g.vx * dt; g.y += g.vy * dt;
        if (g.x < x0 || g.x > x1) { g.vx = -g.vx; g.x = Math.max(x0, Math.min(x1, g.x)); }
        if (g.y < y0 || g.y > y1) { g.vy = -g.vy; g.y = Math.max(y0, Math.min(y1, g.y)); }
        const sx = g.shake > 0 ? Math.sin(g.age * 60) * 7 * (g.shake / 0.4) : 0;
        g.shake = Math.max(0, g.shake - dt);
        const fadeIn = Math.min(1, g.age / 0.5), fadeOut = Math.min(1, (g.life - g.age) / 4);
        g.c.setPosition(g.x + sx, g.y + Math.sin(g.age * 1.7) * 3).setAlpha(Math.max(0, Math.min(fadeIn, fadeOut))).setScale(0.6 + 0.4 * fadeIn);
        if (g.age >= g.life) {
          // a pair leaves together
          const mate = gems.find(o => o !== g && o.word.id === g.word.id);
          dropGem(g); if (mate) dropGem(mate);
        }
      }
    }

    // --------------------------------------------- questions in the column
    // "Save Flash!": when he's in danger the game asks the host (the Thai
    // site) for a question about words the learner has seen, and shows it
    // here, in slow motion. Right = a big heal (and maybe another question);
    // wrong just shows the answer. opts.askQuestion(kind) -> Promise<question>
    //   question: { id, prompt: "th"|"en", th, rom, en, audio, options: [{ id, label, sub, audio }], right, can_quiz }
    const qEl = h("div", "ftc-q"); root.append(qEl);
    let qOpen = null, rescueChain = 0, rescueAt = -1e9;
    function setSlow(on) { slowTo = on ? Math.max(0.1, Math.min(1, +WD.slow_motion || 0.35)) : 1; root.classList.toggle("ftc-slowmo", !!on); }
    function closeQuestion() { if (!qOpen) return; qOpen = null; qEl.classList.remove("show"); qEl.innerHTML = ""; setSlow(false); }
    async function maybeRescue() {
      if (!opts.askQuestion || qOpen || st.phase !== "fight" || st.god) return;
      if (performance.now() - rescueAt < WD.rescue_cooldown * 1000) return;
      rescueAt = performance.now();
      rescueChain = 0;
      ask();
    }
    async function ask() {
      let q = null;
      try { q = await opts.askQuestion("rescue"); } catch (e) { q = null; }
      if (!q || !q.options || q.options.length < 2 || st.phase !== "fight") return;
      showQuestion(q);
    }
    function showQuestion(q) {
      qOpen = q; setSlow(true);
      const head = rescueChain ? `❤️ Again! Keep Flash going (${rescueChain + 1}/${WD.rescue_chain})` : "❤️ Save Flash! He needs the power of the quiz";
      const prompt = q.prompt === "th"
        ? `<div class="ftc-q-th" lang="th">${esc(q.th)}</div>${q.rom ? `<div class="ftc-q-rom">${esc(q.rom)}</div>` : ""}<div class="ftc-q-ask">means…?</div>`
        : `<div class="ftc-q-en">${esc(q.en)}</div><div class="ftc-q-ask">in Thai is…?</div>`;
      qEl.innerHTML = `<div class="ftc-q-card"><button class="ftc-q-x" title="Close">✕</button><div class="ftc-q-head">${head}</div>${prompt}
        <div class="ftc-q-opts"></div><div class="ftc-q-foot"></div></div>`;
      const box = qEl.querySelector(".ftc-q-opts");
      q.options.forEach(o => {
        const b = h("button", "ftc-q-opt", o.sub ? `<span lang="th">${esc(o.label)}</span><small>${esc(o.sub)}</small>` : esc(o.label));
        b.onclick = () => answer(q, o, b);
        box.append(b);
      });
      if (q.prompt === "th" && q.audio) { say(q.audio); const sp = h("button", "ftc-q-say", "🔊"); sp.onclick = () => say(q.audio); qEl.querySelector(".ftc-q-th").append(sp); }
      const foot = qEl.querySelector(".ftc-q-foot");
      if (opts.goQuiz && q.can_quiz) { const gq = h("button", "ftc-btn", "❓ Go to quiz mode"); gq.onclick = () => { closeQuestion(); opts.goQuiz(); }; foot.append(gq); }
      qEl.querySelector(".ftc-q-x").onclick = () => { if (opts.onAnswer) try { opts.onAnswer(q, null); } catch (e) {} sim.noteStudy("rescue_closed"); closeQuestion(); };
      qEl.classList.add("show");
    }
    function answer(q, o, btn) {
      if (qOpen !== q) return;
      const right = o.id === q.right;
      qEl.querySelectorAll(".ftc-q-opt").forEach((b, i) => { b.disabled = true; if (q.options[i].id === q.right) b.classList.add("ok"); });
      if (!right) btn.classList.add("no");
      if (o.audio) say(o.audio);
      if (opts.onAnswer) try { opts.onAnswer(q, right); } catch (e) {}
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
    if (ro) ro.observe(el);

    // -------------------------------------------------------------- HUD
    function updateHud() {
      const f = st.flash;
      stageEl.textContent = st.phase === "start" ? "" : `Round ${st.round} · Stage ${st.stage}`;
      const wv = st.wave;
      timerEl.textContent = st.phase !== "fight" ? "" : wv ? `💀 ${(wv.total - wv.killed).toLocaleString()} left` : fmtT(Math.max(0, sim.S.roundLen - st.roundT));
      waveBar.style.display = wv ? "" : "none";
      if (wv) { waveBar.querySelector("i").style.width = `${wv.killed / wv.total * 100}%`;
                waveBar.querySelector("span").textContent = `${wv.row.name} · ${wv.killed.toLocaleString()} / ${wv.total.toLocaleString()}`; }
      const hpFrac = f ? Math.max(0, f.hp / f.maxHp()) : 1;
      const alarm = A("danger_alarm") && st.phase === "fight" && !st.god;
      vignette.style.opacity = alarm && hpFrac < 0.5 ? String(Math.min(1, (0.5 - hpFrac) * 2.4)) : "0";
      vignette.classList.toggle("pulse", alarm && hpFrac < 0.3);
      dangerEl.classList.toggle("show", alarm && st.danger);
      if (st.combo >= 25 && st.phase === "fight" && A("combo_meter")) {
        use("combo_meter");
        comboEl.innerHTML = `<b>×${st.combo.toLocaleString()}</b><small>combo</small>`;
        comboEl.classList.add("show");
        comboEl.style.fontSize = `${Math.min(34, 16 + Math.log10(st.combo) * 6)}px`;
      } else comboEl.classList.remove("show");
      goldEl.textContent = st.phase === "start" ? "" : `💰 ${st.gold}`;
      pauseBtn.style.visibility = st.phase === "fight" ? "visible" : "hidden";
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
        parts.push(w ? `<span class="ftc-slot${i >= sim.S.slots ? " tail" : ""}" title="${esc(w.def.name)}"><span class="ftc-ico">${icon("weapons", w.id, "🗡️")}</span> ${esc(w.def.name)} <b>${w.level}</b></span>`
                     : `<span class="ftc-slot empty${i >= sim.S.slots ? " tail" : ""}">${i >= sim.S.slots ? "tail" : "empty"}</span>`);
      }
      if (!st.tail) parts.push(`<span class="ftc-slot empty tail">🔒 tail</span>`);
      bottom.innerHTML = st.phase === "start" ? "" : parts.join("");
    }

    // ---------------------------------------------------------- screens
    function hideOverlay() { overlay.classList.remove("show"); overlay.innerHTML = ""; }
    function card(o, onClick) {
      const c = h("div", "ftc-card");
      c.style.borderColor = rarityColour(o.rarity);
      c.innerHTML = `${o.icon ? `<span class="ftc-cardico">${o.icon}</span>` : ""}<span class="ftc-tag" style="color:${rarityColour(o.rarity)}">${esc(o.tag || o.rarity || "")}</span>
        <div class="ftc-name">${esc(o.name)}</div><div class="ftc-desc">${esc(o.desc || "")}</div>${o.stats ? `<div class="ftc-stats">${esc(o.stats)}</div>` : ""}`;
      c.onclick = onClick;
      return c;
    }
    function showStart() {
      overlay.innerHTML = "";
      overlay.append(h("h2", "", "🐈 Flash the Cat"), h("p", "", "Pick a starting weapon. Study to keep Flash alive!"));
      const cards = h("div", "ftc-cards");
      for (const w of sim.startingWeapons())
        cards.append(card({ icon: icon("weapons", w.id, "🗡️"), name: w.name, desc: w.description, rarity: w.rarity, tag: w.behaviour.replace(/_/g, " "),
          stats: `${w.damage} dmg · ${w.cooldown}s · range ${w.range}` }, () => { sim.startRun(w.id); }));
      overlay.append(cards);
      overlay.classList.add("show");
    }
    function showBreak() {
      overlay.innerHTML = "";
      bannerEl.classList.remove("show");
      if (lastWave) overlay.append(h("h2", "ftc-wavewin", `💀 ${esc(lastWave.name)} cleared!`),
        h("p", "", `${lastWave.total.toLocaleString()} skeletons in ${Math.round(lastWave.time)}s · best combo ×${st.comboMax.toLocaleString()}`));
      else overlay.append(h("h2", "", `Round ${st.round} cleared!`));
      overlay.append(h("p", "", `${st.kills.toLocaleString()} skeletons · Level ${st.level} · 💰 ${st.gold}`));
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
        const go = h("button", "ftc-btn big", `Start round ${st.round + 1}`); go.onclick = () => { lastWave = null; sim.nextRound(); };
        overlay.append(go);
      }
      const auto = h("label", "ftc-small", `<input type="checkbox" ${prefs.auto ? "checked" : ""}> Auto-pick & continue (for when you're busy studying)`);
      auto.querySelector("input").onchange = e => { prefs.auto = e.target.checked; savePrefs(); if (prefs.auto) autoBreak(); };
      overlay.append(auto);
      overlay.classList.add("show");
      if (prefs.auto) autoBreak();
    }
    let autoTimer = null;
    function autoBreak() {
      clearTimeout(autoTimer);
      autoTimer = setTimeout(() => {
        if (st.phase !== "break" || !prefs.auto) return;
        if (st.offer) { sim.choose(Math.floor(Math.random() * st.offer.length)); showBreak(); }
        else { lastWave = null; sim.nextRound(); }
      }, 1500);
    }
    function showOver() {
      const r = st.runStats || {};
      overlay.innerHTML = "";
      overlay.append(h("h2", "", "Flash fell! 💀"),
        h("div", "ftc-statgrid", `<span>Round</span><b>${r.round}</b><span>Stage</span><b>${r.stage}</b><span>Level</span><b>${r.level}</b>
          <span>Skeletons</span><b>${r.kills}</b><span>Gold</span><b>${r.gold}</b><span>Time</span><b>${fmtT(r.time || 0)}</b>
          <span>Damage</span><b>${(r.damage || 0).toLocaleString()}</b><span>Best combo</span><b>×${(r.comboMax || 0).toLocaleString()}</b>
          <span>Mega waves</span><b>${r.waves || 0}</b>`),
        h("p", "ftc-small", esc((r.weapons || []).join(" · "))));
      const again = h("button", "ftc-btn big", "Play again"); again.onclick = showStart;
      overlay.append(again);
      overlay.classList.add("show");
    }
    function showPaused() {
      overlay.innerHTML = "";
      overlay.append(h("h2", "", "Paused"), h("p", "", "Study rewards still count while paused."));
      const go = h("button", "ftc-btn big", "Resume"); go.onclick = () => togglePause(false);
      overlay.append(go); overlay.classList.add("show");
    }
    function togglePause(on) {
      if (st.phase !== "fight") return;
      sim.pause(on);
      if (st.paused) { showPaused(); announce("paused"); } else { hideOverlay(); announce("resumed"); }
      updateHud();
    }
    pauseBtn.onclick = () => togglePause();

    // ------------------------------------------------------------ rewards
    const onReward = e => { if (st.phase === "fight" || st.phase === "break") sim.applyReward(e.detail || {}); };
    window.addEventListener("inaflash:reward", onReward);
    // pause when the tab is hidden, so the flashcards never fight the game for the CPU
    const onVis = () => { if (document.hidden && st.phase === "fight" && !st.paused) togglePause(true); };
    document.addEventListener("visibilitychange", onVis);

    const telTimer = setInterval(() => { if (st.phase === "fight" && !st.paused && Date.now() - telSent > 20000) sendTel(); }, 5000);

    showStart();
    updateHud();
    announce("ready");

    return {
      sim, game,
      reward: d => onReward({ detail: d }),
      pause: on => togglePause(on),
      setSpeed: n => { speed = Math.max(0.25, Math.min(8, n)); },
      spawn: (n, elite) => sim.spawn(n, elite),
      megaWave: n => sim.megaWave(n),
      stats: () => ({ fps: game.loop.actualFps, enemies: st.enemies.length, projectiles: st.proj.length + st.eproj.length, fx: fx.length,
                      simMs: perf.sim, drawMs: perf.draw, intensity: st.intensity,
                      hp: st.flash ? st.flash.hp / st.flash.maxHp() : 1, surge: !!st.surge }),
      anims: () => ANIMS.map(([id, name, desc, kind]) => ({ id, name, desc, kind, on: A(id),
                      used: kind === "sprite" ? (usedFrame[id] || 0) : (lastSec[id] || 0) })),
      setAnim: (id, on) => { prefs.anim[id] = !!on; savePrefs(); },
      setAllAnims: on => { for (const a of ANIMS) prefs.anim[a[0]] = !!on; savePrefs(); },
      stressWave: n => sim.stressWave(n),
      setGod: on => sim.setGod(on),
      setWeapons: on => sim.setWeapons(on),
      setMove: on => sim.setMove(on),
      setDirector: on => sim.setDirector(on),
      clearEnemies: () => sim.clearEnemies(),
      telemetry: () => sim.telemetry(),
      // words: [{ id, th, rom, en, audio, weight }] from the host
      setWords: list => { words = Array.isArray(list) ? list.filter(w => w && w.id && w.th && w.en) : []; },
      wordSettings: () => Object.assign({}, WD),
      questionOpen: () => !!qOpen,
      gems: () => gems.map(g => ({ id: g.word.id, side: g.side, x: g.x, y: g.y, w: g.w, h: g.h })),
      setSlow: on => setSlow(on),
      showQuestion: q => showQuestion(q),
      rescue: () => { rescueAt = -1e9; maybeRescue(); },
      sendTelemetry: () => sendTel(),
      destroy() {
        clearInterval(secTimer); clearInterval(telTimer); sendTel(true); if (ro) ro.disconnect();
        window.removeEventListener("pagehide", onUnload);
        window.removeEventListener("inaflash:reward", onReward);
        document.removeEventListener("visibilitychange", onVis);
        game.destroy(true); el.innerHTML = "";
      },
    };
  }

  window.FlashGame = { mount };
})();
