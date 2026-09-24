// acct-master's control page. See apps/desktop/master/src/main.rs.
const { invoke } = window.__TAURI__.core;
const $ = (id) => document.getElementById(id);

async function refresh() {
  const s = await invoke("status");
  $("version").textContent = s.version;
  $("db").textContent = s.db_path;
  $("failed").hidden = !s.error;
  $("failed-reason").textContent = s.error ?? "";
  $("setup").hidden = !!s.error || s.initialised;
  $("running").hidden = !!s.error || !s.initialised;
  $("lan-address").textContent = s.lan_address ?? "";
  $("no-lan").hidden = !!s.lan_address;
}

$("setup-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target.elements;
  const error = $("setup-error");
  error.hidden = true;
  if (f.password.value !== f.again.value) {
    error.textContent = "The passwords don't match.";
    error.hidden = false;
    return;
  }
  const button = e.target.querySelector("button");
  button.disabled = true;
  try {
    await invoke("initialise", {
      practiceName: f.practice.value,
      username: f.username.value,
      displayName: f.display.value,
      password: f.password.value,
    });
    await refresh();
    await invoke("open_app");
  } catch (err) {
    error.textContent = String(err);
    error.hidden = false;
  } finally {
    button.disabled = false;
  }
});

$("open").addEventListener("click", () => invoke("open_app").catch((err) => alert(err)));

refresh();
