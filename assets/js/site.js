(function () {
  'use strict';
  var $ = function (s) { return document.querySelector(s); };
  var reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---------- 3D work map
  // The map is about 1.7 MB of script, so no page loads it up front. The home page fetches it once
  // the page has settled (and never on a phone, where the map is switched off). The Work page
  // fetches it the first time someone opens the 3D view.
  var stage = $('#graph');
  if (stage) {
    var compact = !!stage.dataset.compact, api = null, mounting = false, names = {}, role = '';
    var panel = $('#panel');
    function show(p) {
      if (!panel) return;
      if (!p) { panel.hidden = true; history.replaceState(null, '', location.pathname); return; }
      $('#pim').style.backgroundImage = p.img ? 'url(assets/img/' + p.img + ')' : 'none';
      $('#pim').style.display = p.img ? '' : 'none';
      $('#pyr').textContent = p.year + (p.proof ? ' · ' + p.proof : '');
      $('#pt').textContent = p.title; $('#pl').textContent = p.lede;
      $('#ptags').innerHTML = p.roles.map(function (r) { return '<span>' + names[r] + '</span>'; }).join('');
      $('#pgo').href = 'case-' + p.slug + '.html';
      panel.hidden = false; panel.style.animation = 'none'; void panel.offsetWidth; panel.style.animation = '';
      history.replaceState(null, '', '#' + p.slug);
    }
    // Filter by role: light the chip, and dim the grid tiles that are not that kind of work.
    function chips(r) {
      role = r || '';
      document.querySelectorAll('.chip').forEach(function (c) { c.classList.toggle('on', (c.dataset.role || '') === role); });
      document.querySelectorAll('.g .t').forEach(function (t) { t.classList.toggle('dim', !!role && t.dataset.roles.split(' ').indexOf(role) < 0); });
    }
    function load(src, done) {
      var s = document.createElement('script'); s.src = src; s.onload = done;
      s.onerror = function () { stage.classList.add('nogl'); }; document.head.appendChild(s);
    }
    function mount(then) {
      if (api) { if (then) then(api); return; }
      if (mounting) return; mounting = true;
      load('assets/js/data.js', function () { load('assets/js/graph.js', function () {
        RJ_DATA.roles.forEach(function (r) { names[r[0]] = r[1]; });
        var gl = document.createElement('div'); gl.className = 'gl'; stage.insertBefore(gl, stage.firstChild);
        RJGraph.mount(gl, RJ_DATA, {
          compact: compact,
          background: !!stage.dataset.bg,
          onSelect: compact ? null : show,
          onFilter: chips,
          // Every map dives into the project you click and lands you inside its case study.
          onOpen: function (p) { location.href = 'case-' + p.slug + '.html'; },
          onRole: compact ? function (r) { location.href = 'work.html#role-' + r; } : null,
          onMe: compact ? function () { location.href = 'about.html'; } : null
        }).then(function (a) {
          if (!a) { stage.classList.add('nogl'); return; }
          api = a; window.rjgraph = a;
          // A background map sits under the headline; lift its hover label into a matching layer above the text.
          if (stage.dataset.bg) {
            var tip = stage.querySelector('.float-tooltip-kap');
            if (tip) { var layer = document.createElement('div'); layer.className = 'tiplayer'; stage.parentNode.appendChild(layer); layer.appendChild(tip); }
          }
          if (then) then(a);
        });
      }); });
    }

    if (compact) {
      // Home: decoration behind the headline. Desktop only, after the page is ready.
      if (matchMedia('(min-width:761px)').matches) {
        var later = function () { if (window.requestIdleCallback) requestIdleCallback(function () { mount(); }, { timeout: 1500 }); else setTimeout(function () { mount(); }, 300); };
        if (document.readyState === 'complete') later(); else addEventListener('load', later);
      }
    } else {
      // Work: the grid is the default view. The map is one click away.
      var wired = false;
      function wire(a) {
        if (wired) return; wired = true;
        $('#prev').onclick = function () { a.step(-1); }; $('#next').onclick = function () { a.step(1); };
        $('#reset').onclick = function () { a.tour(false); $('#tour').textContent = 'Play tour'; a.home(); };
        $('#tour').onclick = function () { var on = this.textContent === 'Play tour'; a.tour(on); this.textContent = on ? 'Stop tour' : 'Play tour'; };
        $('#close').onclick = function () { a.home(); };
        $('#pgo').onclick = function (e) { if (a.current) { e.preventDefault(); a.open(a.current); } };
        addEventListener('keydown', function (e) {
          if (stage.hidden || e.target.matches('input,textarea,select')) return;
          if (e.key === 'ArrowRight') a.step(1); else if (e.key === 'ArrowLeft') a.step(-1); else if (e.key === 'Escape') a.home();
        });
        if (role) setTimeout(function () { a.filter(role); }, 900);
      }
      document.querySelectorAll('.chip').forEach(function (c) {
        c.onclick = function () { var r = c.dataset.role || ''; chips(r); if (api && !stage.hidden) { if (r) api.filter(r); else api.home(); } };
      });
      document.querySelectorAll('.seg button').forEach(function (b) {
        b.onclick = function () {
          document.querySelectorAll('.seg button').forEach(function (x) { x.classList.toggle('on', x === b); });
          var g = b.dataset.view === 'grid'; $('#grid').hidden = !g; stage.hidden = g;
          if (!g) mount(function (a) { wire(a); dispatchEvent(new Event('resize')); });
        };
      });
      var fromHash = function () { var h = location.hash.slice(1); if (h.indexOf('role-') === 0) chips(h.slice(5)); };
      fromHash(); addEventListener('hashchange', fromHash);
    }
  }

  // ---------- the reverb network you can play (Web Audio + canvas)
  var cv = $('#rv');
  if (cv) {
    var x = cv.getContext('2d'), W = cv.width, H = cv.height, N = 10, lines = [], t0 = 0, ac = null;
    for (var i = 0; i < N; i++) lines.push({ d: 0.023 + i * 0.0113 + (i % 3) * 0.004, e: 0 });
    function draw(now) {
      x.clearRect(0, 0, W, H);
      var L = 150, R = W - 150, top = 50, gap = (H - 100) / (N - 1), t = (now - t0) / 1000;
      x.lineCap = 'round';
      lines.forEach(function (l, i) {
        var y = top + i * gap;
        x.strokeStyle = 'rgba(64,224,196,.22)'; x.lineWidth = 1.2;
        x.beginPath(); x.moveTo(40, H / 2); x.bezierCurveTo(100, H / 2, 90, y, L, y); x.lineTo(R, y); x.bezierCurveTo(W - 90, y, W - 100, H / 2, W - 40, H / 2); x.stroke();
        var amp = l.e * Math.pow(0.72, t / l.d);
        if (amp > 0.01) {
          x.strokeStyle = 'rgba(64,224,196,' + Math.min(1, amp + .15) + ')'; x.lineWidth = 2 + amp * 5;
          x.beginPath(); x.moveTo(L, y); x.lineTo(R, y); x.stroke();
          var ph = (t % l.d) / l.d, px = L + ph * (R - L);
          x.fillStyle = '#f2f0e9'; x.beginPath(); x.arc(px, y, 3 + amp * 7, 0, 7); x.fill();
        }
      });
      x.fillStyle = '#ffb347'; x.beginPath(); x.arc(40, H / 2, 6, 0, 7); x.fill(); x.beginPath(); x.arc(W - 40, H / 2, 6, 0, 7); x.fill();
      if (!reduce || lines.some(function (l) { return l.e; })) requestAnimationFrame(draw);
    }
    requestAnimationFrame(draw);
    $('#ping').onclick = function () {
      try {
        ac = ac || new (window.AudioContext || window.webkitAudioContext)(); ac.resume();
        var len = ac.sampleRate * 0.03, buf = ac.createBuffer(1, len, ac.sampleRate), d = buf.getChannelData(0);
        for (var i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
        var src = ac.createBufferSource(); src.buffer = buf;
        var out = ac.createGain(); out.gain.value = 0.22; out.connect(ac.destination);
        var dry = ac.createGain(); dry.gain.value = 0.5; src.connect(dry); dry.connect(out);
        lines.forEach(function (l, i) {
          var dl = ac.createDelay(1); dl.delayTime.value = l.d;
          var fb = ac.createGain(); fb.gain.value = 0.72;
          var lp = ac.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 5200 - i * 300;
          var pan = ac.createStereoPanner ? ac.createStereoPanner() : null;
          src.connect(dl); dl.connect(lp); lp.connect(fb); fb.connect(dl);
          if (pan) { pan.pan.value = (i / (N - 1)) * 2 - 1; lp.connect(pan); pan.connect(out); } else lp.connect(out);
          setTimeout(function () { fb.gain.value = 0; }, 6000);
        });
        src.start();
      } catch (e) {}
      lines.forEach(function (l) { l.e = 1; }); t0 = performance.now(); requestAnimationFrame(draw);
    };
  }

  // ---------- contact form: opens the visitor's own email app, addressed and filled in.
  // Not everyone has an email app set up, so the message can also be copied and sent by hand.
  var f = $('#contact');
  if (f) f.addEventListener('submit', function (e) {
    e.preventDefault(); var d = new FormData(f);
    var body = 'Name: ' + d.get('name') + '\nEmail: ' + d.get('email') + '\nCompany: ' + d.get('company') + '\nRole or posting: ' + d.get('date') + '\nNeed: ' + d.get('need') + '\n\n' + d.get('problem');
    location.href = 'mailto:rjvaleo@gmail.com?subject=' + encodeURIComponent('Role: ' + d.get('need')) + '&body=' + encodeURIComponent(body);
    $('#note').textContent = 'Your email app should open with the message ready to send. If nothing opens, copy the message and send it to rjvaleo@gmail.com.';
    var cp = $('#copy'); cp.hidden = false; cp.textContent = 'Copy the message';
    cp.onclick = function () {
      var done = function () { cp.textContent = 'Copied'; };
      if (navigator.clipboard) navigator.clipboard.writeText(body).then(done, function () { cp.textContent = 'Could not copy. Select the text above instead.'; });
    };
  });

  // ---------- résumé: print, or save as a PDF from the print dialog
  var pr = $('#print');
  if (pr) pr.onclick = function () { window.print(); };

  // ---------- case pages: you arrive inside the project's world
  // A star field in the project's colour sits behind the page. Coming in from the map it starts at
  // full warp and slows to a drift as the page settles around you.
  var warp = $('canvas.warp');
  if (warp) {
    var arrived = false;
    try { var a = JSON.parse(sessionStorage.getItem('rj-arrive') || 'null'); sessionStorage.removeItem('rj-arrive');
      arrived = !!a && a.slug === document.body.dataset.slug; } catch (e) {}
    if (arrived && !reduce) document.documentElement.classList.add('arrive');
    var wc = warp.getContext('2d'), col = warp.dataset.c || '#8f9dff', stars = [], N = 420, W = 0, H = 0, dpr = Math.min(2, devicePixelRatio || 1);
    function size() { W = warp.width = innerWidth * dpr; H = warp.height = innerHeight * dpr; }
    size(); addEventListener('resize', size);
    function star(z) { return { x: (Math.random() - 0.5) * 2, y: (Math.random() - 0.5) * 2, z: z == null ? Math.random() : z, pz: 0 }; }
    for (var i = 0; i < N; i++) stars.push(star());
    var t0 = performance.now(), visible = true;
    document.addEventListener('visibilitychange', function () { visible = !document.hidden; if (visible) requestAnimationFrame(tick); });
    function tick(now) {
      var t = (now - t0) / 1000, fast = arrived && !reduce ? Math.exp(-t / 0.55) : 0;
      var v = 0.0009 + 0.05 * fast, f = Math.min(W, H) * 0.9;
      wc.fillStyle = 'rgba(10,10,12,' + (0.35 + 0.5 * (1 - fast)) + ')'; wc.fillRect(0, 0, W, H);
      wc.strokeStyle = col; wc.lineCap = 'round';
      for (var i = 0; i < N; i++) {
        var s = stars[i]; s.pz = s.z; s.z -= v;
        if (s.z <= 0.02) { stars[i] = star(1); continue; }
        var x = W / 2 + s.x / s.z * f, y = H / 2 + s.y / s.z * f, px = W / 2 + s.x / s.pz * f, py = H / 2 + s.y / s.pz * f;
        if (x < 0 || x > W || y < 0 || y > H) { stars[i] = star(1); continue; }
        wc.globalAlpha = Math.min(1, (1 - s.z) * 1.3); wc.lineWidth = Math.max(0.6, (1 - s.z) * 2.6) * dpr;
        wc.beginPath(); wc.moveTo(px, py); wc.lineTo(x + 0.1, y + 0.1); wc.stroke();
      }
      wc.globalAlpha = 1;
      if (visible && !(reduce && t > 0.1)) requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }
})();
