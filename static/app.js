const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

const FLOAT_LOCATIONS = ["Big freezer", "Glass door storage"];
const LOCATION_KINDS = ["freezer", "chiller", "store", "floor"];

const state = {
  pin: sessionStorage.getItem("pin") || "",
  operator: null,
  units: ["kg", "ea", "box", "crate", "pack", "l"],
  locations: [],
  products: [],
  suppliers: [],
  floatProducts: [], // float_product rows: {id, name, location, target_quantity}
  onHand: {}, // product_id -> current on-hand, for stock take / dispatch comparisons
  unitPick: "kg",
  floatLocationPick: FLOAT_LOCATIONS[0],
  locKindPick: LOCATION_KINDS[0],
};

function errorMessage(body) {
  // A plain HTTPException (product not found, insufficient stock, etc.) sends
  // `detail` as a string. FastAPI's own automatic Pydantic validation errors
  // (a name that's too short, a negative quantity, a missing field) instead
  // send `detail` as an array of {msg, loc, ...} objects — passed straight to
  // `new Error()` that stringifies to the useless literal "[object Object]".
  if (typeof body.detail === "string") return body.detail;
  if (Array.isArray(body.detail) && body.detail.length) {
    return body.detail.map((d) => d.msg || String(d)).join(" ");
  }
  return "Something went wrong. Try again.";
}

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
  if (!res.ok) throw new Error(errorMessage(body));
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

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}
function round(n) {
  return Number(n).toFixed(3).replace(/\.?0+$/, "") || "0";
}
function money(n) {
  return Number(n).toFixed(2);
}
// Float items are always counted and targeted in whole crates, never
// individual packs — this labels a number consistently everywhere the
// Float tab shows one, with correct singular/plural.
function crates(n) {
  return `${round(n)} crate${Number(n) === 1 ? "" : "s"}`;
}
// Individual pieces derived from a crate count via a product's
// units-per-crate — a display-only conversion, never itself counted or
// targeted (see the crates() note above).
function items(n) {
  return `${round(n)} item${Number(n) === 1 ? "" : "s"}`;
}

/* ============================================================
   Camera capture — one reusable control, wired up independently
   wherever a photo is needed (currently just a receiving invoice).
   Each instance is a hidden file input + a visible "Take photo"
   button + a thumbnail preview with a "Retake" button, all
   addressed by the DOM ids passed in. The moment a file is picked
   it's drawn to an off-screen canvas, downscaled to at most 1280px
   on its longest side, exported as a quality-0.7 JPEG, and POSTed
   to /api/photos right away — so by the time the surrounding form
   is submitted the photo_id is already sitting in hand, not
   fetched at submit time.
   ============================================================ */
function compressToJpegDataUrl(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const maxSide = 1280;
      let { width, height } = img;
      const longest = Math.max(width, height);
      if (longest > maxSide) {
        const scale = maxSide / longest;
        width = Math.round(width * scale);
        height = Math.round(height * scale);
      }
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      canvas.getContext("2d").drawImage(img, 0, 0, width, height);
      resolve(canvas.toDataURL("image/jpeg", 0.7));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Couldn't read that photo."));
    };
    img.src = url;
  });
}

// ids: {take, file, retake, preview, img, status} — element ids (no "#") for
// one instance. onChange(photoId), if given, fires after every attempt
// (success or failure) so the caller can re-render its own gating/disabled
// state; it does NOT fire from reset() — callers that reset also already
// know the new (null) state, so no forced re-render is needed there.
function initCameraControl(ids, onChange) {
  const take = $("#" + ids.take);
  const file = $("#" + ids.file);
  const retake = $("#" + ids.retake);
  const preview = $("#" + ids.preview);
  const img = $("#" + ids.img);
  const status = $("#" + ids.status);

  const ctrl = { photoId: null };

  function setStatus(msg) {
    status.textContent = msg || "";
  }
  function showIdle() {
    take.hidden = false;
    preview.hidden = true;
  }
  function showPreview() {
    take.hidden = true;
    preview.hidden = false;
  }

  async function handleFile(f) {
    if (!f) return;
    take.disabled = true;
    setStatus("Preparing photo…");
    try {
      const dataUrl = await compressToJpegDataUrl(f);
      img.src = dataUrl;
      showPreview();
      retake.disabled = true;
      setStatus("Uploading…");
      const r = await api("/api/photos", { method: "POST", body: JSON.stringify({ data_url: dataUrl }) });
      ctrl.photoId = r.photo_id;
      setStatus("Photo attached");
    } catch (err) {
      ctrl.photoId = null;
      setStatus(preview.hidden ? "Couldn't read that photo — try again." : "Couldn't upload — tap Retake to try again.");
      toast(err.message, true);
    } finally {
      take.disabled = false;
      retake.disabled = false;
      if (onChange) onChange(ctrl.photoId);
    }
  }

  take.addEventListener("click", () => file.click());
  retake.addEventListener("click", () => file.click());
  file.addEventListener("change", (e) => {
    const f = e.target.files && e.target.files[0];
    file.value = ""; // so picking the very same file again still fires "change"
    handleFile(f);
  });

  ctrl.reset = () => {
    ctrl.photoId = null;
    img.src = "";
    setStatus("");
    showIdle();
  };
  ctrl.getPhotoId = () => ctrl.photoId;
  ctrl.hasPhoto = () => ctrl.photoId != null;

  return ctrl;
}

/* ============================================================
   PIN gate — works from a tap on the on-screen pad OR a typed
   digit on a physical keyboard. There is no separate "enter"
   control: the 4th digit submits automatically either way.
   ============================================================ */
let pinBuf = "";

function drawPin() {
  $$("#pinDots i").forEach((d, i) => d.classList.toggle("on", i < pinBuf.length));
}

function shakePin() {
  const dots = $("#pinDots");
  dots.classList.remove("shake");
  // restart the CSS animation even if it just ran
  void dots.offsetWidth;
  dots.classList.add("shake");
}

async function feedPinDigit(k) {
  if (k === "clear") pinBuf = "";
  else if (k === "back") pinBuf = pinBuf.slice(0, -1);
  else if (pinBuf.length < 4) pinBuf += k;
  drawPin();
  if (pinBuf.length === 4) await submitPin(pinBuf);
}

async function submitPin(pin) {
  try {
    const op = await api("/api/login", { method: "POST", body: JSON.stringify({ pin }) });
    state.pin = pin;
    state.operator = op;
    sessionStorage.setItem("pin", pin);
    $("#gateError").hidden = true;
    await enterApp();
  } catch (err) {
    $("#gateError").textContent = err.message;
    $("#gateError").hidden = false;
    shakePin();
    pinBuf = "";
    drawPin();
  }
}

$(".keypad-pin").addEventListener("click", (e) => {
  const k = e.target.closest("button")?.dataset.k;
  if (k) feedPinDigit(k);
});

document.addEventListener("keydown", (e) => {
  if ($("#gate").hidden) return; // only capture keys while the PIN gate is showing
  if (e.key >= "0" && e.key <= "9") {
    e.preventDefault();
    feedPinDigit(e.key);
  } else if (e.key === "Backspace") {
    e.preventDefault();
    feedPinDigit("back");
  } else if (e.key === "Escape") {
    e.preventDefault();
    feedPinDigit("clear");
  } else if (e.key === "Enter" && pinBuf.length === 4) {
    e.preventDefault();
    submitPin(pinBuf);
  }
});

$("#signOut").addEventListener("click", () => {
  sessionStorage.removeItem("pin");
  location.reload();
});

/* ============================================================
   Boot
   ============================================================ */
async function enterApp() {
  $("#gate").hidden = true;
  $("#app").hidden = false;
  $("#opName").textContent = state.operator.name;
  const meta = await api("/api/meta");
  state.units = meta.units;
  await Promise.all([loadLocations(), loadSuppliers(), loadProducts()]);
  drawUnits();
  drawRecUnitPick();
  drawFloatLocationPick();
  drawLocKindPick();
  // Receive is the tab that's already active on first load, so unlike the
  // other three tabs it never gets a render from the nav's tab-click handler
  // — without this, #recCancelBar stays stuck at its default-hidden markup
  // until the first pick or tab switch forces a re-render.
  renderReceive();
  handleIntegrationRedirect();
}

async function loadLocations() {
  state.locations = await api("/api/locations");
  const opts = state.locations
    .map((l) => `<option value="${l.id}">${esc(l.name)}</option>`)
    .join("");
  $("#pLocation").innerHTML = opts;
  $("#locationPick").innerHTML = opts;
  $("#recPLocation").innerHTML = opts;
}

/* ---------- suppliers ----------
   One list feeds every place a supplier is picked: the Receive tab's
   delivery-details dropdown, the inline "create product" panel, the
   Products tab's own new-product form, and the per-product edit row. Each
   consumer renders its own <option> markup because they differ slightly
   (the Receive dropdown alone gets a "No supplier" + "+ Add new" pair). */
function supplierOptionsPlain(selectedId) {
  return state.suppliers
    .map(
      (s) =>
        `<option value="${s.id}"${s.id === selectedId ? " selected" : ""}>${esc(s.name)}</option>`
    )
    .join("");
}

async function loadSuppliers() {
  state.suppliers = await api("/api/suppliers");
  const plain = `<option value="">No supplier</option>` + supplierOptionsPlain(null);
  $("#pSupplier").innerHTML = plain;
  $("#recPSupplier").innerHTML = plain;

  const pickCurrent = $("#supplierPick").value;
  $("#supplierPick").innerHTML =
    `<option value="">No supplier</option>` +
    supplierOptionsPlain(null) +
    `<option value="__new__">+ Add new supplier&hellip;</option>`;
  if (pickCurrent && pickCurrent !== "__new__") $("#supplierPick").value = pickCurrent;

  $("#supplierList").innerHTML = state.suppliers.length
    ? state.suppliers.map((s) => `<li><div class="row-main"><strong>${esc(s.name)}</strong></div></li>`).join("")
    : `<li><span class="meta">None yet.</span></li>`;
}

// Set while a product's name/cost/supplier are being edited in place on the
// Products tab — mirrors editingFloatTargetId/editingFloatUnitsId below, one
// row open for editing at a time.
let editingProductId = null;

