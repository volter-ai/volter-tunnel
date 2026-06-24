/**
 * Static marketing + docs pages served from the apex (no subdomain).
 *
 * These are plain self-contained HTML strings (inline CSS, no build step, no
 * external assets) so the Worker can serve the front door and getting-started
 * docs directly — no separate static host or deploy target. Tunnel subdomains
 * never reach here; the worker forwards every subdomain path to its TunnelDO.
 *
 * The waitlist form posts JSON to `/waitlist` (RegistryDO). Signup is invite-only
 * while `SIGNUP_ALLOWED_USERS` is set, so the public front door collects requests
 * for an operator to approve (append the login to the env secret).
 */

const STYLE = /* css */ `
  :root {
    --bg:#0b0d12; --panel:#12151c; --panel2:#171b24; --line:#232936;
    --fg:#e7ebf3; --muted:#9aa4b6; --accent:#6ea8fe; --accent2:#7ee3c0;
    --radius:14px; --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  }
  * { box-sizing:border-box; }
  html { scroll-behavior:smooth; }
  body {
    margin:0; background:var(--bg); color:var(--fg);
    font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
    -webkit-font-smoothing:antialiased;
  }
  a { color:var(--accent); text-decoration:none; }
  a:hover { text-decoration:underline; }
  .wrap { max-width:980px; margin:0 auto; padding:0 22px; }
  header.nav {
    position:sticky; top:0; z-index:10; backdrop-filter:blur(8px);
    background:rgba(11,13,18,.72); border-bottom:1px solid var(--line);
  }
  .nav .wrap { display:flex; align-items:center; gap:18px; height:58px; }
  .brand { font-weight:700; letter-spacing:.2px; display:flex; align-items:center; gap:9px; }
  .brand .dot { width:11px; height:11px; border-radius:50%;
    background:linear-gradient(135deg,var(--accent),var(--accent2)); box-shadow:0 0 14px var(--accent); }
  .nav nav { margin-left:auto; display:flex; gap:20px; font-size:14px; }
  .nav nav a { color:var(--muted); }
  .hero { padding:78px 0 54px; text-align:center; }
  .hero h1 { font-size:clamp(34px,6vw,52px); line-height:1.08; margin:0 0 18px; letter-spacing:-1px; }
  .hero h1 .grad { background:linear-gradient(135deg,var(--accent),var(--accent2));
    -webkit-background-clip:text; background-clip:text; color:transparent; }
  .hero p.sub { font-size:clamp(17px,2.4vw,21px); color:var(--muted); max-width:660px; margin:0 auto 30px; }
  .cta { display:flex; gap:14px; justify-content:center; flex-wrap:wrap; }
  .btn { display:inline-block; padding:12px 22px; border-radius:10px; font-weight:600; font-size:15px;
    border:1px solid var(--line); color:var(--fg); background:var(--panel2); cursor:pointer; }
  .btn.primary { background:linear-gradient(135deg,var(--accent),#5b8cf0); border-color:transparent; color:#07101f; }
  .btn:hover { text-decoration:none; transform:translateY(-1px); }
  pre.term { text-align:left; background:#0a0c11; border:1px solid var(--line); border-radius:var(--radius);
    padding:18px 20px; overflow:auto; font:13.5px/1.7 var(--mono); color:#cdd6e6; margin:30px auto 0; max-width:680px; }
  pre.term .c { color:var(--accent2); } pre.term .d { color:#6b7689; } pre.term .u { color:var(--accent); }
  section { padding:46px 0; border-top:1px solid var(--line); }
  section h2 { font-size:26px; margin:0 0 6px; letter-spacing:-.4px; }
  section .lede { color:var(--muted); margin:0 0 26px; }
  .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(250px,1fr)); gap:16px; }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:var(--radius); padding:18px 18px 16px; }
  .card h3 { margin:0 0 6px; font-size:16px; }
  .card p { margin:0; color:var(--muted); font-size:14.5px; }
  .card .tag { font-size:11px; text-transform:uppercase; letter-spacing:.6px; color:var(--accent2);
    font-weight:700; margin-bottom:9px; }
  .steps { display:grid; grid-template-columns:repeat(auto-fit,minmax(260px,1fr)); gap:16px; }
  .step { background:var(--panel); border:1px solid var(--line); border-radius:var(--radius); padding:18px; }
  .step .n { width:26px; height:26px; border-radius:50%; display:grid; place-items:center; font-size:13px; font-weight:700;
    background:var(--panel2); border:1px solid var(--line); color:var(--accent); margin-bottom:10px; }
  .step code { display:block; font:13px/1.6 var(--mono); color:#cdd6e6; background:#0a0c11; border:1px solid var(--line);
    border-radius:9px; padding:10px 12px; margin-top:10px; overflow:auto; }
  form.wl { display:grid; gap:12px; max-width:520px; }
  form.wl label { font-size:13px; color:var(--muted); display:block; margin-bottom:5px; }
  form.wl input, form.wl textarea { width:100%; background:var(--panel2); border:1px solid var(--line); color:var(--fg);
    border-radius:10px; padding:11px 13px; font:15px/1.4 inherit; }
  form.wl textarea { resize:vertical; min-height:74px; }
  form.wl input:focus, form.wl textarea:focus { outline:none; border-color:var(--accent); }
  .wl-msg { font-size:14px; min-height:20px; }
  .wl-msg.ok { color:var(--accent2); } .wl-msg.err { color:#ff8e8e; }
  footer { padding:34px 0 56px; color:var(--muted); font-size:13.5px; border-top:1px solid var(--line); }
  footer .wrap { display:flex; gap:18px; flex-wrap:wrap; align-items:center; }
  footer .sp { margin-left:auto; }
  .doc h2 { margin-top:38px; } .doc h3 { margin-top:26px; font-size:18px; }
  .doc pre { background:#0a0c11; border:1px solid var(--line); border-radius:12px; padding:16px 18px; overflow:auto;
    font:13.5px/1.7 var(--mono); color:#cdd6e6; }
  .doc code { font:13px var(--mono); background:var(--panel2); border:1px solid var(--line); border-radius:6px; padding:1px 6px; }
  .doc pre code { background:none; border:none; padding:0; }
  .doc table { border-collapse:collapse; width:100%; margin:14px 0; font-size:14.5px; }
  .doc th, .doc td { border:1px solid var(--line); padding:8px 11px; text-align:left; }
  .doc th { background:var(--panel2); }
  .note { background:var(--panel); border:1px solid var(--line); border-left:3px solid var(--accent); border-radius:10px;
    padding:12px 16px; color:var(--muted); font-size:14.5px; margin:18px 0; }
`;

