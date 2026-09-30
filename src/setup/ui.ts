/**
 * The setup page. Inline strings rather than asset files: the page ships inside the same compiled
 * `dist` as everything else, with no build step and nothing fetched from the internet, so it works
 * on a machine with no connection beyond the platform's own.
 */

export const INDEX_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DPM Custody Setup</title>
<link rel="stylesheet" href="/app.css">
</head>
<body>
<main>
  <header>
    <h1>DPM Custody Setup</h1>
    <p class="muted" id="subtitle">Set up your wallet service in a few minutes.</p>
  </header>

  <section id="screen-pin" hidden>
    <h2>Enter your setup PIN</h2>
    <p>The installer printed a 6-digit PIN. Type it here.</p>
    <form id="pin-form">
      <input id="pin" inputmode="numeric" autocomplete="one-time-code" maxlength="12" placeholder="PIN" required>
      <button type="submit">Continue</button>
    </form>
  </section>

  <section id="screen-wizard" hidden>
    <ol class="wizard">
      <li>
        <h2>1. Which platform are you joining?</h2>
        <div id="env-list" class="cards"></div>
        <button type="button" class="link" id="toggle-advanced">Show more options</button>
        <label id="custom-url-row" hidden>Platform address
          <input id="custom-url" placeholder="https://api.example.com or http://localhost:8086">
        </label>
      </li>
      <li>
        <h2>2. Paste your builder private key</h2>
        <p class="muted">You get it from the platform team (Backoffice → Custody builders). It starts with <code>bld_sk_</code>.</p>
        <textarea id="builder-key" rows="2" spellcheck="false" autocomplete="off" placeholder="bld_sk_..."></textarea>
        <button type="button" id="check-key">Check key</button>
        <p id="key-result" role="status"></p>
      </li>
      <li id="mode-step" class="disabled">
        <h2>3. How should your users' funds be held?</h2>
        <div class="cards">
          <label class="card"><input type="radio" name="mode" value="segregated">
            <strong>Each user holds their own funds</strong>
            <span>Every user gets their own wallet. When they buy, the money comes from their own wallet. <em>Choose this if you are not sure.</em></span>
          </label>
          <label class="card"><input type="radio" name="mode" value="shared">
            <strong>Your company pays for users' trades</strong>
            <span>Your company's operations wallet pays for purchases, and users' wallets receive what they buy. Choose this if you settle balances with your users yourself.</span>
          </label>
        </div>
        <label class="confirm"><input type="checkbox" id="confirm-mode"> <span>I understand this choice <strong>cannot be changed later</strong>.</span></label>
      </li>
    </ol>
    <button type="button" id="start" class="primary" disabled>Start setup</button>
    <p id="start-error" class="error" role="alert"></p>
  </section>

  <section id="screen-progress" hidden>
    <h2 id="progress-title">Setting things up…</h2>
    <p class="muted" id="progress-hint">This usually takes a minute or two. You can close this page; it carries on.</p>
    <ul id="steps" class="steps"></ul>
    <div id="failure" hidden>
      <p class="error" id="failure-text"></p>
      <button type="button" id="retry" class="primary">Retry</button>
    </div>
  </section>

  <section id="screen-backup" hidden>
    <h2>Save your backup kit</h2>
    <p>This file holds the keys to your install. <strong>Without it, a lost or broken computer cannot be recovered.</strong> Store it in a password manager or another safe, private place.</p>
    <a id="download-kit" class="button primary" href="#" download="dpm-custody-backup-kit.txt">Download backup kit</a>
    <label class="confirm"><input type="checkbox" id="kit-saved"> <span>I have saved the backup kit somewhere safe.</span></label>
    <button type="button" id="kit-done" disabled>Continue</button>
  </section>

  <section id="screen-status" hidden>
    <h2>Your install is running</h2>
    <dl id="summary" class="summary"></dl>
    <h3>Connect your backend</h3>
    <p class="muted">Give these two values to whoever runs your backend. Keep the key private.</p>
    <dl class="summary">
      <dt>Wallet manager address</dt><dd><code id="manager-url"></code></dd>
      <dt>Backend key</dt><dd><code id="operator-key"></code> <button type="button" class="link" id="copy-key">Copy</button></dd>
    </dl>
    <h3>Health</h3>
    <ul id="health" class="steps"></ul>
  </section>