function renderProductRow(p) {
  const priceLine = p.cost_price != null
    ? `<span class="meta">Cost R${money(p.cost_price)}</span>`
    : "";
  const supplierLine = p.supplier ? `<span class="meta">Supplier: ${esc(p.supplier)}</span>` : "";
  const editing = editingProductId === p.id;
  const editor = editing
    ? `<div class="inline-editor wide">
        <input id="editPName-${p.id}" value="${esc(p.name)}" placeholder="Name">
        <input id="editPCost-${p.id}" type="number" step="0.01" min="0" inputmode="decimal"
               value="${p.cost_price ?? ""}" placeholder="Cost price">
        <select id="editPSupplier-${p.id}">
          <option value="">No supplier</option>${supplierOptionsPlain(p.supplier_id)}
        </select>
        <button type="button" class="ghost small" data-save-product="${p.id}">Save</button>
        <button type="button" class="ghost small" data-cancel-product="${p.id}">Cancel</button>
      </div>`
    : "";
  return `<li><div class="row-main"><strong>${esc(p.name)}</strong>
    <span class="meta">${esc(p.location || "No location")}${
      p.code ? " &middot; " + esc(p.code) : ""
    }</span>${priceLine}${supplierLine}${editor}</div>
    <span class="qty">${esc(p.unit)}</span>
    ${
      editing
        ? ""
        : `<button type="button" class="ghost small" data-edit-product="${p.id}">Edit</button>
           <button type="button" class="ghost small" data-deactivate-product="${p.id}">Remove</button>`
    }
    </li>`;
}

function renderInactiveProductRow(p) {
  return `<li><div class="row-main"><strong>${esc(p.name)}</strong>
    <span class="meta">${esc(p.location || "No location")}</span></div>
    <span class="qty">${esc(p.unit)}</span>
    <button type="button" class="ghost small" data-reactivate-product="${p.id}">Reactivate</button>
    </li>`;
}

async function loadProducts() {
  // include_inactive so the Products tab can show a "Deactivated" section
  // with a way back — every other consumer of state.products (Receive's
  // search, Dispatch, Stock take) still only ever sees the active ones.
  const all = await api("/api/products?include_inactive=true");
  state.products = all.filter((p) => p.active);
  const inactive = all.filter((p) => !p.active);

  $("#noProducts").hidden = state.products.length > 0;
  drawResults($("#search").value);
  $("#productList").innerHTML = state.products.length
    ? state.products.map(renderProductRow).join("")
    : `<li><span class="meta">Nothing here yet.</span></li>`;
  $("#inactiveProductList").innerHTML = inactive.length
    ? inactive.map(renderInactiveProductRow).join("")
    : `<li><span class="meta">None.</span></li>`;
}

$("#productList").addEventListener("click", async (e) => {
  const editBtn = e.target.closest("button[data-edit-product]");
  const cancelBtn = e.target.closest("button[data-cancel-product]");
  const saveBtn = e.target.closest("button[data-save-product]");
  const deactivateBtn = e.target.closest("button[data-deactivate-product]");

  if (editBtn) {
    editingProductId = Number(editBtn.dataset.editProduct);
    loadProducts();
    return;
  }
  if (cancelBtn) {
    editingProductId = null;
    loadProducts();
    return;
  }
  if (saveBtn) {
    const id = Number(saveBtn.dataset.saveProduct);
    const name = $(`#editPName-${id}`).value.trim();
    if (name.length < 2) {
      toast("Name must be at least 2 characters.", true);
      return;
    }
    const costRaw = $(`#editPCost-${id}`).value;
    const supplierRaw = $(`#editPSupplier-${id}`).value;
    saveBtn.disabled = true;
    try {
      await api(`/api/products/${id}`, {
        method: "PATCH",
        body: JSON.stringify({
          name,
          cost_price: costRaw === "" ? null : parseFloat(costRaw),
          supplier_id: supplierRaw === "" ? null : Number(supplierRaw),
        }),
      });
      editingProductId = null;
      await loadProducts();
      toast(`${name} updated.`);
    } catch (err) {
      toast(err.message, true);
      saveBtn.disabled = false;
    }
    return;
  }
  if (deactivateBtn) {
    const id = Number(deactivateBtn.dataset.deactivateProduct);
    const p = state.products.find((x) => x.id === id);
    if (!confirm(`Remove ${p ? p.name : "this product"}? Its history is kept — you can bring it back from Deactivated products.`)) {
      return;
    }
    deactivateBtn.disabled = true;
    try {
      await api(`/api/products/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ active: false }),
      });
      await loadProducts();
      toast(`${p ? p.name : "Product"} removed.`);
    } catch (err) {
      toast(err.message, true);
      deactivateBtn.disabled = false;
    }
  }
});

$("#inactiveProductList").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-reactivate-product]");
  if (!btn) return;
  const id = Number(btn.dataset.reactivateProduct);
  btn.disabled = true;
  try {
    await api(`/api/products/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ active: true }),
    });
    await loadProducts();
    toast("Product reactivated.");
  } catch (err) {
    toast(err.message, true);
    btn.disabled = false;
  }
});

/* ---------- product picking ---------- */
// Rendering every matching row is fine at this catalog size — the cap here
// is just to keep a blank search from painting an enormous list on first
// open, not a real limit. When a search is actually narrowed down, this
// should essentially never bind. If it does, say so instead of silently
// dropping items past position 60 with no indication anything's missing.
const RESULTS_CAP = 60;
function moreResultsNote(matchedCount) {
  const hidden = matchedCount - RESULTS_CAP;
  return hidden > 0
    ? `<li><span class="meta">+ ${hidden} more — keep typing to narrow it down</span></li>`
    : "";
}

function drawResults(q = "") {
  const term = q.trim().toLowerCase();
  const matched = state.products.filter(
    (p) =>
      !term ||
      p.name.toLowerCase().includes(term) ||
      (p.code || "").toLowerCase().includes(term)
  );
  const list = matched.slice(0, RESULTS_CAP);
  $("#results").innerHTML =
    list
      .map(
        (p) => `<li><button class="row" data-id="${p.id}">
        <span class="row-main"><strong>${esc(p.name)}</strong>
        <span class="meta">${esc(p.location || "No location")}</span></span>
        <span class="qty">${esc(p.unit)}</span></button></li>`
      )
      .join("") + moreResultsNote(matched.length);
}

$("#search").addEventListener("input", (e) => drawResults(e.target.value));

$("#results").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-id]");
  if (btn) {
    closeRecNewProduct();
    pickReceiveProduct(Number(btn.dataset.id));
  }
});

/* ---------- create a new product without leaving Receive ----------
   For when a delivery shows up for something that isn't in the system yet —
   opens right where the search came up empty, creates the product, and
   drops straight into the same qty step a normal pick would, so receiving
   the actual delivery is never interrupted by a trip to the Products tab. */
state.recUnitPick = "kg";

function drawRecUnitPick() {
  $("#recUnitPick").innerHTML = state.units
    .map(
      (u) => `<button type="button" data-u="${u}" class="${u === state.recUnitPick ? "on" : ""}">${u}</button>`
    )
    .join("");
}

$("#recUnitPick").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-u]");
  if (!b) return;
  state.recUnitPick = b.dataset.u;
  drawRecUnitPick();
});

function openRecNewProduct() {
  $("#recPName").value = $("#search").value.trim();
  state.recUnitPick = "kg";
  drawRecUnitPick();
  $("#recPSupplier").value = "";
  $("#recNewProductForm").hidden = false;
  $("#recNewProductBtn").hidden = true;
  $("#recPName").focus();
}

function closeRecNewProduct() {
  $("#recNewProductForm").hidden = true;
  $("#recNewProductBtn").hidden = false;
}

$("#recNewProductBtn").addEventListener("click", openRecNewProduct);
$("#recNewProductCancel").addEventListener("click", closeRecNewProduct);

$("#recNewProductForm").addEventListener("keydown", (e) => {
  if (e.key === "Enter") e.preventDefault();
});

$("#recNewProductForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("#recPName").value;
  try {
    const created = await api("/api/products", {
      method: "POST",
      body: JSON.stringify({
        name,
        unit: state.recUnitPick,
        location_id: Number($("#recPLocation").value) || null,
        supplier_id: Number($("#recPSupplier").value) || null,
      }),
    });
    toast(`${name} created.`);
    closeRecNewProduct();
    await loadProducts();
    pickReceiveProduct(created.id);
  } catch (err) {
    toast(err.message, true);
  }
});

/* ---------- shared quantity-keypad helper ----------
   Used by every numeric keypad in the app (Receive, Dispatch, Stock take):
   accumulates typed digits into a plain decimal string. */
function applyQtyKey(cur, k) {
  if (k === "back") return cur.length > 1 ? cur.slice(0, -1) : "0";
  if (k === ".") return cur.includes(".") ? cur : cur + ".";
  if (cur === "0") return k;
  return cur.replace(".", "").length < 7 ? cur + k : cur;
}

/* ============================================================
   Receive — a batch of goods-received lines, walked through with
   a pick -> keypad -> add-to-list loop: pick a product, key in a
   quantity (+ optional per-item cost/location), add it to the
   delivery, and either stop there or add another. Once at least
   one item is added the summary/finish screen is already showing,
   so the common one-product delivery stays a two-tap flow (add,
   then accept) — never forced through a separate "add another" step.
   ============================================================ */
const rec = {
  mode: "pick", // pick | qty | summary
  items: [], // {product_id, name, quantity, unit, location_id, unit_cost}
  pending: null,
  pendingQty: "0",
};

const recPhoto = initCameraControl(
  {
    take: "recPhotoTake",
    file: "recPhotoFile",
    retake: "recPhotoRetake",
    preview: "recPhotoPreview",
    img: "recPhotoImg",
    status: "recPhotoStatus",
  },
  () => {} // optional here — nothing to gate, no re-render needed
);

function resetReceive() {
  rec.mode = "pick";
  rec.items = [];
  rec.pending = null;
  rec.pendingQty = "0";
  $("#search").value = "";
  drawResults("");
  closeRecNewProduct();
  $("#supplierPick").value = "";
  $("#newSupplierRow").hidden = true;
  $("#newSupplierName").value = "";
  $("#reference").value = "";
  $("#note").value = "";
  $("#unitCost").value = "";
  recPhoto.reset();
  renderReceive();
}

/* ---------- supplier picker (Receive tab) ---------- */
$("#supplierPick").addEventListener("change", () => {
  const isNew = $("#supplierPick").value === "__new__";
  $("#newSupplierRow").hidden = !isNew;
  if (isNew) $("#newSupplierName").focus();
});

$("#newSupplierCancel").addEventListener("click", () => {
  $("#newSupplierRow").hidden = true;
  $("#newSupplierName").value = "";
  $("#supplierPick").value = "";
});

$("#newSupplierSave").addEventListener("click", async () => {
  const name = $("#newSupplierName").value;
  if (!name.trim()) {
    toast("Enter a supplier name.", true);
    return;
  }
  $("#newSupplierSave").disabled = true;
  try {
    const created = await api("/api/suppliers", { method: "POST", body: JSON.stringify({ name }) });
    await loadSuppliers();
    $("#supplierPick").value = String(created.id);
    $("#newSupplierRow").hidden = true;
    $("#newSupplierName").value = "";
    toast(`${created.name} added.`);
  } catch (err) {
    toast(err.message, true);
  } finally {
    $("#newSupplierSave").disabled = false;
  }
});

