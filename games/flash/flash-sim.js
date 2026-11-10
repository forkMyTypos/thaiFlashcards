/* Flash the Cat - game simulation.
 *
 * Pure JavaScript: no Phaser, no DOM. Everything that decides what happens in
 * a run lives here and reads its numbers from Gamebase's JSON data. The
 * renderer only draws `sim.st` and the events this produces, so the art can
 * change (or be switched off) without touching combat.
 *
 * Runs in the browser (window.FlashSim) and in Node (for headless tests).
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.FlashSim = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // Arena in world units. Portrait, because the game lives in a tall column.
  // The arena is 1000 units tall; its width follows the game column's shape
  // (opts.width / setWidth), from WMIN to WMAX. 600 is the classic size.
  const W = 600, H = 1000, CX = W / 2, CY = H / 2, WMIN = 480, WMAX = 1200;

  // For Flash these stats are bonuses around 1.0 (0.25 = +25%), not raw values.
  const BONUS = new Set(["damage", "weapon_damage", "spell_damage", "area", "duration", "projectile_speed",
    "pickup_range", "xp_gain", "gold_gain", "knockback", "rare_loot", "item_drop_chance", "weapon_range",
    "healing_power"]);

  const ENEMY_COLOURS = { melee: 0xe8e2d0, ranged: 0xc8d68a, tank: 0x9fb0c8, caster: 0xb59aff, support: 0x9affd0,
                          boss: 0xff6a6a };
  const TYPE_COLOURS = { skeleton_grunt: 0xe8e2d0, skeleton_archer: 0xd2dc8c, skeleton_armoured: 0x9fb0c8,
                         skeleton_berserker: 0xf08a6a, skeleton_mage: 0xb59aff, skeleton_elemental: 0xffa24a };

  const byId = list => { const m = {}; for (const r of list || []) m[r.id] = r; return m; };
  const clamp = (v, a, b) => v < a ? a : v > b ? b : v;

  // ------------------------------------------------------------ stat stacks
  function Stats(base, player) {
    this.base = base || {}; this.player = !!player; this.mods = []; this.cache = {};
  }
  Stats.prototype.add = function (list, src, scale) {
    for (const m of list || []) this.mods.push({ stat: m.stat, op: m.op, value: m.value * (scale == null ? 1 : scale), src });
    this.cache = {};
  };
  Stats.prototype.remove = function (src) { this.mods = this.mods.filter(m => m.src !== src); this.cache = {}; };
  Stats.prototype.get = function (stat) {
    if (stat in this.cache) return this.cache[stat];
    const b = this.base[stat] || 0; let A = 0, P = 0, M = 1;
    for (const m of this.mods) {
      if (m.stat !== stat) continue;
      if (m.op === "add") A += m.value; else if (m.op === "add_pct") P += m.value; else if (m.op === "multiply") M *= m.value;
    }
    const v = (this.player && BONUS.has(stat)) ? (1 + b + A + P) * M : (b + A) * (1 + P) * M;
    return (this.cache[stat] = v);
  };
  function modSum(mods, stat) {
    let A = 0, P = 0, M = 1;
    for (const m of mods) {
      if (m.stat !== stat) continue;
      if (m.op === "add") A += m.value; else if (m.op === "add_pct") P += m.value; else if (m.op === "multiply") M *= m.value;
    }
    return { A, P, M, mul: (1 + P) * M };
  }

  // ===================================================================== sim
  // The data files the simulation reads (the renderer also loads icons and the
  // Shared library for looks). A bot runner loads exactly these.
  const DATA_TYPES = ["weapons", "stats_base", "enemies", "enemy_equipment", "reward_effects", "game_settings",
                      "enemy_scaling", "spawn_curve", "enemy_mix", "elite_modifiers", "upgrades", "items",
                      "passives", "rarities", "mega_waves", "spells", "status_effects", "bosses", "boss_schedule", "shop_stock"];
  // A short fingerprint of the game data, so balance charts can separate runs
  // played before and after a change.
  function dataHash(data) {
    const s = JSON.stringify(DATA_TYPES.map(k => [k, data[k] || null]));
    let h = 2166136261 >>> 0;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return h.toString(36);
  }

  function create(data, opts) {
    opts = opts || {};
    const DATA_HASH = dataHash(data);
    const rnd = opts.random || Math.random;
    let W = Math.max(WMIN, Math.min(WMAX, Math.round(opts.width || 600)));
    // Flash's position. Every system aims at / measures from these, and they
    // follow Flash now that he moves (they were fixed at the centre before).
    let CX = W / 2, CY = H / 2;
    const D = {
      weapons: byId(data.weapons), base: byId(data.stats_base), enemies: data.enemies || [],
      equip: byId(data.enemy_equipment), rewards: data.reward_effects || [], upgrades: data.upgrades || [],
      items: data.items || [], passives: data.passives || [], scaling: data.enemy_scaling || [],
      spawn: (data.spawn_curve || []).slice().sort((a, b) => a.stage - b.stage), mix: data.enemy_mix || [],
      elites: data.elite_modifiers || [], rarity: byId(data.rarities), settings: byId(data.game_settings),
      waves: data.mega_waves || [],
    };
    const set = (id, key, d) => { const r = D.settings[id]; return r && r.values && r.values[key] !== undefined ? r.values[key] : d; };
    const T = {   // global tuning knobs (game_settings row "tuning")
      // defaults = the values tuned in headless tests (1 Nov): no study -> dies in round 1-2
      enemy_hp: set("tuning", "enemy_hp", 0.4), enemy_damage: set("tuning", "enemy_damage", 0.2),
      spawn_rate: set("tuning", "spawn_rate", 3), flash_hp: set("tuning", "flash_hp", 1),
      xp: set("tuning", "xp", 1), study_power: set("tuning", "study_power", 3),
      enemy_speed: set("tuning", "enemy_speed", 1),
    };
    const S = {
      roundLen: set("rounds", "round_length", 60), stageLen: set("stages", "stage_length_seconds", 30),
      xpBase: set("levelling", "xp_base", 50), xpLin: set("levelling", "xp_linear", 25), xpSq: set("levelling", "xp_square", 5),
      choices: set("levelling", "choices_per_level", 3), minDamage: set("combat", "min_damage", 1),
      dodgeCap: set("combat", "dodge_cap", 0.75), slots: set("combat", "weapon_slots", 4),
      initial: set("spawning", "initial_enemies", 5), maxCap: set("spawning", "max_active_cap", 1000),
      skipGold: set("choices", "skip_gold", 10),
    };
    const xpNext = L => S.xpBase + S.xpLin * L + S.xpSq * L * L;
    const MV = {   // smart movement (game_settings row "movement")
      enabled: set("movement", "enabled", true), speed: set("movement", "speed", 95),
      lookahead: set("movement", "look_ahead", 0.5), margin: set("movement", "wall_margin", 45),
      decide: set("movement", "decide_every", 0.1), prefer: set("movement", "preferred_range", 0.6),
      fear: set("movement", "fear", 1), trap: set("movement", "trap_fear", 1),
    };
    const DR = {   // the director (game_settings row "director")
      enabled: set("director", "enabled", true), low: set("director", "target_low", 0.3),
      high: set("director", "target_high", 0.65), min: set("director", "min_intensity", 1),
      max: set("director", "max_intensity", 5), up: set("director", "ramp_up", 0.03),
      down: set("director", "ramp_down", 0.25), perRound: set("director", "cap_per_round", 0.35),
      warmup: set("director", "warmup_seconds", 15), surge: set("director", "final_surge_seconds", 10),
      surgeMul: set("director", "final_surge_mult", 1.6), danger: set("director", "danger_hp", 0.3),
      dmgPow: set("director", "damage_power", 0.8), hpPow: set("director", "hp_power", 0.5),
    };

    // ---------------------------------------------------------- telemetry
    // Everything balancing needs, recorded as the run happens. The renderer
    // (or a bot runner) sends it to Gamebase; nothing here talks to a server.
    const SAMPLE_KEYS = ["t", "round", "stage", "level", "hp", "alive", "intensity", "dealt", "taken", "buffs", "danger", "rewards"];
    let tel = null, acc1 = null, accR = null;
    function telStart(weaponId) {
      tel = { v: 1, uid: (opts.uid || "run_" + Date.now().toString(36) + "_" + Math.floor(rnd() * 1e6).toString(36)),
        source: opts.source || "human", started: new Date().toISOString(), status: "running",
        data_hash: DATA_HASH, meta: opts.meta || null, arena_width: W,
        start_weapon: weaponId, mode: st.mode || "test", settings: { tuning: T, director: DR, movement: MV },
        sample_keys: SAMPLE_KEYS, samples: [], rounds: [], picks: [], dmg_by: {}, kills_by: {}, taken_by: {},
        rewards: {}, study: [], study_keys: ["t", "what", "strength"], shop: [], bosses: [], final: null };
      acc1 = { next: 1, dealt: 0, taken: 0, rewards: 0 };
      telRoundStart();
    }
    function telRoundStart() {
      accR = { round: st.round, start: st.fightT, kills: st.kills, dealt: 0, taken: 0, dangers: 0, rewards: 0,
               penalties: 0, intMax: st.intensity, level: st.level, wave: st.wave ? st.wave.row.id : null };
    }
    function telRoundEnd() {
      if (!tel || !accR) return;
      tel.rounds.push({ round: accR.round, wave: accR.wave, seconds: Math.round(st.fightT - accR.start),
        min_hp: Math.round(st.minHpRound * 100), kills: st.kills - accR.kills, dealt: Math.round(accR.dealt),
        taken: Math.round(accR.taken), dangers: accR.dangers, rewards: accR.rewards, penalties: accR.penalties,
        intensity_max: +accR.intMax.toFixed(2), level_start: accR.level, level_end: st.level,
        died: st.phase === "over" });
      accR = null;
    }
    function telSample() {
      if (!tel || st.fightT < acc1.next) return;
      acc1.next += 1;
      const f = st.flash;
      tel.samples.push([Math.round(st.fightT), st.round, st.stage, st.level, Math.round(f.hp / f.maxHp() * 100),
        st.enemies.length, +st.intensity.toFixed(2), Math.round(acc1.dealt), Math.round(acc1.taken), st.buffs.length,
        st.danger ? 1 : 0, acc1.rewards]);
      acc1.dealt = acc1.taken = acc1.rewards = 0;
      if (accR) accR.intMax = Math.max(accR.intMax, st.intensity);
    }
    const add = (o, k, v) => { o[k] = (o[k] || 0) + v; };

    const st = {
      W, H, CX, CY, phase: "start", paused: false, speed: 1,
      t: 0, fightT: 0, roundT: 0, round: 0, stage: 1, level: 1, xp: 0, xpNext: xpNext(1), gold: 0, kills: 0,
      pending: 0, offer: null, flash: null, weapons: [], tail: false, owned: {}, buffs: [],
      enemies: [], proj: [], eproj: [], events: [], spawnAcc: 0, warning: null, streak: 0,
      runStats: null, nextId: 1, damageDone: 0, dmgBy: {}, rDmgBy: {},
      wave: null, pops: [], combo: 0, lastKillT: -9, comboMax: 0, wavesCleared: 0,
      intensity: 1, stressAvg: 0, danger: false, minHpRound: 1, moveOn: MV.enabled, directorOn: DR.enabled,
      spells: [], spellOwned: {}, zones: [], allies: [], delayed: [], tele: [], boss: null, bossDone: {}, bossesKilled: 0,
      shop: null, shield: 0, shieldMax: 0, shieldUntil: 0,
      paws: [], pickups: [], fish: 0, autoEat: false, eatAt: 0, livesUsed: 0, safeUntil: 0,
    };
    const ev = e => { st.events.push(e); };

    // ------------------------------------------------------------- grid
    const CS = 48, GX0 = -240, GY0 = -240, GW = Math.ceil((WMAX + 480) / CS), GH = Math.ceil((H + 480) / CS);
    const head = new Int32Array(GW * GH);
    let nxt = new Int32Array(2048);
    function buildGrid() {
      head.fill(-1);
      const es = st.enemies;
      if (nxt.length < es.length) nxt = new Int32Array(es.length * 2);
      for (let i = 0; i < es.length; i++) {
        const e = es[i];
        const gx = clamp(((e.x - GX0) / CS) | 0, 0, GW - 1), gy = clamp(((e.y - GY0) / CS) | 0, 0, GH - 1);
        const c = gy * GW + gx; nxt[i] = head[c]; head[c] = i;
      }
    }
    function query(x, y, r, fn) {
      const x0 = clamp(((x - r - GX0) / CS) | 0, 0, GW - 1), x1 = clamp(((x + r - GX0) / CS) | 0, 0, GW - 1);
      const y0 = clamp(((y - r - GY0) / CS) | 0, 0, GH - 1), y1 = clamp(((y + r - GY0) / CS) | 0, 0, GH - 1);
      const es = st.enemies;
      for (let gy = y0; gy <= y1; gy++) for (let gx = x0; gx <= x1; gx++) {
        for (let i = head[gy * GW + gx]; i !== -1; i = nxt[i]) {
          const e = es[i];
          if (!e.alive) continue;
          const dx = e.x - x, dy = e.y - y, rr = r + e.r;
          const d2 = dx * dx + dy * dy;
          if (d2 <= rr * rr) { if (fn(e, d2) === false) return; }
        }
      }
    }

    // ------------------------------------------------------------ flash
    function newFlash() {
      const b = (D.base.flash && D.base.flash.stats) || { max_hp: 150, hp_regen: 1, defence: 0.05, crit_chance: 0.05, crit_damage: 1.5, dodge: 0.05, attack_speed: 1, attack_range: 1 };
      const stats = new Stats(Object.assign({ attack_speed: 1, attack_range: 1 }, b, { damage: 0 }), true);
      const f = { x: W / 2, y: H / 2, vx: 0, vy: 0, face: 1, r: 20, stats, hp: 0, hurtT: 0, decideT: 0, gx: 0, gy: 0,
                  maxHp: () => stats.get("max_hp") * T.flash_hp };
      f.hp = f.maxHp();
      return f;
    }
    function changeMax(fn) {           // keep the gain when max HP goes up
      const before = st.flash.maxHp(); fn(); const after = st.flash.maxHp();
      if (after > before) st.flash.hp += after - before;
      st.flash.hp = Math.min(st.flash.hp, after);
    }

    // ---------------------------------------------------------- weapons
    function addWeapon(id) {
      const def = D.weapons[id]; if (!def) return null;
      const w = { uid: st.nextId++, id, def, level: 1, mods: [], cd: 0.3 + rnd() * 0.3, angle: rnd() * 6.28, slot: st.weapons.length };
      st.weapons.push(w); st.owned[id] = w;
      return w;
    }
    function wp(w) {        // a weapon's effective numbers right now
      const f = st.flash.stats, def = w.def, m = s => modSum(w.mods, s);
      const dm = m("damage"), sp = m("attack_speed"), rg = m("attack_range"), ps = m("projectile_speed"),
            cc = m("crit_chance"), cd = m("crit_damage"), kb = m("knockback"), ar = m("area"),
            pc = m("projectile_count"), pi = m("pierce"), bo = m("bounces");
      return {
        damage: (def.damage + dm.A) * dm.mul * f.get("damage") * f.get("weapon_damage"),
        cooldown: def.cooldown / Math.max(0.05, sp.mul * f.get("attack_speed")),
        range: def.range * rg.mul * f.get("attack_range") * f.get("weapon_range"),
        speed: (def.projectile_speed || 450) * ps.mul * f.get("projectile_speed"),
        count: Math.max(1, (def.projectile_count || 1) + pc.A + f.get("projectile_count")),
        pierce: def.pierce < 0 ? -1 : (def.pierce || 0) + pi.A + f.get("pierce"),
        bounces: (def.bounces || 0) + bo.A + f.get("bounces"),
        critC: f.get("crit_chance") + cc.A, critD: f.get("crit_damage") + cd.A,
        kb: ((def.knockback || 0) + kb.A) * kb.mul * f.get("knockback"),
        radius: (def.radius || 0) * ar.mul * f.get("area"),
        explodeChance: f.get("explode_chance"),
      };
    }

    // -------------------------------------------------------- targeting
    function targets(mode, range, n) {
      const out = [];
      query(CX, CY, range, (e, d2) => { out.push({ e, d: Math.sqrt(d2) }); });
      if (!out.length) return [];
      const doomed = o => o.e.hp - o.e.incoming <= 0;
      let list = out;
      if (mode === "spread" || mode === "smart" || mode === "strongest") {
        const alive = out.filter(o => !doomed(o));
        if (alive.length) list = alive;
      }
      const score = {
        nearest: o => -o.d, homing: o => -o.d, area: o => -o.d, directional: o => -o.d,
        weakest: o => -o.e.hp, strongest: o => o.e.max + (o.e.elite ? 1e6 : 0),
        random: () => rnd(),
        spread: o => -o.d - o.e.incoming * 4,
        smart: o => (1 - o.d / range) * 3 + (o.e.elite ? 3 : 0) + (o.e.attacking ? 1.5 : 0) + o.e.dmg / 20,
      }[mode] || (o => -o.d);
      list.sort((a, b) => score(b) - score(a));
      return list.slice(0, n).map(o => o.e);
    }

    // ----------------------------------------------------------- damage
    // el: the hit's element (fire, ice, lightning, nuclear, steam, ...); by
    // default the element of whatever did it (a spell's element, a weapon's)
    function hitEnemy(e, base, critC, critD, kb, src, el) {
      if (!e.alive) return 0;
      el = el || EL[src] || null;
      if (el && e.fx) combo(e, el, base, src);              // 🔥 on 🧊 = steam, ⚡ on 🧊 / 🔥 ...
      if (!e.alive) return 0;
      const crit = rnd() < critC;
      let dmg = base * (crit ? critD : 1), def = e.def;
      if (e.fx) {
        if (e.fx.mark > st.t) dmg *= 1 + (e.fx.markB || 0.4);                 // Death Mark
        if (e.fx.curse > st.t) def = Math.max(0, def - (e.fx.curseD || 0.2));  // Bone Curse
        if ((e.fx.frozen || 0) > st.t) dmg *= 1 + ELS.shatter_bonus;           // frozen skeletons are brittle
      }
      dmg = Math.max(S.minDamage, Math.round(dmg * (1 - def)));
      e.hp -= dmg; e.hitT = 0.08; st.damageDone += dmg;
      // who did it, for the run and this round (the DPS breakdown between rounds)
      const by = src || "other"; st.dmgBy[by] = (st.dmgBy[by] || 0) + dmg; st.rDmgBy[by] = (st.rDmgBy[by] || 0) + dmg;
      if (tel) { add(tel.dmg_by, src || "other", dmg); acc1.dealt += dmg; if (accR) accR.dealt += dmg; }
      if (kb > 0 && !e.held) {
        const dx = e.x - CX, dy = e.y - CY, d = Math.hypot(dx, dy) || 1;
        const k = kb * 6 / Math.max(0.6, e.size);
        e.kx += dx / d * k; e.ky += dy / d * k;
      }
      // a big hit on something big (a boss or a big elite) can flash the screen
      const big = crit && e.max >= 400 && dmg >= e.max * 0.08;
      ev({ t: "hit", x: e.x, y: e.y, v: dmg, crit, src, el, big });
      const ls = st.flash.stats.get("lifesteal");
      if (ls > 0) st.flash.hp = Math.min(st.flash.maxHp(), st.flash.hp + dmg * ls);
      if (e.hp <= 0) kill(e, src, el, kb >= 25 || dmg >= e.max * 2.5);
      return dmg;
    }
    function explode(x, y, r, dmg, critC, critD, src, fx, power, c) {
      ev({ t: "explode", x, y, r, c });
      query(x, y, r, e => { hitEnemy(e, dmg, critC, critD, 4, src); if (fx) for (const id of fx) applyStatus(e, id, power, src); });
    }
    function kill(e, src, el, heavy) {
      if (!e.alive) return;
      e.alive = false; st.kills++;
      if (tel) add(tel.kills_by, src || "other", 1);
      st.combo = st.t - st.lastKillT < 1.2 ? st.combo + 1 : 1; st.lastKillT = st.t;
      if (st.combo > st.comboMax) st.comboMax = st.combo;
      if (e.fodder && st.wave) st.wave.killed++;
      if (e.chain > 0 && st.pops.length < 400 && rnd() < e.chain) st.pops.push({ x: e.x, y: e.y, r: e.chainR, dmg: e.max * 1.2 });
      const x = e.fx, frozen = !!x && (x.frozen || 0) > st.t, burning = !!x && !!x.burn && x.burn.until > st.t;
      if (x) {
        const pl = x.plague, bu = x.burst;
        if (pl && pl.until > st.t) query(e.x, e.y, 75, o => { if (o !== e && !(o.fx && o.fx.poison && o.fx.poison.until > st.t)) {
          const x2 = fxOf(o); x2.poison = { dps: (x.poison ? x.poison.dps : 5), until: st.t + 4, src: pl.src }; x2.plague = Object.assign({}, pl); } });
        if (bu && bu.until > st.t && st.delayed.length < 200) st.delayed.push({ at: st.t + 0.05, x: e.x, y: e.y, r: bu.r, dmg: bu.dmg, src: bu.src, c: 0xc8a0ff });
        // 🔥 fire spreads: a burning skeleton that falls sets its neighbours alight
        if (burning && tok("spread", 1)) spreadFire(e, x.burn, ELS.spread_on_death);
        // 🧊 a frozen skeleton shatters, and the shards hurt (and chill) the ones close by
        if (frozen && !e.boss && tok("combo", 1)) {
          const dmg = e.max * ELS.shatter_damage + 6, sr = ELS.shatter_radius * Math.sqrt(e.size);
          query(e.x, e.y, sr, o => { if (o !== e && !o.held) { chill(o, 1); hitEnemy(o, dmg, 0, 1, 2, "shatter", "shards"); } });
        }
      }
      // how it went: the renderer gives each a funny death of its own
      const how = e.thrown ? "pins" : e.pinned > st.t ? "pins" : el === "nuclear" ? "launch"
        : frozen || el === "ice" || el === "shards" || el === "superconduct" ? "shatter"
        : el === "lightning" ? "zap" : burning || el === "fire" || el === "overload" || el === "steam" || el === "rad" ? "ash"
        : heavy && rnd() < 0.6 ? "launch" : "pop";
      if (e.boss) bossDown(e);
      const f = st.flash.stats;
      // 🐟 a fish, now and then (always from a boss)
      if (!st.practice && !e.fodder) {
        const ch = e.boss ? 1 : e.elite ? FI.elite : FI.drop * (1 + (f.get("luck") || 0) / 100);
        for (let k = e.boss ? FI.boss : 1; k > 0; k--) if (rnd() < ch && st.pickups.length < FI.floor_max)
          st.pickups.push({ id: st.nextId++, k: "fish", x: e.x + (k - 1) * 18, y: e.y, until: st.t + FI.life, born: st.t });
      } else if (e.fodder && !st.practice && FI.horde > 0 && rnd() < FI.horde && st.pickups.length < FI.floor_max)
        st.pickups.push({ id: st.nextId++, k: "fish", x: e.x, y: e.y, until: st.t + FI.life, born: st.t });
      const dx = e.x - CX, dy = e.y - CY, dd = Math.hypot(dx, dy) || 1;
      ev({ t: "death", x: e.x, y: e.y, elite: e.elite, colour: e.colour, size: e.size, how, el, type: e.type, dx: dx / dd, dy: dy / dd });
      if (st.practice) return;                       // learning mode: no XP, gold or level-ups
      st.xp += e.xp * f.get("xp_gain") * T.xp;
      st.gold += Math.round(e.gold * f.get("gold_gain"));
      while (st.xp >= st.xpNext) {
        st.xp -= st.xpNext; st.level++; st.pending++; st.xpNext = xpNext(st.level);
        ev({ t: "levelup", level: st.level });
      }
    }

    // ------------------------------------------------------------ firing
    function fire(w) {
      const p = wp(w), def = w.def, b = def.behaviour;
      if (b === "orbit") return true;            // orbits are always out (see updateOrbits)
      const mode = def.targeting || "nearest";
      if (b === "melee_arc" || b === "area_smash") {
        const [t] = targets("nearest", p.range, 1);
        if (!t) return false;
        const ang = Math.atan2(t.y - CY, t.x - CX);
        if (b === "melee_arc") {
          query(CX, CY, p.range, e => {
            let da = Math.abs(Math.atan2(e.y - CY, e.x - CX) - ang); if (da > Math.PI) da = 2 * Math.PI - da;
            if (da < 1.1) hitEnemy(e, p.damage, p.critC, p.critD, p.kb, w.id);
          });
          ev({ t: "swing", a: ang, r: p.range, w: w.id, x: CX, y: CY });
        } else {
          const r = p.radius || 110;
          explode(t.x, t.y, r, p.damage, p.critC, p.critD, w.id);
        }
        return true;
      }
      if (b === "melee_rapid" || b === "continuous" || b === "melee_heavy") {
        const [t] = targets(mode, p.range, 1);
        if (!t) return false;
        hitEnemy(t, p.damage, p.critC, p.critD, b === "melee_heavy" ? Math.max(p.kb, 20) : p.kb, w.id);
        if (b === "melee_heavy") query(t.x, t.y, 34, e => { if (e !== t) hitEnemy(e, p.damage * 0.5, 0, 1, p.kb, w.id); });
        ev({ t: "stab", x: t.x, y: t.y, w: w.id });
        return true;
      }
      if (b === "paw_bowl") return grabOne(w, p);
      // projectiles
      const n = Math.round(p.count);
      let aims;
      if (b === "spread_projectile") {
        const [t] = targets(mode, p.range, 1);
        if (!t) return false;
        const a0 = Math.atan2(t.y - CY, t.x - CX), spread = 0.22;
        aims = []; for (let i = 0; i < n; i++) aims.push({ a: a0 + (i - (n - 1) / 2) * spread, t: i === (n >> 1) ? t : null });
      } else {
        const ts = targets(mode, p.range, n);
        if (!ts.length) return false;
        aims = []; for (let i = 0; i < n; i++) { const t = ts[i % ts.length]; aims.push({ a: Math.atan2(t.y - CY, t.x - CX) + (i >= ts.length ? (rnd() - 0.5) * 0.3 : 0), t }); }
      }
      for (const a of aims) {
        if (a.t) a.t.incoming += p.damage;
        st.proj.push({
          x: CX, y: CY, vx: Math.cos(a.a) * p.speed, vy: Math.sin(a.a) * p.speed, r: 7, w: w.id, b,
          dmg: p.damage, critC: p.critC, critD: p.critD, kb: p.kb, pierce: b === "returning_projectile" ? -1 : p.pierce,
          bounces: b === "bouncing_projectile" ? Math.max(1, p.bounces) : 0, radius: p.radius || 60,
          life: p.range / p.speed, back: false, hit: new Set(), target: a.t, expl: p.explodeChance,
          speed: p.speed, alive: true,
        });
      }
      ev({ t: "fire", w: w.id });
      return true;
    }

    // ---- 🐾 paws (Dan: "paws that grab and throw skeletons"): Flash's paw
    // reaches out, grabs one, winds up and bowls it into the thickest part of
    // the crowd. Everything it rolls through is hit and sent flying like pins.
    function grabOne(w, p) {
      if (st.paws.some(q => q.w === w.uid)) return false;          // one throw at a time per paw
      const def = w.def;
      let t = null, bd = 1e12;
      query(CX, CY, p.range, (e, d2) => { if (!e.boss && !e.held && e.size <= 1.6 && d2 < bd) { bd = d2; t = e; } });
      if (!t) return false;
      // which way: the line through the most skeletons
      const reach = (def.throw_range || 420) * p.range / Math.max(1, def.range || 140);
      let best = 0, bn = -1;
      for (let k = 0; k < 16; k++) {
        const a = k * Math.PI / 8, ca = Math.cos(a), sa = Math.sin(a);
        let n = 0;
        for (let s = 1; s <= 5; s++) { const d = s * reach / 5; n += countNear(t.x + ca * d, t.y + sa * d, 34); }
        if (n > bn) { bn = n; best = a; }
      }
      t.held = true; t.attacking = false; t.kx = t.ky = 0;
      st.paws.push({ w: w.uid, wid: w.id, e: t, phase: "grab", t: def.hold || 0.32, a: best, dmg: p.damage, critC: p.critC, critD: p.critD,
                     kb: Math.max(p.kb, 30), speed: def.throw_speed || 520, left: reach, hit: new Set([t.id]), pins: 0, sx: t.x, sy: t.y });
      ev({ t: "paw", k: "grab", id: t.id, x: t.x, y: t.y });
      return true;
    }
    function updatePaws(dt) {
      if (!st.paws.length) return;
      for (const q of st.paws) {
        const e = q.e;
        if (!e.alive) { q.done = true; continue; }
        if (q.phase === "grab") {
          // pulled in beside Flash, on the far side from where it's going (the wind-up)
          q.t -= dt;
          const tx = CX - Math.cos(q.a) * 30, ty = CY - Math.sin(q.a) * 30, k = Math.min(1, dt * 12);
          e.x += (tx - e.x) * k; e.y += (ty - e.y) * k;
          if (q.t <= 0) { q.phase = "roll"; e.thrown = true; e.spin = 0; ev({ t: "paw", k: "throw", id: e.id, x: e.x, y: e.y, a: q.a }); }
          continue;
        }
        const step = q.speed * dt, ca = Math.cos(q.a), sa = Math.sin(q.a);
        e.x += ca * step; e.y += sa * step; q.left -= step;
        query(e.x, e.y, e.r + 6, o => {
          if (q.hit.has(o.id) || o.held) return;
          q.hit.add(o.id); q.pins++;
          o.pinned = st.t + 0.6;                                   // if it dies now, it goes flying like a pin
          // knocked sideways off the ball's path, and back a little
          const side = ((o.x - e.x) * -sa + (o.y - e.y) * ca) >= 0 ? 1 : -1, f = q.kb * 7 / Math.max(0.6, o.size);
          o.kx += (-sa * side * 0.9 + ca * 0.5) * f; o.ky += (ca * side * 0.9 + sa * 0.5) * f;
          hitEnemy(o, q.dmg, q.critC, q.critD, 0, q.wid);
        });
        const out = e.x < -60 || e.x > W + 60 || e.y < -60 || e.y > H + 60;
        if (q.left <= 0 || out) {
          if (q.pins >= FEEL.strike) { ev({ t: "strike", x: e.x, y: e.y, n: q.pins }); if (q.pins >= FEEL.strike * 2) ev({ t: "big", k: "strike", x: e.x, y: e.y }); }
          // the ball is spent: it smashes (the big ones just take a lot of damage)
          e.held = false; e.thrown = false;
          if (e.size > 1.25) { hitEnemy(e, q.dmg * 3, 0, 1, 0, q.wid); e.pinned = st.t + 0.3; }
          else { e.thrown = true; hitEnemy(e, e.hp + 1, 0, 1, 0, q.wid); e.thrown = false; }
          if (e.alive && out) { e.x = clamp(e.x, -20, W + 20); e.y = clamp(e.y, -20, H + 20); }
          q.done = true;
        }
      }
      st.paws = st.paws.filter(q => !q.done);
      for (const q of st.paws) if (!q.e.alive) q.e.held = false;
    }

    function updateOrbits(dt) {
      for (const w of st.weapons) {
        if (w.def.behaviour !== "orbit") continue;
        const p = wp(w), n = Math.round(p.count) + 1, rad = Math.max(40, p.range * 0.8);
        w.angle += dt * 2.6 * (1 + (p.cooldown < 0.5 ? 0.5 : 0));
        w.blades = [];
        for (let i = 0; i < n; i++) {
          const a = w.angle + i * 6.283 / n, bx = CX + Math.cos(a) * rad, by = CY + Math.sin(a) * rad;
          w.blades.push({ x: bx, y: by, a });
          query(bx, by, 16 + (p.radius ? p.radius * 0.3 : 0), e => {
            const k = "o" + w.uid;
            if ((e[k] || 0) > st.t) return;
            e[k] = st.t + p.cooldown;
            hitEnemy(e, p.damage, p.critC, p.critD, p.kb, w.id);
          });
        }
      }
    }

    function updateProjectiles(dt) {
      for (const pr of st.proj) {
        if (!pr.alive) continue;
        if (pr.b === "returning_projectile" && pr.back) {
          const dx = CX - pr.x, dy = CY - pr.y, d = Math.hypot(dx, dy);
          if (d < 20) { pr.alive = false; continue; }
          pr.vx = dx / d * pr.speed; pr.vy = dy / d * pr.speed;
        } else if ((pr.b === "projectile" || pr.homing) && pr.target && pr.target.alive && (pr.homing || (pr.w && D.weapons[pr.w] && D.weapons[pr.w].targeting === "homing"))) {
          const dx = pr.target.x - pr.x, dy = pr.target.y - pr.y, d = Math.hypot(dx, dy) || 1;
          pr.vx = dx / d * pr.speed; pr.vy = dy / d * pr.speed;
        }
        pr.x += pr.vx * dt; pr.y += pr.vy * dt;
        pr.life -= dt;
        if (pr.life <= 0) {
          if (pr.b === "returning_projectile" && !pr.back) { pr.back = true; pr.hit.clear(); pr.life = 99; }
          else { pr.alive = false; if (pr.target) pr.target.incoming = Math.max(0, pr.target.incoming - pr.dmg); continue; }
        }
        query(pr.x, pr.y, pr.r, e => {
          if (pr.hit.has(e.id)) return;
          pr.hit.add(e.id);
          if (e === pr.target) { e.incoming = Math.max(0, e.incoming - pr.dmg); pr.target = null; }
          hitEnemy(e, pr.dmg, pr.critC, pr.critD, pr.kb, pr.w);
          if (pr.fx) for (const id of pr.fx) applyStatus(e, id, pr.power, pr.w, pr.chance);
          if (pr.b === "explosive_projectile" || (pr.expl > 0 && rnd() < pr.expl)) {
            explode(pr.x, pr.y, pr.radius, pr.dmg * 0.6, pr.critC, pr.critD, pr.w, pr.fx, pr.power, pr.c);
            if (pr.b === "explosive_projectile") { pr.alive = false; return false; }
          }
          if (pr.b === "bouncing_projectile") {
            if (pr.bounces-- <= 0) { pr.alive = false; return false; }
            let best = null, bd = 1e9;
            query(pr.x, pr.y, 220, (o, d2) => { if (!pr.hit.has(o.id) && d2 < bd) { bd = d2; best = o; } });
            if (!best) { pr.alive = false; return false; }
            const dx = best.x - pr.x, dy = best.y - pr.y, d = Math.hypot(dx, dy) || 1;
            pr.vx = dx / d * pr.speed; pr.vy = dy / d * pr.speed; pr.life = 1;
            return false;
          }
          if (pr.pierce >= 0) {
            if (pr.pierce-- <= 0) { pr.alive = false; return false; }
          }
        });
      }
      st.proj = st.proj.filter(p => p.alive);
    }

    // ------------------------------------------------------------ enemies
    function lerpStage(rows, key, stage) {
      // smooth curve between table rows (geometric for multipliers)
      if (!rows.length) return 1;
      const sorted = rows.slice().sort((a, b) => a.from_stage - b.from_stage);
      for (let i = 0; i < sorted.length; i++) {
        const r = sorted[i], nx = sorted[i + 1];
        const to = r.to_stage == null ? Infinity : r.to_stage;
        if (stage >= r.from_stage && stage <= to) {
          if (r.to_stage == null) return r[key] * Math.pow(1 + (r.growth_per_stage || 0), stage - r.from_stage);
          if (!nx) return r[key];
          const k = (stage - r.from_stage) / Math.max(1, nx.from_stage - r.from_stage);
          return r[key] * Math.pow(nx[key] / r[key], k);
        }
      }
      return sorted[sorted.length - 1][key];
    }
    function spawnParams(stage) {
      const rows = D.spawn;
      if (!rows.length) return { interval: 2, min: 1, max: 1, target: 40 };
      let a = rows[0], b = rows[rows.length - 1];
      for (let i = 0; i < rows.length - 1; i++) if (stage >= rows[i].stage && stage <= rows[i + 1].stage) { a = rows[i]; b = rows[i + 1]; break; }
      if (stage >= rows[rows.length - 1].stage) a = b = rows[rows.length - 1];
      const k = a === b ? 0 : (stage - a.stage) / (b.stage - a.stage);
      const L = (x, y) => x + (y - x) * k;
      return { interval: L(a.spawn_interval, b.spawn_interval), min: Math.round(L(a.per_spawn_min, b.per_spawn_min)),
               max: Math.round(L(a.per_spawn_max, b.per_spawn_max)), target: L(a.active_target, b.active_target) };
    }
    function mixFor(stage) {
      const row = D.mix.find(r => stage >= r.from_stage && (r.to_stage == null || stage <= r.to_stage)) || D.mix[D.mix.length - 1];
      let pool = D.enemies;
      if (row && row.enemies && !row.enemies.includes("*")) pool = D.enemies.filter(e => row.enemies.includes(e.id));
      pool = pool.filter(e => (e.min_level || 1) <= Math.max(stage, 1)) || pool;
      return { pool: pool.length ? pool : D.enemies, elite: row ? row.elite_chance || 0 : 0 };
    }
    const pickWeighted = (list, w) => {
      let tot = 0; for (const x of list) tot += w(x);
      let r = rnd() * tot; for (const x of list) { r -= w(x); if (r <= 0) return x; }
      return list[list.length - 1];
    };
    const pickOne = arr => arr && arr.length ? arr[(rnd() * arr.length) | 0] : null;

    // Archers and other shooters (3 Nov balance pass): they stood at 300 range,
    // out of reach of every melee weapon, and did 75-90% of the damage in
    // Dan's runs. Tunable in Game settings > combat:
    //   ranged_max_share  at most this share of the live skeletons shoot
    //   ranged_damage     their shots' damage (x)
    //   ranged_range      how far away they stop to shoot (x)
    //   arrow_speed       how fast their shots fly (slower = Flash dodges more)
    const RG = { share: set("combat", "ranged_max_share", 1), dmg: set("combat", "ranged_damage", 1),
                 range: set("combat", "ranged_range", 1), arrow: set("combat", "arrow_speed", 240) };
    function spawnEnemy(forceElite, defId, at) {
      if (st.enemies.length >= S.maxCap) return null;
      const { pool, elite } = mixFor(st.stage);
      let def = (defId && D.enemies.find(x => x.id === defId)) || pickWeighted(pool, e => e.spawn_weight || 1);
      if (def && !defId && RG.share < 1 && /ranged|caster/.test(def.role || "")) {
        let n = 0; for (const o of st.enemies) if (o.alive && o.ranged) n++;
        if (n >= Math.max(2, RG.share * st.enemies.length)) { const melee = pool.filter(e => !/ranged|caster/.test(e.role || "")); if (melee.length) def = pickWeighted(melee, e => e.spawn_weight || 1); }
      }
      if (!def) return null;
      const base = (D.base[def.base] && D.base[def.base].stats) || { max_hp: 40, damage: 5, attack_speed: 1, movement_speed: 60, attack_range: 60 };
      const s = new Stats(base, false);
      const eq = [pickOne(def.equipment_pool), rnd() < 0.5 ? pickOne(def.armour_pool) : null,
                  rnd() < 0.3 ? pickOne(def.accessory_pool) : null].filter(Boolean);
      for (const id of eq) if (D.equip[id]) s.add(D.equip[id].modifiers, id);
      if (def.stat_modifiers) s.add(def.stat_modifiers, "def");
      let isElite = forceElite || rnd() < elite, mod = null, size = 1;
      if (isElite && D.elites.length) {
        mod = pickOne(D.elites); s.add(mod.effects, "elite"); size = mod.size_scale || 1.35;
      }
      const hpMul = lerpStage(D.scaling, "hp_mult", st.stage) * T.enemy_hp * Math.pow(st.intensity, DR.hpPow);
      const dmgMul = lerpStage(D.scaling, "damage_mult", st.stage) * T.enemy_damage;
      // spawn just outside the visible arena
      const side = (rnd() * 4) | 0, m = 30;
      let x, y;
      if (side === 0) { x = rnd() * W; y = -m; } else if (side === 1) { x = W + m; y = rnd() * H; }
      else if (side === 2) { x = rnd() * W; y = H + m; } else { x = -m; y = rnd() * H; }
      if (at) { x = at.x; y = at.y; }
      const role = def.role || "melee";
      const ranged = role === "ranged" || role === "caster";
      const e = {
        id: st.nextId++, type: def.id, role, ranged, x, y, kx: 0, ky: 0, alive: true, elite: isElite,
        eliteMod: mod ? mod.id : null, size,
        r: 11 * Math.sqrt(size), max: Math.max(1, s.get("max_hp") * hpMul), dmg: s.get("damage") * dmgMul * (ranged ? RG.dmg : 1),
        atkSpd: Math.max(0.1, s.get("attack_speed")), range: Math.max(40, s.get("attack_range") * (ranged ? RG.range : 1)),
        speed: Math.max(10, s.get("movement_speed") || 60) * T.enemy_speed * (isElite && mod && mod.id === "swift" ? 1 : 1),
        def: s.get("defence"), regen: s.get("hp_regen") + (mod && mod.id === "regenerating" ? 0.05 * s.get("max_hp") * hpMul : 0),
        lifesteal: s.get("lifesteal"), atkT: 0.5 + rnd(), attacking: false, incoming: 0, hitT: 0,
        xp: (def.xp || 5) * (isElite ? 5 : 1), gold: (def.gold || 1) * (isElite ? 5 : 1),
        colour: TYPE_COLOURS[def.id] || ENEMY_COLOURS[role] || 0xe8e2d0, explodes: !!(mod && mod.on_death && mod.on_death.length),
      };
      e.hp = e.max;
      st.enemies.push(e);
      return e;
    }

    // ------------------------------------------------------- mega waves
    function waveFor(round) {
      let best = null;
      for (const w of D.waves) {
        if (w.ambush) continue;                      // ambushes come mid-round, by chance (nextRound)
        const hit = round === w.from_round || (w.every_rounds > 0 && round > w.from_round && (round - w.from_round) % w.every_rounds === 0);
        if (hit && (!best || w.total > best.total)) best = w;
      }
      return best;
    }
    function startWave(row) {
      const r = Object.assign({ name: "Mega wave", total: 5000, max_alive: 1000, spawn_per_second: 160, hp_mult: 0.3,
        damage_mult: 0.35, speed_mult: 1.15, xp_each: 0.4, gold_chance: 0.08, chain_chance: 0.35, chain_radius: 42,
        colour: "#e8e2d0" }, row || {});
      // parts: back-to-back waves of `total` each (Dan: "mega hordes, like 5x 10k")
      const parts = Math.max(1, r.parts || 1);
      const side0 = (rnd() * 4) | 0;
      st.wave = { row: r, total: r.total * parts, partSize: r.total, parts, part: 1, spawned: 0, killed: 0, acc: 0, side: side0, nextSide: nextSideFrom(side0), sideT: 0,
                  sideEvery: r.side_every || 2.2, pause: 0, t: 0, ambush: !!r.ambush };
      // an ambush has no warning (Dan: "shock hordes, like 10k block.. no warning"): a ring
      // closes in around Flash at once, and the banner only comes when it's already there
      if (r.ambush) {
        const n = Math.min(st.wave.total, aliveCap, Math.round((r.burst || r.max_alive) * aliveScale()));
        for (let i = 0; i < n; i++) spawnFodder(0, true);
        ev({ t: "ambush", name: r.name, total: st.wave.total, banner: r.banner || `😱 AMBUSH! ${st.wave.total.toLocaleString()} skeletons` });
      } else ev({ t: "mega_start", name: r.name, total: st.wave.total, parts, banner: r.banner || `💀 ${r.name}! ${st.wave.total.toLocaleString()} skeletons` });
    }
    // how many skeletons this device keeps on screen at once, as a share of the
    // data's max_alive (the game sets it from ⚙ Effects quality)
    let aliveK = 1, aliveCap = Infinity;
    const aliveScale = () => aliveK;
    // the side the next front comes from, picked ahead so the game can warn about it
    const nextSideFrom = s0 => (s0 + 1 + ((rnd() * 3) | 0)) % 4;
    function spawnFodder(side, ring) {
      const w = st.wave, r = w.row;
      const base = (D.base.skeleton_basic && D.base.skeleton_basic.stats) || { max_hp: 40, damage: 5, attack_speed: 1, movement_speed: 60, attack_range: 60 };
      const hpMul = lerpStage(D.scaling, "hp_mult", st.stage) * T.enemy_hp * r.hp_mult * Math.pow(st.intensity, DR.hpPow);
      const dmgMul = lerpStage(D.scaling, "damage_mult", st.stage) * T.enemy_damage * r.damage_mult;
      // a thick front rolling in from one side
      const depth = 20 + rnd() * 160;
      let x, y;
      if (ring) {                    // the ambush ring: all around Flash, thick
        // close enough to see the whole ring on screen, thick
        const a = rnd() * 6.283, rr = Math.min(W, H) * (0.3 + rnd() * 0.24);
        x = Math.max(-30, Math.min(W + 30, CX + Math.cos(a) * rr)); y = Math.max(-30, Math.min(H + 30, CY + Math.sin(a) * rr));
      } else if (side === 0) { x = rnd() * W; y = -depth; } else if (side === 1) { x = W + depth; y = rnd() * H; }
      else if (side === 2) { x = rnd() * W; y = H + depth; } else { x = -depth; y = rnd() * H; }
      const max = Math.max(1, (base.max_hp || 40) * hpMul);
      st.enemies.push({
        id: st.nextId++, type: "fodder", role: "melee", ranged: false, x, y, kx: 0, ky: 0, alive: true, elite: false,
        size: 0.85, r: 9.5, max, hp: max, dmg: (base.damage || 5) * dmgMul, atkSpd: base.attack_speed || 1,
        range: base.attack_range || 60, speed: (base.movement_speed || 60) * r.speed_mult * T.enemy_speed * (0.85 + rnd() * 0.3),
        def: 0, regen: 0, lifesteal: 0, atkT: 0.5 + rnd(), attacking: false, incoming: 0, hitT: 0,
        xp: r.xp_each, gold: rnd() < r.gold_chance ? 1 : 0, colour: parseInt(String(r.colour).slice(1), 16) || 0xe8e2d0,
        fodder: true, chain: r.chain_chance, chainR: r.chain_radius, explodes: false, wob: rnd() * 6.28,
      });
      w.spawned++;
    }
    function updateWave(dt) {
      const w = st.wave, r = w.row;
      w.t += dt; w.sideT += dt;
      // a breather between the waves of a set (part_gap), then the next one; the
      // front stays put meanwhile, on the side the countdown points at
      if (w.pause > 0) {
        w.sideT = 0;
        w.pause -= dt;
        if (w.pause <= 0) { w.pause = 0; w.part++; w.sideT = 0; ev({ t: "mega_part", name: r.name, part: w.part, parts: w.parts, total: w.partSize, side: w.side }); }
        return;
      }
      if (w.sideT > w.sideEvery) { w.sideT = 0; w.side = w.nextSide; w.nextSide = nextSideFrom(w.side); }
      if (w.spawned < w.total) {
        // the next wave of a back-to-back set: straight on, or after a breather
        if (w.parts > 1 && w.spawned >= w.part * w.partSize && w.part < w.parts) {
          if (r.part_gap > 0) { w.pause = r.part_gap; w.side = w.nextSide; w.nextSide = nextSideFrom(w.side); ev({ t: "mega_gap", name: r.name, part: w.part + 1, parts: w.parts, gap: r.part_gap, side: w.side }); return; }
          w.part++; ev({ t: "mega_part", name: r.name, part: w.part, parts: w.parts, total: w.partSize, side: w.side });
        }
        w.acc += dt * r.spawn_per_second;
        const room = Math.min(aliveCap, Math.round(r.max_alive * aliveScale())) - st.enemies.length;
        let n = Math.min(Math.floor(w.acc), room, w.total - w.spawned);
        if (n > 0) { w.acc -= n; while (n-- > 0) spawnFodder(rnd() < 0.8 ? w.side : (rnd() * 4) | 0); }
        if (w.acc > r.spawn_per_second) w.acc = r.spawn_per_second;    // don't bank forever while the screen is full
      } else if (st.enemies.length && st.enemies.length <= Math.max(8, w.total * 0.02)) {
        w.stragT = (w.stragT || 0) + dt;                   // the last few stop hanging back and charge
        if (w.stragT > 5 && !w.rushed) { w.rushed = true; for (const e of st.enemies) { e.ranged = false; e.speed *= 1.6; } ev({ t: "rush" }); }
      } else if (!st.enemies.length || (w.ambush && w.spawned >= w.total && st.enemies.length <= 3)) {
        ev({ t: "mega_end", name: r.name, total: w.total, time: w.t, ambush: w.ambush });
        st.wavesCleared++;
        st.wave = null;
        // an ambush comes in the middle of a round: the round carries on to its end
        if (!w.ambush || st.roundT >= S.roundLen) endRound();
      }
    }
    function processPops() {
      if (!st.pops.length) return;
      const list = st.pops; st.pops = [];
      let n = 0;
      for (const p of list) {
        if (n++ > 150) break;
        ev({ t: "pop", x: p.x, y: p.y, r: p.r });
        query(p.x, p.y, p.r, e => { hitEnemy(e, p.dmg, 0, 1, 2, "chain"); });
      }
    }

    function hurtFlash(dmg, e) {
      if (st.god || st.practice || st.t < st.safeUntil) return;
      dmg *= Math.pow(st.intensity, DR.dmgPow);
      if (st.mode === "learn") dmg *= LEARN_DMG;          // 1 (normal) unless set
      const f = st.flash, s = f.stats;
      if (rnd() < Math.min(s.get("dodge"), S.dodgeCap)) { ev({ t: "dodge" }); return; }
      if (rnd() < s.get("ignore_damage_chance")) { ev({ t: "dodge" }); return; }
      let d = Math.max(S.minDamage, dmg * (1 - s.get("defence")));
      if (st.shield > 0 && st.shieldUntil > st.t) {             // Magic Shield soaks it first
        const soak = Math.min(st.shield, d); st.shield -= soak; d -= soak;
        ev({ t: "shield_hit", left: st.shield });
        if (d <= 0) return;
      }
      f.hp -= d; f.hurtT = 0.15;
      if (st.mode === "learn" && LEARN_FLOOR > 0) f.hp = Math.max(f.hp, f.maxHp() * LEARN_FLOOR);   // off unless set
      const who = e ? (e.elite ? "elite_" + e.type : e.type) : "explosion";
      st.lastHitBy = who;
      if (tel) { add(tel.taken_by, who, d); acc1.taken += d; if (accR) accR.taken += d; }
      ev({ t: "hurt", v: Math.round(d) });
      if (e && e.alive) {
        const th = s.get("thorns") + d * s.get("thorns_pct");
        if (th > 0) hitEnemy(e, th, 0, 1, 0, "thorns");
      }
      if (f.hp <= 0 && !nineLives()) gameOver();
    }
    // 😼 Nine Lives (a rare item): once per charm, Flash gets back up instead of falling
    function livesLeft() { return Math.max(0, Math.floor(st.flash.stats.get("nine_lives") + 1e-6) - st.livesUsed); }
    function nineLives() {
      if (livesLeft() <= 0) return false;
      st.livesUsed++;
      const f = st.flash; f.hp = f.maxHp() * FEEL.revive_hp; f.hurtT = 0;
      st.safeUntil = st.t + FEEL.revive_safe;
      // he springs up and everything close is thrown back
      query(CX, CY, FEEL.revive_radius, (e, d2) => {
        hitEnemy(e, FEEL.revive_damage + 4 * st.level, 0, 1, 0, "nine_lives", "holy");
        if (e.alive && !e.boss) { const d = Math.sqrt(d2) || 1, k = 700 * (1 - d / (FEEL.revive_radius + 40)) / e.size; e.kx += (e.x - CX) / d * k; e.ky += (e.y - CY) / d * k; }
      });
      st.eproj = [];
      if (tel) (tel.revives = tel.revives || []).push(Math.round(st.fightT));
      ev({ t: "revive", x: CX, y: CY, left: livesLeft(), r: FEEL.revive_radius });
      ev({ t: "big", k: "revive", x: CX, y: CY });
      return true;
    }
    // ---- 🐟 fish: picked up when Flash is close (if he has room), eaten by a tap, H, or by himself
    function updatePickups(dt) {
      if (!st.pickups.length && !(st.autoEat && st.fish)) return;
      const f = st.flash, mag = FI.magnet * Math.max(1, f.stats.get("pickup_range"));
      for (const p of st.pickups) {
        if (st.t > p.until) { p.gone = true; ev({ t: "fish", k: "lost", x: p.x, y: p.y }); continue; }
        if (st.fish >= FI.carry) continue;                       // his arms are full
        const dx = CX - p.x, dy = CY - p.y, d = Math.hypot(dx, dy) || 1;
        if (d < 22) { p.gone = true; st.fish++; ev({ t: "fish", k: "got", x: p.x, y: p.y, n: st.fish }); continue; }
        if (d < mag) { const v = Math.min(d, (240 + (mag - d) * 4) * dt); p.x += dx / d * v; p.y += dy / d * v; }
      }
      st.pickups = st.pickups.filter(p => !p.gone);
      if (st.autoEat && st.fish > 0 && f.hp / f.maxHp() < FI.auto_below && st.t >= st.eatAt) eatFish(true);
    }
    function eatFish(auto) {
      const f = st.flash;
      if (!f || st.fish <= 0 || (st.phase !== "fight" && st.phase !== "break") || f.hp >= f.maxHp() - 0.5) return false;
      if (st.phase === "fight" && st.t < st.eatAt) return false;       // one at a time (eat_gap)
      st.fish--; st.eatAt = st.t + FI.eat_gap;
      const was = f.hp; f.hp = Math.min(f.maxHp(), f.hp + f.maxHp() * FI.heal * f.stats.get("healing_power"));
      if (tel) add(tel.fish = tel.fish || {}, auto ? "auto" : "eaten", 1);
      ev({ t: "fish", k: "eat", auto: !!auto, heal: Math.round(f.hp - was), n: st.fish });
      return true;
    }

    function updateEnemies(dt) {
      const es = st.enemies;
      for (let i = 0; i < es.length; i++) {
        const e = es[i];
        if (!e.alive) continue;
        if (e.hitT > 0) e.hitT -= dt;
        if (e.held) { e.attacking = false; continue; }            // in a paw: it can't walk or bite
        if (e.regen > 0 && e.hp < e.max) e.hp = Math.min(e.max, e.hp + e.regen * dt);
        let move = 1;
        if (e.fx) { move = statusTick(e, dt); if (!e.alive) continue; }
        if (e.slowMul != null) { move *= e.slowMul; e.slowMul = null; }
        // knockback velocity
        e.x += e.kx * dt; e.y += e.ky * dt; e.kx *= 0.86; e.ky *= 0.86;
        const dx = CX - e.x, dy = CY - e.y, d = Math.hypot(dx, dy) || 1;
        const reach = e.ranged ? e.range : st.flash.r + e.r + Math.min(e.range, 40) * 0.5;
        if (d > reach) {
          e.attacking = false;
          e.x += dx / d * e.speed * dt * move; e.y += dy / d * e.speed * dt * move;
        } else {
          e.attacking = move > 0;
          e.atkT -= dt * (move > 0 ? Math.max(0.4, move) : 0);
          if (e.atkT <= 0) {
            e.atkT = 1 / e.atkSpd;
            if (e.ranged) st.eproj.push({ x: e.x, y: e.y, vx: dx / d * RG.arrow, vy: dy / d * RG.arrow, dmg: e.dmg, alive: true, life: 4 * 240 / RG.arrow, src: e, colour: e.colour });
            else hurtFlash(e.dmg, e);
          }
        }
      }
      // light separation so the horde spreads into a crowd instead of one dot.
      // Staggered (half the crowd each step) and capped per skeleton, so it
      // stays cheap when thousands are packed together.
      const big = es.length > 1500, half = (st.frame = (st.frame || 0) + 1) & 1;
      const cap = es.length > 4000 ? 2 : 4;
      for (let i = big ? half : 0; i < es.length; i += big ? 2 : 1) {
        const e = es[i]; if (!e.alive || e.held) continue;
        let n = 0, seen = 0;
        query(e.x, e.y, e.r, o => {
          if (o === e || o.held) return;
          if (++seen > 12) return false;
          const dx = e.x - o.x, dy = e.y - o.y, d = Math.hypot(dx, dy) || 0.01, ov = e.r + o.r - d;
          if (ov > 0) { const k = ov * (big ? 0.5 : 0.35) / d; e.x += dx * k; e.y += dy * k; o.x -= dx * k; o.y -= dy * k; if (++n >= cap) return false; }
        });
      }
      // enemy projectiles
      for (const p of st.eproj) {
        if (!p.alive) continue;
        p.x += p.vx * dt; p.y += p.vy * dt; p.life -= dt;
        if (p.life <= 0) { p.alive = false; continue; }
        const dx = p.x - CX, dy = p.y - CY;
        if (dx * dx + dy * dy < (st.flash.r + 5) ** 2) { p.alive = false; hurtFlash(p.dmg, p.src); }
      }
      st.eproj = st.eproj.filter(p => p.alive);
    }

    function compact() {
      const es = st.enemies; let j = 0;
      for (let i = 0; i < es.length; i++) {
        const e = es[i];
        if (e.alive) es[j++] = e;
        else if (e.explodes) { e.explodes = false; ev({ t: "explode", x: e.x, y: e.y, r: 60, enemy: true });
          const dx = e.x - CX, dy = e.y - CY; if (dx * dx + dy * dy < 80 * 80) hurtFlash(e.dmg, null); }
      }
      es.length = j;
    }

    // =================================================================
    // Spells, status effects, bosses and the shop (2 Nov)
    // =================================================================
    // Everything here reads Gamebase data: spells, status_effects, bosses,
    // boss_schedule, shop_stock, and the Game settings rows "shop" / "boss".
    const SPELLS = byId(data.spells), STATUS = byId(data.status_effects), BOSSES = byId(data.bosses);
    const BOSS_SCHED = data.boss_schedule || [], SHOP = data.shop_stock || [];
    const SPELL_COLOUR = { fire: 0xff7a2a, ice: 0xaee8ff, lightning: 0xd8c8ff, dark: 0xa66cff, poison: 0x8fe36a,
                           wind: 0xdff5ec, earth: 0xc8a070, holy: 0xfff0a0, arcane: 0x7cc4ff };
    const spellColour = d => SPELL_COLOUR[d.element] || 0xb59aff;
    const SH = { slots: set("shop", "stock_slots", 5), reroll: set("shop", "reroll_cost", 25),
                 growth: set("shop", "price_scaling_per_stage", 0.02), potion: set("shop", "potion_heal", 0.4),
                 // Dan (9 Nov): "shop items need to scale ... some levels, we have absolutely
                 // massive amounts of cash, and nothing really special to buy"
                 power: set("shop", "item_power_per_stage", 0),          // an item bought at stage s is (1 + power*(s-1)) as strong
                 shift: set("shop", "rarity_shift_per_stage", 0),        // rarer tiers turn up more often stage by stage
                 vaultFrom: set("shop", "vault_from_stage", 0),          // 💎 one rare-or-better item, from this stage (0 = never)
                 vaultMarkup: set("shop", "vault_markup", 1.4),
                 upFrom: set("shop", "weapon_upgrade_from_stage", 0),    // ⬆ upgrade a weapon you own, for gold (0 = never)
                 upPrice: set("shop", "weapon_upgrade_price", 70),
                 upGrowth: set("shop", "weapon_upgrade_price_per_level", 0.35) };
    const TIER = { common: 0, uncommon: 1, rare: 2, epic: 3, legendary: 4, mythical: 5 };
    const stageK = k => 1 + Math.max(0, st.stage - 1) * k;
    // an item's numbers, k times as strong (add and add_pct; anything else as it is)
    const scaleFx = (fx, k) => k === 1 ? fx : (fx || []).map(e => (e.op === "add" || e.op === "add_pct") && typeof e.value === "number"
      ? Object.assign({}, e, { value: Math.round(e.value * k * 1000) / 1000 }) : e);
    const BS = { first: set("boss", "first_stage", 10), every: set("boss", "every_stages", 10), hp: set("boss", "hp_mult", 1),
                 damage: set("boss", "damage_mult", 1), picks: set("boss", "bonus_picks", 2) };
    const FAVOUR = set("choices", "favour_current_build", 0.5);

    // ---- elements (Round 3 step 3, seed v21: Game settings → elements)
    // Dan: "elemental weapons (fire, ice, lightning in several colours, nuclear)".
    //   🔥 fire burns and spreads (to neighbours as it ticks, and when a burning skeleton falls)
    //   🧊 ice chills (slower), freezes after a few hits, frozen skeletons take extra damage and shatter
    //   ⚡ lightning chains and stuns
    //   ☢️ nuclear: a rare, huge blast that leaves a glowing zone
    // and combos: 🔥 on 🧊 = steam burst, ⚡ on 🧊 = superconduct, ⚡ on 🔥 = overload.
    // Spreads and combos are rationed per second, so 10,000 burning skeletons stay cheap.
    const es_ = (k, d) => set("elements", k, d);
    const ELS = {
      spread_chance: es_("burn_spread_chance", 0.3), spread_radius: es_("burn_spread_radius", 46), spread_on_death: es_("burn_spread_on_death", 2),
      spread_power: es_("burn_spread_power", 0.6), spreads_ps: es_("spreads_per_second", 90),
      chill_slow: es_("chill_slow", 0.4), chill_dur: es_("chill_duration", 2), freeze_hits: es_("freeze_after_hits", 3),
      shatter_bonus: es_("frozen_damage_bonus", 0.5), shatter_damage: es_("shatter_damage", 0.35), shatter_radius: es_("shatter_radius", 46),
      steam_damage: es_("steam_damage", 28), steam_radius: es_("steam_radius", 70),
      super_mult: es_("superconduct_mult", 2.5), overload_damage: es_("overload_damage", 24), overload_radius: es_("overload_radius", 56),
      combos_ps: es_("combos_per_second", 30), big_combo: es_("big_combo_hits", 8),
    };
    // a hit's element, from whatever did it: spells and weapons say theirs in Gamebase
    const EL = {};
    for (const s of Object.values(SPELLS)) if (s.element && s.element !== "none") EL[s.id] = s.element;
    for (const w of Object.values(D.weapons)) if (w.element && w.element !== "none") EL[w.id] = w.element;
    // per-second rations (token buckets), refilled every step
    const TOK = { spread: ELS.spreads_ps, combo: ELS.combos_ps };
    const tokMax = { spread: ELS.spreads_ps, combo: ELS.combos_ps };
    function tok(k, n) { if (TOK[k] < n) return false; TOK[k] -= n; return true; }
    function refill(dt) { for (const k in TOK) TOK[k] = Math.min(tokMax[k], TOK[k] + tokMax[k] * dt); }
    // 🐟 healing fish (seed v21: Game settings → fish). Dan: "carryable heal items (~5)"
    const fi_ = (k, d) => set("fish", k, d);
    const FI = { drop: fi_("drop_chance", 0.006), elite: fi_("elite_drop_chance", 0.25), boss: fi_("boss_drops", 2), horde: fi_("horde_drop_chance", 0.0004),
                 carry: fi_("carry", 5), heal: fi_("heal", 0.25), auto_below: fi_("auto_eat_below", 0.3), life: fi_("floor_seconds", 18),
                 floor_max: fi_("floor_max", 10), magnet: fi_("magnet_range", 70), eat_gap: fi_("eat_gap", 0.6) };
    // 🐾 paws, 😼 nine lives, ☢️ the nuke (seed v21: Game settings → feel)
    const fe_ = (k, d) => set("feel", k, d);
    const FEEL = { revive_hp: fe_("revive_hp", 0.5), revive_safe: fe_("revive_invulnerable", 2.5), revive_radius: fe_("revive_radius", 280),
                   revive_damage: fe_("revive_damage", 60), strike: fe_("strike_pins", 5) };

    // ---- status effects on skeletons
    const fxOf = e => e.fx || (e.fx = {});
    // 🧊 chill: slower for a moment; enough cold hits in a row and it freezes
    function chill(e, hits) {
      if (!e.alive) return;
      const x = fxOf(e), cold = (x.chill || 0) > st.t;
      x.chill = st.t + ELS.chill_dur;
      x.ice = (cold ? x.ice || 0 : 0) + (hits || 1);
      if (!e.boss && x.ice >= ELS.freeze_hits) { x.frozen = st.t + 2 * st.flash.stats.get("duration"); x.ice = 0; }
    }
    function spreadFire(e, burn, n) {
      let k = 0;
      query(e.x, e.y, ELS.spread_radius + e.r, o => {
        if (o === e || o.held || (o.fx && o.fx.burn && o.fx.burn.until > st.t)) return;
        applyStatus(o, "burn", Math.max(0.2, burn.dps / ((STATUS.burn || {}).damage_per_second || 5)) * ELS.spread_power, burn.src);
        if (++k >= n) return false;
      });
    }
    // combos: what a hit's element does to a skeleton already burning or frozen
    function combo(e, el, base, src) {
      const x = e.fx, frozen = (x.frozen || 0) > st.t, burning = !!x.burn && x.burn.until > st.t;
      let k = null;
      if ((el === "fire" && frozen) || (el === "ice" && burning)) k = "steam";
      else if (el === "lightning" && frozen) k = "superconduct";
      else if (el === "lightning" && burning) k = "overload";
      if (!k || !tok("combo", 1)) return;
      const pw = Math.max(1, base / 20);
      let n = 0;
      if (k === "steam") {             // the ice melts, the fire goes out, and a scalding cloud bursts
        x.frozen = 0; x.burn = null; x.chill = 0;
        query(e.x, e.y, ELS.steam_radius, o => { n++; chill(o, 0); hitEnemy(o, ELS.steam_damage * pw, 0, 1, 3, "steam", "steam"); });
      } else if (k === "superconduct") {   // a frozen skeleton conducts: the bolt hits it far harder and it shatters
        n = 1; hitEnemy(e, base * ELS.super_mult + e.max * 0.15, 0, 1, 6, src, "superconduct");
        if (e.alive) x.frozen = 0;
      } else {                          // fire and lightning: it overloads and goes off
        query(e.x, e.y, ELS.overload_radius, o => { n++; hitEnemy(o, ELS.overload_damage * pw, 0, 1, 8, "overload", "overload");
          if (o.alive && o !== e) applyStatus(o, "burn", 0.5, x.burn ? x.burn.src : src); });
      }
      ev({ t: "combo", k, x: e.x, y: e.y, n, r: k === "steam" ? ELS.steam_radius : k === "overload" ? ELS.overload_radius : 30 });
      if (n >= ELS.big_combo) ev({ t: "big", k, x: e.x, y: e.y });
      if (tel) add(tel.combos = tel.combos || {}, k, 1);
    }
    function applyStatus(e, id, power, src, extraChance) {
      if (!e.alive || !id) return;
      const row = STATUS[id] || {}, f = st.flash.stats, x = fxOf(e);
      const dur = (row.duration || 3) * f.get("duration");
      const chance = (row.chance == null ? 1 : row.chance) + f.get("effect_chance") + (extraChance || 0);
      if (id === "burn" || id === "poison" || id === "bleed") {
        const dps = (row.damage_per_second || 5) * (power || 1), cur = x[id];
        const grow = cur && cur.until > st.t && row.stacking === "refresh_and_increase";
        x[id] = { dps: grow ? Math.min(dps * 3, cur.dps + dps * 0.5) : Math.max(dps, cur && cur.until > st.t ? cur.dps : 0), until: st.t + dur, src };
      } else if (id === "freeze") { chill(e, 1); if (!e.boss && rnd() < chance) x.frozen = st.t + dur; }
      else if (id === "shock") { if (rnd() < chance) { if (!e.boss) x.stun = st.t + (row.duration || 0.3); hitEnemy(e, (row.damage || 10) * (power || 1), 0, 1, 0, src); } }
      else if (id === "stun") { if (!e.boss) x.stun = st.t + dur; }
      else if (id === "knockback") { const dx = e.x - CX, dy = e.y - CY, d = Math.hypot(dx, dy) || 1; e.kx += dx / d * 500 / e.size; e.ky += dy / d * 500 / e.size; }
      else if (id === "plague_spread") x.plague = { until: st.t + dur + 2, src, power };
    }
    // burns and poisons tick twice a second; returns how fast this skeleton can move (0 = frozen)
    function statusTick(e, dt) {
      const x = e.fx;
      let dot = 0, src = null, el = null;
      for (const k of ["burn", "poison", "bleed"]) { const s = x[k]; if (s && s.until > st.t) { dot += s.dps; src = s.src; el = k === "burn" ? "fire" : k === "poison" ? "poison" : null; } }
      if (dot > 0) {
        x.acc = (x.acc || 0) + dot * dt; x.tickT = (x.tickT || 0) + dt;
        if (x.tickT >= 0.5) {
          const d = x.acc; x.acc = 0; x.tickT = 0;
          // a burn tick can catch the skeleton next to it
          if (x.burn && x.burn.until > st.t && rnd() < ELS.spread_chance && tok("spread", 1)) spreadFire(e, x.burn, 1);
          hitEnemy(e, d, 0, 1, 0, src, el === "fire" ? "burn" : el);
        }
      }
      if ((x.frozen || 0) > st.t || (x.stun || 0) > st.t) return 0;
      if ((x.chill || 0) > st.t) return e.boss ? 1 - ELS.chill_slow * 0.5 : 1 - ELS.chill_slow;
      return 1;
    }

    // ---- spells: owned like weapons, but unlimited, and they cast themselves
    function addSpell(id) {
      const def = SPELLS[id]; if (!def || st.spellOwned[id]) return null;
      const s = { uid: st.nextId++, id, def, level: 1, mods: [], cd: 0.6 + rnd() * 0.8 };
      st.spells.push(s); st.spellOwned[id] = s;
      return s;
    }
    function spp(s) {       // a spell's effective numbers right now
      const f = st.flash.stats, d = s.def, m = k => modSum(s.mods, k);
      const lv = 1 + 0.15 * (s.level - 1), pw = m("damage").mul * lv * f.get("damage") * f.get("spell_damage");
      return {
        damage: (d.damage || 0) * pw, dps: (d.damage_per_second || 0) * pw, power: pw,
        cooldown: (d.cooldown || 5) * Math.max(0.35, 1 - m("cooldown_reduction").A - f.get("cooldown_reduction") - 0.04 * (s.level - 1)),
        radius: (d.radius || 0) * m("area").mul * f.get("area"), range: d.range || 400,
        duration: (d.duration || 3) * m("duration").mul * f.get("duration"),
        count: Math.max(1, Math.round((d.projectile_count || 1) + m("projectile_count").A)),
        targets: Math.max(1, (d.targets || 1) + m("targets").A + Math.floor((s.level - 1) / 2)),
        summons: Math.max(1, (d.summons || 1) + Math.floor((s.level - 1) / 3)),
        summonDur: (d.summon_duration || 8) * m("summon_duration").mul * f.get("duration"),
        heal: ((d.heal || 0) + (d.heal_per_second || 0)) * m("healing_power").mul * f.get("healing_power"),
        shield: (d.shield || 0) * lv, chance: m("effect_chance").A,
        critC: f.get("crit_chance"), critD: f.get("crit_damage"),
      };
    }
    function countNear(x, y, r) { let n = 0; query(x, y, r, () => { n++; }); return n; }
    function castSpell(s) {
      const d = s.def, p = spp(s), b = d.behaviour, c = spellColour(d), src = s.id, f = st.flash;
      const fxs = d.applies_effects || [], hpFrac = f.hp / f.maxHp();
      const hitAll = (x, y, r, dmg, kb) => query(x, y, r, e => { hitEnemy(e, dmg, p.critC, p.critD, kb || 0, src); for (const id of fxs) applyStatus(e, id, p.power, src, p.chance); });
      if (b === "projectile") {
        const ts = targets(d.targeting === "spread" ? "spread" : "smart", p.range, p.count);
        if (!ts.length) return false;
        for (let i = 0; i < p.count; i++) {
          const t = ts[i % ts.length], a = Math.atan2(t.y - CY, t.x - CX) + (i >= ts.length ? (rnd() - 0.5) * 0.5 : 0);
          t.incoming += p.damage;
          st.proj.push({ x: CX, y: CY, vx: Math.cos(a) * 420, vy: Math.sin(a) * 420, r: 9, w: src, b: p.radius ? "explosive_projectile" : "projectile",
            dmg: p.damage, critC: p.critC, critD: p.critD, kb: 0, pierce: d.pierce || 0, bounces: 0, radius: p.radius || 60,
            life: p.range / 420, back: false, hit: new Set(), target: t, expl: 0, speed: 420, alive: true,
            homing: d.targeting !== "spread", spell: true, c, fx: fxs, power: p.power, chance: p.chance });
        }
        ev({ t: "cast", s: src, k: "projectile", c });
        return true;
      }
      if (b === "chain") {
        const [t0] = targets("smart", 340, 1); if (!t0) return false;
        const hit = new Set([t0.id]), pts = [{ x: CX, y: CY }, { x: t0.x, y: t0.y }];
        hitEnemy(t0, p.damage, p.critC, p.critD, 0, src); applyStatus(t0, "shock", p.power, src, p.chance);
        let cur = t0;
        for (let j = 0; j < p.targets; j++) {
          let best = null, bd = 1e9;
          query(cur.x, cur.y, 180, (o, d2) => { if (!hit.has(o.id) && d2 < bd) { bd = d2; best = o; } });
          if (!best) break;
          hit.add(best.id); hitEnemy(best, p.damage * 0.85, p.critC, p.critD, 0, src); applyStatus(best, "shock", p.power, src, p.chance);
          pts.push({ x: best.x, y: best.y }); cur = best;
        }
        ev({ t: "cast", s: src, k: "chain", pts, c });
        return true;
      }
      if (b === "nova" || b === "ground_area") {
        const r = p.radius || 150; if (!countNear(CX, CY, r)) return false;
        hitAll(CX, CY, r, p.damage, b === "ground_area" ? 30 : 6);
        ev({ t: "cast", s: src, k: b === "nova" ? "nova" : "quake", x: CX, y: CY, r, c });
        return true;
      }
      if (b === "area_drop") {
        const ts = targets("random", 460, 4 + s.level); if (!ts.length) return false;
        const r = p.radius || 100, drops = [];
        ts.forEach((t, i) => { const at = st.t + 0.55 + i * 0.16; st.delayed.push({ at, x: t.x, y: t.y, r, dmg: p.damage, src, fx: fxs, power: p.power, c }); drops.push({ x: t.x, y: t.y, at }); });
        ev({ t: "cast", s: src, k: "meteors", drops, r, c });
        return true;
      }
      if (b === "vortex") {
        const [t] = targets("smart", 360, 1); if (!t) return false;
        st.zones.push({ k: "tornado", x: t.x, y: t.y, r: p.radius || 90, dps: p.dps, until: st.t + p.duration, src, c, tick: 0 });
        ev({ t: "cast", s: src, k: "tornado", c });
        return true;
      }
      if (b === "drain") {
        const r = p.radius || 120; if (countNear(CX, CY, r) < 2) return false;
        st.zones.push({ k: "drain", follow: true, x: CX, y: CY, r, dps: p.dps, until: st.t + p.duration, src, c, tick: 0, hits: [] });
        ev({ t: "cast", s: src, k: "drain", c });
        return true;
      }
      if (b === "mark") {
        const [t] = targets("strongest", 460, 1); if (!t || (t.fx && t.fx.mark > st.t)) return false;
        const x = fxOf(t); x.mark = st.t + p.duration; x.markB = d.damage_taken_bonus || 0.4;
        ev({ t: "cast", s: src, k: "mark", id: t.id, x: t.x, y: t.y, c });
        return true;
      }
      if (b === "spread") {
        const ts = targets("nearest", 320, 2 + s.level); if (!ts.length) return false;
        for (const e of ts) { const x = fxOf(e); x.poison = { dps: Math.max(p.dps, 1), until: st.t + p.duration, src }; x.plague = { until: st.t + p.duration + 2, src, power: p.power }; }
        ev({ t: "cast", s: src, k: "plague", pts: ts.map(e => ({ x: e.x, y: e.y })), c });
        return true;
      }
      if (b === "curse") {
        const ts = targets("smart", 360, 4 + s.level); if (!ts.length) return false;
        for (const e of ts) { const x = fxOf(e); x.curse = st.t + p.duration; x.curseD = d.defence_reduction || 0.2; hitEnemy(e, p.damage, p.critC, p.critD, 0, src); }
        ev({ t: "cast", s: src, k: "curse", pts: ts.map(e => ({ x: e.x, y: e.y })), c });
        return true;
      }
      if (b === "death_burst") {
        const r = 230; if (countNear(CX, CY, r) < 3) return false;
        query(CX, CY, r, e => { fxOf(e).burst = { until: st.t + 4, dmg: p.damage, r: p.radius || 100, src }; });
        ev({ t: "cast", s: src, k: "souls", x: CX, y: CY, r, c });
        return true;
      }
      if (b === "shield") {
        if (st.shieldUntil > st.t || (countNear(CX, CY, 220) < 3 && hpFrac > 0.8)) return false;
        st.shield = p.shield; st.shieldMax = p.shield; st.shieldUntil = st.t + p.duration;
        ev({ t: "cast", s: src, k: "shield", c });
        return true;
      }
      if (b === "heal_aura") {
        if (hpFrac > 0.85) return false;
        st.zones.push({ k: "heal", follow: true, x: CX, y: CY, r: 60, hps: p.heal, until: st.t + p.duration, src, c });
        ev({ t: "cast", s: src, k: "heal", c });
        return true;
      }
      if (b === "heal_burst") {
        const r = p.radius || 130;
        if (hpFrac > 0.9 && countNear(CX, CY, r) < 4) return false;
        f.hp = Math.min(f.maxHp(), f.hp + p.heal);
        hitAll(CX, CY, r, p.damage, 4);
        ev({ t: "cast", s: src, k: "holy", x: CX, y: CY, r, c });
        return true;
      }
      if (b === "slow_field") {
        const r = p.radius || 200; if (countNear(CX, CY, r) < 4) return false;
        st.zones.push({ k: "slow", x: CX, y: CY, r, mul: 1 - (d.slow || 0.4), until: st.t + p.duration, src, c });
        ev({ t: "cast", s: src, k: "slow", x: CX, y: CY, r, c });
        return true;
      }
      if (b === "summon") {
        if (!countNear(CX, CY, 450)) return false;
        for (let i = 0; i < p.summons; i++) {
          const a = rnd() * 6.283;
          st.allies.push({ id: st.nextId++, kind: s.id === "ghost_cats" ? "ghost_cat" : "wolf", x: CX + Math.cos(a) * 30, y: CY + Math.sin(a) * 30,
            dmg: p.damage, until: st.t + p.summonDur, cd: 0, speed: 240, src, c, r: 10 });
        }
        ev({ t: "cast", s: src, k: "summon", c });
        return true;
      }
      if (b === "convert") {
        let best = null, bd = 1e12;
        query(CX, CY, 320, (e, d2) => { if (!e.boss && !e.fodder && !e.elite && d2 < bd) { bd = d2; best = e; } });
        if (!best) return false;
        best.alive = false;                                   // leaves the horde (no XP: he's on our side now)
        st.allies.push({ id: st.nextId++, kind: "bone", type: best.type, colour: best.colour, size: best.size, x: best.x, y: best.y,
          dmg: Math.max(10, best.dmg * 2), until: st.t + p.duration, cd: 0, speed: Math.max(120, best.speed * 1.6), src, c: 0x8fe36a, r: best.r });
        ev({ t: "cast", s: src, k: "convert", x: best.x, y: best.y, c: 0x8fe36a });
        return true;
      }
      if (b === "nuke") {
        // ☢️ rare and huge: it waits for a real crowd, lobs itself at the thickest
        // part, and goes off a moment later, leaving a glowing zone
        const r = p.radius || 260, ts = targets("random", 520, 14), need = d.min_targets || 25;
        let best = null, bn = 0;
        for (const t of ts) { const n = countNear(t.x, t.y, r * 0.6); if (n > bn) { bn = n; best = t; } }
        if (!best || bn < need) return false;
        const at = st.t + 1.1;
        st.delayed.push({ at, x: best.x, y: best.y, r, dmg: p.damage, src, nuke: true, power: p.power,
          zr: (d.zone_radius || 150) * modSum(s.mods, "area").mul * f.stats.get("area"), zdps: (d.zone_dps || 20) * p.power, zdur: (d.zone_duration || 5) * f.stats.get("duration") });
        ev({ t: "cast", s: src, k: "nuke", x: best.x, y: best.y, r, at, c });
        return true;
      }
      return false;
    }
    function castSpells(dt) {
      for (const s of st.spells) {
        s.cd -= dt;
        if (s.cd <= 0) s.cd = castSpell(s) ? spp(s).cooldown : 0.3;
      }
    }
    function updateZones(dt) {
      const f = st.flash;
      for (const z of st.zones) {
        if (z.follow) { z.x = CX; z.y = CY; }
        if (z.k === "tornado") {
          let best = null, bd = 1e12;
          query(z.x, z.y, 320, (e, d2) => { if (d2 < bd) { bd = d2; best = e; } });
          if (best) { const dx = best.x - z.x, dy = best.y - z.y, d = Math.hypot(dx, dy) || 1; z.x += dx / d * 70 * dt; z.y += dy / d * 70 * dt; }
          query(z.x, z.y, z.r, e => { if (!e.boss) { e.x += (z.x - e.x) * 2.2 * dt; e.y += (z.y - e.y) * 2.2 * dt; } });
        }
        if (z.k === "tornado" || z.k === "drain") {
          z.tick += dt;
          if (z.tick >= 0.25) {
            const dmg = z.dps * z.tick; z.tick = 0; let dealt = 0; z.hits = [];
            query(z.x, z.y, z.r, e => { dealt += hitEnemy(e, dmg, 0, 1, 0, z.src); if (z.hits && z.hits.length < 8) z.hits.push({ x: e.x, y: e.y }); });
            if (z.k === "drain" && dealt > 0) f.hp = Math.min(f.maxHp(), f.hp + dealt * 0.3 * f.stats.get("healing_power"));
          }
        }
        if (z.k === "rad") {                                   // ☢️ the glow left behind
          z.tick += dt;
          if (z.tick >= 0.25) { const dmg = z.dps * z.tick; z.tick = 0; query(z.x, z.y, z.r, e => { hitEnemy(e, dmg, 0, 1, 0, z.src, "rad"); }); }
        }
        if (z.k === "heal") f.hp = Math.min(f.maxHp(), f.hp + z.hps * dt);
        if (z.k === "slow") query(z.x, z.y, z.r, e => { e.slowMul = Math.min(e.slowMul == null ? 1 : e.slowMul, e.boss ? Math.max(z.mul, 0.7) : z.mul); });
      }
      st.zones = st.zones.filter(z => z.until > st.t);
      if (st.shieldUntil <= st.t) st.shield = 0;
    }
    function updateAllies(dt) {
      for (const a of st.allies) {
        let best = null, bd = 1e12;
        query(a.x, a.y, 420, (e, d2) => { if (d2 < bd) { bd = d2; best = e; } });
        if (!best) {                                         // nothing to bite: stay with Flash
          const dx = CX - a.x, dy = CY - a.y, d = Math.hypot(dx, dy) || 1;
          if (d > 50) { a.x += dx / d * a.speed * 0.6 * dt; a.y += dy / d * a.speed * 0.6 * dt; }
          continue;
        }
        const dx = best.x - a.x, dy = best.y - a.y, d = Math.sqrt(bd) || 1;
        a.face = dx >= 0 ? 1 : -1;
        if (d > best.r + a.r + 2) { a.x += dx / d * a.speed * dt; a.y += dy / d * a.speed * dt; }
        a.cd -= dt;
        if (a.cd <= 0 && d < best.r + a.r + 10) { a.cd = 0.55; hitEnemy(best, a.dmg, 0, 1, 3, a.src); ev({ t: "stab", x: best.x, y: best.y, w: a.src }); }
      }
      st.allies = st.allies.filter(a => a.until > st.t);
    }
    function nukeGoesOff(d) {
      let n = 0;
      query(d.x, d.y, d.r, (e, d2) => {
        n++;
        const k = 1 - Math.sqrt(d2) / (d.r + e.r);           // full damage in the middle, half at the edge
        hitEnemy(e, d.dmg * (0.5 + 0.5 * Math.max(0, k)), 0, 1, 0, d.src, "nuclear");
        if (e.alive && !e.boss) { const dx = e.x - d.x, dy = e.y - d.y, dd = Math.hypot(dx, dy) || 1; e.kx += dx / dd * 900 / e.size; e.ky += dy / dd * 900 / e.size; }
      });
      st.zones.push({ k: "rad", x: d.x, y: d.y, r: d.zr, dps: d.zdps, until: st.t + d.zdur, src: d.src, c: 0x9dff5a, tick: 0 });
      ev({ t: "nuke", x: d.x, y: d.y, r: d.r, zr: d.zr, n });
      ev({ t: "big", k: "nuke", x: d.x, y: d.y });
    }
    function updateDelayed() {
      if (!st.delayed.length) return;
      const keep = [];
      for (const d of st.delayed) {
        if (st.t < d.at) { keep.push(d); continue; }
        if (d.nuke) { nukeGoesOff(d); continue; }
        explode(d.x, d.y, d.r, d.dmg, 0, 1, d.src, d.fx, d.power, d.c);
      }
      st.delayed = keep;
    }

    // ---- bosses (boss_schedule: every 10 stages from stage 10)
    const BOSS_COLOUR = { skeleton_king: 0xffd23a, bone_dragon: 0xff7a4a, lich: 0xb59aff, bone_golem: 0xb8c4d0 };
    function bossRowFor(stage) {
      if (stage < BS.first || (stage - BS.first) % BS.every !== 0 || st.bossDone[stage]) return null;
      return BOSS_SCHED.find(r => stage >= r.from_stage && (r.to_stage == null || stage <= r.to_stage)) || null;
    }
    function spawnBoss(row) {
      st.bossDone[st.stage] = true;
      const pool = (row.boss_pool || []).filter(id => BOSSES[id]);
      const def = BOSSES[pickOne(pool.length ? pool : Object.keys(BOSSES))]; if (!def) return;
      const base = (D.base[def.base] && D.base[def.base].stats) || { max_hp: 40, damage: 5, attack_speed: 1, movement_speed: 60, attack_range: 60 };
      const hpMul = lerpStage(D.scaling, "hp_mult", st.stage) * T.enemy_hp * BS.hp;
      const dmgMul = lerpStage(D.scaling, "damage_mult", st.stage) * T.enemy_damage * BS.damage;
      const max = Math.max(50, (base.max_hp || 40) * (def.hp_multiplier || 60) * hpMul);
      const e = {
        id: st.nextId++, type: def.id, role: "boss", ranged: false, x: W / 2, y: -50, kx: 0, ky: 0, alive: true, elite: false,
        boss: def, size: 3, r: 30, max, hp: max, dmg: (base.damage || 5) * dmgMul * 3, atkSpd: 0.7, range: 60,
        speed: (base.movement_speed || 60) * 0.55 * T.enemy_speed, def: 0.1, regen: 0, lifesteal: 0, atkT: 1, attacking: false,
        incoming: 0, hitT: 0, xp: def.xp || 250, gold: def.gold || 100, colour: BOSS_COLOUR[def.id] || 0xff6a6a, explodes: false,
        phase: 1, phases: Math.max(1, def.phases || 1), specT: 3, sumT: 5,
      };
      st.enemies.push(e); st.boss = e;
      if (tel) tel.bosses.push({ id: def.id, stage: st.stage, round: st.round, spawned: Math.round(st.fightT), down: null });
      ev({ t: "boss", id: def.id, name: def.name, encounter: row.encounter || "" });
    }
    function updateBoss(dt) {
      const e = st.boss;
      if (!e || !e.alive) { st.boss = null; return; }
      // phases: at each threshold the boss gets angrier
      const want = Math.min(e.phases, 1 + Math.floor((1 - e.hp / e.max) * e.phases));
      if (want > e.phase) { e.phase = want; e.speed *= 1.2; e.atkSpd *= 1.25; ev({ t: "boss_phase", phase: e.phase, name: e.boss.name }); }
      e.specT -= dt;
      if (e.specT <= 0) {
        e.specT = 3.6 / (1 + 0.3 * (e.phase - 1));
        const atk = pickOne(e.boss.attacks || ["slam"]) || "slam";
        const dx = CX - e.x, dy = CY - e.y, a0 = Math.atan2(dy, dx);
        if (/breath/.test(atk)) {
          for (let i = -3; i <= 3; i++) { const a = a0 + i * 0.12; st.eproj.push({ x: e.x, y: e.y, vx: Math.cos(a) * 260, vy: Math.sin(a) * 260, dmg: e.dmg * 0.5, alive: true, life: 4, src: e, colour: 0xff8a3a }); }
        } else if (/volley/.test(atk)) {
          for (let i = 0; i < 12; i++) { const a = i / 12 * 6.283; st.eproj.push({ x: e.x, y: e.y, vx: Math.cos(a) * 200, vy: Math.sin(a) * 200, dmg: e.dmg * 0.45, alive: true, life: 5, src: e, colour: 0xb59aff }); }
        } else if (/tail|sweep|nova/.test(atk)) {
          st.tele.push({ x: e.x, y: e.y, r: /nova/.test(atk) ? 230 : 160, at: st.t + 1.1, dmg: e.dmg * 1.2, src: e, c: /nova/.test(atk) ? 0xa66cff : 0xff7a4a, follow: e });
        } else {   // slam / smash: where Flash is standing now
          st.tele.push({ x: CX, y: CY, r: 95, at: st.t + 1.15, dmg: e.dmg * 1.6, src: e, c: 0xff5a3a });
        }
        ev({ t: "boss_attack", kind: atk });
      }
      if (e.boss.summons) {
        e.sumT -= dt;
        if (e.sumT <= 0) {
          e.sumT = 7 / (1 + 0.3 * (e.phase - 1));
          for (let i = 0; i < 2 + e.phase; i++) spawnEnemy(false, e.boss.summons, { x: e.x + (rnd() - 0.5) * 120, y: e.y + (rnd() - 0.5) * 120 });
          ev({ t: "boss_summon", x: e.x, y: e.y });
        }
      }
    }
    function updateTele() {
      if (!st.tele.length) return;
      const keep = [];
      for (const t of st.tele) {
        if (t.follow && t.follow.alive) { t.x = t.follow.x; t.y = t.follow.y; }
        if (st.t < t.at) { keep.push(t); continue; }
        ev({ t: "explode", x: t.x, y: t.y, r: t.r, enemy: true, c: t.c });
        if (Math.hypot(CX - t.x, CY - t.y) < t.r + st.flash.r * 0.5) hurtFlash(t.dmg, t.src);
      }
      st.tele = keep;
    }
    function bossDown(e) {
      st.boss = null; st.bossesKilled = (st.bossesKilled || 0) + 1;
      st.tele = [];
      st.pending += BS.picks;
      if (tel) { const b = tel.bosses.filter(x => x.id === e.type && x.down == null).pop(); if (b) b.down = Math.round(st.fightT); }
      ev({ t: "boss_down", id: e.type, name: e.boss.name, x: e.x, y: e.y, picks: BS.picks });
    }

    // ---- the shop, in the break between rounds
    function spellOffer(sp) {
      return { kind: "spell", id: sp.id, name: sp.name, rarity: sp.rarity || "uncommon", desc: sp.description || "", tag: "New spell" };
    }
    function shopOffer(row) {
      const k = row.kind; let o = null;
      if (k === "item") {
        const pool = D.items.filter(it => it.effects && it.effects.length && (it.rarity || "common") === (row.rarity || "common"));
        const it = pickOne(pool);
        if (it) {
          const pw = Math.round(stageK(SH.power) * 100) / 100, fx = scaleFx(it.effects, pw);
          o = { kind: "item", id: it.id, name: it.name, rarity: it.rarity || "common", desc: pw > 1 ? fmtMods(fx) : (it.description || fmtMods(it.effects)), effects: fx, pow: pw };
        }
      } else if (k === "weapon") {
        if (st.weapons.length < S.slots + (st.tail ? 1 : 0)) {
          const w = pickOne(Object.values(D.weapons).filter(w => !st.owned[w.id] && (w.unlock_stage || 1) <= Math.max(2, st.stage)));
          if (w) o = { kind: "weapon", id: w.id, name: w.name, rarity: w.rarity || "common", desc: w.description || "" };
        }
      } else if (k === "spell") {
        const sp = pickOne(Object.values(SPELLS).filter(s => !st.spellOwned[s.id] && (s.unlock_stage || 1) <= Math.max(1, st.stage)));
        if (sp) o = spellOffer(sp);
      } else if (k === "upgrade") {
        const u = pickOne(D.upgrades.filter(u => u.applies_to === "global" && u.effects && u.effects.length));
        if (u) o = { kind: "stat", id: u.id, name: u.name, rarity: u.rarity || "common", desc: fmtMods(u.effects), effects: u.effects };
      } else if (k === "consumable") {
        o = { kind: "potion", id: row.id, name: row.name || "Healing potion", rarity: "common", desc: `Heals ${Math.round(SH.potion * 100)}% of Flash's HP now` };
      }
      if (!o) return null;
      return Object.assign(o, { row: row.id, price: Math.round((row.price || 50) * (1 + (st.stage - 1) * SH.growth)), tag: o.pow > 1.05 ? `×${o.pow.toFixed(1)} power` : "Shop" });
    }
    // ⬆ a weapon you own, one level, for gold
    function weaponUpOffer() {
      const ws = st.weapons.slice(); if (!ws.length) return null;
      for (let tries = 0; tries < 6; tries++) {
        const w = pickOne(ws);
        const ups = D.upgrades.filter(u => u.applies_to === "weapon" && u.effects && u.effects.length).filter(u => {
          const s0 = (u.effects[0] || {}).stat;
          if (["projectile_speed", "pierce", "bounces"].includes(s0) && !PROJECTILE(w.def.behaviour)) return false;
          return !(s0 === "bounces" && w.def.behaviour !== "bouncing_projectile");
        });
        const u = pickOne(ups); if (!u) continue;
        return { kind: "wup", id: u.id, wuid: w.uid, wid: w.id, name: `${w.def.name} · ${u.name}`, rarity: u.rarity || "uncommon", desc: fmtMods(u.effects),
                 price: Math.round(SH.upPrice * (1 + SH.upGrowth * (w.level - 1)) * stageK(SH.growth)), tag: `⬆ Lv ${w.level} → ${w.level + 1}`, row: "weapon_upgrade" };
      }
      return null;
    }
    // 💎 the vault: one rare-or-better item, at a premium
    function vaultOffer() {
      const best = D.items.filter(it => it.effects && it.effects.length && (TIER[it.rarity] || 0) >= 2);
      if (!best.length) return null;
      const top = best.filter(it => (TIER[it.rarity] || 0) >= 3);
      const it = top.length && rnd() < 0.35 + 0.05 * st.stage ? pickOne(top) : pickOne(best);
      const row = SHOP.find(r => r.kind === "item" && r.rarity === it.rarity) || { price: 250 };
      const pw = Math.round(stageK(SH.power) * 100) / 100, fx = scaleFx(it.effects, pw);
      return { kind: "item", id: it.id, name: it.name, rarity: it.rarity, desc: fmtMods(fx), effects: fx, pow: pw, row: "vault",
               price: Math.round((row.price || 250) * SH.vaultMarkup * stageK(SH.growth)), tag: "💎 Vault" + (pw > 1.05 ? ` · ×${pw.toFixed(1)}` : "") };
    }
    function makeShop(rerolls) {
      const rows = SHOP.filter(r => r.kind !== "reroll"), out = [];
      if (SH.vaultFrom && st.stage >= SH.vaultFrom) { const v = vaultOffer(); if (v) out.push(v); }
      if (SH.upFrom && st.stage >= SH.upFrom) { const u = weaponUpOffer(); if (u) out.push(u); }
      // rarer tiers more often as the stages go up
      const w = r => r.kind === "item" ? rarityW(r.rarity) * (1 + SH.shift * (TIER[r.rarity] || 0) * Math.max(0, st.stage - 1)) * 4 : r.kind === "consumable" ? 0.5 : 0.7;
      const want = SH.slots + out.length;           // the vault and the upgrade come on top of the usual slots
      for (let tries = 0; rows.length && out.length < want && tries < 60; tries++) {
        const o = shopOffer(pickWeighted(rows, w));
        if (o && !out.some(x => x.kind === o.kind && x.id === o.id)) out.push(o);
      }
      st.shop = { items: out, rerolls: rerolls || 0 };
    }
    const rerollPrice = () => { const row = SHOP.find(r => r.kind === "reroll");
      return Math.round((row ? row.price : SH.reroll) * (1 + 0.5 * (st.shop ? st.shop.rerolls : 0)) * (1 + (st.stage - 1) * SH.growth)); };
    function buy(i) {
      const sh = st.shop; if (!sh || st.phase !== "break") return false;
      const o = sh.items[i]; if (!o || o.sold || st.gold < o.price) return false;
      st.gold -= o.price; o.sold = true;
      applyOffer(o);
      if (tel) tel.shop.push({ round: st.round, bought: offerKey(o), price: o.price });
      ev({ t: "bought", name: o.name, price: o.price });
      return true;
    }
    function reroll() {
      if (!st.shop || st.phase !== "break") return false;
      const price = rerollPrice(); if (st.gold < price) return false;
      st.gold -= price; makeShop(st.shop.rerolls + 1);
      if (tel) tel.shop.push({ round: st.round, bought: "reroll", price });
      return true;
    }
    // every offer a run takes, in order, so a saved run can be rebuilt (Dan:
    // "do we have a way to save the game state? ... in learning mode, the game
    // might last longer")
    function logOffer(o) {
      if (!st.log || o.kind === "potion") return;
      const l = { k: o.kind, id: o.id };
      if (o.pow && o.pow !== 1) l.p = o.pow;
      if (o.kind === "wup") { const w = st.weapons.find(x => x.uid === o.wuid); l.w = o.wid || (w && w.id); }
      if (o.kind === "sup") { const sp = st.spells.find(x => x.uid === o.suid); l.s = o.sid || (sp && sp.id); }
      st.log.push(l);
    }
    function applyOffer(o) {
      logOffer(o);
      if (o.kind === "weapon") addWeapon(o.id);
      else if (o.kind === "spell") addSpell(o.id);
      else if (o.kind === "wup") { const w = st.weapons.find(x => x.uid === o.wuid); const u = D.upgrades.find(x => x.id === o.id); if (w && u) { w.mods.push(...u.effects); w.level++; } }
      else if (o.kind === "sup") { const s = st.spells.find(x => x.uid === o.suid); const u = D.upgrades.find(x => x.id === o.id); if (s && u) { s.mods.push(...u.effects); s.level++; } }
      else if (o.kind === "tail") st.tail = true;
      else if (o.kind === "potion") { const f = st.flash; f.hp = Math.min(f.maxHp(), f.hp + f.maxHp() * SH.potion); }
      else if (o.effects) changeMax(() => st.flash.stats.add(o.effects, "perm"));
    }

    // ------------------------------------------------------------ rewards
    const DASH = { every: Math.max(1, set("words", "dash_every", 5)), radius: set("words", "dash_radius", 240),
                   damage: set("words", "dash_damage", 15), per_level: set("words", "dash_damage_per_level", 4),
                   knockback: set("words", "dash_knockback", 160) };
    function flashDash() {
      if (!st.flash || st.phase !== "fight") return;
      const dmg = DASH.damage + DASH.per_level * st.level, hits = [];
      buildGrid();                   // called between steps (a reward arrived): the grid may be stale
      query(CX, CY, DASH.radius, (e, d2) => hits.push([e, Math.sqrt(d2)]));
      for (const [e, d] of hits) hitEnemy(e, dmg, 0, 1, DASH.knockback * (0.5 + 0.5 * Math.max(0, 1 - d / DASH.radius)), "flash_dash");
      ev({ t: "dash", x: CX, y: CY, r: DASH.radius, n: hits.length, streak: st.streak });
      if (tel && tel.study.length < 5000) tel.study.push([Math.round(st.fightT * 10) / 10, "flash_dash", hits.length]);
    }
    function applyReward(d) {
      d = d || {};
      if (st.paused) return;               // a paused game earns nothing
      const kind = d.kind || "reward", source = d.source || "quiz";
      const logStudy = (what, strength) => { if (tel && tel.study.length < 5000) tel.study.push([Math.round(st.fightT * 10) / 10, what, strength]); };
      if (kind === "warning") { logStudy("warning", 0); st.warning = { text: d.message || "Flash needs quiz answers to survive!", until: st.t + 6 }; ev({ t: "warning", text: st.warning.text }); return; }
      if (typeof d.streak === "number") st.streak = d.streak;
      const row = D.rewards.find(r => r.kind === kind && r.source === source) || D.rewards.find(r => r.kind === kind);
      if (!row) return;
      const strength = clamp(d.strength == null ? 1 : +d.strength, 0, 1);
      if (row.kind === "penalty") {
        if (row.clears_buffs === "all") { for (const b of st.buffs) st.flash.stats.remove(b.id); st.buffs = []; }
        else if (row.clears_buffs !== "none" && st.buffs.length) { const b = st.buffs.pop(); st.flash.stats.remove(b.id); }
        st.streak = 0;
        logStudy("penalty", 0);
        if (tel) { add(tel.rewards, "penalty", 1); if (accR) accR.penalties++; }
        ev({ t: "reward", text: row.floating_text || "Oops!", bad: true });
        return;
      }
      const streakMul = 1 + (row.streak_bonus_per_step || 0) * Math.min(st.streak, row.streak_cap || 999);
      const scale = strength * streakMul * T.study_power;
      if (!row.stacks) {
        const old = st.buffs.find(b => b.row === row.id);
        if (old) { old.until = st.fightT + (row.duration || 10); old.total = row.duration || 10; }
      }
      if (row.stacks || !st.buffs.find(b => b.row === row.id)) {
        const b = { id: "buff" + st.nextId++, row: row.id, source, until: st.fightT + (row.duration || 10), total: row.duration || 10 };
        changeMax(() => st.flash.stats.add(row.effects, b.id, scale));
        st.buffs.push(b);
      }
      if (row.heal_pct) st.flash.hp = Math.min(st.flash.maxHp(), st.flash.hp + st.flash.maxHp() * row.heal_pct * scale);
      logStudy(source, Math.round(strength * 100) / 100);
      // "in a flash": every DASH.every quiz answers in a row, Flash lets out a
      // blue shockwave that throws back (and hurts) everything close by
      // (the word card asks for it on its own streaks: d.dash)
      if ((source === "quiz" || d.dash) && st.streak > 0 && st.streak % DASH.every === 0) flashDash();
      if (tel) { add(tel.rewards, source, 1); acc1.rewards++; if (accR) accR.rewards++; }
      const text = (row.floating_text || "+POWER").replace("{word}", d.word || "").replace(/\(\s*\)/, "").trim();
      ev({ t: "reward", text, source });
    }
    function updateBuffs() {
      const keep = [];
      for (const b of st.buffs) {
        if (st.fightT >= b.until) changeMax(() => st.flash.stats.remove(b.id));
        else keep.push(b);
      }
      st.buffs = keep;
      if (st.warning && st.t > st.warning.until) st.warning = null;
    }

    // ------------------------------------------------------------- offers
    const rarityW = r => (D.rarity[r] && D.rarity[r].weight) || ({ common: .6, uncommon: .25, rare: .1, epic: .04, legendary: .009, mythical: .001 }[r] || .3);
    const fmtMods = mods => (mods || []).map(m => {
      const n = m.stat.replace(/_/g, " ");
      if (m.op === "add_pct") return `+${Math.round(m.value * 100)}% ${n}`;
      if (m.op === "multiply") return `x${m.value} ${n}`;
      return (Math.abs(m.value) < 1 && m.value !== 0 ? `${m.value > 0 ? "+" : ""}${Math.round(m.value * 100)}% ` : `${m.value > 0 ? "+" : ""}${m.value} `) + n;
    }).join(", ");
    const PROJECTILE = b => /projectile/.test(b);
    function makeOffer() {
      const pool = [];
      const slots = S.slots + (st.tail ? 1 : 0);
      const available = Object.values(D.weapons).filter(w => (w.unlock_stage || 1) <= 2 || w.starting);
      if (st.weapons.length < slots)
        for (const w of available) if (!st.owned[w.id]) pool.push({ kind: "weapon", id: w.id, name: w.name, rarity: w.rarity || "common",
          desc: w.description || "", tag: "New weapon" });
      for (const w of st.weapons) {
        for (const u of D.upgrades.filter(u => u.applies_to === "weapon")) {
          const st_ = (u.effects[0] || {}).stat;
          if (["projectile_speed", "pierce", "bounces"].includes(st_) && !PROJECTILE(w.def.behaviour)) continue;
          if (st_ === "bounces" && w.def.behaviour !== "bouncing_projectile") continue;
          pool.push({ kind: "wup", id: u.id, wuid: w.uid, wid: w.id, name: `${w.def.name} · ${u.name}`, rarity: u.rarity || "common",
            desc: fmtMods(u.effects), tag: `Lv ${w.level} → ${w.level + 1}` });
        }
      }
      for (const u of D.upgrades.filter(u => u.applies_to === "global")) {
        if (u.id === "extra_weapon_slot") { if (!st.tail && st.weapons.length >= S.slots) pool.push({ kind: "tail", id: u.id, name: u.name, rarity: u.rarity || "legendary", desc: u.description, tag: "Special" }); continue; }
        if (u.effects && u.effects.length) pool.push({ kind: "stat", id: u.id, name: u.name, rarity: u.rarity || "common", desc: fmtMods(u.effects), tag: "Upgrade", effects: u.effects });
      }
      for (const sp of Object.values(SPELLS)) if (!st.spellOwned[sp.id] && (sp.unlock_stage || 1) <= Math.max(1, st.stage)) pool.push(spellOffer(sp));
      for (const s of st.spells) {
        if (s.level >= 8) continue;
        for (const u of D.upgrades.filter(u => u.applies_to === "spell")) {
          const st_ = (u.effects[0] || {}).stat, b = s.def.behaviour;
          if (st_ === "projectile_count" && b !== "projectile") continue;
          if (st_ === "summon_duration" && b !== "summon") continue;
          if (st_ === "healing_power" && !/heal|drain/.test(b)) continue;
          if (st_ === "targets" && !/chain|spread|curse|projectile/.test(b)) continue;
          if (st_ === "area" && !s.def.radius && !/nova|ground_area|area_drop|vortex|slow_field|drain/.test(b)) continue;
          pool.push({ kind: "sup", id: u.id, suid: s.uid, sid: s.id, name: `${s.def.name} · ${u.name}`, rarity: u.rarity || "common",
            desc: fmtMods(u.effects), tag: `Lv ${s.level} → ${s.level + 1}` });
        }
      }
      for (const it of D.items) if (it.effects && it.effects.length) pool.push({ kind: "item", id: it.id, name: it.name, rarity: it.rarity || "common", desc: it.description || fmtMods(it.effects), tag: "Item", effects: it.effects });
      for (const p of D.passives) if (p.trigger === "always" && p.effects && p.effects.length) pool.push({ kind: "passive", id: p.id, name: p.name, rarity: p.rarity || "uncommon", desc: p.description || fmtMods(p.effects), tag: "Passive", effects: p.effects });
      const out = [], used = new Set();
      for (let i = 0; i < S.choices && pool.length; i++) {
        let pick, tries = 0;
        // favour_current_build: upgrades to what Flash already has come up more often
        do { pick = pickWeighted(pool, o => rarityW(o.rarity) * (o.kind === "weapon" ? 1.6 : o.kind === "spell" ? 1.3
               : o.kind === "wup" || o.kind === "sup" ? 1.2 * (1 + FAVOUR) : 1)); tries++; }
        while (used.has(pick.kind + pick.id + (pick.wuid || "")) && tries < 30);
        used.add(pick.kind + pick.id + (pick.wuid || ""));
        out.push(pick);
      }
      return out;
    }
    const offerKey = o => o.kind === "wup" ? `wup:${o.wid}:${o.id}` : o.kind === "sup" ? `sup:${o.sid}:${o.id}` : `${o.kind}:${o.id}`;
    function choose(i) {
      if (!st.offer || !st.offer[i]) return;
      const o = st.offer[i];
      if (tel) tel.picks.push({ round: st.round, level: st.level, offered: st.offer.map(offerKey), picked: offerKey(o) });
      applyOffer(o);
      st.picked = (st.picked || []).concat([o.name]);
      st.pending--;
      st.offer = st.pending > 0 ? makeOffer() : null;
      ev({ t: "picked", name: o.name });
    }
    function skip() {
      if (!st.offer) return;
      if (tel) tel.picks.push({ round: st.round, level: st.level, offered: st.offer.map(offerKey), picked: "skip" });
      st.gold += S.skipGold; st.pending--;
      st.offer = st.pending > 0 ? makeOffer() : null;
    }

    // -------------------------------------------------------------- flow
    function startRun(weaponId) {
      Object.assign(st, { phase: "fight", paused: false, t: 0, fightT: 0, roundT: 0, round: 1, stage: 1, level: 1,
        xp: 0, xpNext: xpNext(1), gold: 0, kills: 0, pending: 0, offer: null, weapons: [], owned: {}, tail: false,
        buffs: [], enemies: [], proj: [], eproj: [], spawnAcc: 0, warning: null, streak: 0, runStats: null,
        damageDone: 0, dmgBy: {}, rDmgBy: {}, picked: [], wave: null, pops: [], combo: 0, lastKillT: -9, comboMax: 0, wavesCleared: 0,
        intensity: 1, stressAvg: 0, danger: false, minHpRound: 1, lastHitBy: null,
        stressUsed: !!st.god, megaUsed: false,
        spells: [], spellOwned: {}, zones: [], allies: [], delayed: [], tele: [], boss: null, bossDone: {}, bossesKilled: 0,
        bossQueue: null, shop: null, shield: 0, shieldMax: 0, shieldUntil: 0, practice: false, log: [], startWeapon: weaponId || null,
        paws: [], pickups: [], fish: 0, eatAt: 0, livesUsed: 0, safeUntil: 0 });
      CX = W / 2; CY = H / 2;
      st.flash = newFlash();
      addWeapon(weaponId || Object.values(D.weapons).find(w => w.starting).id);
      telStart(st.weapons[0].id);
      for (let i = 0; i < S.initial; i++) spawnEnemy();
      ev({ t: "start" });
    }
    // ---- saving a run: only between rounds, when the arena is empty. What is
    // kept is the run's recipe (the starting weapon and every pick, upgrade
    // and purchase, in order) and its numbers; restoring replays the recipe.
    const RUN_KEEP = ["round", "stage", "level", "xp", "xpNext", "gold", "kills", "pending", "damageDone", "dmgBy", "comboMax",
                      "wavesCleared", "fightT", "t", "bossesKilled", "mode", "fish", "livesUsed"];
    function exportRun() {
      if (st.phase !== "break" || st.practice || !st.flash || !st.log) return null;
      const n = {}; for (const k of RUN_KEEP) n[k] = st[k];
      n.bossDone = Object.assign({}, st.bossDone); n.hp = st.flash.hp / st.flash.maxHp(); n.picked = (st.picked || []).slice(-60);
      return { v: 1, start: st.startWeapon || (st.weapons[0] && st.weapons[0].id), log: st.log.slice(), n, data: DATA_HASH, at: Date.now() };
    }
    function restoreRun(s) {
      if (!s || !s.start || !D.weapons[s.start] || !Array.isArray(s.log) || !s.n) return false;
      startRun(s.start);
      st.enemies = []; st.events = [];
      const log = st.log = [];
      const eff = (list, id) => { const x = (list || []).find(r => r.id === id); return x && x.effects && x.effects.length ? x.effects : null; };
      for (const l of s.log) {
        if (!l || !l.k) continue;
        if (l.k === "weapon") { if (D.weapons[l.id] && !st.owned[l.id]) addWeapon(l.id); else continue; }
        else if (l.k === "spell") { if (!addSpell(l.id)) continue; }
        else if (l.k === "wup") { const w = st.owned[l.w], u = D.upgrades.find(x => x.id === l.id); if (!w || !u) continue; w.mods.push(...u.effects); w.level++; }
        else if (l.k === "sup") { const sp = st.spellOwned[l.s], u = D.upgrades.find(x => x.id === l.id); if (!sp || !u) continue; sp.mods.push(...u.effects); sp.level++; }
        else if (l.k === "tail") st.tail = true;
        else {
          let e = l.k === "stat" ? eff(D.upgrades, l.id) : l.k === "item" ? eff(D.items, l.id) : l.k === "passive" ? eff(D.passives, l.id) : null;
          if (!e) continue;
          if (l.p) e = scaleFx(e, l.p);
          changeMax(() => st.flash.stats.add(e, "perm"));
        }
        log.push(l);
      }
      for (const k of RUN_KEEP) if (s.n[k] !== undefined) st[k] = s.n[k];
      st.bossDone = Object.assign({}, s.n.bossDone || {}); st.picked = (s.n.picked || []).slice();
      st.flash.hp = st.flash.maxHp() * Math.max(0.05, Math.min(1, +s.n.hp || 1));
      st.phase = "break"; st.roundT = 0;
      st.offer = st.pending > 0 ? makeOffer() : null;
      makeShop(0);
      if (tel) tel.resumed = { round: st.round, level: st.level, saved_at: s.at || null };
      ev({ t: "resumed", round: st.round });
      return true;
    }
    function endRound() {
      st.phase = "break";
      st.lastRoundMinHp = st.minHpRound;
      telRoundEnd(); st.danger = false;
      for (const e of st.enemies) if (e.alive) ev({ t: "death", x: e.x, y: e.y, colour: e.colour, size: e.size, quiet: true });
      st.enemies = []; st.proj = []; st.eproj = [];
      st.zones = []; st.allies = []; st.delayed = []; st.tele = []; st.boss = null; st.paws = [];
      // fish left on the floor are scooped up at the end of a round (if there's room)
      let scooped = 0;
      for (const p of st.pickups) if (st.fish < FI.carry) { st.fish++; scooped++; }
      st.pickups = [];
      if (scooped) ev({ t: "fish", k: "scoop", n: st.fish, got: scooped });
      st.offer = st.pending > 0 ? makeOffer() : null;
      makeShop(0);
      ev({ t: "round_end", round: st.round });
    }
    function nextRound() {
      if (st.phase !== "break" || st.pending > 0) return;
      st.round++; st.roundT = 0; st.phase = "fight"; st.spawnAcc = 0; st.minHpRound = 1; st.shop = null; st.rDmgBy = {};
      st.intensity = 1 + (st.intensity - 1) * 0.5;          // a breather at the start of each round
      ev({ t: "round_start", round: st.round });
      const mw = waveFor(st.round);
      if (mw) startWave(mw);
      else for (let i = 0; i < S.initial + st.round; i++) spawnEnemy();
      // an ambush, some time in this round (rows with ambush: true and a chance)
      st.ambushAt = 0; st.ambushRow = null;
      if (!mw) {
        const am = D.waves.filter(w => w.ambush && st.round >= (w.from_round || 1) && rnd() < (w.chance || 0));
        if (am.length) { st.ambushRow = am.sort((a, b) => (b.total || 0) - (a.total || 0))[0]; st.ambushAt = S.roundLen * (0.25 + rnd() * 0.45); }
      }
      telRoundStart();
    }
    // ---- learning mode after Flash falls (Dan: "very few skeletons, we show
    // the user the correct answers ... then test mode, if the user gets above
    // 80% they get a bonus item next run"). The renderer runs the words; the
    // sim only keeps the arena calm and Flash safe, and gives no XP or gold.
    // The finished run's record is put aside so practice adds nothing to it
    // but the result (tel.learn).
    const PR = { every: set("learn", "skeleton_every", 3.5), max: set("learn", "skeleton_max", 3) };
    // the run's mode, chosen on the start screen: "learn" (hints, gentler) or "test"
    // Learn mode is the normal game with the answers showing (Dan: "learn mode
    // = normal mode but with all the answers, we don't need to make the game
    // easier"). These stay as knobs, off by default: 1 = normal damage, 0 = no
    // health floor, 1 = normal skeleton rate.
    const LEARN_DMG = set("modes", "learn_enemy_damage", 1), LEARN_FLOOR = set("modes", "learn_hp_floor", 0),
          LEARN_SPAWN = set("modes", "learn_spawn_rate", 1);
    let practiceTel = null;
    function startPractice() {
      if (st.phase !== "over" || !st.flash) return false;
      practiceTel = tel; tel = null; accR = null;
      Object.assign(st, { phase: "fight", paused: false, practice: true, enemies: [], proj: [], eproj: [], zones: [], allies: [], paws: [], pickups: [],
        delayed: [], tele: [], pops: [], boss: null, bossQueue: null, wave: null, offer: null, shop: null, pending: 0, buffs: [],
        danger: false, intensity: 1, spawnAcc: PR.every - 1, warning: null, surge: false, combo: 0 });
      const f = st.flash; f.hp = f.maxHp(); f.hurtT = 0;
      ev({ t: "practice", on: true });
      return true;
    }
    function endPractice(result) {
      if (!st.practice) return false;
      st.practice = false; tel = practiceTel; practiceTel = null;
      if (tel && result) (tel.learn = tel.learn || []).push(result);
      for (const e of st.enemies) if (e.alive) ev({ t: "death", x: e.x, y: e.y, colour: e.colour, size: e.size, quiet: true });
      Object.assign(st, { phase: "over", enemies: [], proj: [], eproj: [], zones: [], allies: [], delayed: [], tele: [], paws: [], pickups: [] });
      ev({ t: "practice", on: false });
      return true;
    }
    // a study bonus carried into a new run: one item, as if picked
    function grantItem(id) {
      const it = D.items.find(x => x.id === id && x.effects && x.effects.length);
      if (!it || !st.flash) return null;
      applyOffer({ kind: "item", id: it.id, name: it.name, effects: it.effects });
      if (tel) (tel.bonus = tel.bonus || []).push(it.id);
      return it;
    }
    // which item a pass earns: random, from the better rarities when there are any
    function bonusItem() {
      const want = set("learn", "bonus_rarities", ["rare", "epic"]);
      const all = D.items.filter(it => it.effects && it.effects.length);
      const pool = all.filter(it => (want || []).includes(it.rarity || "common"));
      const from = pool.length ? pool : all;
      return from.length ? from[Math.floor(Math.random() * from.length)] : null;
    }
    function gameOver() {
      if (st.phase === "over") return;
      st.phase = "over"; st.flash.hp = 0;
      st.paused = false;                       // "paused" only means something in a fight (the bench can end a paused run)
      st.runStats = { round: st.round, stage: st.stage, level: st.level, kills: st.kills, gold: st.gold,
                      time: st.fightT, weapons: st.weapons.map(w => `${w.def.name} Lv${w.level}`), damage: Math.round(st.damageDone),
                      comboMax: st.comboMax, waves: st.wavesCleared };
      telRoundEnd();
      if (tel) {
        tel.status = "over";
        tel.final = { round: st.round, stage: st.stage, level: st.level, kills: st.kills, seconds: Math.round(st.fightT),
          cause: st.lastHitBy || "unknown", damage: Math.round(st.damageDone), combo_max: st.comboMax,
          waves: st.wavesCleared, gold: st.gold, weapons: st.weapons.map(w => ({ id: w.id, level: w.level })),
          spells: st.spells.map(s => ({ id: s.id, level: s.level })), bosses: st.bossesKilled || 0 };
      }
      ev({ t: "over", stats: st.runStats });
    }

    // ------------------------------------------------------ smart movement
    // Every decide_every seconds Flash scores 16 directions (and standing
    // still) by where he'd be after look_ahead seconds: nearby skeletons
    // (elites count more), incoming arrows, being boxed in on many sides,
    // walls, and how far he is from his weapons' sweet spot. He takes the
    // safest, with a little inertia so he doesn't jitter.
    let prefRange = 120;
    // Where Flash may stand: the HUD covers the top ~110 units and the weapon
    // slots the bottom ~70, so those count as walls.
    const B = { x0: 30, x1: W - 30, y0: 125, y1: H - 85 };
    function chooseDir() {
      const f = st.flash, T = MV.lookahead;
      const sp = MV.speed * (1 + f.stats.mods.filter(m => m.stat === "movement_speed" && m.op === "add_pct").reduce((a, m) => a + m.value, 0));
      let maxR = 60;
      for (const w of st.weapons) maxR = Math.max(maxR, w.def.behaviour === "orbit" ? w.def.range * 0.8 : w.def.range);
      prefRange = maxR * MV.prefer;
      const near = [];
      query(f.x, f.y, 280, (e) => { if (near.length < 160) near.push(e); });
      let hunt = null;
      if (!near.length && st.enemies.length) {          // nothing close: go and find them
        let bd = 1e12;
        for (const e of st.enemies) { const d = (e.x - f.x) ** 2 + (e.y - f.y) ** 2; if (d < bd) { bd = d; hunt = e; } }
      }
      const shots = [];
      for (const p of st.eproj) { const dx = p.x - f.x, dy = p.y - f.y; if (dx * dx + dy * dy < 260 * 260) shots.push(p); if (shots.length > 60) break; }
      let best = 16, bestS = Infinity;
      for (let k = 0; k <= 16; k++) {
        const a = k * Math.PI / 8, dx = k < 16 ? Math.cos(a) : 0, dy = k < 16 ? Math.sin(a) : 0;
        const px = f.x + dx * sp * T, py = f.y + dy * sp * T;
        let sc = 0;
        const m = MV.margin, wl = Math.min(px - B.x0, B.x1 - px, py - B.y0, B.y1 - py);
        if (wl < m) sc += ((m - wl) / m) ** 2 * 6;
        // walls block escape routes too: a corner is a trap
        let mask = 0, nd = 1e9;
        const reach = 130;
        if (px - B.x0 < reach) mask |= 1 << 0 | 1 << 7;
        if (B.x1 - px < reach) mask |= 1 << 3 | 1 << 4;
        if (py - B.y0 < reach) mask |= 1 << 1 | 1 << 2;
        if (B.y1 - py < reach) mask |= 1 << 5 | 1 << 6;
        for (const e of near) {
          const ex = e.x - px, ey = e.y - py, d = Math.sqrt(ex * ex + ey * ey);
          const gap = Math.max(4, d - e.r - f.r);
          const w = (e.elite ? 2.5 : 1) * (e.ranged ? 0.4 : 1);
          sc += MV.fear * w * 220 / (gap * gap);
          if (d < nd) nd = d;
          if (d < 150) mask |= 1 << (((Math.atan2(ey, ex) + Math.PI) / (Math.PI / 4)) | 0) % 8;
        }
        let sides = 0; for (let b = 0; b < 8; b++) if (mask & (1 << b)) sides++;
        if (sides >= 6) sc += MV.trap * (sides - 5) * 1.5;
        for (const p of shots) {                          // closest approach of each arrow to where I'd be
          const vx = p.vx * T, vy = p.vy * T, wx = px - p.x, wy = py - p.y;
          const tt = Math.max(0, Math.min(1, (wx * vx + wy * vy) / (vx * vx + vy * vy || 1)));
          const cx = p.x + vx * tt - px, cy = p.y + vy * tt - py, dd = Math.sqrt(cx * cx + cy * cy);
          if (dd < 28) sc += 3 * (1 - dd / 28);
        }
        for (const t of st.tele) {                       // a boss attack is about to land here: get out
          const dd = Math.hypot(px - t.x, py - t.y);
          if (dd < t.r + 14) sc += 5 + 4 * (1 - dd / (t.r + 14));
        }
        if (near.length) sc += Math.abs(nd - prefRange) / Math.max(60, prefRange) * 0.5;
        else if (hunt) sc += Math.hypot(hunt.x - px, hunt.y - py) / 400;
        else sc += Math.hypot((B.x0 + B.x1) / 2 - px, (B.y0 + B.y1) / 2 - py) / 600;      // calm: drift home
        sc += (1 - (dx * f.gx + dy * f.gy)) * 0.12;                 // inertia
        if (sc < bestS) { bestS = sc; best = k; }
      }
      const a = best * Math.PI / 8;
      return best < 16 ? { x: Math.cos(a), y: Math.sin(a), sp } : { x: 0, y: 0, sp };
    }
    function moveFlash(dt) {
      const f = st.flash;
      if (!st.moveOn) { f.vx = f.vy = 0; return; }
      f.decideT -= dt;
      if (f.decideT <= 0) { f.decideT = MV.decide; const g = chooseDir(); f.gx = g.x; f.gy = g.y; f.gsp = g.sp; }
      const k = Math.min(1, dt * 8);
      f.vx += (f.gx * f.gsp - f.vx) * k; f.vy += (f.gy * f.gsp - f.vy) * k;
      f.x = clamp(f.x + f.vx * dt, B.x0, B.x1); f.y = clamp(f.y + f.vy * dt, B.y0, B.y1);
      if (Math.abs(f.vx) > 5) f.face = f.vx > 0 ? 1 : -1;
      CX = f.x; CY = f.y;
    }

    // ----------------------------------------------------------- director
    // Keeps the player on the edge of their seat: it watches Flash's HP and
    // turns the pressure up while he's comfortable and back down (never
    // below normal) when he's in trouble. Below danger_hp it raises the alarm
    // so the player knows a quiz answer would save him.
    function direct(dt) {
      const f = st.flash, hp = f.hp / f.maxHp();
      st.minHpRound = Math.min(st.minHpRound, hp);
      if (st.god || st.practice || !st.directorOn) { st.intensity = 1; return; }
      st.stressAvg += ((1 - hp) - st.stressAvg) * Math.min(1, dt / 3);
      // pressure builds over the run: round 1 can only get a little harder, later rounds much more
      const cap = Math.min(DR.max, 1 + DR.perRound * st.round);
      const settling = st.roundT < DR.warmup || st.wave;        // no ramping while the round warms up or during mega waves
      if (!settling && st.stressAvg < DR.low) st.intensity += DR.up * dt;
      else if (st.stressAvg > DR.high) st.intensity -= DR.down * dt;
      if (hp < DR.danger) st.intensity -= DR.down * 2 * dt;     // emergency: back off fast
      st.intensity = clamp(st.intensity, DR.min, cap);
      if (!st.danger && hp < DR.danger) { st.danger = true; if (accR) accR.dangers++; ev({ t: "danger", on: true }); }
      else if (st.danger && hp > DR.danger + 0.12) { st.danger = false; ev({ t: "danger", on: false }); }
    }

    function step(dt) {
      if (st.phase !== "fight" || st.paused) return;
      st.t += dt;
      if (!st.practice) { st.fightT += dt; st.roundT += dt; st.stage = 1 + Math.floor(st.fightT / S.stageLen); }
      refill(dt);
      const f = st.flash;
      buildGrid();
      moveFlash(dt);
      direct(dt);
      f.hp = Math.min(f.maxHp(), f.hp + f.stats.get("hp_regen") * dt);
      if (f.hurtT > 0) f.hurtT -= dt;
      updateBuffs();
      // spawning (adapts: if Flash clears the screen, more come)
      const sp = spawnParams(st.stage), alive = st.enemies.length;
      const surge = !st.wave && st.roundT > S.roundLen - DR.surge ? DR.surgeMul : 1;
      st.surge = surge > 1;
      if (st.practice) {
        // learning mode: a calm arena, just a few skeletons wandering in
        st.spawnAcc += dt;
        if (st.spawnAcc >= PR.every) { st.spawnAcc = 0; if (alive < PR.max) spawnEnemy(); }
      } else st.spawnAcc += st.wave ? 0 : dt * T.spawn_rate * st.intensity * surge * (alive < Math.min(6, sp.target * 0.25) ? 1.6 : 1) * (st.mode === "learn" ? LEARN_SPAWN : 1);
      while (!st.practice && st.spawnAcc >= sp.interval) {
        st.spawnAcc -= sp.interval;
        if (alive < sp.target * 1.5 * st.intensity) {
          const n = sp.min + ((rnd() * (sp.max - sp.min + 1)) | 0);
          for (let i = 0; i < n; i++) spawnEnemy();
        }
      }
      if (st.ambushRow && !st.wave && !st.boss && st.phase === "fight" && st.roundT >= st.ambushAt) { const r = st.ambushRow; st.ambushRow = null; startWave(r); }
      if (st.wave) updateWave(dt);
      if (st.phase !== "fight") return;
      buildGrid();
      processPops();
      for (const w of (st.noWeapons ? [] : st.weapons)) {
        w.cd -= dt;
        if (w.cd <= 0) {
          const p = wp(w);
          w.cd = fire(w) ? p.cooldown : 0.1;
        }
      }
      if (!st.noWeapons) updateOrbits(dt);
      updatePaws(dt);
      if (!st.noWeapons) castSpells(dt);
      updateZones(dt);
      updateAllies(dt);
      updateDelayed();
      // a boss stage was reached: the boss comes as soon as no mega wave is on
      if (!st.practice) { const br = bossRowFor(st.stage); if (br) { st.bossDone[st.stage] = true; st.bossQueue = br; } }
      if (st.bossQueue && !st.boss && !st.wave) { const br = st.bossQueue; st.bossQueue = null; spawnBoss(br); }
      if (st.boss) updateBoss(dt);
      updateTele();
      if (st.phase !== "fight") return;
      updateProjectiles(dt);
      updateEnemies(dt);
      updatePickups(dt);
      compact();
      telSample();
      // a round can't end with a boss still standing
      if (st.phase === "fight" && !st.practice && !st.wave && !st.boss && st.roundT >= S.roundLen) endRound();
      if (st.t - st.lastKillT > 1.2) st.combo = 0;
    }

    return {
      st, D, S, T, step, startRun, choose, skip, nextRound, applyReward, wp, xpNext, spp, buy, reroll, rerollPrice,
      addSpell(id) { return !!addSpell(id); },
      spellIds: () => Object.keys(SPELLS),
      // test bench: bring the next boss now
      bossNow(id) { if (st.phase !== "fight" || st.boss) return false; buildGrid();
        spawnBoss(id && BOSSES[id] ? { boss_pool: [id] } : (BOSS_SCHED[0] || { boss_pool: Object.keys(BOSSES) })); st.bossDone[st.stage] = false; st.stressUsed = true; return true; },
      pause(on) { st.paused = on === undefined ? !st.paused : !!on; },
      spawn(n, elite, defId) { buildGrid(); for (let i = 0; i < n; i++) spawnEnemy(elite, defId); },
      telemetry() {     // a snapshot safe to send (adds the current state of an unfinished round)
        if (!tel) return null;
        const t = Object.assign({}, tel, { snapshot_at: new Date().toISOString(),
          progress: { round: st.round, stage: st.stage, level: st.level, kills: st.kills, seconds: Math.round(st.fightT) } });
        t.tainted = !!(st.god || st.noWeapons || st.stressUsed || st.megaUsed);
        return t;
      },
      setGod(on) { st.god = !!on; if (on) st.stressUsed = true; },
      eatFish: () => eatFish(false),
      setAutoEat(on) { st.autoEat = !!on; },
      livesLeft: () => st.flash ? livesLeft() : 0,
      fishCarry: () => FI.carry,
      // test bench: a fish in Flash's arms, a Nine Lives charm
      giveFish(n) { st.fish = Math.max(0, Math.min(FI.carry, st.fish + (n || 1))); return st.fish; },
      giveWeapon(id) {
        if (!D.weapons[id] || st.owned[id] || !st.flash) return false;
        if (st.weapons.length >= S.slots + (st.tail ? 1 : 0)) { const old = st.weapons.pop(); delete st.owned[old.id]; }
        addWeapon(id); st.stressUsed = true; return true;
      },
      giveLife() { if (!st.flash) return 0; changeMax(() => st.flash.stats.add([{ stat: "nine_lives", op: "add", value: 1 }], "bench")); st.stressUsed = true; return livesLeft(); },
      startPractice, endPractice, grantItem, bonusItem,
      die() { if (st.phase === "fight" && !st.practice) gameOver(); },
      setMode(m) { st.mode = m === "learn" ? "learn" : "test"; if (tel && st.phase === "fight") tel.mode = st.mode; },
      setWeapons(on) { st.noWeapons = !on; },
      // The column was resized: the arena gets wider or narrower (height stays 1000).
      setWidth(w) {
        W = Math.max(WMIN, Math.min(WMAX, Math.round(w)));
        st.W = W; B.x1 = W - 30;
        if (st.flash) {
          if (!st.moveOn) { st.flash.x = W / 2; CX = W / 2; }
          else if (st.flash.x > B.x1) { st.flash.x = B.x1; CX = B.x1; }
        }
        return W;
      },
      // Something the learner did that isn't a reward (a wrong word match, a
      // closed pop quiz), so balance can see it.
      noteStudy(what) { if (tel && tel.study.length < 5000) tel.study.push([Math.round(st.fightT * 10) / 10, String(what), 0]); },
      setMove(on) { st.moveOn = !!on; if (!on && st.flash) { st.flash.x = W / 2; st.flash.y = H / 2; CX = W / 2; CY = H / 2; } },
      setDirector(on) { st.directorOn = !!on; },
      clearEnemies() { st.enemies = []; st.proj = []; st.eproj = []; st.paws = []; },
      // stress test: n skeletons at once from every side, ignoring the on-screen cap
      stressWave(n) {
        if (st.phase !== "fight") return 0;
        st.stressUsed = true;
        S.maxCap = Math.max(S.maxCap, st.enemies.length + n);
        const start = st.enemies.length;
        for (let i = 0; i < n; i++) spawnEnemy();
        for (let i = start; i < st.enemies.length; i++) {      // a thick front, not a single line
          const e = st.enemies[i], d = Math.random() * 220;
          e.xp = 0; e.gold = 0;                               // test skeletons give no XP or gold
          if (e.y < 0) e.y -= d; else if (e.y > H) e.y += d; else if (e.x < 0) e.x -= d; else e.x += d;
        }
        return st.enemies.length - start;
      },
      // test bench: a wave row by id, now
      waveNow(id) { const r = D.waves.find(w => w.id === id); if (!r || st.phase !== "fight" || st.wave) return false; st.megaUsed = true; startWave(r); return true; },
      // k: a share of each wave's max_alive; cap: never more than this on screen (from Dan's PC: smooth up to ~4,300)
      setAliveScale(k, cap) { aliveK = Math.max(0.1, Math.min(3, +k || 1)); aliveCap = cap > 0 ? cap : Infinity; },
      ambushNow(total) { if (st.phase !== "fight" || st.wave) return false; st.megaUsed = true; startWave(Object.assign({}, D.waves.find(w => w.ambush) || { hp_mult: 0.3, damage_mult: 0.35, speed_mult: 1.1, max_alive: 3000, spawn_per_second: 400 }, { ambush: true, total: total || 3000, name: "Ambush", banner: null })); return true; },
      megaWave(total) { if (st.phase === "fight" && !st.wave) { st.megaUsed = true; st.enemies = []; startWave(Object.assign({}, waveFor(999) || {}, { total, parts: 1, name: total >= 10000 ? "Skeleton apocalypse" : "Mega horde", banner: null })); } },
      drain() { const e = st.events; st.events = []; return e; },
      startingWeapons: () => Object.values(D.weapons).filter(w => w.starting),
      exportRun, restoreRun,
      fmtMods,
    };
  }

  return { create, W, H, WMIN, WMAX, DATA_TYPES };
});
