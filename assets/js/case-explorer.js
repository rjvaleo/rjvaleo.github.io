// Tabbed, interactive case study (.rx). Without this script every panel shows, one after another.
(function () {
  var rx = document.querySelector('.rx');
  if (!rx) return;
  rx.classList.add('js');
  var calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
  var tabs = [].slice.call(rx.querySelectorAll('[role=tab]'));
  var panels = [].slice.call(rx.querySelectorAll('[role=tabpanel]'));

  function show(key, focus, scroll) {
    var found = false;
    tabs.forEach(function (t) {
      var on = t.id === 'tab-' + key;
      if (on) found = true;
      t.setAttribute('aria-selected', on ? 'true' : 'false');
      t.tabIndex = on ? 0 : -1;
      if (on && focus) t.focus();
    });
    if (!found) return false;
    panels.forEach(function (p) { p.hidden = p.id !== 'p-' + key; });
    window.dispatchEvent(new Event('resize'));  // canvases inside a panel size themselves when it shows
    if (typeof tours !== 'undefined' && tours[key] && tours[key].tour) tours[key].tour();
    if (key === 'problem' && typeof flipOnce === 'function') flipOnce();
    if (history.replaceState) history.replaceState(null, '', '#' + key);
    if (scroll) rx.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
    return true;
  }
  tabs.forEach(function (t, i) {
    t.addEventListener('click', function () { show(t.id.slice(4)); });
    t.addEventListener('keydown', function (e) {
      var n = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 1, ArrowUp: -1 }[e.key];
      if (e.key === 'Home') n = -i; if (e.key === 'End') n = tabs.length - 1 - i;
      if (n === undefined) return;
      e.preventDefault();
      show(tabs[(i + n + tabs.length) % tabs.length].id.slice(4), true);
    });
  });
  if (!show(location.hash.slice(1))) show(tabs[0].id.slice(4));

  // A diagram whose parts explain themselves: select a part, its detail shows.
  function picker(svgSel, partSel, detailSel) {
    var svg = rx.querySelector(svgSel); if (!svg) return null;
    var parts = [].slice.call(svg.querySelectorAll(partSel));
    var details = [].slice.call(rx.querySelectorAll(detailSel + ' [data-for]'));
    function pick(k) {
      parts.forEach(function (p) { p.classList.toggle('on', p.dataset.k === k); p.setAttribute('aria-pressed', p.dataset.k === k ? 'true' : 'false'); });
      details.forEach(function (d) { d.hidden = d.dataset.for !== k; });
    }
    var touched = false, toured = false;
    parts.forEach(function (p) {
      p.addEventListener('click', function () { touched = true; pick(p.dataset.k); });
      p.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); touched = true; pick(p.dataset.k); } });
    });
    var first = details.filter(function (d) { return !d.hidden; })[0];
    if (first) pick(first.dataset.for);
    // The first time its panel opens, step through a few parts so people see they change.
    pick.tour = function () {
      if (toured || calm || !first) return; toured = true;
      var seq = parts.slice(0, 4).map(function (p) { return p.dataset.k; }).filter(function (k) { return k !== first.dataset.for; }).slice(0, 2);
      seq.push(first.dataset.for);
      seq.forEach(function (k, i) { setTimeout(function () { if (!touched) { pick(k); svg.classList.add('touring'); } if (i === seq.length - 1) svg.classList.remove('touring'); }, 900 * (i + 1)); });
    };
    pick.manual = function (k) { touched = true; pick(k); };
    return pick;
  }
  var pickArch = picker('.rx-arch', '.ab', '.rx-archwrap .rx-detail');
  var pickLoop = picker('.rx-loop', '.lb', '.loopd');
  var tours = { architecture: pickArch, ai: pickLoop };

  // Cards that point into the architecture.
  [].slice.call(rx.querySelectorAll('[data-goto]')).forEach(function (b) {
    b.addEventListener('click', function () { show('architecture', false, true); if (pickArch) pickArch.manual(b.dataset.goto); });
  });

  // Previous / next steps under each panel.
  [].slice.call(rx.querySelectorAll('[data-show]')).forEach(function (b) {
    b.addEventListener('click', function () { show(b.dataset.show, false, true); });
  });

  // Before / after.
  [].slice.call(rx.querySelectorAll('.rx-toggle')).forEach(function (g) {
    var wrap = g.parentNode.querySelector('[data-state]:not(button)');
    [].slice.call(g.querySelectorAll('button')).forEach(function (b) {
      b.addEventListener('click', function () {
        flipped = true; wrap.dataset.state = b.dataset.state;
        [].slice.call(g.querySelectorAll('button')).forEach(function (x) { x.setAttribute('aria-pressed', x === b ? 'true' : 'false'); });
      });
    });
  });

  // Flip to "after" once by itself, the first time the picture is on screen.
  var flipped = false;
  function flipOnce() {
    var wrap = rx.querySelector('.rx-netwrap'); if (!wrap || flipped || calm) return;
    var go = function () {
      setTimeout(function () {
        if (flipped) return; flipped = true;
        var b = rx.querySelector('.rx-toggle [data-state=after]'); if (b) b.click();
      }, 1400);
    };
    if (!('IntersectionObserver' in window)) return go();
    var io = new IntersectionObserver(function (es) { if (es[0].isIntersecting) { io.disconnect(); go(); } }, { threshold: .6 });
    io.observe(wrap);
  }
  var cur = rx.querySelector('[role=tab][aria-selected=true]');
  if (cur) { var k = cur.id.slice(4); if (k === 'problem') flipOnce(); else if (tours[k] && tours[k].tour) tours[k].tour(); }

  // Picture viewer: thumbnails swap the main picture.
  [].slice.call(rx.querySelectorAll('.rx-gal')).forEach(function (g) {
    var img = g.querySelector('.main img'), cap = g.querySelector('.main figcaption');
    var btns = [].slice.call(g.querySelectorAll('.thumbs button'));
    btns.forEach(function (b, i) {
      b.setAttribute('aria-label', 'Show picture ' + (i + 1) + (b.dataset.cap ? ': ' + b.dataset.cap : ''));
      b.addEventListener('click', function () {
        img.src = b.dataset.src; img.alt = b.dataset.alt; cap.textContent = b.dataset.cap;
        btns.forEach(function (x) { x.setAttribute('aria-pressed', x === b ? 'true' : 'false'); });
      });
    });
  });
})();
