const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

const state = {
  pin: sessionStorage.getItem("pin") || "",
  operator: null,
  units: ["kg", "ea", "box", "crate", "pack", "l"],
  locations: [],
  products: [],
  product: null,
  qty: "0",
  unitPick: "kg",
};

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      "X-Operator-Pin": state.pin,
      ...(opts.headers || {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.detail || "Something went wrong. Try again.");
  return body;
}

function toast(msg, bad = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.toggle("bad", bad);
  t.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (t.hidden = true), 3200);
}

/* ---------- PIN gate ---------- */
let pinBuf = "";

function drawPin() {
  $$("#pinDots i").forEach((d, i) => d.classList.toggle("on", i < pinBuf.length));
}

$(".keypad-pin").addEventListener("click", async (e) => {
  const k = e.target.dataset.k;
  if (!k) return;
  if (k === "clear") pinBuf = "";
  else if (k === "back") pinBuf = pinBuf.slice(0, -1);
  else if (pinBuf.length < 4) pinBuf += k;
  drawPin();
  if (pinBuf.length === 4) await tryPin(pinBuf);
});

async function tryPin(pin) {
  try {
    const op = await api("/api/login", {
      method: "POST",
      body: JSON.stringify({ pin }),
    });
    state.pin = pin;
    state.operator = op;
    sessionStorage.setItem("pin", pin);
    $("#gateError").hidden = true;
    await start();
  } catch (err) {
    $("#gateError").textContent = err.message;
    $("#gateError").hidden = false;
    pinBuf = "";
    drawPin();
  }
}

$("#signOut").addEventListener("click", () => {
  sessionStorage.removeItem("pin");
  location.reload();
});

/* ---------- boot ---------- */
async function start() {
  $("#gate").hidden = true;
  $("#app").hidden = false;
  $("#opName").textContent = state.operator.name;
  const meta = await api("/api/meta");
  state.units = meta.units;
  await Promise.all([loadLocations(), loadProducts()]);
  drawUnits();
}

async function loadLocations() {
  state.locations = await api("/api/locations");
  const opts = state.locations
    .map((l) => `<option value="${l.id}">${esc(l.name)}</option>`)
    .join("");
  $("#pLocation").innerHTML = opts;
  $("#locationPick").innerHTML = opts;
}

async function loadProducts() {
  state.products = await api("/api/products");
  $("#noProducts").hidden = state.products.length > 0;
  drawResults($("#search").value);
  $("#productList").innerHTML = state.products.length
    ? state.products
        .map(
          (p) => `<li><div class="row-main"><strong>${esc(p.name)}</strong>
          <span class="meta">${esc(p.location || "No location")}${
            p.code ? " &middot; " + esc(p.code) : ""
          }</span></div><span class="qty">${esc(p.unit)}</span></li>`
        )
        .join("")
    : `<li><span class="meta">Nothing here yet.</span></li>`;
}

/* ---------- product picking ---------- */
function drawResults(q = "") {
  const term = q.trim().toLowerCase();
  const list = state.products
    .filter(
      (p) =>
        !term ||
        p.name.toLowerCase().includes(term) ||
        (p.code || "").toLowerCase().includes(term)
    )
    .slice(0, 30);
  $("#results").innerHTML = list
    .map(
      (p) => `<li><button class="row" data-id="${p.id}">
        <span class="row-main"><strong>${esc(p.name)}</strong>
        <span class="meta">${esc(p.location || "No location")}</span></span>
        <span class="qty">${esc(p.unit)}</span></button></li>`
    )
    .join("");
}

$("#search").addEventListener("input", (e) => drawResults(e.target.value));

$("#results").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-id]");
  if (!btn) return;
  pickProduct(Number(btn.dataset.id));
});

function pickProduct(id) {
  const p = state.products.find((x) => x.id === id);
  if (!p) return;
  state.product = p;
  state.qty = "0";
  $("#pickedName").textContent = p.name;
  $("#pickedMeta").textContent = `Measured in ${p.unit}${
    p.location ? " · " + p.location : ""
  }`;
  $("#qtyUnit").textContent = p.unit;
  if (p.location_id) $("#locationPick").value = p.location_id;
  $("#picked").hidden = false;
  $("#chooser").hidden = true;
  $("#capture").hidden = false;
  drawQty();
}

$("#changeProduct").addEventListener("click", clearPick);

function clearPick() {
  state.product = null;
  state.qty = "0";
  $("#picked").hidden = true;
  $("#chooser").hidden = false;
  $("#capture").hidden = true;
  $("#search").value = "";
  drawResults("");
}