function renderReceive() {
  const inWizard = rec.mode !== "summary";
  $("#recWizard").hidden = !inWizard;
  $("#recSummary").hidden = inWizard;
  // Always available while in the wizard, even before anything's been added
  // yet — Cancel just lands on the (possibly empty) summary, which is a
  // perfectly safe place to be. Without this, picking the wrong product on
  // the very first item left no way back except abandoning the tab.
  $("#recCancelBar").hidden = !inWizard;
  $("#recPickZone").hidden = rec.mode !== "pick";
  $("#recQtyZone").hidden = rec.mode !== "qty";

  if (rec.mode === "pick") {
    $("#recPickLabel").textContent = rec.items.length === 0 ? "What are you receiving?" : "Add another product";
  }

  if (rec.mode === "qty") {
    $("#recQtyLabel").textContent = `How much ${rec.pending.name} came in?`;
    $("#qty").textContent = rec.pendingQty;
    $("#qtyUnit").textContent = rec.pending.unit;
    $("#unitCostLabel").textContent = rec.pending.unit;
    $("#recQtyConfirm").disabled = !(parseFloat(rec.pendingQty) > 0);
  }

  $("#recSummaryMeta").textContent = `${rec.items.length} item${rec.items.length === 1 ? "" : "s"}`;
  $("#recNoItems").hidden = rec.items.length > 0;
  $("#recItemList").innerHTML = rec.items
    .map(
      (it, idx) => `<li><div class="row-main"><strong>${esc(it.name)}</strong>
      ${it.unit_cost != null ? `<span class="meta">R${money(it.unit_cost)}/${esc(it.unit)}</span>` : ""}</div>
      <span class="qty">${it.quantity}<span>${esc(it.unit)}</span></span>
      <button type="button" class="ghost small" data-remove="${idx}">Remove</button></li>`
    )
    .join("");

  $("#accept").disabled = rec.items.length === 0;
}

function pickReceiveProduct(id) {
  const p = state.products.find((x) => x.id === id);
  if (!p) return;
  rec.pending = p;
  rec.pendingQty = "0";
  $("#unitCost").value = "";
  rec.mode = "qty";
  renderReceive();
  if (p.location_id) $("#locationPick").value = p.location_id;
}

$(".keypad-qty").addEventListener("click", (e) => {
  const k = e.target.closest("button")?.dataset.k;
  if (!k) return;
  rec.pendingQty = applyQtyKey(rec.pendingQty, k);
  renderReceive();
});

$("#recQtyConfirm").addEventListener("click", () => {
  const unitCostRaw = $("#unitCost").value;
  rec.items.push({
    product_id: rec.pending.id,
    name: rec.pending.name,
    quantity: parseFloat(rec.pendingQty),
    unit: rec.pending.unit,
    location_id: Number($("#locationPick").value) || null,
    unit_cost: unitCostRaw !== "" ? parseFloat(unitCostRaw) : null,
  });
  rec.pending = null;
  rec.pendingQty = "0";
  $("#unitCost").value = "";
  rec.mode = "summary";
  renderReceive();
});

$("#recCancel").addEventListener("click", () => {
  rec.pending = null;
  rec.pendingQty = "0";
  rec.mode = "summary";
  closeRecNewProduct();
  renderReceive();
});

$("#recStartOver").addEventListener("click", resetReceive);

$("#recAddAnother").addEventListener("click", () => {
  rec.mode = "pick";
  $("#search").value = "";
  drawResults("");
  closeRecNewProduct();
  renderReceive();
});

$("#recItemList").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-remove]");
  if (!btn) return;
  rec.items.splice(Number(btn.dataset.remove), 1);
  renderReceive();
});

// Keeps the success toast readable even for a big delivery — lists items up
// to a cap, then folds the rest into "and N more" instead of dumping every
// line and every field.
function summarizeReceipt(items) {
  if (items.length === 0) return "Delivery accepted.";
  if (items.length === 1) {
    const it = items[0];
    return `${round(it.quantity)} ${it.unit} ${it.product} accepted. On hand: ${round(it.on_hand)} ${it.unit}.`;
  }
  const cap = 4;
  const names = items
    .slice(0, cap)
    .map((it) => `${round(it.quantity)} ${it.unit} ${it.product}`)
    .join(", ");
  const moreCount = items.length > cap ? ` and ${items.length - cap} more` : "";
  return `Delivery accepted: ${items.length} items — ${names}${moreCount}.`;
}

/* ---------- accept ---------- */
$("#accept").addEventListener("click", async () => {
  const btn = $("#accept");
  btn.disabled = true;
  try {
    const body = {
      items: rec.items.map((it) => ({
        product_id: it.product_id,
        quantity: it.quantity,
        location_id: it.location_id,
        unit_cost: it.unit_cost,
      })),
      supplier_id: Number($("#supplierPick").value) || null,
      reference: $("#reference").value || null,
      note: $("#note").value || null,
      photo_id: recPhoto.getPhotoId(),
      device: navigator.userAgent.slice(0, 80),
    };
    const r = await api("/api/receipts", { method: "POST", body: JSON.stringify(body) });
    toast(summarizeReceipt(r.items || []));
    resetReceive();
  } catch (err) {
    toast(err.message, true);
    btn.disabled = false;
  }
});

/* ============================================================
   Dispatch — send stock out for processing elsewhere. Nothing past
   this point is tracked (no breakdown, no waste) — a dispatch just
   deducts the float and prints a pick list for staff to fulfil.
   Building the list to send mirrors Receive exactly: pick a product,
   key in a quantity, add it to the list, repeat, then send. After
   sending (or after tapping a past dispatch from history) the same
   detail view shows what was requested vs what was actually taken,
   with an inline editor per line to correct the latter.
   ============================================================ */
const disp = {
  mode: "pick", // pick | qty | summary | detail
  items: [], // {product_id, name, quantity, unit}
  pending: null,
  pendingQty: "0",
  detail: null, // the dispatch detail object currently shown in #dispDetail —
  // either the response just sent, re-fetched for a consistent shape, or a
  // past dispatch opened from history. Always the shape of GET
  // /api/dispatches/{id}: {id, note, created_at, operator, items:[...]}.
};

function resetDispatch() {
  disp.mode = "pick";
  disp.items = [];
  disp.pending = null;
  disp.pendingQty = "0";
  $("#dispSearch").value = "";
  drawDispResults("");
  $("#dispNote").value = "";
  renderDispatch();
}

function renderDispatch() {
  // Keep the picker in sync with state.products on every re-render, not
  // just on a full reset — same reasoning as Receive/Stock take.
  drawDispResults($("#dispSearch").value);

  const inWizard = disp.mode === "pick" || disp.mode === "qty";
  $("#dispWizard").hidden = !inWizard;
  $("#dispSummary").hidden = disp.mode !== "summary";
  $("#dispDetail").hidden = disp.mode !== "detail";
  // Always available in the wizard, even before anything's been added yet —
  // see the identical note on recCancelBar above for why.
  $("#dispCancelBar").hidden = !inWizard;
  $("#dispPickZone").hidden = disp.mode !== "pick";
  $("#dispQtyZone").hidden = disp.mode !== "qty";

  if (disp.mode === "pick") {
    $("#dispPickLabel").textContent = disp.items.length === 0 ? "What do you want sent out?" : "Add another product";
  }

  if (disp.mode === "qty") {
    $("#dispQtyLabel").textContent = `How much ${disp.pending.name} should go out?`;
    $("#dispQty").textContent = disp.pendingQty;
    $("#dispQtyUnit").textContent = disp.pending.unit;
    const onHand = state.onHand[disp.pending.id] ?? 0;
    $("#dispOnHandLine").textContent = `${round(onHand)} ${disp.pending.unit} on hand`;
    $("#dispQtyConfirm").disabled = !(parseFloat(disp.pendingQty) > 0);
  }

  if (disp.mode === "summary") {
    $("#dispSummaryMeta").textContent = `${disp.items.length} item${disp.items.length === 1 ? "" : "s"}`;
    $("#dispNoItems").hidden = disp.items.length > 0;
    $("#dispItemList").innerHTML = disp.items
      .map(
        (it, idx) => `<li><div class="row-main"><strong>${esc(it.name)}</strong></div>
        <span class="qty">${it.quantity}<span>${esc(it.unit)}</span></span>
        <button type="button" class="ghost small" data-remove="${idx}">Remove</button></li>`
      )
      .join("");
    $("#dispSend").disabled = disp.items.length === 0;
  }

  if (disp.mode === "detail" && disp.detail) {
    $("#dispDetailId").textContent = disp.detail.id;
    $("#dispDetailMeta").textContent = `${disp.detail.created_at} · ${disp.detail.operator}`;
    renderDispatchDetailList();
  }
}

function pickDispatchProduct(id) {
  const p = state.products.find((x) => x.id === id);
  if (!p) return;
  disp.pending = p;
  disp.pendingQty = "0";
  disp.mode = "qty";
  renderDispatch();
}

function drawDispResults(q = "") {
  const term = q.trim().toLowerCase();
  const matched = state.products.filter(
    (p) =>
      !term ||
      p.name.toLowerCase().includes(term) ||
      (p.code || "").toLowerCase().includes(term)
  );
  const list = matched.slice(0, RESULTS_CAP);
  $("#dispResults").innerHTML =
    list
      .map(
        (p) => `<li><button class="row" data-id="${p.id}">
        <span class="row-main"><strong>${esc(p.name)}</strong>
        <span class="meta">${esc(p.location || "No location")}</span></span>
        <span class="qty">${esc(p.unit)}</span></button></li>`
      )
      .join("") + moreResultsNote(matched.length);
}

$("#dispSearch").addEventListener("input", (e) => drawDispResults(e.target.value));

$("#dispResults").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-id]");
  if (btn) pickDispatchProduct(Number(btn.dataset.id));
});

$(".keypad-dispqty").addEventListener("click", (e) => {
  const k = e.target.closest("button")?.dataset.k;
  if (!k) return;
  disp.pendingQty = applyQtyKey(disp.pendingQty, k);
  renderDispatch();
});

$("#dispQtyConfirm").addEventListener("click", () => {
  disp.items.push({
    product_id: disp.pending.id,
    name: disp.pending.name,
    quantity: parseFloat(disp.pendingQty),
    unit: disp.pending.unit,
  });
  disp.pending = null;
  disp.pendingQty = "0";
  disp.mode = "summary";
  renderDispatch();
});

$("#dispCancel").addEventListener("click", () => {
  disp.pending = null;
  disp.pendingQty = "0";
  disp.mode = "summary";
  renderDispatch();
});

