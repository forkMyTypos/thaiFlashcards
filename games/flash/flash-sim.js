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
                      "passives", "rarities", "mega_waves"];
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
        start_weapon: weaponId, settings: { tuning: T, director: DR, movement: MV },
        sample_keys: SAMPLE_KEYS, samples: [], rounds: [], picks: [], dmg_by: {}, kills_by: {}, taken_by: {},
        rewards: {}, study: [], study_keys: ["t", "what", "strength"], final: null };
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
      runStats: null, nextId: 1, damageDone: 0,
      wave: null, pops: [], combo: 0, lastKillT: -9, comboMax: 0, wavesCleared: 0,
      intensity: 1, stressAvg: 0, danger: false, minHpRound: 1, moveOn: MV.enabled, directorOn: DR.enabled,
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
    function hitEnemy(e, base, critC, critD, kb, src) {
      if (!e.alive) return 0;
      const crit = rnd() < critC;
      let dmg = base * (crit ? critD : 1);
      dmg = Math.max(S.minDamage, Math.round(dmg * (1 - e.def)));
      e.hp -= dmg; e.hitT = 0.08; st.damageDone += dmg;
      if (tel) { add(tel.dmg_by, src || "other", dmg); acc1.dealt += dmg; if (accR) accR.dealt += dmg; }
      if (kb > 0) {
        const dx = e.x - CX, dy = e.y - CY, d = Math.hypot(dx, dy) || 1;
        const k = kb * 6 / Math.max(0.6, e.size);
        e.kx += dx / d * k; e.ky += dy / d * k;
      }
      ev({ t: "hit", x: e.x, y: e.y, v: dmg, crit, src });
      const ls = st.flash.stats.get("lifesteal");
      if (ls > 0) st.flash.hp = Math.min(st.flash.maxHp(), st.flash.hp + dmg * ls);
      if (e.hp <= 0) kill(e, src);
      return dmg;
    }
    function explode(x, y, r, dmg, critC, critD, src) {
      ev({ t: "explode", x, y, r });
      query(x, y, r, e => { hitEnemy(e, dmg, critC, critD, 4, src); });
    }
    function kill(e, src) {
      if (!e.alive) return;
      e.alive = false; st.kills++;
      if (tel) add(tel.kills_by, src || "other", 1);
      st.combo = st.t - st.lastKillT < 1.2 ? st.combo + 1 : 1; st.lastKillT = st.t;
      if (st.combo > st.comboMax) st.comboMax = st.combo;
      if (e.fodder && st.wave) st.wave.killed++;
      if (e.chain > 0 && st.pops.length < 400 && rnd() < e.chain) st.pops.push({ x: e.x, y: e.y, r: e.chainR, dmg: e.max * 1.2 });
      const f = st.flash.stats;
      st.xp += e.xp * f.get("xp_gain") * T.xp;
      st.gold += Math.round(e.gold * f.get("gold_gain"));
      ev({ t: "death", x: e.x, y: e.y, elite: e.elite, colour: e.colour, size: e.size });
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
        } else if (pr.b === "projectile" && pr.target && pr.target.alive && pr.w && D.weapons[pr.w] && D.weapons[pr.w].targeting === "homing") {
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
          if (pr.b === "explosive_projectile" || (pr.expl > 0 && rnd() < pr.expl)) {
            explode(pr.x, pr.y, pr.radius, pr.dmg * 0.6, pr.critC, pr.critD, pr.w);
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

    function spawnEnemy(forceElite) {
      if (st.enemies.length >= S.maxCap) return null;
      const { pool, elite } = mixFor(st.stage);
      const def = pickWeighted(pool, e => e.spawn_weight || 1);
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
      const role = def.role || "melee";
      const ranged = role === "ranged" || role === "caster";
      const e = {
        id: st.nextId++, type: def.id, role, ranged, x, y, kx: 0, ky: 0, alive: true, elite: isElite,
        eliteMod: mod ? mod.id : null, size,
        r: 11 * Math.sqrt(size), max: Math.max(1, s.get("max_hp") * hpMul), dmg: s.get("damage") * dmgMul,
        atkSpd: Math.max(0.1, s.get("attack_speed")), range: Math.max(40, s.get("attack_range")),
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
        const hit = round === w.from_round || (w.every_rounds > 0 && round > w.from_round && (round - w.from_round) % w.every_rounds === 0);
        if (hit && (!best || w.total > best.total)) best = w;
      }
      return best;
    }
    function startWave(row) {
      const r = Object.assign({ name: "Mega wave", total: 5000, max_alive: 1000, spawn_per_second: 160, hp_mult: 0.3,
        damage_mult: 0.35, speed_mult: 1.15, xp_each: 0.4, gold_chance: 0.08, chain_chance: 0.35, chain_radius: 42,
        colour: "#e8e2d0" }, row || {});
      st.wave = { row: r, total: r.total, spawned: 0, killed: 0, acc: 0, side: (rnd() * 4) | 0, sideT: 0, t: 0 };
      ev({ t: "mega_start", name: r.name, total: r.total, banner: r.banner || `💀 ${r.name}! ${r.total.toLocaleString()} skeletons` });
    }
    function spawnFodder(side) {
      const w = st.wave, r = w.row;
      const base = (D.base.skeleton_basic && D.base.skeleton_basic.stats) || { max_hp: 40, damage: 5, attack_speed: 1, movement_speed: 60, attack_range: 60 };
      const hpMul = lerpStage(D.scaling, "hp_mult", st.stage) * T.enemy_hp * r.hp_mult * Math.pow(st.intensity, DR.hpPow);
      const dmgMul = lerpStage(D.scaling, "damage_mult", st.stage) * T.enemy_damage * r.damage_mult;
      // a thick front rolling in from one side
      const depth = 20 + rnd() * 160;
      let x, y;
      if (side === 0) { x = rnd() * W; y = -depth; } else if (side === 1) { x = W + depth; y = rnd() * H; }
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
      if (w.sideT > 2.2) { w.sideT = 0; w.side = (w.side + 1 + ((rnd() * 2) | 0)) % 4; }
      if (w.spawned < w.total) {
        w.acc += dt * r.spawn_per_second;
        const room = r.max_alive - st.enemies.length;
        let n = Math.min(Math.floor(w.acc), room, w.total - w.spawned);
        if (n > 0) { w.acc -= n; while (n-- > 0) spawnFodder(rnd() < 0.8 ? w.side : (rnd() * 4) | 0); }
        if (w.acc > r.spawn_per_second) w.acc = r.spawn_per_second;    // don't bank forever while the screen is full
      } else if (st.enemies.length && st.enemies.length <= Math.max(8, w.total * 0.02)) {
        w.stragT = (w.stragT || 0) + dt;                   // the last few stop hanging back and charge
        if (w.stragT > 5 && !w.rushed) { w.rushed = true; for (const e of st.enemies) { e.ranged = false; e.speed *= 1.6; } ev({ t: "rush" }); }
      } else if (!st.enemies.length) {
        ev({ t: "mega_end", name: r.name, total: w.total, time: w.t });
        st.wavesCleared++;
        st.wave = null;
        endRound();
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
      if (st.god) return;
      dmg *= Math.pow(st.intensity, DR.dmgPow);
      const f = st.flash, s = f.stats;
      if (rnd() < Math.min(s.get("dodge"), S.dodgeCap)) { ev({ t: "dodge" }); return; }
      if (rnd() < s.get("ignore_damage_chance")) { ev({ t: "dodge" }); return; }
      const d = Math.max(S.minDamage, dmg * (1 - s.get("defence")));
      f.hp -= d; f.hurtT = 0.15;
      const who = e ? (e.elite ? "elite_" + e.type : e.type) : "explosion";
      st.lastHitBy = who;
      if (tel) { add(tel.taken_by, who, d); acc1.taken += d; if (accR) accR.taken += d; }
      ev({ t: "hurt", v: Math.round(d) });
      if (e && e.alive) {
        const th = s.get("thorns") + d * s.get("thorns_pct");
        if (th > 0) hitEnemy(e, th, 0, 1, 0, "thorns");
      }
      if (f.hp <= 0) gameOver();
    }

    function updateEnemies(dt) {
      const es = st.enemies;
      for (let i = 0; i < es.length; i++) {
        const e = es[i];
        if (!e.alive) continue;
        if (e.hitT > 0) e.hitT -= dt;
        if (e.regen > 0 && e.hp < e.max) e.hp = Math.min(e.max, e.hp + e.regen * dt);
        // knockback velocity
        e.x += e.kx * dt; e.y += e.ky * dt; e.kx *= 0.86; e.ky *= 0.86;
        const dx = CX - e.x, dy = CY - e.y, d = Math.hypot(dx, dy) || 1;
        const reach = e.ranged ? e.range : st.flash.r + e.r + Math.min(e.range, 40) * 0.5;
        if (d > reach) {
          e.attacking = false;
          e.x += dx / d * e.speed * dt; e.y += dy / d * e.speed * dt;
        } else {
          e.attacking = true;
          e.atkT -= dt;
          if (e.atkT <= 0) {
            e.atkT = 1 / e.atkSpd;
            if (e.ranged) st.eproj.push({ x: e.x, y: e.y, vx: dx / d * 240, vy: dy / d * 240, dmg: e.dmg, alive: true, life: 4, src: e, colour: e.colour });
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
        const e = es[i]; if (!e.alive) continue;
        let n = 0, seen = 0;
        query(e.x, e.y, e.r, o => {
          if (o === e) return;
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

    // ------------------------------------------------------------ rewards
    function applyReward(d) {
      d = d || {};
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
      for (const it of D.items) if (it.effects && it.effects.length) pool.push({ kind: "item", id: it.id, name: it.name, rarity: it.rarity || "common", desc: it.description || fmtMods(it.effects), tag: "Item", effects: it.effects });
      for (const p of D.passives) if (p.trigger === "always" && p.effects && p.effects.length) pool.push({ kind: "passive", id: p.id, name: p.name, rarity: p.rarity || "uncommon", desc: p.description || fmtMods(p.effects), tag: "Passive", effects: p.effects });
      const out = [], used = new Set();
      for (let i = 0; i < S.choices && pool.length; i++) {
        let pick, tries = 0;
        do { pick = pickWeighted(pool, o => rarityW(o.rarity) * (o.kind === "weapon" ? 1.6 : o.kind === "wup" ? 1.2 : 1)); tries++; }
        while (used.has(pick.kind + pick.id + (pick.wuid || "")) && tries < 30);
        used.add(pick.kind + pick.id + (pick.wuid || ""));
        out.push(pick);
      }
      return out;
    }
    const offerKey = o => o.kind === "wup" ? `wup:${o.wid}:${o.id}` : `${o.kind}:${o.id}`;
    function choose(i) {
      if (!st.offer || !st.offer[i]) return;
      const o = st.offer[i];
      if (tel) tel.picks.push({ round: st.round, level: st.level, offered: st.offer.map(offerKey), picked: offerKey(o) });
      if (o.kind === "weapon") { addWeapon(o.id); }
      else if (o.kind === "wup") { const w = st.weapons.find(x => x.uid === o.wuid); const u = D.upgrades.find(x => x.id === o.id); if (w && u) { w.mods.push(...u.effects); w.level++; } }
      else if (o.kind === "tail") { st.tail = true; }
      else changeMax(() => st.flash.stats.add(o.effects, "perm"));
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
        damageDone: 0, picked: [], wave: null, pops: [], combo: 0, lastKillT: -9, comboMax: 0, wavesCleared: 0,
        intensity: 1, stressAvg: 0, danger: false, minHpRound: 1, lastHitBy: null,
        stressUsed: !!st.god, megaUsed: false });
      CX = W / 2; CY = H / 2;
      st.flash = newFlash();
      addWeapon(weaponId || Object.values(D.weapons).find(w => w.starting).id);
      telStart(st.weapons[0].id);
      for (let i = 0; i < S.initial; i++) spawnEnemy();
      ev({ t: "start" });
    }
    function endRound() {
      st.phase = "break";
      st.lastRoundMinHp = st.minHpRound;
      telRoundEnd(); st.danger = false;
      for (const e of st.enemies) if (e.alive) ev({ t: "death", x: e.x, y: e.y, colour: e.colour, size: e.size, quiet: true });
      st.enemies = []; st.proj = []; st.eproj = [];
      st.offer = st.pending > 0 ? makeOffer() : null;
      ev({ t: "round_end", round: st.round });
    }
    function nextRound() {
      if (st.phase !== "break" || st.pending > 0) return;
      st.round++; st.roundT = 0; st.phase = "fight"; st.spawnAcc = 0; st.minHpRound = 1;
      st.intensity = 1 + (st.intensity - 1) * 0.5;          // a breather at the start of each round
      ev({ t: "round_start", round: st.round });
      const mw = waveFor(st.round);
      if (mw) startWave(mw);
      else for (let i = 0; i < S.initial + st.round; i++) spawnEnemy();
      telRoundStart();
    }
    function gameOver() {
      if (st.phase === "over") return;
      st.phase = "over"; st.flash.hp = 0;
      st.runStats = { round: st.round, stage: st.stage, level: st.level, kills: st.kills, gold: st.gold,
                      time: st.fightT, weapons: st.weapons.map(w => `${w.def.name} Lv${w.level}`), damage: Math.round(st.damageDone),
                      comboMax: st.comboMax, waves: st.wavesCleared };
      telRoundEnd();
      if (tel) {
        tel.status = "over";
        tel.final = { round: st.round, stage: st.stage, level: st.level, kills: st.kills, seconds: Math.round(st.fightT),
          cause: st.lastHitBy || "unknown", damage: Math.round(st.damageDone), combo_max: st.comboMax,
          waves: st.wavesCleared, gold: st.gold, weapons: st.weapons.map(w => ({ id: w.id, level: w.level })) };
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
      if (st.god || !st.directorOn) { st.intensity = 1; return; }
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
      st.t += dt; st.fightT += dt; st.roundT += dt;
      st.stage = 1 + Math.floor(st.fightT / S.stageLen);
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
      st.spawnAcc += st.wave ? 0 : dt * T.spawn_rate * st.intensity * surge * (alive < Math.min(6, sp.target * 0.25) ? 1.6 : 1);
      while (st.spawnAcc >= sp.interval) {
        st.spawnAcc -= sp.interval;
        if (alive < sp.target * 1.5 * st.intensity) {
          const n = sp.min + ((rnd() * (sp.max - sp.min + 1)) | 0);
          for (let i = 0; i < n; i++) spawnEnemy();
        }
      }
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
      updateProjectiles(dt);
      updateEnemies(dt);
      compact();
      telSample();
      if (st.phase === "fight" && !st.wave && st.roundT >= S.roundLen) endRound();
      if (st.t - st.lastKillT > 1.2) st.combo = 0;
    }

    return {
      st, D, S, T, step, startRun, choose, skip, nextRound, applyReward, wp, xpNext,
      pause(on) { st.paused = on === undefined ? !st.paused : !!on; },
      spawn(n, elite) { buildGrid(); for (let i = 0; i < n; i++) spawnEnemy(elite); },
      telemetry() {     // a snapshot safe to send (adds the current state of an unfinished round)
        if (!tel) return null;
        const t = Object.assign({}, tel, { snapshot_at: new Date().toISOString(),
          progress: { round: st.round, stage: st.stage, level: st.level, kills: st.kills, seconds: Math.round(st.fightT) } });
        t.tainted = !!(st.god || st.noWeapons || st.stressUsed || st.megaUsed);
        return t;
      },
      setGod(on) { st.god = !!on; if (on) st.stressUsed = true; },
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
      clearEnemies() { st.enemies = []; st.proj = []; st.eproj = []; },
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
      megaWave(total) { if (st.phase === "fight" && !st.wave) { st.megaUsed = true; st.enemies = []; startWave(Object.assign({}, waveFor(999) || {}, { total, name: total >= 10000 ? "Skeleton apocalypse" : "Mega horde", banner: null })); } },
      drain() { const e = st.events; st.events = []; return e; },
      startingWeapons: () => Object.values(D.weapons).filter(w => w.starting),
      fmtMods,
    };
  }

  return { create, W, H, WMIN, WMAX, DATA_TYPES };
});
