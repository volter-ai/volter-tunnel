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
 *
 * Visual language: npmjs.com — light/white, npm-red accent, system Helvetica,
 * left-aligned, flat bordered cards, roomy. (Design iterated via screenshot
 * review.) Fully offline: no remote fonts/images/CSS.
 */

const STYLE = /* css */ `
  :root {
    --npm-red: #cb3837;
    --npm-red-hover: #b02b2a;
    --border-color: #e6e6e6;
    --text-color: #262626;
    --text-color-light: #555;
    --bg-light-gray: #f7f7f7;
    --monospace: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  * { box-sizing: border-box; }
  html { scroll-behavior: smooth; }
  body {
    margin: 0;
    background: #fff;
    color: var(--text-color);
    font: 16px/1.7 -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  a { color: var(--npm-red); text-decoration: none; }
  a:hover { text-decoration: underline; color: var(--npm-red-hover); }

  .wrap { max-width: 1100px; margin: 0 auto; padding: 0 24px; }

  header.nav {
    border-bottom: 1px solid var(--border-color);
    background: #fff;
    position: sticky; top: 0; z-index: 10;
  }
  .nav .wrap { display: flex; align-items: center; gap: 18px; height: 64px; }
  .brand { font-weight: 700; font-size: 20px; display: flex; align-items: center; gap: 8px; color: var(--text-color); }
  .brand:hover { text-decoration: none; }
  .brand .mark { width: 24px; height: 24px; background: var(--npm-red); border-radius: 4px; }
  .nav nav { margin-left: auto; display: flex; gap: 24px; font-size: 16px; }
  .nav nav a { color: var(--text-color-light); transition: color 0.2s ease; }
  .nav nav a:hover { color: var(--npm-red-hover); text-decoration: none; }

  .hero { padding: 100px 0 80px; }
  .hero h1 { font-size: 52px; line-height: 1.15; margin: 0 0 24px; font-weight: 700; letter-spacing: -1.8px; }
  .hero p.sub { font-size: 21px; line-height: 1.6; color: var(--text-color-light); max-width: 680px; margin: 0 0 40px; }
  .hero code { font-family: var(--monospace); font-size: 0.9em; background: var(--bg-light-gray); padding: 3px 7px; border-radius: 5px; border: 1px solid var(--border-color); }

  .cta { display: flex; gap: 16px; align-items: center; flex-wrap: wrap; margin-bottom: 55px; }
  .btn {
    display: inline-block; padding: 14px 28px; border-radius: 6px; font-weight: 600; font-size: 16px;
    border: 1px solid var(--border-color); color: var(--text-color); background: #fff; cursor: pointer;
    transition: all 0.2s ease;
  }
  .btn.primary { background: var(--npm-red); border-color: var(--npm-red); color: #fff; }
  .btn:hover { text-decoration: none; border-color: var(--npm-red); transform: translateY(-1px); box-shadow: 0 2px 4px rgba(0,0,0,0.05); }
  .btn.primary:hover { background: var(--npm-red-hover); border-color: var(--npm-red-hover); }

  pre.term {
    text-align: left; background: var(--bg-light-gray); border: 1px solid var(--border-color); border-radius: 0 0 6px 6px;
    padding: 20px; overflow: auto; font: 14px/1.6 var(--monospace);
    color: var(--text-color); margin: 0;
  }
  .term-header {
    background: #f0f0f0; padding: 10px 20px; border: 1px solid var(--border-color);
    border-bottom: none; border-radius: 6px 6px 0 0; font-family: var(--monospace);
    font-size: 13px; color: var(--text-color-light);
  }
  pre.term .c { color: var(--npm-red); }
  pre.term .d { color: #888; }
  pre.term .u { color: var(--text-color); font-weight: 600; }

  section { border-top: 1px solid var(--border-color); padding: 80px 0; }
  section.bg-gray { background: var(--bg-light-gray); }
  section h2 { font-size: 36px; margin: 0 0 16px; font-weight: 600; letter-spacing: -.8px; }
  section .lede { color: var(--text-color-light); font-size: 18px; line-height: 1.7; margin: 0 0 50px; max-width: 680px; }

  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 30px; }
  .card {
    background: #fff; border: 1px solid var(--border-color); border-radius: 8px; padding: 28px;
    transition: box-shadow 0.2s ease, transform 0.2s ease, border-color 0.2s ease;
  }
  .card:hover { transform: translateY(-2px); border-color: #ccc; box-shadow: 0 5px 15px rgba(0,0,0,0.05); }
  .card .icon { margin-bottom: 16px; color: var(--npm-red); }
  .card h3 { margin: 0 0 10px; font-size: 19px; font-weight: 600; }
  .card p { margin: 0; color: var(--text-color-light); font-size: 16px; line-height: 1.65; }
  .card code { font-family: var(--monospace); font-size: 0.9em; background: var(--bg-light-gray); padding: 3px 7px; border-radius: 5px; border: 1px solid var(--border-color); }

  .steps-grid { display: grid; grid-template-columns: 30px 1fr; gap: 20px 30px; }
  .step-num {
    grid-column: 1; font-size: 18px; font-weight: 700; color: var(--npm-red);
    width: 30px; height: 30px; border: 2px solid var(--border-color);
    border-radius: 50%; display: grid; place-items: center;
    background: #fff;
  }
  .step-content { grid-column: 2; padding-bottom: 30px; border-left: 2px solid var(--border-color); padding-left: 30px; margin-left: 14px; }
  .steps-grid > div:last-of-type { border-left: 2px solid transparent; }
  .step-content h3 { font-size: 20px; font-weight: 600; margin: 4px 0 8px; }
  .step-content p { margin: 0; font-size: 16px; color: var(--text-color-light); }
  .step-content code {
    display: block; font: 14px/1.6 var(--monospace); color: var(--text-color);
    background: #fff; border: 1px solid var(--border-color);
    border-radius: 6px; padding: 14px 16px; margin-top: 14px; overflow: auto;
  }

  form.wl { display: grid; grid-template-columns: 1fr; gap: 12px; max-width: 520px; }
  form.wl .form-group { display: flex; flex-direction: column; }
  form.wl label { font-size: 14px; font-weight: 600; display: block; margin-bottom: 8px; }
  form.wl input, form.wl textarea {
    width: 100%; background: #fff; border: 1px solid #bbb; color: var(--text-color);
    border-radius: 6px; padding: 14px; font: 16px/1.4 inherit; transition: border-color 0.2s, box-shadow 0.2s;
  }
  form.wl textarea { resize: vertical; min-height: 90px; }
  form.wl input:focus, form.wl textarea:focus {
    outline: none; border-color: var(--npm-red); box-shadow: 0 0 0 3px rgba(203, 56, 55, 0.15);
  }
  form.wl .btn { margin-top: 8px; }
  .wl-msg { font-size: 15px; min-height: 22px; padding-top: 5px; }
  .wl-msg.ok { color: #28a745; }
  .wl-msg.err { color: #d73a49; }

  footer { padding: 50px 0; font-size: 14px; border-top: 1px solid var(--border-color); background: var(--bg-light-gray); }
  footer .wrap { display: flex; gap: 30px; flex-wrap: wrap; align-items: flex-start; justify-content: space-between; }
  footer a { color: var(--text-color-light); transition: color 0.2s ease; }
  footer a:hover { color: var(--text-color); text-decoration: none; }
  footer .brand-col p { color: var(--text-color-light); font-size: 13px; margin-top: 8px; max-width: 280px; }
  footer .brand { font-size: 16px; }
  footer .links-col { display: flex; gap: 60px; }
  footer .links-col div { display: flex; flex-direction: column; gap: 10px; }
  footer .links-col strong { font-weight: 600; color: var(--text-color); margin-bottom: 4px; }

  /* Docs article (same light system) */
  .doc { max-width: 820px; padding-bottom: 40px; }
  .doc h1 { font-size: 40px; letter-spacing: -1px; font-weight: 700; margin: 0 0 8px; }
  .doc .doc-sub { color: var(--text-color-light); font-size: 18px; margin: 0 0 4px; }
  .doc h2 { font-size: 27px; font-weight: 600; letter-spacing: -.4px; margin: 0 0 14px; padding-top: 40px; margin-top: 40px; border-top: 1px solid var(--border-color); }
  .doc h3 { font-size: 19px; font-weight: 600; margin: 28px 0 8px; }
  .doc p { color: var(--text-color-light); }
  .doc pre { background: var(--bg-light-gray); border: 1px solid var(--border-color); border-radius: 8px; padding: 16px 18px; overflow: auto; font: 14px/1.7 var(--monospace); color: var(--text-color); }
  .doc pre code { background: none; border: none; padding: 0; font-size: inherit; }
  .doc code { font-family: var(--monospace); font-size: 0.9em; background: var(--bg-light-gray); padding: 2px 6px; border-radius: 5px; border: 1px solid var(--border-color); }
  .doc table { border-collapse: collapse; width: 100%; margin: 16px 0; font-size: 15px; }
  .doc th, .doc td { border: 1px solid var(--border-color); padding: 9px 12px; text-align: left; }
  .doc th { background: var(--bg-light-gray); font-weight: 600; }
  .note { background: #fff; border: 1px solid var(--border-color); border-left: 3px solid var(--npm-red); border-radius: 6px; padding: 14px 18px; color: var(--text-color-light); font-size: 15px; margin: 20px 0; }

  @media (max-width: 768px) {
    .hero { text-align: left; padding: 60px 0; }
    .hero h1 { font-size: 38px; letter-spacing: -1.2px; }
    .hero p.sub { font-size: 18px; }
    .nav .wrap { padding: 0 16px; height: 60px; }
    .wrap { padding: 0 16px; }
    .nav nav { display: none; }
    section { padding: 60px 0; }
    section h2 { font-size: 30px; }
    footer .wrap { flex-direction: column; gap: 30px; }
    footer .links-col { margin-left: 0; width: 100%; justify-content: space-between; gap: 30px; }
    .step-content { padding-left: 24px; margin-left: 12px; }
    .doc h1 { font-size: 32px; }
  }
`;