$("#dispStartOver").addEventListener("click", resetDispatch);

$("#dispAddAnother").addEventListener("click", () => {
  disp.mode = "pick";
  $("#dispSearch").value = "";
  drawDispResults("");
  renderDispatch();
});

$("#dispItemList").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-remove]");
  if (!btn) return;
  disp.items.splice(Number(btn.dataset.remove), 1);
  renderDispatch();
});

$("#dispSend").addEventListener("click", async () => {
  const btn = $("#dispSend");
  btn.disabled = true;
  try {
    const body = {
      items: disp.items.map((it) => ({ product_id: it.product_id, quantity: it.quantity })),
      note: $("#dispNote").value || null,
    };
    const r = await api("/api/dispatches", { method: "POST", body: JSON.stringify(body) });
    toast(`Dispatch #${r.dispatch_id} sent — ${r.items.length} item${r.items.length === 1 ? "" : "s"}.`);
    resetDispatch();
    // Re-fetch rather than render the POST response directly — its item
    // shape (item_id, no updated_at) differs slightly from GET's (id,
    // updated_at), and this way #dispDetail always renders one consistent
    // shape regardless of whether it just got sent or was opened from history.
    const detail = await api(`/api/dispatches/${r.dispatch_id}`);
    showDispatchDetail(detail);
    await loadDispatchHistory();
  } catch (err) {
    toast(err.message, true);
    btn.disabled = false;
  }
});

/* ---------- dispatch history + detail ---------- */
// Same reasoning as the movement log: the API has to be asked for more than
// its default 50, and asking for one extra row is how "is there more?" is
// known for certain rather than guessed at.
let dispHistoryLimit = 200;
let dispHistoryHasMore = false;

async function loadDispatchHistory() {
  const rows = await api(`/api/dispatches?limit=${dispHistoryLimit + 1}`);
  dispHistoryHasMore = rows.length > dispHistoryLimit;
  const shown = dispHistoryHasMore ? rows.slice(0, dispHistoryLimit) : rows;
  if (!shown.length) {
    $("#dispHistoryList").innerHTML = `<li><span class="meta">No dispatches yet.</span></li>`;
    return;
  }
  const rowsHtml = shown
    .map(
      (d) => `<li><button class="row" data-id="${d.id}">
          <span class="row-main"><strong>Dispatch #${d.id}</strong>
          <span class="meta">${esc(d.created_at)} &middot; ${esc(d.operator)} &middot; ${d.item_count} item${
        d.item_count === 1 ? "" : "s"
      }${
        d.adjusted_count > 0
          ? ` &middot; ${d.adjusted_count} item${d.adjusted_count === 1 ? "" : "s"} adjusted`
          : ""
      }</span></span></button></li>`
    )
    .join("");
  const loadMore = dispHistoryHasMore
    ? `<li><button type="button" class="ghost bd-add" id="dispHistoryLoadMore">Load more</button></li>`
    : "";
  $("#dispHistoryList").innerHTML = rowsHtml + loadMore;
}

$("#dispHistoryList").addEventListener("click", async (e) => {
  const loadMoreBtn = e.target.closest("#dispHistoryLoadMore");
  if (loadMoreBtn) {
    loadMoreBtn.disabled = true;
    dispHistoryLimit += 200;
    await loadDispatchHistory();
    return;
  }
  const btn = e.target.closest("button[data-id]");
  if (!btn) return;
  try {
    const detail = await api(`/api/dispatches/${btn.dataset.id}`);
    showDispatchDetail(detail);
  } catch (err) {
    toast(err.message, true);
  }
});

// Which dispatch line's actual-quantity editor is currently open — at most
// one at a time, cleared whenever #dispDetail is (re)shown from scratch.
// Mirrors the markup-editor's editingMarkupId that used to live on the
// Products tab, before per-product markup editing was removed.
let editingDispatchItemId = null;

function showDispatchDetail(detail) {
  disp.detail = detail;
  disp.mode = "detail";
  editingDispatchItemId = null;
  renderDispatch();
}

function renderDispatchDetailList() {
  const items = disp.detail ? disp.detail.items : [];
  $("#dispDetailList").innerHTML = items.length
    ? items.map(renderDispatchItemRow).join("")
    : `<li><span class="meta">Nothing on this dispatch.</span></li>`;
}

function renderDispatchItemRow(it) {
  const editing = editingDispatchItemId === it.id;
  const differs = it.actual_quantity !== it.requested_quantity;
  const editor = editing
    ? `<div class="inline-editor">
        <input type="number" id="actualInput-${it.id}" value="${it.actual_quantity}" min="0" step="0.001" inputmode="decimal">
        <button type="button" class="ghost small" data-save-actual="${it.id}">Save</button>
        <button type="button" class="ghost small" data-cancel-actual="${it.id}">Cancel</button>
      </div>`
    : "";
  return `<li><div class="row-main"><strong>${esc(it.product)}</strong>
    <span class="meta">${esc(it.location || "No location")} &middot; requested ${round(it.requested_quantity)} ${esc(it.unit)}</span>
    ${editor}</div>
    <span class="qty${differs ? " adjusted" : ""}">${round(it.actual_quantity)}<span>${esc(it.unit)}</span></span>
    ${editing ? "" : `<button type="button" class="ghost small" data-edit-actual="${it.id}">Edit</button>`}
    </li>`;
}

$("#dispDetailList").addEventListener("click", async (e) => {
  const editBtn = e.target.closest("button[data-edit-actual]");
  const cancelBtn = e.target.closest("button[data-cancel-actual]");
  const saveBtn = e.target.closest("button[data-save-actual]");

  if (editBtn) {
    editingDispatchItemId = Number(editBtn.dataset.editActual);
    renderDispatchDetailList();
    $("#actualInput-" + editingDispatchItemId)?.focus();
    return;
  }
  if (cancelBtn) {
    editingDispatchItemId = null;
    renderDispatchDetailList();
    return;
  }
  if (saveBtn) {
    const itemId = Number(saveBtn.dataset.saveActual);
    const input = $("#actualInput-" + itemId);
    const value = parseFloat(input.value);
    if (!Number.isFinite(value) || value < 0) {
      toast("Enter an amount of 0 or more.", true);
      return;
    }
    saveBtn.disabled = true;
    try {
      await api(`/api/dispatches/${disp.detail.id}/items/${itemId}/actual`, {
        method: "POST",
        body: JSON.stringify({ actual_quantity: value }),
      });
      // Trust the server, same as every other write in this file — re-fetch
      // the whole dispatch rather than patching this one line locally.
      const fresh = await api(`/api/dispatches/${disp.detail.id}`);
      showDispatchDetail(fresh);
      toast("Amount updated.");
      await loadDispatchHistory(); // the adjusted-count badge may have just changed
    } catch (err) {
      toast(err.message, true);
      saveBtn.disabled = false;
    }
  }
});

$("#dispDetailBack").addEventListener("click", () => {
  disp.detail = null;
  editingDispatchItemId = null;
  // Back to wherever they were building a batch, if anything was in
  // progress — opening a past dispatch from history doesn't wipe it.
  disp.mode = disp.items.length > 0 ? "summary" : "pick";
  renderDispatch();
});

/* ============================================================
   Printing — four entry points (a dispatch pick list, a blank
   stock-take count sheet, a blank float count sheet, and a float
   pack list) share one render helper and each just populates
   #printSheet then calls window.print(). #printSheet is only ever
   visible via @media print (see styles.css), and is simply
   overwritten fresh each time any of these buttons is pressed —
   nothing needs cleaning up afterward.
   ============================================================ */
// extraColumnLabel/r.extraValueOrBlank add a 4th column when given — used by
// Float's two sheets to give staff somewhere to actually write down how many
// went in each crate, since that number varies and was never a fixed print
// value to begin with. Dispatch and Stocktake don't pass it, so their sheets
// keep the original 3 columns untouched.
function renderPrintSheet(title, sections, extraColumnLabel) {
  const today = new Date().toLocaleDateString();
  const operatorName = state.operator ? state.operator.name : "";
  const extraHeader = extraColumnLabel ? `<th>${esc(extraColumnLabel)}</th>` : "";
  const sectionsHtml = sections
    .map(
      (sec) => `<div class="print-section"><h2>${esc(sec.location)}</h2>
        <table class="print-table">
          <thead><tr><th>Item</th><th>Unit</th><th>Qty</th>${extraHeader}</tr></thead>
          <tbody>${sec.rows
            .map(
              (r) =>
                `<tr><td>${esc(r.name)}</td><td>${esc(r.unit)}</td><td>${r.valueOrBlank}</td>${
                  extraColumnLabel ? `<td>${r.extraValueOrBlank ?? ""}</td>` : ""
                }</tr>`
            )
            .join("")}</tbody>
        </table>
      </div>`
    )
    .join("");
  return `<div class="print-header"><h1>${esc(title)}</h1><p>${esc(today)} &middot; ${esc(operatorName)}</p></div>${sectionsHtml}`;
}

$("#dispPrintBtn").addEventListener("click", () => {
  if (!disp.detail) return;
  // The detail response is already ordered by location, so a simple
  // "did the location change since the last item" check while iterating
  // is enough to start a new section — no need to re-sort.
  const sections = [];
  let current = null;
  disp.detail.items.forEach((it) => {
    const loc = it.location || "No location";
    if (!current || current.location !== loc) {
      current = { location: loc, rows: [] };
      sections.push(current);
    }
    current.rows.push({ name: it.product, unit: it.unit, valueOrBlank: round(it.requested_quantity) });
  });
  $("#printSheet").innerHTML = renderPrintSheet(`Dispatch #${disp.detail.id} pick list`, sections);
  window.print();
});

$("#stPrintBtn").addEventListener("click", async () => {
  try {
    // All active products, freshly fetched — this endpoint isn't pre-sorted
    // by location the way the dispatch detail one is, so sort client-side.
    const products = await api("/api/products");
    const sorted = [...products].sort((a, b) => {
      const la = a.location || "";
      const lb = b.location || "";
      return la === lb ? a.name.localeCompare(b.name) : la.localeCompare(lb);
    });
    const sections = [];
    let current = null;
    sorted.forEach((p) => {
      const loc = p.location || "No location";
      if (!current || current.location !== loc) {
        current = { location: loc, rows: [] };
        sections.push(current);
      }
      current.rows.push({ name: p.name, unit: p.unit, valueOrBlank: `<span class="print-blank">&nbsp;</span>` });
    });
    $("#printSheet").innerHTML = renderPrintSheet("Stock count sheet", sections);
    window.print();
  } catch (err) {
    toast(err.message, true);
  }
});