const FAVICON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Ccircle cx='16' cy='16' r='13' fill='%236ea8fe'/%3E%3C/svg%3E";

function shell(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<meta name="description" content="volter-tunnel — free, stable, reservable tunnel URLs. An open-source ngrok alternative on Cloudflare's edge.">
<link rel="icon" href="${FAVICON}">
<style>${STYLE}</style>
</head><body>${body}</body></html>`;
}

function nav(): string {
  return `<header class="nav"><div class="wrap">
    <span class="brand"><span class="dot"></span> volter-tunnel</span>
    <nav>
      <a href="/#features">Features</a>
      <a href="/#start">Quickstart</a>
      <a href="/docs">Docs</a>
      <a href="/#waitlist">Get access</a>
    </nav>
  </div></header>`;
}

function footer(): string {
  return `<footer><div class="wrap">
    <span class="brand"><span class="dot"></span> volter-tunnel</span>
    <span>Open-source HTTP/WS reverse tunnel on Cloudflare.</span>
    <span class="sp"></span>
    <a href="/docs">Docs</a><a href="/#waitlist">Get access</a>
  </div></footer>`;
}

/** The marketing landing page with the waitlist form. */
export function landingPage(domain: string): string {
  const example = `my-app.${domain}`;
  const body = `${nav()}
  <main>
    <div class="hero wrap">
      <h1>A tunnel URL that's<br><span class="grad">yours, free, and stays put.</span></h1>
      <p class="sub">Expose a local port at <code style="font-family:var(--mono)">https://${example}</code> — reserve a
        friendly subdomain once and keep it across reconnects and restarts. Open-source, on Cloudflare's edge, with
        idle tunnels that cost nothing.</p>
      <div class="cta">
        <a class="btn primary" href="#waitlist">Request access</a>
        <a class="btn" href="/docs">Read the docs</a>
      </div>
      <pre class="term"><span class="d"># log in with the GitHub CLI you already have — no password, no OAuth app</span>
<span class="c">$</span> volter-tunnel login <span class="d">--host</span> <span class="u">https://${domain}</span>
<span class="d"># expose localhost:3000 at a stable, reservable URL</span>
<span class="c">$</span> volter-tunnel <span class="d">--port</span> 3000 <span class="d">--tunnel-id</span> my-app
  <span class="u">https://${example}</span>  <span class="d">→  http://localhost:3000</span></pre>
    </div>

    <section id="features"><div class="wrap">
      <h2>Why volter-tunnel</h2>
      <p class="lede">Everything ngrok charges for at the free-tier boundary — given away, because idle tunnels are
        genuinely free to run on Cloudflare Durable Objects.</p>
      <div class="grid">
        <div class="card"><div class="tag">Headline</div><h3>Reserved subdomains, free</h3>
          <p>Claim <code style="font-family:var(--mono)">my-app</code> and it's yours. The URL survives reconnects,
            restarts, and laptop sleeps — no random hostname every run.</p></div>
        <div class="card"><div class="tag">Cost</div><h3>Idle = free → run many</h3>
          <p>Tunnels hibernate when quiet and cost nothing while idle, so keeping several reserved at once is fine.</p></div>
        <div class="card"><div class="tag">Auth</div><h3>GitHub login, no OAuth app</h3>
          <p>Reuses the credential your <code style="font-family:var(--mono)">gh</code> CLI already has — verified once
            and discarded. Or prove it with a public gist and send us no token at all.</p></div>
        <div class="card"><div class="tag">Inspect</div><h3>Live request inspector</h3>
          <p>See every request/response flowing through your tunnel in real time — the most-loved ngrok feature.</p></div>
        <div class="card"><div class="tag">Gate</div><h3>Share with only your team</h3>
          <p>Put HTTP basic-auth or JWT in front of a tunnel at the edge, before traffic ever reaches your machine.</p></div>
        <div class="card"><div class="tag">Embed</div><h3>Iframe-embeddable</h3>
          <p>Strips <code style="font-family:var(--mono)">frame-ancestors</code> / X-Frame-Options so a tunneled app
            renders inside another web UI — something no other OSS tunnel does.</p></div>
        <div class="card"><div class="tag">Protocol</div><h3>HTTP, streaming &amp; WebSocket</h3>
          <p>Full WebSocket relay and streaming responses, not just plain request/response.</p></div>
        <div class="card"><div class="tag">Mobile</div><h3>QR code on connect</h3>
          <p>Scan the printed QR to open your tunnel on a phone instantly — real-device testing in one step.</p></div>
        <div class="card"><div class="tag">Routing</div><h3>Wildcard subdomains</h3>
          <p><code style="font-family:var(--mono)">*.my-app.${domain}</code> all route to one tunnel — handy for
            multi-tenant or vhost apps.</p></div>
      </div>
    </div></section>

    <section id="start"><div class="wrap">
      <h2>Quickstart</h2>
      <p class="lede">Three steps once you're off the waitlist. Full reference in the <a href="/docs">docs</a>.</p>
      <div class="steps">
        <div class="step"><div class="n">1</div><strong>Install the client</strong>
          <p style="color:var(--muted);font-size:14px;margin:6px 0 0">Runs under Bun (imports TypeScript directly).</p>
          <code>bun add @volter/tunnel</code></div>
        <div class="step"><div class="n">2</div><strong>Log in with GitHub</strong>
          <p style="color:var(--muted);font-size:14px;margin:6px 0 0">Uses your <code>gh</code> auth; mints a token saved locally.</p>
          <code>volter-tunnel login --host https://${domain}</code></div>
        <div class="step"><div class="n">3</div><strong>Expose a port</strong>
          <p style="color:var(--muted);font-size:14px;margin:6px 0 0">Pick a tunnel id to reserve the subdomain.</p>
          <code>volter-tunnel --port 3000 --tunnel-id my-app</code></div>
      </div>
    </div></section>

    <section id="waitlist"><div class="wrap">
      <h2>Request access</h2>
      <p class="lede">We're rolling out by invite while we scale. Drop your GitHub username and we'll add you to the
        allowlist — you'll log in with that same GitHub account.</p>
      <form class="wl" id="wl" autocomplete="off">
        <div><label for="gh">GitHub username <span style="color:#ff8e8e">*</span></label>
          <input id="gh" name="githubUser" placeholder="octocat" required maxlength="39"></div>
        <div><label for="em">Email <span style="color:var(--muted)">(optional — to notify you)</span></label>
          <input id="em" name="email" type="email" placeholder="you@example.com" maxlength="200"></div>
        <div><label for="uc">What will you tunnel? <span style="color:var(--muted)">(optional)</span></label>
          <textarea id="uc" name="useCase" placeholder="local dev server, webhook testing, demo for a client…" maxlength="500"></textarea></div>
        <div><button class="btn primary" type="submit" id="wlbtn">Join the waitlist</button></div>
        <div class="wl-msg" id="wlmsg" role="status"></div>
      </form>
    </div></section>
  </main>
  ${footer()}
  <script>
    (function () {
      var f = document.getElementById('wl'), msg = document.getElementById('wlmsg'), btn = document.getElementById('wlbtn');
      f.addEventListener('submit', function (e) {
        e.preventDefault();
        msg.className = 'wl-msg'; msg.textContent = '';
        var body = {
          githubUser: f.githubUser.value.trim(),
          email: f.email.value.trim(),
          useCase: f.useCase.value.trim()
        };
        if (!body.githubUser) { msg.className = 'wl-msg err'; msg.textContent = 'GitHub username is required.'; return; }
        btn.disabled = true; btn.textContent = 'Submitting…';
        fetch('/waitlist', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
          .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
          .then(function (res) {
            if (res.ok) {
              msg.className = 'wl-msg ok';
              msg.textContent = res.j && res.j.alreadyAllowed
                ? "You're already approved — run \`volter-tunnel login\` to sign up."
                : "You're on the list — we'll reach out when your GitHub account is approved.";
              f.reset();
            } else {
              msg.className = 'wl-msg err';
              msg.textContent = (res.j && res.j.error) || 'Something went wrong. Please try again.';
            }
          })
          .catch(function () { msg.className = 'wl-msg err'; msg.textContent = 'Network error. Please try again.'; })
          .finally(function () { btn.disabled = false; btn.textContent = 'Join the waitlist'; });
      });
    })();
  </script>`;
  return shell('volter-tunnel — free, stable tunnel URLs', body);
}

/** Getting-started documentation, served at /docs. */
export function docsPage(domain: string): string {
  const example = `my-app.${domain}`;
  const body = `${nav()}
  <main class="wrap doc" style="padding:42px 22px 0">
    <h1 style="font-size:34px;letter-spacing:-.6px;margin:0 0 6px">Documentation</h1>
    <p style="color:var(--muted);margin:0 0 8px">Get a local port onto a stable public URL in a couple of minutes.</p>

    <div class="note">Signup is <strong>invite-only</strong> right now. If <code>volter-tunnel login</code> returns
      <em>signup not permitted</em>, <a href="/#waitlist">request access</a> first.</div>

    <h2>1. Install</h2>
    <p>The client ships TypeScript and runs under <a href="https://bun.sh" target="_blank" rel="noopener">Bun</a>
      (which imports <code>.ts</code> directly).</p>
    <pre><code>bun add @volter/tunnel
# or run it without installing:
bunx @volter/tunnel --port 3000</code></pre>

    <h2>2. Log in (GitHub)</h2>
    <p>Two ways to prove your GitHub identity — pick either. Both map you to a stable account so your reserved
      subdomains come back every time.</p>

    <h3>Token exchange (default)</h3>
    <p>Sends the token from your <code>gh</code> CLI once; the relay verifies it against the GitHub API and
      <strong>discards it</strong> (never stored or logged), then mints a <code>vta_</code> token saved to
      <code>~/.config/volter/token</code>.</p>
    <pre><code>volter-tunnel login --host https://${domain}</code></pre>

    <h3>Gist proof (sends us no token)</h3>
    <p>The relay issues a one-time nonce; you publish it as a <strong>public gist</strong>; the relay reads the gist's
      owner. Your token never leaves your machine.</p>
    <pre><code>volter-tunnel login --host https://${domain} --gist</code></pre>

    <h2>3. Expose a port</h2>
    <pre><code># random id (anonymous-style) — prints a URL + QR code
volter-tunnel --port 3000 --host https://${domain}

# reserve a friendly, stable subdomain
volter-tunnel --port 3000 --host https://${domain} --tunnel-id my-app
#   → https://${example}</code></pre>
    <p>The reserved id is yours and is returned on every reconnect. Idle reservations are only reclaimed if they go
      unused past the idle window <em>and</em> someone else asks for that exact name.</p>

    <h2>Use it as a library</h2>
    <pre><code>import { createTunnel } from '@volter/tunnel/client';

const tunnel = await createTunnel({
  port: 3000,
  host: 'https://${domain}',
  tunnelId: 'my-app',            // → https://${example}
});
console.log(tunnel.url);
// … later
tunnel.close();</code></pre>

    <h2>Protect a tunnel</h2>
    <p>Gate access at the edge so only your team reaches the app:</p>
    <pre><code>volter-tunnel --port 3000 --tunnel-id my-app --basic-auth user:pass</code></pre>
    <p>JWT / cookie auth is also supported when the relay has <code>JWT_SECRET</code> configured (Bearer header,
      <code>?__volter_token=</code> query, or the <code>__volter_auth</code> cookie).</p>

    <h2>Inspect traffic</h2>
    <p>Every request through your tunnel is visible to the tunnel owner. It's gated by your tunnel secret:</p>
    <pre><code>curl https://${example}/__volter_inspect \\
  -H "Authorization: Bearer $TUNNEL_SECRET"</code></pre>

    <h2>Common flags</h2>
    <table>
      <tr><th>Flag</th><th>Meaning</th></tr>
      <tr><td><code>--port &lt;n&gt;</code></td><td>Local port to expose (required).</td></tr>
      <tr><td><code>--host &lt;url&gt;</code></td><td>Relay URL, e.g. <code>https://${domain}</code>.</td></tr>
      <tr><td><code>--tunnel-id &lt;id&gt;</code></td><td>Reserve a stable subdomain instead of a random one.</td></tr>
      <tr><td><code>--basic-auth user:pass</code></td><td>Require HTTP basic-auth at the edge.</td></tr>
      <tr><td><code>--no-qr</code></td><td>Don't print the QR code on connect.</td></tr>
    </table>

    <div class="note">Limits: free accounts get a few reserved ids and a generous daily/monthly fair-use cap. Heavy
      bandwidth, custom hostnames, and raw TCP/UDP are roadmap/paid items.</div>

    <p style="margin:30px 0 0"><a href="/">← Back to home</a> &nbsp;·&nbsp; <a href="/#waitlist">Request access</a></p>
  </main>
  ${footer()}`;
  return shell('volter-tunnel — docs', body);
}

export function htmlResponse(html: string): Response {
  return new Response(html, {
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=300' },
  });
}