// npm-style red block mark.
const FAVICON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Cpath fill='%23cb3837' d='M12 12h76v76H12z'/%3E%3Cpath fill='%23fff' d='M25 25h19v31h-7V32h-5v24h-7V25zm24 0h19v31h-7V32h-5v24h-7V25z'/%3E%3C/svg%3E";

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
    <a href="/" class="brand"><span class="mark"></span>volter-tunnel</a>
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
    <div class="brand-col">
      <a href="/" class="brand"><span class="mark"></span>volter-tunnel</a>
      <p>Open-source HTTP/WS reverse tunnel on Cloudflare's edge.</p>
    </div>
    <div class="links-col">
      <div>
        <strong>Product</strong>
        <a href="/#features">Features</a>
        <a href="/#start">Quickstart</a>
        <a href="/#waitlist">Get access</a>
      </div>
      <div>
        <strong>Resources</strong>
        <a href="/docs">Docs</a>
      </div>
    </div>
  </div></footer>`;
}

/** The marketing landing page with the waitlist form. */
export function landingPage(domain: string): string {
  const example = `my-app.${domain}`;
  const icon = (path: string) =>
    `<div class="icon"><svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${path}</svg></div>`;
  const body = `${nav()}
  <main>
    <div class="hero"><div class="wrap">
      <h1>A tunnel URL that's yours, free, and stays put.</h1>
      <p class="sub">Expose a local port at <code>https://${example}</code> — reserve a
        friendly subdomain once and keep it across reconnects and restarts. Open-source, on Cloudflare's edge, with
        idle tunnels that cost nothing.</p>
      <div class="cta">
        <a class="btn primary" href="#waitlist">Request access</a>
        <a class="btn" href="/docs">Read the docs</a>
      </div>
      <div>
        <div class="term-header">/bin/bash</div>
        <pre class="term"><span class="d"># log in with the GitHub CLI you already have — no password, no OAuth app</span>