$("#floatPrintSheetBtn").addEventListener("click", () => {
  // state.floatProducts is already fresh — loaded on every Float tab entry
  // and re-fetched after every add/edit in "Manage float items" below — so
  // no need for a fetch of its own here, same reasoning as dispPrintBtn.
  const sections = groupByFloatLocation(state.floatProducts, (p) => p.location).map((section) => ({
    location: section.location,
    rows: section.items.map((p) => ({
      name: p.name,
      unit: "crates",
      valueOrBlank: `<span class="print-blank">&nbsp;</span>`,
      // A blank line to write in, not a fixed printed number — how many
      // actually go in a crate varies pack to pack. Where a usual figure is
      // on file it's shown as a light reference, never as the value itself.
      extraValueOrBlank:
        `<span class="print-blank">&nbsp;</span>` +
        (p.units_per_crate != null
          ? `<br><span class="print-hint">usually ${p.units_per_crate}</span>`
          : ""),
    })),
  }));
  $("#printSheet").innerHTML = renderPrintSheet("Float count sheet", sections, "Items/crate");
  window.print();
});

$("#floatPrintPackBtn").addEventListener("click", () => {
  if (!float.review) return;
  // The point of this printout is "what to go pack more of", so it shows
  // shortfall, not the raw count. An item with no target has no shortfall
  // to show — rather than leave that line blank or drop it, show the
  // counted quantity with a clear "(no target)" label so it's still there,
  // just obviously informational rather than a number to act on.
  const sections = groupByFloatLocation(float.review.items, (it) => it.location).map((section) => ({
    location: section.location,
    rows: section.items.map((it) => ({
      name: it.product,
      unit: "crates",
      valueOrBlank:
        it.shortfall != null
          ? String(round(it.shortfall)) +
            (it.shortfall_items != null ? ` (est. ${round(it.shortfall_items)} items)` : "")
          : `${round(it.counted_quantity)} (no target)` +
            (it.counted_items != null ? ` &middot; est. ${round(it.counted_items)} items` : ""),
      // A blank line for whoever packs it to record what actually went into
      // each crate — the estimate above is only ever a reference, since the
      // real figure changes pack to pack and was never meant to be fixed.
      extraValueOrBlank: `<span class="print-blank">&nbsp;</span>`,
    })),
  }));
  $("#printSheet").innerHTML = renderPrintSheet("Float pack list", sections, "Items/crate packed");
  window.print();
});

/* ============================================================
   Stock take — reconcile what the system thinks is on hand with
   what's actually on the shelf. Same pick-then-keypad pattern as
   everywhere else: count one product, add it to the list, repeat,
   then finish. Any product's very first count is just its opening
   balance, so this doubles as the initial stock take. WiFi at the
   butchery is unreliable, so staff typically print a blank count
   sheet first, count on paper, then someone types the numbers in
   here afterward — the sheet is just a print of every product
   grouped by location with a blank to write the count on.
   ============================================================ */
const st = {
  mode: "pick", // pick | qty | list
  pending: null,
  qty: "0",
  counts: [], // {product_id, name, unit, counted, was, adjustment}
};

async function loadOnHand() {
  const rows = await api("/api/stock");
  state.onHand = Object.fromEntries(rows.map((r) => [r.product_id, r.on_hand]));
}

function resetStocktake() {
  st.mode = "pick";
  st.pending = null;
  st.qty = "0";
  st.counts = [];
  $("#stSearch").value = "";
  drawStResults("");
  renderStocktake();
}

function renderStocktake() {
  // Same reasoning as renderReceive(): keep the product picker in sync
  // with state.products on every re-render, not just on a full reset.
  drawStResults($("#stSearch").value);

  const inWizard = st.mode !== "list";
  $("#stWizard").hidden = !inWizard;
  $("#stList").hidden = inWizard;
  // Always available in the wizard, even before anything's been counted yet
  // — see the identical note on recCancelBar above for why.
  $("#stCancelBar").hidden = !inWizard;
  $("#stPickZone").hidden = st.mode !== "pick";
  $("#stQtyZone").hidden = st.mode !== "qty";

  if (st.mode === "qty") {
    $("#stQtyLabel").textContent = `How much ${st.pending.name} is actually on the shelf?`;
    $("#stQty").textContent = st.qty;
    $("#stQtyUnit").textContent = st.pending.unit;
    const was = st.pending.on_hand;
    const diff = Math.round((parseFloat(st.qty || "0") - was) * 1000) / 1000;
    $("#stWasLine").textContent =
      diff === 0
        ? `System already shows ${round(was)} ${st.pending.unit} — no change.`
        : `System shows ${round(was)} ${st.pending.unit} — this will ${
            diff > 0 ? "add" : "remove"
          } ${diff > 0 ? "+" : ""}${diff} ${st.pending.unit}.`;
  }

  $("#stNoCounts").hidden = st.counts.length > 0;
  $("#stCountedList").innerHTML = st.counts
    .map((c, i) => {
      const tag = c.adjustment === 0 ? "no change" : `${c.adjustment > 0 ? "+" : ""}${c.adjustment} ${c.unit}`;
      return `<li><div class="row-main"><strong>${esc(c.name)}</strong>
        <span class="meta">Counted ${c.counted} ${esc(c.unit)} &middot; ${tag}</span></div>
        <button type="button" class="ghost small" data-remove="${i}">Remove</button></li>`;
    })
    .join("");
  $("#stFinish").disabled = st.counts.length === 0;
}

function drawStResults(q = "") {
  const term = q.trim().toLowerCase();
  const matched = state.products.filter(
    (p) =>
      !term ||
      p.name.toLowerCase().includes(term) ||
      (p.code || "").toLowerCase().includes(term)
  );
  const list = matched.slice(0, RESULTS_CAP);
  $("#stResults").innerHTML =
    list
      .map((p) => {
        const onHand = state.onHand[p.id] ?? 0;
        return `<li><button class="row" data-id="${p.id}">
        <span class="row-main"><strong>${esc(p.name)}</strong>
        <span class="meta">${esc(p.location || "No location")} &middot; system shows ${round(
          onHand
        )} ${esc(p.unit)}</span></span>
        <span class="qty">${esc(p.unit)}</span></button></li>`;
      })
      .join("") + moreResultsNote(matched.length);
}

$("#stSearch").addEventListener("input", (e) => drawStResults(e.target.value));

$("#stResults").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-id]");
  if (!btn) return;
  const p = state.products.find((x) => x.id === Number(btn.dataset.id));
  if (!p) return;
  st.pending = { ...p, on_hand: state.onHand[p.id] ?? 0 };
  st.qty = "0";
  st.mode = "qty";
  renderStocktake();
});

$(".keypad-stqty").addEventListener("click", (e) => {
  const k = e.target.closest("button")?.dataset.k;
  if (!k) return;
  st.qty = applyQtyKey(st.qty, k);
  renderStocktake();
});

$("#stConfirm").addEventListener("click", () => {
  const counted = parseFloat(st.qty || "0");
  const adjustment = Math.round((counted - st.pending.on_hand) * 1000) / 1000;
  st.counts.push({
    product_id: st.pending.id,
    name: st.pending.name,
    unit: st.pending.unit,
    counted,
    was: st.pending.on_hand,
    adjustment,
  });
  st.pending = null;
  st.qty = "0";
  st.mode = "list";
  renderStocktake();
});

$("#stCancel").addEventListener("click", () => {
  st.pending = null;
  st.qty = "0";
  st.mode = "list";
  renderStocktake();
});

$("#stAddAnother").addEventListener("click", () => {
  st.mode = "pick";
  $("#stSearch").value = "";
  drawStResults("");
  renderStocktake();
});

$("#stCountedList").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-remove]");
  if (!btn) return;
  st.counts.splice(Number(btn.dataset.remove), 1);
  renderStocktake();
});

$("#stFinish").addEventListener("click", async () => {
  const btn = $("#stFinish");
  btn.disabled = true;
  try {
    const r = await api("/api/stocktakes", {
      method: "POST",
      body: JSON.stringify({
        counts: st.counts.map((c) => ({ product_id: c.product_id, counted_quantity: c.counted })),
      }),
    });
    const changed = r.results.filter((x) => x.adjustment !== 0).length;
    toast(
      `Stock take saved. ${r.results.length} product${
        r.results.length === 1 ? "" : "s"
      } counted, ${changed} adjusted.`
    );
    resetStocktake();
  } catch (err) {
    toast(err.message, true);
    btn.disabled = false;
  }
});

/* ============================================================
   Float — packed items kept in the freezer overnight to restock
   shelves each morning (e.g. "Beef stew, 69-size tray"). Entirely
   disconnected from the rest of the app: no location, no cost, no
   effect on the real stock ledger. Every morning's count is its own
   fresh, independent submission — there's no "reset"; the previous
   count simply becomes history the moment a new one is submitted.
   Same pick -> keypad -> list loop as Stock take, but simpler (no
   search box, no on-hand comparison), plus a review screen — shown
   either right after finishing a count or on tab entry if one
   already exists today — comparing the count to each item's
   manager-set target level so staff know what to go pack more of.
   ============================================================ */
const float = {
  mode: "init", // init | pick | qty | list | review — "init" is a sentinel
  // distinct from "pick" so the tab-entry handler below can tell "never
  // opened this tab this session" (decide review vs. picker for you) apart
  // from "operator is deliberately sitting on the picker" (leave them there).
  pending: null,
  qty: "0",
  counts: [], // {float_product_id, name, counted_quantity}
  review: null, // GET/POST float-counts response shown in #floatReview, or
  // null if nobody has ever counted anything yet — a normal state, not an error.
};

function drawFloatLocationPick() {
  $("#floatLocationPick").innerHTML = FLOAT_LOCATIONS.map(
    (loc) => `<button type="button" data-loc="${esc(loc)}" class="${
      loc === state.floatLocationPick ? "on" : ""
    }">${esc(loc)}</button>`
  ).join("");
}

$("#floatLocationPick").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-loc]");
  if (!b) return;
  state.floatLocationPick = b.dataset.loc;
  drawFloatLocationPick();
});

// Groups an already location-sorted list into [{location, items}] sections —
// shared by the picker, the manage list, the review, and both print sheets,
// all of which show float items grouped the same way.
function groupByFloatLocation(items, locationOf) {
  const sections = [];
  let current = null;
  items.forEach((item) => {
    const loc = locationOf(item);
    if (!current || current.location !== loc) {
      current = { location: loc, items: [] };
      sections.push(current);
    }
    current.items.push(item);
  });
  return sections;
}

async function loadFloatProducts() {
  state.floatProducts = await api("/api/float-products");
}

async function loadLatestFloatCount() {
  float.review = await api("/api/float-counts/latest"); // null is a valid response
}

