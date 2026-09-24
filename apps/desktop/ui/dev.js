// acct-dev's control page. See apps/desktop/dev/src/main.rs.
const { invoke } = window.__TAURI__.core;
const $ = (id) => document.getElementById(id);
const fail = (err) => alert(String(err));

invoke("status").then((s) => {
  $("version").textContent = s.version;
  $("failed").hidden = !s.error;
  $("failed-reason").textContent = s.error ?? "";
  $("url").textContent = s.url ?? "—";
  $("loaded").textContent = s.client_name ? `${s.client_name} (${s.journals} journals)` : "nothing";
  $("password").textContent = s.password;
  for (const u of s.users) {
    const b = document.createElement("button");
    b.textContent = `Open as ${u.username} (${u.role})`;
    b.addEventListener("click", () => invoke("open_as", { username: u.username }).catch(fail));
    $("users").append(b);
  }
});

$("signed-out").addEventListener("click", () => invoke("open_as", { username: null }).catch(fail));
$("connect").addEventListener("click", () => invoke("open_connect").catch(fail));

$("sim-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target.elements;
  const button = e.target.querySelector("button");
  const result = $("sim-result");
  const list = $("sim-checks");
  button.disabled = true;
  result.className = "";
  result.textContent = "Running…";
  list.replaceChildren();
  try {
    const report = await invoke("simulate", {
      clients: Number(f.clients.value),
      journalsEach: Number(f.journals.value),
    });
    result.className = report.passed ? "pass" : "fail";
    result.textContent = report.passed ? "Passed" : "Failed";
    for (const c of report.checks) {
      const li = document.createElement("li");
      li.className = c.passed ? "pass" : "fail";
      li.textContent = `${c.passed ? "✓" : "✗"} ${c.what}`;
      list.append(li);
    }
  } catch (err) {
    result.className = "fail";
    result.textContent = String(err);
  } finally {
    button.disabled = false;
  }
});