/* ---------- quantity keypad ---------- */
$(".keypad-qty").addEventListener("click", (e) => {
  const k = e.target.dataset.k;
  if (!k) return;
  if (k === "back") state.qty = state.qty.length > 1 ? state.qty.slice(0, -1) : "0";
  else if (k === ".") {
    if (!state.qty.includes(".")) state.qty += ".";
  } else if (state.qty === "0") state.qty = k;
  else if (state.qty.replace(".", "").length < 7) state.qty += k;
  drawQty();
});

function drawQty() {
  $("#qty").textContent = state.qty;
  $("#accept").disabled = !(parseFloat(state.qty) > 0);
}

/* ---------- accept ---------- */
$("#accept").addEventListener("click", async () => {
  const btn = $("#accept");
  btn.disabled = true;
  try {
    const r = await api("/api/receipts", {
      method: "POST",
      body: JSON.stringify({
        product_id: state.product.id,
        quantity: parseFloat(state.qty),
        location_id: Number($("#locationPick").value) || null,
        supplier: $("#supplier").value,
        reference: $("#reference").value,
        note: $("#note").value,
        device: navigator.userAgent.slice(0, 80),
      }),
    });
    toast(`${r.quantity} ${r.unit} ${r.product} accepted. On hand: ${round(r.on_hand)} ${r.unit}`);
    $("#note").value = "";
    clearPick();
  } catch (err) {
    toast(err.message, true);
    btn.disabled = false;
  }
});

/* ---------- products tab ---------- */
function drawUnits() {
  $("#unitPick").innerHTML = state.units
    .map(
      (u) =>
        `<button type="button" data-u="${u}" class="${
          u === state.unitPick ? "on" : ""
        }">${u}</button>`
    )
    .join("");
}

$("#unitPick").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-u]");
  if (!b) return;
  state.unitPick = b.dataset.u;
  drawUnits();
});

$("#productForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    await api("/api/products", {
      method: "POST",
      body: JSON.stringify({
        name: $("#pName").value,
        unit: state.unitPick,
        location_id: Number($("#pLocation").value) || null,
        code: $("#pCode").value,
      }),
    });
    toast(`${$("#pName").value} created.`);
    $("#pName").value = "";
    $("#pCode").value = "";
    await loadProducts();
  } catch (err) {
    toast(err.message, true);
  }
});

/* ---------- stock + log ---------- */
async function loadStock() {
  const rows = await api("/api/stock");
  $("#stockList").innerHTML = rows.length
    ? rows
        .map(
          (r) => `<li><div class="row-main"><strong>${esc(r.name)}</strong>
        <span class="meta">${esc(r.location || "No location")}</span></div>
        <span class="qty">${round(r.on_hand)}<span>${esc(r.unit)}</span></span></li>`
        )
        .join("")
    : `<li><span class="meta">Nothing received yet.</span></li>`;
}

async function loadLog() {
  const rows = await api("/api/movements", { method: "GET" });
  $("#logList").innerHTML = rows.length
    ? rows
        .map((m) => {
          const rev = m.direction === "REVERSAL";
          return `<li><div class="row-main">
          <strong class="${m.reversed ? "struck" : ""}">${esc(m.product)}</strong>
          <span class="meta">${esc(m.created_at)} &middot; ${esc(m.operator)}${
            m.reference ? " &middot; " + esc(m.reference) : ""
          }${rev ? " &middot; reversal" : ""}</span></div>
          <span class="qty">${rev ? "&minus;" : "+"}${round(m.quantity)}<span>${esc(
            m.unit
          )}</span></span></li>`;
        })
        .join("")
    : `<li><span class="meta">No entries yet.</span></li>`;
}

/* ---------- tabs ---------- */
$$(".tabs button").forEach((b) =>
  b.addEventListener("click", async () => {
    $$(".tabs button").forEach((x) => x.classList.toggle("on", x === b));
    $$(".view").forEach((v) => (v.hidden = v.id !== "view-" + b.dataset.view));
    if (b.dataset.view === "stock") await loadStock();
    if (b.dataset.view === "log") await loadLog();
    if (b.dataset.view === "receive") await loadProducts();
  })
);

/* ---------- helpers ---------- */
function esc(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])
  );
}
function round(n) {
  return Number(n).toFixed(3).replace(/\.?0+$/, "") || "0";
}

/* ---------- resume session ---------- */
if (state.pin) tryPin(state.pin);
