// The connect page, shown by acct-client and by acct-dev's "client connect screen".
const { invoke } = window.__TAURI__.core;
const $ = (id) => document.getElementById(id);
const form = $("connect-form");

invoke("start").then((s) => {
  $("version").textContent = s.version;
  if (s.address) form.elements.address.value = s.address;
  form.elements.address.focus();
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const button = form.querySelector("button");
  $("error").hidden = true;
  button.disabled = true;
  button.textContent = "Connecting…";
  try {
    await invoke("connect", { address: form.elements.address.value });
  } catch (err) {
    $("error").textContent = String(err);
    $("error").hidden = false;
  } finally {
    button.disabled = false;
    button.textContent = "Connect";
  }
});
