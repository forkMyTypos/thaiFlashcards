/* Mouth and tongue: step through how a word is said, one sound at a time.
 *
 * Each Thai word card carries its sounds in data-mouth ("kh aa w|dt a":
 * syllables split by "|", sounds by spaces), worked out in WordBase from the
 * romanization (app/mouth.py). The 45 drawings are in mouth.json beside this
 * file, fetched the first time somebody opens one — a visitor who never
 * presses the button never downloads them.
 *
 * Once a visitor has opened it, it stays open on every card they move to
 * (remembered in this browser), because somebody working on pronunciation
 * wants it on the next word too.
 */
(function () {
  "use strict";
  var me = document.currentScript && document.currentScript.src;
  var BASE = me ? me.replace(/mouth\.js(\?.*)?$/, "") : "";
  var KEY = "wb.mouth.open";
  var data = null, loading = null;

  function remember(on) { try { localStorage.setItem(KEY, on ? "1" : ""); } catch (e) { /* private mode */ } }
  function wanted() { try { return localStorage.getItem(KEY) === "1"; } catch (e) { return false; } }

  function load() {
    if (data) return Promise.resolve(data);
    if (!loading) loading = fetch(BASE + "mouth.json").then(function (r) {
      if (!r.ok) throw new Error("mouth.json " + r.status);
      return r.json();
    }).then(function (j) { data = j.sounds; return data; });
    return loading;
  }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function parse(attr) {
    // -> [{syl: 0, key: "kh"}, …]
    var out = [];
    (attr || "").split("|").forEach(function (s, i) {
      s.split(" ").forEach(function (k) { if (k) out.push({ syl: i, key: k }); });
    });
    return out;
  }

  function build(box) {
    var steps = parse(box.getAttribute("data-mouth"));
    var panel = el("div", "mouthpanel");
    var chips = el("div", "mouthchips");
    var fig = el("div", "mouthfig");
    var txt = el("div", "mouthtxt");
    var nav = el("div", "mouthnav");
    var prev = el("button", "mprev", "‹");
    var next = el("button", "mnext", "›");
    var play = el("button", "mplay", "▶ Step through");
    var count = el("span", "mcount");
    [prev, next, play].forEach(function (b) { b.type = "button"; });
    prev.setAttribute("aria-label", "Previous sound");
    next.setAttribute("aria-label", "Next sound");
    nav.appendChild(prev); nav.appendChild(count); nav.appendChild(next); nav.appendChild(play);
    var cur = 0, timer = null;
    steps.forEach(function (s, i) {
      if (i && steps[i - 1].syl !== s.syl) chips.appendChild(el("span", "msep", "·"));
      var c = el("button", "mchip", "");
      c.type = "button";
      c.setAttribute("data-i", i);
      chips.appendChild(c);
    });
    panel.appendChild(chips); panel.appendChild(fig); panel.appendChild(txt); panel.appendChild(nav);
    box.appendChild(panel);

    function stop() { if (timer) { clearInterval(timer); timer = null; play.textContent = "▶ Step through"; } }
    function show(i) {
      cur = (i + steps.length) % steps.length;
      var s = data[steps[cur].key];
      if (!s) { txt.textContent = "No drawing for " + steps[cur].key; return; }
      fig.innerHTML = s.svg;
      txt.innerHTML = "";
      var h = el("div", "mname");
      h.appendChild(el("b", "", s.name));
      h.appendChild(el("span", "mthai", s.thai));
      var tags = [];
      if (s.kind === "final") tags.push("ending");
      if (s.kind === "vowel" || s.kind === "glide") tags.push(s.long ? "long" : "short");
      if (s.nose) tags.push("through the nose");
      else if (s.kind === "consonant" && s.voice) tags.push("voice on");
      if (tags.length) h.appendChild(el("span", "mtags", tags.join(" · ")));
      txt.appendChild(h);
      txt.appendChild(el("div", "mtip", s.tip));
      count.textContent = (cur + 1) + " / " + steps.length;
      Array.prototype.forEach.call(chips.querySelectorAll(".mchip"), function (c, j) {
        c.classList.toggle("on", j === cur);
      });
    }
    Array.prototype.forEach.call(chips.querySelectorAll(".mchip"), function (c, j) {
      var s = data[steps[j].key];
      c.textContent = s ? s.name : steps[j].key;
      c.addEventListener("click", function () { stop(); show(j); });
    });
    prev.addEventListener("click", function () { stop(); show(cur - 1); });
    next.addEventListener("click", function () { stop(); show(cur + 1); });
    play.addEventListener("click", function () {
      if (timer) return stop();
      play.textContent = "❚❚ Pause";
      show(0);
      timer = setInterval(function () {
        if (cur + 1 >= steps.length) return stop();
        show(cur + 1);
      }, 1400);
    });
    show(0);
    return panel;
  }

  function open(box, on) {
    var btn = box.querySelector(".mouthbtn");
    var panel = box.querySelector(".mouthpanel");
    if (!on) {
      if (panel) panel.hidden = true;
      if (btn) btn.setAttribute("aria-expanded", "false");
      return Promise.resolve();
    }
    if (btn) btn.setAttribute("aria-expanded", "true");
    if (panel) { panel.hidden = false; return Promise.resolve(); }
    box.classList.add("loading");
    return load().then(function () { build(box); }).catch(function () {
      box.appendChild(el("div", "mouthpanel mfail", "The mouth diagrams could not be loaded."));
    }).then(function () { box.classList.remove("loading"); });
  }

  document.addEventListener("click", function (e) {
    var btn = e.target.closest && e.target.closest(".mouthbtn");
    if (!btn) return;
    var box = btn.closest(".mouthbox");
    var on = btn.getAttribute("aria-expanded") !== "true";
    remember(on);
    open(box, on);
  });

  // Open it on each card as it comes into view, once the visitor wants it.
  function watch() {
    var boxes = document.querySelectorAll(".mouthbox");
    if (!boxes.length) return;
    if (!("IntersectionObserver" in window)) return;
    var io = new IntersectionObserver(function (list) {
      list.forEach(function (x) {
        if (x.isIntersecting && wanted()) open(x.target, true);
      });
    });
    Array.prototype.forEach.call(boxes, function (b) { io.observe(b); });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", watch);
  else watch();
})();