// Past counts — mirrors Dispatch's "Past dispatches" history exactly (same
// fetch-one-extra "Load more" pattern), and the click handler reuses
// showFloatReview() so a past count renders through the exact same review
// screen as today's, with its title switching to the date it was actually
// taken on (see isTodayLocal() above).
let floatHistoryLimit = 200;
let floatHistoryHasMore = false;

async function loadFloatHistory() {
  const rows = await api(`/api/float-counts?limit=${floatHistoryLimit + 1}`);
  floatHistoryHasMore = rows.length > floatHistoryLimit;
  const shown = floatHistoryHasMore ? rows.slice(0, floatHistoryLimit) : rows;
  if (!shown.length) {
    $("#floatHistoryList").innerHTML = `<li><span class="meta">No counts yet.</span></li>`;
    return;
  }
  const rowsHtml = shown
    .map(
      (c) => `<li><button class="row" data-id="${c.id}">
          <span class="row-main"><strong>${esc(c.created_at)}</strong>
          <span class="meta">${esc(c.operator)} &middot; ${c.item_count} item${
        c.item_count === 1 ? "" : "s"
      } counted</span></span></button></li>`
    )
    .join("");
  const loadMore = floatHistoryHasMore
    ? `<li><button type="button" class="ghost bd-add" id="floatHistoryLoadMore">Load more</button></li>`
    : "";
  $("#floatHistoryList").innerHTML = rowsHtml + loadMore;
}

$("#floatHistoryList").addEventListener("click", async (e) => {
  const loadMoreBtn = e.target.closest("#floatHistoryLoadMore");
  if (loadMoreBtn) {
    loadMoreBtn.disabled = true;
    floatHistoryLimit += 200;
    await loadFloatHistory();
    return;
  }
  const btn = e.target.closest("button[data-id]");
  if (!btn) return;
  try {
    const detail = await api(`/api/float-counts/${btn.dataset.id}`);
    showFloatReview(detail);
  } catch (err) {
    toast(err.message, true);
  }
});

function resetFloatCount() {
  float.mode = "pick";
  float.pending = null;
  float.qty = "0";
  float.counts = [];
  renderFloat();
}

function showFloatReview(review) {
  float.review = review;
  float.mode = "review";
  renderFloat();
}

function drawFloatPickList() {
  // Once counted, an item drops off the list to count — like ticking it off
  // a physical sheet, so it's obvious what's left. "Remove" on the counted
  // line (in #floatCountedList) brings it back here if it needs redoing.
  const countedIds = new Set(float.counts.map((c) => c.float_product_id));
  const remaining = state.floatProducts.filter((p) => !countedIds.has(p.id));
  const sections = groupByFloatLocation(remaining, (p) => p.location);
  $("#floatPickList").innerHTML = sections
    .map(
      (section) =>
        `<li class="list-section">${esc(section.location)}</li>` +
        section.items
          .map(
            (p) => `<li><button class="row" data-id="${p.id}">
      <span class="row-main"><strong>${esc(p.name)}</strong>
      <span class="meta">${
        p.target_quantity != null ? "Target " + crates(p.target_quantity) : "No target set"
      }${p.units_per_crate != null ? ` &middot; ${p.units_per_crate}/crate` : ""}</span></span></button></li>`
          )
          .join("")
    )
    .join("");
}

function renderFloat() {
  // Same reasoning as renderReceive()/renderStocktake(): keep the picker
  // (and the always-visible manage list) in sync on every re-render, not
  // just on a full reset.
  drawFloatPickList();
  renderFloatProductList();

  const inWizard = float.mode === "pick" || float.mode === "qty";
  $("#floatWizard").hidden = !inWizard;
  $("#floatList").hidden = float.mode !== "list";
  $("#floatReview").hidden = float.mode !== "review";
  // Always available in the wizard, even before anything's been counted yet
  // — see the identical note on recCancelBar above for why.
  $("#floatCancelBar").hidden = !inWizard;
  $("#floatPickZone").hidden = float.mode !== "pick";
  $("#floatQtyZone").hidden = float.mode !== "qty";
  if (state.floatProducts.length === 0) {
    $("#floatNoProducts").hidden = false;
    $("#floatNoProducts").textContent = "No float items yet. Add the first one below.";
  } else if (float.counts.length === state.floatProducts.length) {
    $("#floatNoProducts").hidden = false;
    $("#floatNoProducts").textContent = "Everything's counted — tap Finish count below.";
  } else {
    $("#floatNoProducts").hidden = true;
  }

  if (float.mode === "qty" && float.pending) {
    $("#floatQtyLabel").textContent = `How many crates of ${float.pending.name} are there?`;
    $("#floatQty").textContent = float.qty;
  }

  $("#floatNoCounts").hidden = float.counts.length > 0;
  $("#floatCountedList").innerHTML = float.counts
    .map(
      (c, i) => `<li><div class="row-main"><strong>${esc(c.name)}</strong>
      <span class="meta">Counted ${crates(c.counted_quantity)}${
        c.units_per_crate != null ? ` &middot; ${items(c.counted_quantity * c.units_per_crate)}` : ""
      }</span></div>
      <button type="button" class="ghost small" data-remove="${i}">Remove</button></li>`
    )
    .join("");
  $("#floatFinish").disabled = float.counts.length === 0;

  if (float.mode === "review" && float.review) {
    renderFloatReview();
  }
}

// SQLite stores created_at in UTC; parsing it explicitly as UTC and then
// comparing in the browser's own local time (which, on a device physically
// in the shop, already is SAST) is simpler and more robust than hardcoding
// a timezone offset in JS the way the backend does for its own date math.
function isTodayLocal(sqliteUtcString) {
  const d = new Date(sqliteUtcString.replace(" ", "T") + "Z");
  return d.toDateString() === new Date().toDateString();
}

function renderFloatReview() {
  const r = float.review;
  $("#floatReviewTitle").textContent = isTodayLocal(r.created_at)
    ? "Today's float"
    : `Float count — ${new Date(r.created_at.replace(" ", "T") + "Z").toLocaleDateString()}`;
  $("#floatReviewMeta").textContent = `${r.created_at} · ${r.operator}`;
  if (!r.items.length) {
    $("#floatReviewList").innerHTML = `<li><span class="meta">Nothing counted.</span></li>`;
    return;
  }
  const sections = groupByFloatLocation(r.items, (it) => it.location);
  $("#floatReviewList").innerHTML = sections
    .map(
      (section) =>
        `<li class="list-section">${esc(section.location)}</li>` +
        section.items
          .map((it) => {
            const short = it.shortfall;
            const isShort = short != null && short > 0;
            const targetLine =
              it.target_quantity != null ? `Target ${crates(it.target_quantity)}` : "No target set";
            // Piece counts are a pure display conversion from crates via
            // units_per_crate — shown alongside, never in place of, the
            // crate figures that counting and targets actually run on.
            const itemsLine = isShort
              ? it.shortfall_items != null
                ? ` &middot; short ${items(it.shortfall_items)}`
                : ""
              : it.counted_items != null
              ? ` &middot; ${items(it.counted_items)}`
              : "";
            return `<li><div class="row-main"><strong>${esc(it.product)}</strong>
          <span class="meta">${targetLine}${
              isShort ? ` &middot; short ${crates(short)}` : ""
            }${itemsLine}</span></div>
          <span class="qty${isShort ? " adjusted" : ""}">${crates(it.counted_quantity)}</span></li>`;
          })
          .join("")
    )
    .join("");
}

$("#floatPickList").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-id]");
  if (!btn) return;
  const p = state.floatProducts.find((x) => x.id === Number(btn.dataset.id));
  if (!p) return;
  float.pending = p;
  float.qty = "0";
  float.mode = "qty";
  renderFloat();
});

$(".keypad-floatqty").addEventListener("click", (e) => {
  const k = e.target.closest("button")?.dataset.k;
  if (!k) return;
  float.qty = applyQtyKey(float.qty, k);
  renderFloat();
});

$("#floatQtyConfirm").addEventListener("click", () => {
  // A count is "how many are here right now," not a quantity being added —
  // unlike Receive/Dispatch, where picking the same product twice legitimately
  // sums two deliveries/requests, re-picking the same float item here should
  // replace its count, not sit alongside it as a second, ambiguous line. The
  // picker already hides anything already counted (see drawFloatPickList),
  // so this only ever matters if a line is re-entered after being removed —
  // covering it here too rather than relying solely on that.
  const existing = float.counts.find((c) => c.float_product_id === float.pending.id);
  if (existing) {
    existing.counted_quantity = parseFloat(float.qty || "0");
  } else {
    float.counts.push({
      float_product_id: float.pending.id,
      name: float.pending.name,
      counted_quantity: parseFloat(float.qty || "0"),
      units_per_crate: float.pending.units_per_crate,
    });
  }
  float.pending = null;
  float.qty = "0";
  float.mode = "list";
  renderFloat();
});

$("#floatCancel").addEventListener("click", () => {
  float.pending = null;
  float.qty = "0";
  float.mode = "list";
  renderFloat();
});

$("#floatAddAnother").addEventListener("click", () => {
  float.mode = "pick";
  renderFloat();
});

$("#floatCountedList").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-remove]");
  if (!btn) return;
  float.counts.splice(Number(btn.dataset.remove), 1);
  renderFloat();
});

$("#floatFinish").addEventListener("click", async () => {
  const btn = $("#floatFinish");
  btn.disabled = true;
  try {
    const r = await api("/api/float-counts", {
      method: "POST",
      body: JSON.stringify({
        counts: float.counts.map((c) => ({
          float_product_id: c.float_product_id,
          counted_quantity: c.counted_quantity,
        })),
      }),
    });
    toast(`Float count saved. ${r.items.length} item${r.items.length === 1 ? "" : "s"} counted.`);
    // Same "reset, then show the freshly-created detail" two-step Dispatch
    // uses after sending: resetFloatCount() clears the wizard/list back to a
    // clean picker, then showFloatReview() layers the review screen on top.
    resetFloatCount();
    showFloatReview(r);
  } catch (err) {
    toast(err.message, true);
    btn.disabled = false;
  }
});

$("#floatReviewNew").addEventListener("click", resetFloatCount);

/* ---------- manage float items (targets & crate size) ---------- */
// Mirrors Dispatch's actual-quantity inline editor exactly: at most one
// target editor open at a time, tracked by a module-level id, and every
// save re-fetches state.floatProducts fresh rather than patching the
// edited row in place. Units-per-crate gets its own independent id in the
// same style, since a row can have either editor open without the other.
let editingFloatTargetId = null;
let editingFloatUnitsId = null;