<span class="c">$</span> volter-tunnel login <span class="d">--host</span> <span class="u">https://${domain}</span>
<span class="d"># expose localhost:3000 at a stable, reservable URL</span>
<span class="c">$</span> volter-tunnel <span class="d">--port</span> 3000 <span class="d">--tunnel-id</span> my-app
  <span class="u">https://${example}</span>  <span class="d">→  http://localhost:3000</span></pre>
      </div>
    </div></div>

    <section id="features" class="bg-gray"><div class="wrap">
      <h2>Why volter-tunnel</h2>
      <p class="lede">Everything ngrok charges for at the free-tier boundary — given away, because idle tunnels are
        genuinely free to run on Cloudflare Durable Objects.</p>
      <div class="grid">
        <div class="card">${icon('<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.72"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.72-1.72"></path>')}<h3>Reserved subdomains, free</h3>
          <p>Claim <code>my-app</code> and it's yours. The URL survives reconnects,
            restarts, and laptop sleeps — no random hostname every run.</p></div>
        <div class="card">${icon('<path d="M12 22v-6"></path><path d="M12 8V2"></path><path d="m15 11-2.5-2.5L10 11"></path><path d="m9 13 2.5 2.5L14 13"></path><path d="M22 12h-6"></path><path d="M8 12H2"></path>')}<h3>Idle = free → run many</h3>
          <p>Tunnels hibernate when quiet and cost nothing while idle, so keeping several reserved at once is fine.</p></div>
        <div class="card">${icon('<path d="M9 19c-4.3 1.4-4.3-2.5-6-3m12 5v-3.5c0-1 .1-1.4-.5-2 2.8-.3 5.5-1.4 5.5-6.1a4.6 4.6 0 0 0-1.3-3.2 4.2 4.2 0 0 0-.1-3.2s-1.1-.3-3.5 1.3a12.3 12.3 0 0 0-6.2 0C6.5 2.8 5.4 3.1 5.4 3.1a4.2 4.2 0 0 0-.1 3.2A4.6 4.6 0 0 0 4 9.5c0 4.7 2.7 5.8 5.5 6.1-.6.5-.9 1.2-.9 2.2v3.5"></path>')}<h3>GitHub login, no OAuth app</h3>
          <p>Reuses the credential your <code>gh</code> CLI already has — verified once
            and discarded. Or prove it with a public gist and send us no token at all.</p></div>
        <div class="card">${icon('<path d="M21.5 12H16c-.7 2-2 3-4 3s-3.3-1-4-3H2.5"></path><path d="M2.5 12a10 10 0 0 1 19 0Z"></path><circle cx="8" cy="12" r=".5" fill="currentColor"></circle><circle cx="16" cy="12" r=".5" fill="currentColor"></circle>')}<h3>Live request inspector</h3>
          <p>See every request/response flowing through your tunnel in real time — the most-loved ngrok feature.</p></div>
        <div class="card">${icon('<rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path>')}<h3>Share with only your team</h3>
          <p>Put HTTP basic-auth or JWT in front of a tunnel at the edge, before traffic ever reaches your machine.</p></div>
        <div class="card">${icon('<rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><line x1="3" y1="9" x2="21" y2="9"></line><line x1="9" y1="21" x2="9" y2="9"></line>')}<h3>Iframe-embeddable</h3>
          <p>Strips <code>frame-ancestors</code> / X-Frame-Options so a tunneled app
            renders inside another web UI — something no other OSS tunnel does.</p></div>
        <div class="card">${icon('<path d="m12 19-7-7 7-7"></path><path d="m19 19-7-7 7-7"></path>')}<h3>HTTP, streaming &amp; WebSocket</h3>
          <p>Full WebSocket relay and streaming responses, not just plain request/response.</p></div>
        <div class="card">${icon('<rect x="3" y="3" width="18" height="18" rx="2"></rect><path d="M9 12h6"></path><path d="M12 9v6"></path>')}<h3>QR code on connect</h3>
          <p>Scan the printed QR to open your tunnel on a phone instantly — real-device testing in one step.</p></div>
        <div class="card">${icon('<circle cx="12" cy="12" r="3"></circle><path d="M12 3v2"></path><path d="M12 19v2"></path><path d="M5 12H3"></path><path d="M21 12h-2"></path><path d="m6.3 6.3-1.4-1.4"></path><path d="m19.1 19.1-1.4-1.4"></path><path d="m6.3 17.7-1.4 1.4"></path><path d="m19.1 4.9-1.4 1.4"></path>')}<h3>Wildcard subdomains</h3>
          <p><code>*.${example}</code> all route to one tunnel — handy for
            multi-tenant or vhost apps.</p></div>
      </div>
    </div></section>

    <section id="start"><div class="wrap">
      <h2>Quickstart</h2>
      <p class="lede">Three steps once you're off the waitlist. Full reference in the <a href="/docs">docs</a>.</p>
      <div class="steps-grid">
        <div class="step-num">1</div>
        <div class="step-content">
          <h3>Install the client</h3>
          <p>Runs under Bun (imports TypeScript directly).</p>
          <code>bun add @volter/tunnel</code>
        </div>
        <div class="step-num">2</div>
        <div class="step-content">
          <h3>Log in with GitHub</h3>
          <p>Uses your <code>gh</code> auth; mints a token saved locally.</p>
          <code>volter-tunnel login --host https://${domain}</code>
        </div>
        <div class="step-num">3</div>
        <div class="step-content">
          <h3>Expose a port</h3>
          <p>Pick a tunnel id to reserve the subdomain.</p>
          <code>volter-tunnel --port 3000 --tunnel-id my-app</code>
        </div>
      </div>
    </div></section>

    <section id="waitlist" class="bg-gray"><div class="wrap">
      <h2>Request access</h2>
      <p class="lede">We're rolling out by invite while we scale. Drop your GitHub username and we'll add you to the
        allowlist — you'll log in with that same GitHub account.</p>
      <form class="wl" id="wl" autocomplete="off">
        <div class="form-group"><label for="gh">GitHub username <span style="color:#d73a49">*</span></label>
          <input id="gh" name="githubUser" placeholder="octocat" required maxlength="39"></div>
        <div class="form-group"><label for="em">Email <span style="color:var(--text-color-light)">(optional — to notify you)</span></label>
          <input id="em" name="email" type="email" placeholder="you@example.com" maxlength="200"></div>
        <div class="form-group"><label for="uc">What will you tunnel? <span style="color:var(--text-color-light)">(optional)</span></label>
          <textarea id="uc" name="useCase" placeholder="local dev server, webhook testing, demo for a client…" maxlength="500"></textarea></div>
        <div class="form-group"><button class="btn primary" type="submit" id="wlbtn">Join the waitlist</button></div>
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
  <main class="wrap doc" style="padding-top:42px">
    <h1>Documentation</h1>
    <p class="doc-sub">Get a local port onto a stable public URL in a couple of minutes.</p>

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

    <p style="margin:34px 0 0"><a href="/">← Back to home</a> &nbsp;·&nbsp; <a href="/#waitlist">Request access</a></p>
  </main>
  ${footer()}`;
  return shell('volter-tunnel — docs', body);
}

export function htmlResponse(html: string): Response {
  return new Response(html, {
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=300' },
  });
}
