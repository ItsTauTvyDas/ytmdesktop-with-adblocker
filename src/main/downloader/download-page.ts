// Static page
export const DOWNLOAD_PAGE_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<style>
  :root{color-scheme:dark;--bg:#121212;--panel:#1e1e1e;--line:#2c2c2c;--text:#eee;--muted:#9a9a9a;--accent:#ff3d4f;--ok:#4cd964}
  *{box-sizing:border-box}
  html,body{height:100%;margin:0}
  body{background:var(--bg);color:var(--text);font:14px/1.4 system-ui,"Segoe UI",sans-serif;display:flex;flex-direction:column;user-select:none;overflow:hidden}
  header{height:36px;flex:none;display:flex;align-items:center;padding:0 14px;font-size:12px;color:var(--muted);-webkit-app-region:drag}
  main{flex:1;min-height:0;display:flex;padding:8px 24px 24px}
  [hidden]{display:none!important}
  .view{flex:1;display:flex;flex-direction:column;min-width:0}
  .center{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;text-align:center}
  .spacer{flex:1}
  .title{font-size:15px;font-weight:600;margin:0 0 18px;word-break:break-word;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
  .label{font-size:12px;color:var(--muted);margin:14px 0 6px;text-transform:uppercase;letter-spacing:.05em}
  .hint{font-size:12px;color:var(--muted);margin-top:8px}
  .muted{color:var(--muted);font-size:13px}
  .seg{display:flex;gap:8px}
  .seg label{flex:1}
  .seg input{display:none}
  .seg span{display:block;text-align:center;padding:9px 0;border:1px solid var(--line);border-radius:8px;background:var(--panel);cursor:pointer}
  .seg input:checked + span{border-color:var(--accent);background:#2a1a1d}
  .seg input:disabled + span{opacity:.4;cursor:not-allowed}
  select{width:100%;padding:9px 10px;background:var(--panel);color:var(--text);border:1px solid var(--line);border-radius:8px;font:inherit}
  .actions{display:flex;justify-content:flex-end;gap:10px}
  .btn{padding:9px 18px;border-radius:8px;border:1px solid var(--line);background:var(--panel);color:var(--text);font:inherit;cursor:pointer}
  .btn:hover{background:#262626}
  .btn.primary{background:var(--accent);border-color:var(--accent);color:#fff}
  .btn.primary:hover{filter:brightness(1.1)}
  .spinner{width:44px;height:44px;border:4px solid var(--line);border-top-color:var(--accent);border-radius:50%;animation:spin 1s linear infinite}
  @keyframes spin{to{transform:rotate(360deg)}}
  .bar{width:100%;height:8px;background:var(--line);border-radius:4px;overflow:hidden;position:relative}
  .fill{height:100%;width:0;background:var(--accent);border-radius:4px;transition:width .15s linear}
  .bar.indeterminate .fill{position:absolute;width:35%;animation:slide 1.1s ease-in-out infinite}
  @keyframes slide{0%{left:-35%}100%{left:100%}}
  .big{font-size:40px;line-height:1}
  .ok{color:var(--ok)} .err{color:var(--accent)}
</style></head>
<body>
<header id="hdr">Download</header>
<main>
  <div class="view" id="v-loading">
    <div class="center">
      <div class="spinner"></div>
      <div id="lText">Loading…</div>
      <div class="bar" id="lBarWrap" hidden><div class="fill" id="lBar"></div></div>
    </div>
    <div class="actions"><button class="btn" id="cancelLoad">Cancel</button></div>
  </div>

  <div class="view" id="v-options" hidden>
    <div class="title" id="title"></div>
    <div class="label">Format</div>
    <div class="seg">
      <label><input type="radio" name="kind" value="mp4" checked><span>MP4 (video)</span></label>
      <label><input type="radio" name="kind" value="mp3"><span>MP3 (audio)</span></label>
    </div>
    <div class="label">Quality</div>
    <select id="quality"></select>
    <div class="hint" id="hint" hidden>MP3 quality is capped by the source audio YouTube provides.</div>
    <div class="spacer"></div>
    <div class="actions">
      <button class="btn" id="cancelOpt">Cancel</button>
      <button class="btn primary" id="start">Download</button>
    </div>
  </div>

  <div class="view" id="v-progress" hidden>
    <div class="center">
      <div id="pStage">Downloading…</div>
      <div class="bar" id="pBarWrap"><div class="fill" id="pBar"></div></div>
      <div class="muted" id="pMeta"></div>
    </div>
    <div class="actions"><button class="btn" id="cancelProg">Cancel</button></div>
  </div>

  <div class="view" id="v-result" hidden>
    <div class="center">
      <div class="big" id="rIcon"></div>
      <div id="rText"></div>
    </div>
    <div class="actions">
      <button class="btn" id="openFolder">Open folder</button>
      <button class="btn primary" id="closeBtn">Close</button>
    </div>
  </div>
</main>
<script>
  var $ = function (id) { return document.getElementById(id); };
  function post(o) { window.open("ytmd-dl:" + encodeURIComponent(JSON.stringify(o))); }
  var heights = [];

  function setBar(wrap, fill, pct) {
    if (pct === null || pct === undefined) { wrap.classList.add("indeterminate"); fill.style.width = ""; }
    else { wrap.classList.remove("indeterminate"); fill.style.width = Math.max(0, Math.min(100, pct)) + "%"; }
  }

  function fillQuality() {
    var kind = document.querySelector('input[name="kind"]:checked').value;
    var sel = $("quality");
    sel.textContent = "";
    var opts = kind === "mp4"
      ? heights.map(function (h) { return [String(h), h + "p"]; })
      : [["0", "Best available"], ["192K", "192 kbps"], ["128K", "128 kbps"]];
    opts.forEach(function (o) {
      var el = document.createElement("option");
      el.value = o[0]; el.textContent = o[1]; sel.appendChild(el);
    });
    $("hint").hidden = kind !== "mp3";
  }

  var STAGES = { video: "Downloading video", audio: "Downloading audio", processing: "Processing (merging / converting)…" };

  window.setState = function (s) {
    var views = document.querySelectorAll(".view");
    for (var i = 0; i < views.length; i++) views[i].hidden = views[i].id !== "v-" + s.view;

    if (s.view === "loading") {
      $("lText").textContent = s.text;
      $("lBarWrap").hidden = s.percent === null || s.percent === undefined;
      if (!$("lBarWrap").hidden) setBar($("lBarWrap"), $("lBar"), s.percent);
    } else if (s.view === "options") {
      $("title").textContent = s.title;
      heights = s.heights || [];
      var mp4 = document.querySelector('input[value="mp4"]');
      mp4.disabled = !heights.length;
      if (!heights.length) document.querySelector('input[value="mp3"]').checked = true;
      fillQuality();
    } else if (s.view === "progress") {
      var label = STAGES[s.stage] || "Starting…";
      var pct = s.percent;
      $("pStage").textContent = (pct !== null && pct !== undefined && s.stage !== "processing") ? label + " – " + pct.toFixed(1) + "%" : label;
      setBar($("pBarWrap"), $("pBar"), s.stage === "processing" ? null : pct);
      var meta = [];
      if (s.speed) meta.push(s.speed);
      if (s.eta) meta.push("ETA " + s.eta);
      $("pMeta").textContent = meta.join("  ·  ");
    } else if (s.view === "result") {
      $("rIcon").textContent = s.ok ? "\\u2713" : "\\u2715";
      $("rIcon").className = "big " + (s.ok ? "ok" : "err");
      $("rText").textContent = s.text;
      $("openFolder").hidden = !s.canOpen;
    }
  };

  ["cancelLoad", "cancelOpt", "cancelProg"].forEach(function (id) {
    $(id).addEventListener("click", function () { post({ type: "cancel" }); });
  });
  $("start").addEventListener("click", function () {
    post({ type: "start", kind: document.querySelector('input[name="kind"]:checked').value, quality: $("quality").value });
  });
  $("openFolder").addEventListener("click", function () { post({ type: "open-folder" }); });
  $("closeBtn").addEventListener("click", function () { post({ type: "close" }); });
  document.querySelectorAll('input[name="kind"]').forEach(function (r) { r.addEventListener("change", fillQuality); });
</script>
</body></html>`;