// A row can have its target editor and its crate-size editor open at once —
// they're independent by design (see the comment above these two ids). But
// renderFloatProductList() always rebuilds every input's value straight
// from state.floatProducts, and it's called from several places (picking
// items, saving the *other* editor, anything that calls renderFloat()) that
// have nothing to do with whichever editor is sitting open and mid-edit.
// Capturing that live, unsaved value first and reapplying it after the
// redraw is what stops an unrelated re-render from silently discarding it —
// previously a real edit could vanish with no warning if the other editor
// on the same row got saved (or even just opened) first.
function renderFloatProductList() {
  const targetDraft =
    editingFloatTargetId != null ? $("#floatTargetInput-" + editingFloatTargetId)?.value : undefined;
  const unitsDraft =
    editingFloatUnitsId != null ? $("#floatUnitsInput-" + editingFloatUnitsId)?.value : undefined;

  renderFloatProductListInner();

  if (targetDraft !== undefined) {
    const el = $("#floatTargetInput-" + editingFloatTargetId);
    if (el) el.value = targetDraft;
  }
  if (unitsDraft !== undefined) {
    const el = $("#floatUnitsInput-" + editingFloatUnitsId);
    if (el) el.value = unitsDraft;
  }
}

function renderFloatProductListInner() {
  if (!state.floatProducts.length) {
    $("#floatProductList").innerHTML = `<li><span class="meta">No float items yet.</span></li>`;
    return;
  }
  const sections = groupByFloatLocation(state.floatProducts, (p) => p.location);
  $("#floatProductList").innerHTML = sections
    .map(
      (section) =>
        `<li class="list-section">${esc(section.location)}</li>` +
        section.items.map(renderFloatProductRow).join("")
    )
    .join("");
}

function renderFloatProductRow(p) {
  const editingTarget = editingFloatTargetId === p.id;
  const editingUnits = editingFloatUnitsId === p.id;
  const targetEditor = editingTarget
    ? `<div class="inline-editor">
        <input type="number" id="floatTargetInput-${p.id}" value="${
        p.target_quantity ?? ""
      }" min="0" step="1" inputmode="decimal" placeholder="No target">
        <button type="button" class="ghost small" data-save-target="${p.id}">Save</button>
        <button type="button" class="ghost small" data-cancel-target="${p.id}">Cancel</button>
      </div>`
    : "";
  const unitsEditor = editingUnits
    ? `<div class="inline-editor">
        <input type="number" id="floatUnitsInput-${p.id}" value="${
        p.units_per_crate ?? ""
      }" min="1" step="1" inputmode="numeric" placeholder="Not set">
        <button type="button" class="ghost small" data-save-units="${p.id}">Save</button>
        <button type="button" class="ghost small" data-cancel-units="${p.id}">Cancel</button>
      </div>`
    : "";
  return `<li><div class="row-main"><strong>${esc(p.name)}</strong>
    <span class="meta">${
      p.target_quantity != null ? "Target " + crates(p.target_quantity) : "No target set"
    } &middot; ${
      p.units_per_crate != null ? p.units_per_crate + " items/crate" : "Items per crate not set"
    }</span>
    ${targetEditor}${unitsEditor}</div>
    ${
      editingTarget
        ? ""
        : `<button type="button" class="ghost small" data-edit-target="${p.id}">Edit target</button>`
    }
    ${
      editingUnits
        ? ""
        : `<button type="button" class="ghost small" data-edit-units="${p.id}">Edit crate size</button>`
    }
    </li>`;
}

$("#floatProductList").addEventListener("click", async (e) => {
  const editBtn = e.target.closest("button[data-edit-target]");
  const cancelBtn = e.target.closest("button[data-cancel-target]");
  const saveBtn = e.target.closest("button[data-save-target]");
  const editUnitsBtn = e.target.closest("button[data-edit-units]");
  const cancelUnitsBtn = e.target.closest("button[data-cancel-units]");
  const saveUnitsBtn = e.target.closest("button[data-save-units]");

  if (editBtn) {
    editingFloatTargetId = Number(editBtn.dataset.editTarget);
    renderFloatProductList();
    $("#floatTargetInput-" + editingFloatTargetId)?.focus();
    return;
  }
  if (cancelBtn) {
    editingFloatTargetId = null;
    renderFloatProductList();
    return;
  }
  if (saveBtn) {
    const id = Number(saveBtn.dataset.saveTarget);
    const raw = $("#floatTargetInput-" + id).value;
    // Blank is a legitimate way to clear a target back to "none set", not
    // an invalid input to reject.
    const value = raw === "" ? null : parseFloat(raw);
    if (value != null && (!Number.isFinite(value) || value < 0)) {
      toast("Enter a target of 0 or more, or leave it blank to clear it.", true);
      return;
    }
    saveBtn.disabled = true;
    try {
      await api(`/api/float-products/${id}/target`, {
        method: "POST",
        body: JSON.stringify({ target_quantity: value }),
      });
      editingFloatTargetId = null;
      await loadFloatProducts();
      renderFloat();
      toast("Target updated.");
    } catch (err) {
      toast(err.message, true);
      saveBtn.disabled = false;
    }
    return;
  }

  if (editUnitsBtn) {
    editingFloatUnitsId = Number(editUnitsBtn.dataset.editUnits);
    renderFloatProductList();
    $("#floatUnitsInput-" + editingFloatUnitsId)?.focus();
    return;
  }
  if (cancelUnitsBtn) {
    editingFloatUnitsId = null;
    renderFloatProductList();
    return;
  }
  if (saveUnitsBtn) {
    const id = Number(saveUnitsBtn.dataset.saveUnits);
    const raw = $("#floatUnitsInput-" + id).value;
    // Blank clears it back to "not set" — a legitimate choice, not an
    // invalid input.
    const value = raw === "" ? null : parseInt(raw, 10);
    if (value != null && (!Number.isInteger(value) || value < 1)) {
      toast("Enter a whole number of 1 or more, or leave it blank to clear it.", true);
      return;
    }
    saveUnitsBtn.disabled = true;
    try {
      await api(`/api/float-products/${id}/units-per-crate`, {
        method: "POST",
        body: JSON.stringify({ units_per_crate: value }),
      });
      editingFloatUnitsId = null;
      await loadFloatProducts();
      renderFloat();
      toast("Crate size updated.");
    } catch (err) {
      toast(err.message, true);
      saveUnitsBtn.disabled = false;
    }
  }
});

$("#floatProductForm").addEventListener("keydown", (e) => {
  if (e.key === "Enter") e.preventDefault();
});

$("#floatProductForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    const name = $("#floatNewName").value;
    const unitsRaw = $("#floatNewUnitsPerCrate").value;
    const targetRaw = $("#floatNewTarget").value;
    await api("/api/float-products", {
      method: "POST",
      body: JSON.stringify({
        name,
        location: state.floatLocationPick,
        units_per_crate: unitsRaw !== "" ? parseInt(unitsRaw, 10) : null,
        target_quantity: targetRaw !== "" ? parseFloat(targetRaw) : null,
      }),
    });
    toast(`${name} added.`);
    $("#floatNewName").value = "";
    $("#floatNewUnitsPerCrate").value = "";
    $("#floatNewTarget").value = "";
    await loadFloatProducts();
    renderFloat(); // the picker needs to see the new item immediately too
  } catch (err) {
    toast(err.message, true);
  }
});

/* ---------- products tab ---------- */
function drawUnits() {
  $("#unitPick").innerHTML = state.units
    .map(
      (u) => `<button type="button" data-u="${u}" class="${u === state.unitPick ? "on" : ""}">${u}</button>`
    )
    .join("");
}

$("#unitPick").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-u]");
  if (!b) return;
  state.unitPick = b.dataset.u;
  drawUnits();
});

$("#productForm").addEventListener("keydown", (e) => {
  if (e.key === "Enter") e.preventDefault();
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
        supplier_id: Number($("#pSupplier").value) || null,
        code: $("#pCode").value,
      }),
    });
    toast(`${$("#pName").value} created.`);
    $("#pName").value = "";
    $("#pCode").value = "";
    $("#pSupplier").value = "";
    await loadProducts();
  } catch (err) {
    toast(err.message, true);
  }
});

/* ---------- suppliers (Products tab management) ---------- */
$("#supplierForm").addEventListener("keydown", (e) => {
  if (e.key === "Enter") e.preventDefault();
});

$("#supplierForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("#newSupplierNameProducts").value;
  try {
    await api("/api/suppliers", { method: "POST", body: JSON.stringify({ name }) });
    toast(`${name} added.`);
    $("#newSupplierNameProducts").value = "";
    await loadSuppliers();
  } catch (err) {
    toast(err.message, true);
  }
});

/* ---------- add a storage location ---------- */
// POST /api/locations already existed on the backend with nothing in the UI
// ever calling it — adding a new freezer/chiller/etc. required going
// straight to the database. Mirrors the unit-picker above exactly.
function drawLocKindPick() {
  $("#locKindPick").innerHTML = LOCATION_KINDS.map(
    (k) => `<button type="button" data-k="${k}" class="${k === state.locKindPick ? "on" : ""}">${k}</button>`
  ).join("");
}

$("#locKindPick").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-k]");
  if (!b) return;
  state.locKindPick = b.dataset.k;
  drawLocKindPick();
});

$("#locationForm").addEventListener("keydown", (e) => {
  if (e.key === "Enter") e.preventDefault();
});