</main>
<script src="/app.js"></script>
</body>
</html>
`;

export const APP_CSS = `:root {
  --bg: #f7f7f5; --panel: #ffffff; --text: #1d1d1b; --muted: #6b6b66; --line: #e2e2dc;
  --accent: #2459d6; --accent-text: #ffffff; --ok: #1f8a4c; --bad: #c0392b;
  color-scheme: light dark;
}
@media (prefers-color-scheme: dark) {
  :root { --bg: #161615; --panel: #1f1f1d; --text: #ececea; --muted: #a3a39c; --line: #33332f;
    --accent: #6d95f5; --accent-text: #0e0e0d; --ok: #4cc47f; --bad: #ee7466; }
}
* { box-sizing: border-box; }
/* Author display rules below would otherwise beat the hidden attribute. */
[hidden] { display: none !important; }
body { margin: 0; background: var(--bg); color: var(--text);
  font: 16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
main { max-width: 720px; margin: 0 auto; padding: 32px 16px 64px; }
header h1 { margin: 0 0 4px; font-size: 1.6rem; }
section { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 24px; margin-top: 24px; }
h2 { font-size: 1.15rem; margin: 0 0 8px; }
h3 { font-size: 1rem; margin: 24px 0 8px; }
.muted { color: var(--muted); }
.error { color: var(--bad); }
.ok { color: var(--ok); }
ol.wizard { list-style: none; padding: 0; margin: 0; }
ol.wizard > li { padding: 16px 0; border-bottom: 1px solid var(--line); }
ol.wizard > li.disabled { opacity: .45; pointer-events: none; }
.cards { display: grid; gap: 12px; margin: 12px 0; }
.card { display: grid; gap: 4px; padding: 14px 14px 14px 44px; position: relative; border: 1px solid var(--line);
  border-radius: 10px; cursor: pointer; }
.card input { position: absolute; left: 14px; top: 17px; }
.card span { color: var(--muted); font-size: .95rem; }
.card:has(input:checked) { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
input, textarea { width: 100%; font: inherit; padding: 10px 12px; border: 1px solid var(--line); border-radius: 8px;
  background: var(--bg); color: var(--text); }
textarea { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .9rem; }
.card input, .confirm input { width: auto; }
label { display: block; margin: 8px 0; }
.confirm { display: flex; gap: 8px; align-items: flex-start; margin-top: 12px; }
button, .button { display: inline-block; font: inherit; padding: 10px 18px; margin-top: 8px; border-radius: 8px;
  border: 1px solid var(--line); background: var(--panel); color: var(--text); cursor: pointer; text-decoration: none; }
.primary { background: var(--accent); color: var(--accent-text); border-color: var(--accent); }
button:disabled { opacity: .5; cursor: not-allowed; }
button.link { border: 0; background: none; color: var(--accent); padding: 0; margin: 4px 0; }
form { display: flex; gap: 8px; align-items: center; }
form button { margin-top: 0; }
.steps { list-style: none; padding: 0; margin: 16px 0; }
.steps li { padding: 6px 0 6px 28px; position: relative; }
.steps li::before { position: absolute; left: 0; width: 20px; text-align: center; }
.steps li.done::before { content: "✓"; color: var(--ok); }
.steps li.running::before { content: "…"; color: var(--accent); }
.steps li.pending::before { content: "○"; color: var(--muted); }
.steps li.bad::before, .steps li.failed::before { content: "✕"; color: var(--bad); }
.steps li.skipped { display: none; }
.summary { display: grid; grid-template-columns: max-content 1fr; gap: 6px 16px; margin: 0; }
.summary dt { color: var(--muted); }
.summary dd { margin: 0; overflow-wrap: anywhere; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .9rem; }
@media (max-width: 520px) { .summary { grid-template-columns: 1fr; } form { flex-direction: column; align-items: stretch; } }
`;

export const APP_JS = `(() => {
  const PIN_KEY = "dpm-setup-pin";
  const $ = (id) => document.getElementById(id);
  const screens = ["pin", "wizard", "progress", "backup", "status"];
  let checkedKey = null;
  let pollTimer = null;

  function show(name) {
    for (const s of screens) $("screen-" + s).hidden = s !== name;
  }

  async function api(method, path, body) {
    const res = await fetch(path, {
      method,
      headers: { "Content-Type": "application/json", "X-Setup-Pin": sessionStorage.getItem(PIN_KEY) || "" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && path !== "/api/session") { sessionStorage.removeItem(PIN_KEY); show("pin"); }
    if (!res.ok) throw new Error(data.message || "Request failed (" + res.status + ")");
    return data;
  }

  // ── PIN ──
  $("pin-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    sessionStorage.setItem(PIN_KEY, $("pin").value.trim());
    try { await api("POST", "/api/session", { pin: $("pin").value.trim() }); refresh(); }
    catch (err) { sessionStorage.removeItem(PIN_KEY); alertText($("pin"), err.message); }
  });

  function alertText(input, text) { input.setCustomValidity(text); input.reportValidity(); input.addEventListener("input", () => input.setCustomValidity(""), { once: true }); }

  // ── Wizard ──
  function renderEnvironments(envs, defaultEnvironment) {
    const list = $("env-list");
    if (list.childElementCount) return;
    for (const env of envs) {
      const label = document.createElement("label");
      label.className = "card" + (env.advanced ? " advanced" : "");
      label.hidden = env.advanced;
      label.innerHTML = '<input type="radio" name="env"><strong></strong><span></span>';
      label.querySelector("input").value = env.id;
      label.querySelector("strong").textContent = env.label;
      label.querySelector("span").textContent = env.description;
      if (env.id === defaultEnvironment) label.querySelector("input").checked = true;
      list.appendChild(label);
    }
    list.addEventListener("change", () => { $("custom-url-row").hidden = selectedEnv() !== "custom"; resetKeyCheck(); });
  }

  $("toggle-advanced").addEventListener("click", () => {
    for (const el of document.querySelectorAll(".card.advanced")) el.hidden = false;
    $("toggle-advanced").hidden = true;
  });

  const selectedEnv = () => (document.querySelector('input[name="env"]:checked') || {}).value;
  const selectedMode = () => (document.querySelector('input[name="mode"]:checked') || {}).value;

  function keyInput() {
    return { environment: selectedEnv(), customUrl: $("custom-url").value, builderKey: $("builder-key").value };
  }

  function resetKeyCheck() {
    checkedKey = null;
    $("key-result").textContent = "";
    $("mode-step").classList.add("disabled");
    updateStart();
  }
  $("builder-key").addEventListener("input", resetKeyCheck);
  $("custom-url").addEventListener("input", resetKeyCheck);

  $("check-key").addEventListener("click", async () => {
    const out = $("key-result");
    out.className = "muted"; out.textContent = "Checking…";
    try {
      const result = await api("POST", "/api/check-key", keyInput());
      checkedKey = JSON.stringify(keyInput());
      out.className = "ok";
      out.textContent = "✓ Connecting as " + result.builderName + ".";
      $("mode-step").classList.remove("disabled");
    } catch (err) {
      out.className = "error"; out.textContent = err.message;
    }
    updateStart();
  });

  function updateStart() {
    $("start").disabled = !(checkedKey && selectedMode() && $("confirm-mode").checked);
  }
  document.addEventListener("change", (e) => { if (e.target.name === "mode" || e.target.id === "confirm-mode") updateStart(); });

  $("start").addEventListener("click", async () => {
    $("start").disabled = true; $("start-error").textContent = "";
    try {
      await api("POST", "/api/start", { ...keyInput(), mode: selectedMode(), confirmModeIsPermanent: $("confirm-mode").checked });
      refresh();
    } catch (err) { $("start-error").textContent = err.message; updateStart(); }
  });

  // ── Progress ──
  function renderSteps(list, steps) {
    list.innerHTML = "";
    for (const step of steps) {
      const li = document.createElement("li");
      li.className = step.status;
      li.textContent = step.label;
      list.appendChild(li);
    }
  }

  $("retry").addEventListener("click", async () => { await api("POST", "/api/retry"); refresh(); });

  // ── Backup ──
  $("download-kit").addEventListener("click", async (e) => {
    e.preventDefault();
    const res = await fetch("/api/backup-kit", { headers: { "X-Setup-Pin": sessionStorage.getItem(PIN_KEY) || "" } });
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement("a");
    a.href = url; a.download = "dpm-custody-backup-kit.txt"; a.click();
    URL.revokeObjectURL(url);
  });
  $("kit-saved").addEventListener("change", () => { $("kit-done").disabled = !$("kit-saved").checked; });
  $("kit-done").addEventListener("click", async () => { await api("POST", "/api/backup-acknowledged"); refresh(); });

  // ── Status ──
  $("copy-key").addEventListener("click", () => navigator.clipboard && navigator.clipboard.writeText($("operator-key").textContent));

  async function renderStatus(state) {
    const summary = $("summary");
    summary.innerHTML = "";
    for (const [k, v] of [["Builder", state.builderName], ["Environment", state.environment], ["Custody mode", state.mode]]) {
      const dt = document.createElement("dt"); dt.textContent = k;
      const dd = document.createElement("dd"); dd.textContent = v || "";
      summary.append(dt, dd);
    }
    if (state.connection) {
      $("manager-url").textContent = state.connection.managerUrl;
      $("operator-key").textContent = state.connection.operatorKey;
    }
    try {
      const live = await api("GET", "/api/live-status");
      renderSteps($("health"), live.checks.map((c) => ({ label: c.label + (c.detail ? " — " + c.detail : ""), status: c.ok ? "done" : "bad" })));
    } catch (err) { renderSteps($("health"), [{ label: err.message, status: "bad" }]); }
  }

  // ── Router ──
  async function refresh() {
    clearTimeout(pollTimer);
    if (!sessionStorage.getItem(PIN_KEY)) return show("pin");
    let state;
    try { state = await api("GET", "/api/state"); } catch { return; }
    $("subtitle").textContent = state.builderName ? "Install for " + state.builderName : "Set up your wallet service in a few minutes.";
    if (state.phase === "new") { renderEnvironments(state.environments, state.defaultEnvironment); return show("wizard"); }
    if (state.phase === "running" || state.phase === "failed") {
      show("progress");
      renderSteps($("steps"), state.steps);
      $("failure").hidden = state.phase !== "failed";
      $("failure-text").textContent = state.lastError || "";
      $("progress-title").textContent = state.phase === "failed" ? "Setup stopped" : "Setting things up…";
      $("progress-hint").textContent = state.phase === "failed"
        ? "Nothing is lost: finished steps stay finished. Fix the problem below, then click Retry."
        : "This usually takes a minute or two. You can close this page; it carries on.";
      pollTimer = setTimeout(refresh, 2000);
      return;
    }
    if (!state.backupAcknowledged) return show("backup");
    show("status");
    renderStatus(state);
    pollTimer = setTimeout(refresh, 15000);
  }

  refresh();
})();
`;
