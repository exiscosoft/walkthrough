/**
 * Controlled demo app for automated tests: a dealer accepts an invitation and sets a password.
 * Failure toggles are set with ?fixture=<mode> on /invite and remembered in a cookie:
 *   slow          responses and form rendering are delayed
 *   modal         an unexpected "Update available" modal opens on /setup
 *   renameButton  "Accept invitation" is relabelled "Join now"
 *   expire        /setup redirects to /login (session expired)
 * Also: /app needs a session cookie set by /login's "Sign in" button, /logout clears it,
 * /offsite redirects off the allowlist, and /secrets (+ /card in an iframe) exercises masking.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";

const page = (title: string, body: string, script = "") => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${title} · Northwind Dealer Portal</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; font: 16px/1.5 -apple-system, Helvetica, Arial, sans-serif; color: #1d2433; background: #f3f5f9; }
  header { background: #12305f; color: #fff; padding: 14px 32px; font-weight: 600; }
  main { max-width: 560px; margin: 40px auto; background: #fff; border-radius: 12px; padding: 32px 36px; box-shadow: 0 2px 12px rgba(0,0,0,.08); }
  h1 { font-size: 26px; margin: 0 0 8px; }
  label { display: block; font-weight: 600; margin: 16px 0 6px; }
  input, select { width: 100%; padding: 10px 12px; font-size: 16px; border: 1px solid #b8c0cf; border-radius: 8px; }
  button { margin-top: 24px; background: #1f4fd8; color: #fff; border: 0; border-radius: 8px; padding: 12px 22px; font-size: 16px; font-weight: 600; cursor: pointer; }
  .error { color: #b3261e; font-size: 14px; margin-top: 6px; }
  .account { margin-top: 18px; padding: 10px 12px; background: #f3f5f9; border-radius: 8px; }
  .modal-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,.45); display: grid; place-items: center; }
  .modal { background: #fff; padding: 28px; border-radius: 12px; width: 380px; }
</style></head>
<body><header>Northwind Dealer Portal</header><main>${body}</main>${script ? `<script>${script}</script>` : ""}</body></html>`;

function mode(req: IncomingMessage, url: URL): string {
  return url.searchParams.get("fixture") ?? /(?:^|; )fixture=([^;]+)/.exec(req.headers.cookie ?? "")?.[1] ?? "";
}

export function startFixture(port = 0): Promise<{ server: Server; url: string }> {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const m = mode(req, url);
    if (m === "slow") await new Promise((r) => setTimeout(r, 1200));
    const send = (status: number, html: string, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": "text/html; charset=utf-8", ...headers });
      res.end(html);
    };
    const cookie = url.searchParams.has("fixture") ? { "set-cookie": `fixture=${m}; Path=/` } : {};

    switch (url.pathname) {
      case "/invite":
        return send(
          200,
          page(
            "Invitation",
            `<h1>You're invited to Northwind</h1>
             <p>Jordan from Northwind Motors invited you to manage dealer orders.</p>
             <p class="account">Dealer account number: <span data-sensitive id="acct">DLR-48213-77</span></p>
             <p><a href="https://example.com/terms">Read the dealer terms</a></p>
             <button type="button" onclick="location.href='/setup'">${m === "renameButton" ? "Join now" : "Accept invitation"}</button>`,
          ),
          { ...cookie },
        );
      case "/setup":
        if (m === "expire") return send(302, "", { location: "/login" });
        return send(
          200,
          page(
            "Set up your account",
            `<h1>Set up your account</h1>
             <form id="setup" novalidate style="${m === "slow" ? "display:none" : ""}">
               <label for="name">Full name</label><input id="name" name="name" autocomplete="name">
               <label for="email">Work email</label><input id="email" name="email" type="email" value="avery@dealer.example" readonly>
               <label for="region">Dealer region</label>
               <select id="region" name="region"><option value="">Choose a region</option>
                 <option>Pacific Northwest</option><option>Mountain West</option><option>Great Lakes</option></select>
               <label for="password">Password</label><input id="password" name="password" type="password" autocomplete="new-password">
               <label for="confirm">Confirm password</label><input id="confirm" name="confirm" type="password" autocomplete="new-password">
               <div class="error" id="err" role="alert"></div>
               <button type="submit">Create account</button>
             </form>
             ${m === "modal" ? `<div class="modal-backdrop"><div class="modal" role="dialog" aria-label="Update available"><h2>Update available</h2><p>A new version is ready.</p><button type="button">Remind me later</button></div></div>` : ""}`,
            `${m === "slow" ? "setTimeout(() => { document.getElementById('setup').style.display = ''; }, 1200);" : ""}
             document.getElementById('setup').addEventListener('submit', (e) => {
               e.preventDefault();
               const f = e.target, err = document.getElementById('err');
               if (!f.name.value.trim()) { err.textContent = 'Enter your full name.'; return; }
               if (!f.region.value) { err.textContent = 'Choose a dealer region.'; return; }
               if (f.password.value.length < 12) { err.textContent = 'Use at least 12 characters.'; return; }
               if (f.password.value !== f.confirm.value) { err.textContent = 'Passwords do not match.'; return; }
               location.href = '/welcome';
             });`,
          ),
        );
      case "/secrets": {
        // Masking edge cases. All secret text is magenta so tests can look for leaked pixels.
        const port = (req.headers.host ?? "").split(":")[1] ?? "";
        return send(
          200,
          page(
            "Developer settings",
            `<h1>Developer settings</h1>
             <p class="secret">sk_live_4f9a8b7c6d5e4f3a sk_test_9z8y7x6w5v4u3t2s</p>
             <secret-card></secret-card>
             <iframe title="Card" src="http://localhost:${port}/card" style="border:0;width:100%;height:90px"></iframe>
             <div class="toast secret">sk_live_TOASTTOKEN123456</div>
             <style>
               .secret, input { color: #ff00ff; }
               .toast { position: fixed; right: 24px; bottom: 24px; background: #fff; padding: 12px 16px; border-radius: 8px;
                        box-shadow: 0 2px 10px rgba(0,0,0,.2); animation: slide 1.5s ease-in-out infinite alternate; }
               @keyframes slide { from { transform: translateX(-420px); } to { transform: translateX(0); } }
             </style>`,
            `customElements.define("secret-card", class extends HTMLElement {
               connectedCallback() {
                 this.attachShadow({ mode: "open" }).innerHTML =
                   '<style>input,span{color:#ff00ff}</style><label>Signing secret <input type="password" value="hunter2hunter2"></label>' +
                   '<p>Customer: <span data-sensitive>CUST-77120</span></p>';
               }
             });`,
          ),
        );
      }
      case "/card":
        return send(
          200,
          `<!doctype html><body style="margin:0;font:16px sans-serif">
           <label>Card number <input autocomplete="cc-number" value="4242 4242 4242 4242" style="color:#ff00ff;font-size:16px"></label></body>`,
        );
      case "/welcome":
        return send(
          200,
          page("Welcome", `<h1>Your account is ready</h1><p>You can now place and track dealer orders.</p><button type="button">Go to dashboard</button>`),
        );
      case "/login":
        return send(
          200,
          page(
            "Sign in",
            `<h1>Sign in to continue</h1><p>Your session has expired.</p>
             <button type="button" onclick="document.cookie='session=1; Path=/; Max-Age=86400'; location.href='/app'">Sign in</button>`,
          ),
        );
      case "/app":
        if (!/(?:^|; )session=1/.test(req.headers.cookie ?? "")) return send(302, "", { location: "/login" });
        return send(200, page("Dashboard", `<h1>Dashboard</h1><p>Welcome back.</p><a href="/logout">Sign out</a>`));
      case "/logout":
        return send(302, "", { location: "/login", "set-cookie": "session=; Path=/; Max-Age=0" });
      case "/offsite":
        return send(302, "", { location: "https://example.com/elsewhere" });
      default:
        return send(404, page("Not found", "<h1>Not found</h1>"));
    }
  });
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address();
      resolve({ server, url: `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : port}` });
    });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 4310);
  startFixture(port).then(({ url }) => console.log(`fixture app on ${url}/invite`));
}