$("#locationForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("#locName").value;
  try {
    await api("/api/locations", {
      method: "POST",
      body: JSON.stringify({ name, kind: state.locKindPick }),
    });
    toast(`${name} added.`);
    $("#locName").value = "";
    await loadLocations(); // refreshes #pLocation and Receive's #locationPick too
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
        <span class="meta">${esc(r.location || "No location")}</span>${
          r.cost_price != null ? `<span class="meta">Cost R${money(r.cost_price)}</span>` : ""
        }</div>
        <span class="qty">${round(r.on_hand)}<span>${esc(r.unit)}</span></span></li>`
        )
        .join("")
    : `<li><span class="meta">Nothing received yet.</span></li>`;
}

// The API defaults to the 50 most recent movements — plenty for a quick
// check, but a real shop generates one row per receipt line, dispatch line,
// and stock-take adjustment, so 50 can be just a day or two of history.
// logLimit grows via "Load more" below rather than the log silently
// stopping at 50 with no sign anything's missing. Always fetching one row
// past logLimit is how "is there more?" is known for certain, rather than
// guessing from whether the page happened to come back full.
let logLimit = 200;
let lastLogRows = [];
let logHasMore = false;
let reversingMovementId = null;

async function loadLog() {
  const rows = await api(`/api/movements?limit=${logLimit + 1}`);
  logHasMore = rows.length > logLimit;
  lastLogRows = logHasMore ? rows.slice(0, logLimit) : rows;
  renderLog();
}

function renderLog() {
  if (!lastLogRows.length) {
    $("#logList").innerHTML = `<li><span class="meta">No entries yet.</span></li>`;
    return;
  }
  const rows = lastLogRows
    .map((m) => {
      const negative = m.direction === "REVERSAL" || m.direction === "OUT";
      const tag =
        m.direction === "REVERSAL"
          ? " &middot; reversal"
          : m.dispatch_id
          ? " &middot; dispatch"
          : m.stocktake_id
          ? " &middot; stock take"
          : "";
      // Only a plain receipt can be reversed from here — a dispatch line
      // already has its own actual-quantity correction, and a stock-take
      // adjustment is meant to be corrected with a fresh stock take (it
      // can't be reopened), so reversing either from the log would just
      // give the same correction two conflicting paths to happen through.
      const reversible =
        m.direction === "IN" && !m.dispatch_id && !m.stocktake_id && !m.breakdown_id && !m.reversed;
      const reversing = reversingMovementId === m.id;
      const reverseEditor = reversing
        ? `<div class="inline-editor">
            <input type="text" id="reverseNote-${m.id}" placeholder="Reason (optional)">
            <button type="button" class="ghost small" data-confirm-reverse="${m.id}">Reverse it</button>
            <button type="button" class="ghost small" data-cancel-reverse="${m.id}">Cancel</button>
          </div>`
        : "";
      return `<li><div class="row-main">
      <strong class="${m.reversed ? "struck" : ""}">${esc(m.product)}</strong>
      <span class="meta">${esc(m.created_at)} &middot; ${esc(m.operator)}${
        m.reference ? " &middot; " + esc(m.reference) : ""
      }${tag}</span>
      ${reverseEditor}</div>
      <span class="qty">${negative ? "&minus;" : "+"}${round(m.quantity)}<span>${esc(m.unit)}</span></span>
      ${
        reversible && !reversing
          ? `<button type="button" class="ghost small" data-start-reverse="${m.id}">Reverse</button>`
          : ""
      }
      </li>`;
    })
    .join("");
  const loadMore = logHasMore
    ? `<li><button type="button" class="ghost bd-add" id="logLoadMore">Load more</button></li>`
    : "";
  $("#logList").innerHTML = rows + loadMore;
}

$("#logList").addEventListener("click", async (e) => {
  const loadMoreBtn = e.target.closest("#logLoadMore");
  const startBtn = e.target.closest("button[data-start-reverse]");
  const cancelBtn = e.target.closest("button[data-cancel-reverse]");
  const confirmBtn = e.target.closest("button[data-confirm-reverse]");

  if (loadMoreBtn) {
    loadMoreBtn.disabled = true;
    logLimit += 200;
    await loadLog();
    return;
  }
  if (startBtn) {
    reversingMovementId = Number(startBtn.dataset.startReverse);
    renderLog();
    $("#reverseNote-" + reversingMovementId)?.focus();
    return;
  }
  if (cancelBtn) {
    reversingMovementId = null;
    renderLog();
    return;
  }
  if (confirmBtn) {
    const id = Number(confirmBtn.dataset.confirmReverse);
    const note = $("#reverseNote-" + id).value.trim();
    confirmBtn.disabled = true;
    try {
      await api("/api/reversals", {
        method: "POST",
        body: JSON.stringify({ movement_id: id, note: note || null }),
      });
      reversingMovementId = null;
      toast("Entry reversed.");
      await loadLog();
    } catch (err) {
      toast(err.message, true);
      confirmBtn.disabled = false;
    }
  }
});

// Log is no longer one of the bottom tabs — it's opened from a button inside
// Analytics instead, using the exact same show/hide plumbing as
// openSettings() below: hide every .view except this one, and since Log
// isn't a tab, no tab bar button gets marked "on".
function openLog() {
  $$(".tabs button").forEach((x) => x.classList.remove("on"));
  $$(".view").forEach((v) => (v.hidden = v.id !== "view-log"));
  logLimit = 200;
  reversingMovementId = null;
  loadLog();
}

$("#viewLogBtn").addEventListener("click", openLog);

/* ---------- analytics ---------- */
async function loadAnalytics() {
  const a = await api("/api/analytics/summary");
  const totalProducts = (a.priced_products || 0) + (a.unpriced_products || 0);

  $("#anStats").innerHTML = `
    <li><div class="row-main"><strong>Inventory value</strong></div>
      <span class="qty">R${money(a.inventory_value ?? 0)}</span></li>
    <li><div class="row-main"><strong>Products priced</strong></div>
      <span class="qty">${a.priced_products ?? 0} of ${totalProducts}</span></li>
    <li><div class="row-main"><strong>Receipts, last 30 days</strong></div>
      <span class="qty">${a.receipts_last_30_days ?? 0}</span></li>
    <li><div class="row-main"><strong>Dispatches, last 30 days</strong></div>
      <span class="qty">${a.dispatches_last_30_days ?? 0}</span></li>
    <li><div class="row-main"><strong>Stock takes, last 30 days</strong></div>
      <span class="qty">${a.stocktakes_last_30_days ?? 0}</span></li>
  `;

  const topProducts = a.top_value_products || [];
  $("#anTopProducts").innerHTML = topProducts.length
    ? topProducts
        .map(
          (p) => `<li><div class="row-main"><strong>${esc(p.product)}</strong>
        <span class="meta">${round(p.on_hand)} ${esc(p.unit)} on hand</span></div>
        <span class="qty">R${money(p.value ?? 0)}</span></li>`
        )
        .join("")
    : `<li><span class="meta">Nothing here yet.</span></li>`;

  const topSuppliers = a.top_suppliers || [];
  $("#anTopSuppliers").innerHTML = topSuppliers.length
    ? topSuppliers
        .map(
          (s) => `<li><div class="row-main"><strong>${esc(s.supplier)}</strong>
        <span class="meta">${s.receipt_count} receipt${s.receipt_count === 1 ? "" : "s"}</span></div>
        <span class="qty">R${money(s.total_value ?? 0)}</span></li>`
        )
        .join("")
    : `<li><span class="meta">Nothing here yet.</span></li>`;
}

/* ============================================================
   Settings — accounting integrations (Xero / Sage). Opened from the
   header button rather than the bottom tab bar, so it reuses the same
   .view show/hide plumbing but isn't one of the seven tabs.
   ============================================================ */
const INTEGRATION_LABELS = { xero: "Xero", sage: "Sage" };

function openSettings() {
  $$(".tabs button").forEach((x) => x.classList.remove("on"));
  $$(".view").forEach((v) => (v.hidden = v.id !== "view-settings"));
  loadIntegrations();
}

$("#settingsBtn").addEventListener("click", openSettings);

async function loadIntegrations() {
  const list = await api("/api/integrations");
  $("#integrationsList").innerHTML = list
    .map((p) => {
      if (p.connected) {
        return `<li><div class="row-main"><strong>${esc(p.label)}</strong>
          <span class="meta">Connected${
            p.tenant_name ? " &middot; " + esc(p.tenant_name) : ""
          }</span></div>
          <button class="ghost small" data-provider="${p.provider}" data-action="disconnect">Disconnect</button></li>`;
      }
      if (!p.configured) {
        return `<li><div class="row-main"><strong>${esc(p.label)}</strong>
          <span class="meta">Not set up on this server yet</span></div></li>`;
      }
      return `<li><div class="row-main"><strong>${esc(p.label)}</strong>
        <span class="meta">Not connected</span></div>
        <button class="ghost small" data-provider="${p.provider}" data-action="connect">Connect</button></li>`;
    })
    .join("");
}

$("#integrationsList").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-provider]");
  if (!btn) return;
  const provider = btn.dataset.provider;
  const action = btn.dataset.action;
  btn.disabled = true;
  try {
    if (action === "connect") {
      const res = await api(`/api/integrations/${provider}/connect`, { method: "POST" });
      location.href = res.authorize_url; // hand off to the provider's own login/consent screen
    } else {
      await api(`/api/integrations/${provider}/disconnect`, { method: "POST" });
      toast("Disconnected.");
      await loadIntegrations();
    }
  } catch (err) {
    toast(err.message, true);
    btn.disabled = false;
  }
});

// The provider's callback redirects the whole browser back to "/" with
// ?integration=xero&status=connected (or status=error&reason=...) tacked on.
// Called once from enterApp() on every boot — a no-op unless those params
// are actually present, so a normal sign-in never touches it.
function handleIntegrationRedirect() {
  const params = new URLSearchParams(location.search);
  const provider = params.get("integration");
  if (!provider) return;
  const label = INTEGRATION_LABELS[provider] || provider;
  const status = params.get("status");
  if (status === "connected") {
    toast(`${label} connected.`);
  } else {
    const reason = params.get("reason");
    toast(
      `Couldn't connect ${label}${reason ? " (" + reason.replace(/_/g, " ") + ")" : ""}.`,
      true
    );
  }
  history.replaceState({}, "", location.pathname);
  openSettings();
}

/* ---------- tabs ---------- */
$$(".tabs button").forEach((b) =>
  b.addEventListener("click", async () => {
    $$(".tabs button").forEach((x) => x.classList.toggle("on", x === b));
    $$(".view").forEach((v) => (v.hidden = v.id !== "view-" + b.dataset.view));
    try {
      if (b.dataset.view === "stock") await loadStock();
      if (b.dataset.view === "products") await loadProducts();
      if (b.dataset.view === "receive") {
        await loadProducts();
        renderReceive();
      }
      if (b.dataset.view === "dispatch") {
        // Refresh the underlying data, but don't clear an in-progress batch —
        // switching to another tab to check something and coming back must
        // not silently wipe out a dispatch list already being built.
        // resetDispatch() still runs after an actual send, and "Start over"
        // is there if you want a clean slate on purpose.
        await Promise.all([loadProducts(), loadOnHand(), loadDispatchHistory()]);
        renderDispatch();
      }
      if (b.dataset.view === "stocktake") {
        await Promise.all([loadProducts(), loadOnHand()]);
        renderStocktake();
      }
      if (b.dataset.view === "float") {
        // Same non-destructive reasoning as dispatch above: refresh float
        // items + today's latest count, but never wipe an in-progress count
        // session. Only on the very first entry this session (mode still
        // "init") do we decide review-vs-picker for the operator; every
        // re-entry after that leaves mode exactly where they left it.
        await Promise.all([loadFloatProducts(), loadLatestFloatCount(), loadFloatHistory()]);
        if (float.mode === "init") {
          float.mode = float.review ? "review" : "pick";
        }
        renderFloat();
      }
      if (b.dataset.view === "analytics") await loadAnalytics();
    } catch (err) {
      // A failed load here used to fail silently — the tab would already be
      // visible with nothing telling the operator its contents didn't
      // actually refresh. Surface it instead, same as every other action.
      toast(err.message, true);
    }
  })
);

/* ---------- resume session ---------- */
if (state.pin) submitPin(state.pin);
