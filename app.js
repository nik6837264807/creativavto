function getDb() {
  if (window._fsClient) return window._fsClient;
  const projectId = "creativavto-f7bee";
  const host = "https://googleapis.com";
  const baseUrl = `${host}/v1/projects/${projectId}/databases/(default)/documents`;

  const fromFsVal = (obj) => {
    if (!obj || "nullValue" in obj) return null;
    if ("booleanValue" in obj) return obj.booleanValue;
    if ("integerValue" in obj) return Number(obj.integerValue);
    if ("doubleValue" in obj) return Number(obj.doubleValue);
    if ("stringValue" in obj) return obj.stringValue;
    if ("arrayValue" in obj) return (obj.arrayValue.values || new Array()).map(fromFsVal);
    if ("mapValue" in obj) {
      const res = {};
      for (const [k, v] of Object.entries(obj.mapValue.fields || {})) res[k] = fromFsVal(v);
      return res;
    }
    return null;
  };

  const toFsVal = (v) => {
    if (v === null || v === undefined) return { nullValue: null };
    if (typeof v === "boolean") return { booleanValue: v };
    if (typeof v === "number") return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
    if (Array.isArray(v)) return { arrayValue: { values: v.map(toFsVal) } };
    if (typeof v === "object") {
      const fields = {};
      for (const [k, val] of Object.entries(v)) fields[k] = toFsVal(val);
      return { mapValue: { fields } };
    }
    return { stringValue: String(v) };
  };

  const parseDoc = (doc) => {
    const id = doc.name.split("/").pop();
    const out = { id };
    for (const [k, v] of Object.entries(doc.fields || {})) out[k] = fromFsVal(v);
    return out;
  };

  window._fsClient = {
    from(table) {
      let filters = new Array(), method = "GET", payload = null, isSingle = false;
      const b = {
        select() { return b; },
        eq(col, val) { filters.push({ col, val }); return b; },
        insert(data) { method = "POST"; payload = data; return b; },
        update(data) { method = "PATCH"; payload = data; return b; },
        delete() { method = "DELETE"; return b; },
        single() { isSingle = true; return b; },
        maybeSingle() { isSingle = true; return b; },
        async then(resolve) {
          try {
            const idFilter = filters.find((f) => f.col === "id");
            if (method === "GET") {
              if (idFilter) {
                const r = await fetch(`${baseUrl}/${table}/${encodeURIComponent(idFilter.val)}`);
                if (!r.ok) return resolve({ data: null, error: null });
                return resolve({ data: parseDoc(await r.json()), error: null });
              }
              const r = await fetch(`${baseUrl}/${table}?pageSize=500`);
              const json = await r.json();
              let rows = (json.documents || new Array()).map(parseDoc);
              for (const f of filters) rows = rows.filter((row) => String(row[f.col]) === String(f.val));
              return resolve({ data: isSingle ? (rows.at(0) || null) : rows, error: null });
            }
            if (method === "POST") {
              const fields = {};
              for (const [k, v] of Object.entries(payload)) if (k !== "id") fields[k] = toFsVal(v);
              const r = await fetch(`${baseUrl}/${table}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ fields }) });
              const doc = await r.json();
              return resolve({ data: parseDoc(doc), error: r.ok ? null : new Error(doc.error?.message || "Insert error") });
            }
            if (method === "PATCH") {
              let targets = idFilter ? Array.of(String(idFilter.val)) : new Array();
              if (!idFilter && filters.length) {
                const rGet = await fetch(`${baseUrl}/${table}?pageSize=500`);
                const jGet = await rGet.json();
                let rows = (jGet.documents || new Array()).map(parseDoc);
                for (const f of filters) rows = rows.filter((row) => String(row[f.col]) === String(f.val));
                targets = rows.map((row) => row.id);
              }
              const fields = {}, mask = new Array();
              for (const [k, v] of Object.entries(payload)) { fields[k] = toFsVal(v); mask.push(`updateMask.fieldPaths=${encodeURIComponent(k)}`); }
              let lastDoc = null;
              for (const tid of targets) {
                const r = await fetch(`${baseUrl}/${table}/${encodeURIComponent(tid)}?${mask.join("&")}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ fields }) });
                if (r.ok) lastDoc = parseDoc(await r.json());
              }
              return resolve({ data: lastDoc, error: null });
            }
            if (method === "DELETE" && idFilter) {
              await fetch(`${baseUrl}/${table}/${encodeURIComponent(idFilter.val)}`, { method: "DELETE" });
              return resolve({ data: null, error: null });
            }
            resolve({ data: null, error: null });
          } catch (error) { resolve({ data: null, error }); }
        }
      };
      return b;
    },
    functions: {
      async invoke(fnName, { body }) {
        try {
          const fallbackHost = Array.of("https:/", "afrlwjzssgmlwxmzlmiq.supabase.co").join("/");
          const url = window.CLOUD_FUNCTIONS_BASE ? `${window.CLOUD_FUNCTIONS_BASE}/${fnName}` : `${fallbackHost}/functions/v1/${fnName}`;
          const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
          const data = await r.json();
          return r.ok ? { data, error: null } : { data: null, error: new Error(data?.error || r.statusText) };
        } catch (error) { return { data: null, error }; }
      }
    }
  };
  return window._fsClient;
}

var isLoginMode = false;
var showArchive = false;
var selectedPlanId = "plan_6m";
var cachedPlans = new Array();
var state = JSON.parse(localStorage.getItem("creativavto_session") || "null");

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js").catch(() => {});
}

var isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
var isStandalone = window.navigator.standalone === true || window.matchMedia("(display-mode: standalone)").matches;
if (isIos && !isStandalone) {
  document.getElementById("ios-install-hint")?.classList.remove("hidden");
}

function saveSession(data) {
  state = { ...(state || {}), ...data };
  localStorage.setItem("creativavto_session", JSON.stringify(state));
  updateHeaderCar();
}
function updateHeaderCar() {
  if (!state) return;
  const plate = state.carPlate ? ` (${state.carPlate})` : "";
  const label = `${state.carModel || "Выбрать авто"}${plate}`;
  document.getElementById("header-car").textContent = `🚗 ${label} ▼`;
  document.getElementById("book-title").textContent = `Сервисная книжка: ${state.carModel || ""}`;
  document.getElementById("new-app-title").textContent = `Новая заявка (${state.carModel || ""})`;
}

function toggleAuthMode() {
  isLoginMode = !isLoginMode;
  document.getElementById("reg-fields").classList.toggle("hidden", isLoginMode);
  document.getElementById("auth-subtitle").textContent = isLoginMode ? "Восстановление сервисной книжки" : "Регистрация автовладельца";
  document.getElementById("auth-submit-btn").textContent = isLoginMode ? "Войти и восстановить данные" : "Создать сервисную книжку";
  document.getElementById("auth-toggle-btn").textContent = isLoginMode ? "Впервые у нас? Зарегистрироваться" : "Уже есть аккаунт / сменил телефон? Войти";
}

async function handleAuth() {
  const db = getDb();
  const phone = document.getElementById("auth-phone").value.trim();
  const password = document.getElementById("auth-pass").value.trim();
  const btn = document.getElementById("auth-submit-btn");
  btn.disabled = true;

  try {
    if (isLoginMode) {
      const { data: found, error } = await db.from("clients").select("*").eq("phone", phone).eq("password", password).maybeSingle();
      if (error) throw error;
      if (!found) {
        alert("Неверный телефон или кодовое слово");
        btn.disabled = false;
        return;
      }
      const { data: cars } = await db.from("cars").select("*").eq("client_id", found.id);
      const firstCar = Array.isArray(cars) && cars.length > 0 ? cars.at(0) : null;
      saveSession({
        clientId: found.id, name: found.name, phone: found.phone,
        activeCarId: firstCar ? firstCar.id : "",
        carModel: firstCar ? firstCar.car_model : found.car_model,
        carPlate: firstCar ? firstCar.car_plate : found.car_plate,
        subscriptionUntil: found.subscription_until || null
      });
      initApp();
    } else {
      const name = document.getElementById("auth-name").value.trim();
      const carModel = document.getElementById("auth-car").value.trim();
      const carPlate = document.getElementById("auth-plate").value.trim();
      if (!name || !carModel || !phone || !password) {
        alert("Заполните обязательные поля");

        btn.disabled = false;
        return;
      }
      const { data: inserted, error } = await db.from("clients")
        .insert({ name, car_model: carModel, car_plate: carPlate, phone, password, current_mileage: 0, subscription_plan: "free", trial_granted_days: 0 })
        .select().single();
      if (error) throw error;

      const { data: insertedCar } = await db.from("cars")
        .insert({ client_id: inserted.id, car_model: carModel, car_plate: carPlate, current_mileage: 0 })
        .select().single();

      saveSession({
        clientId: inserted.id, name: inserted.name, phone: inserted.phone,
        activeCarId: insertedCar ? insertedCar.id : "", carModel, carPlate,
        subscriptionUntil: inserted.subscription_until || null
      });
      initApp();
    }
  } catch (e) {
    alert("Ошибка сети: " + e.message);
  }
  btn.disabled = false;
}

function switchTab(idx) {
  const tabs = Array.of(0, 1, 2, 3);
  const navItems = document.querySelectorAll(".nav-item");
  tabs.forEach((i) => {
    const el = document.getElementById(`tab-${i}`);
    if (el) el.classList.toggle("hidden", i !== idx);
    if (navItems.item(i)) navItems.item(i).classList.toggle("active", i === idx);
  });
  document.getElementById("tab-settings")?.classList.add("hidden");
  document.getElementById("bottom-nav")?.classList.remove("hidden");

  if (idx === 0) refreshSubscriptionStatus();
  if (idx === 1) loadServiceBook();
  if (idx === 2) loadAppointments();
  if (idx === 3) {
    loadMessages();
    syncPushButtonState();
  }
}

function isSubscriptionActive() {
  if (!state || !state.subscriptionUntil) return false;
  return new Date(state.subscriptionUntil).getTime() > Date.now();
}

function applySubscriptionUi() {
  const active = isSubscriptionActive();
  const unlockedEl = document.getElementById("ai-unlocked-area");
  const lockedEl = document.getElementById("ai-locked-area");
  const statusEl = document.getElementById("sub-status-text");

  if (unlockedEl && lockedEl) {
    unlockedEl.classList.toggle("hidden", !active);
    lockedEl.classList.toggle("hidden", active);
  }
  if (statusEl) {
    if (active) {
      const dt = new Date(state.subscriptionUntil).toLocaleDateString("ru-RU");
      statusEl.innerHTML = `<span style="color:var(--green); font-weight:700;">✅ Активна до ${dt}</span>`;
    } else {
      statusEl.innerHTML = `<span style="color:var(--red); font-weight:700;">⛔ Не активна (ИИ первого экрана ограничен)</span>`;
    }
  }
  if (!active) loadSubscriptionPlans();
}

async function refreshSubscriptionStatus() {
  if (!state || !state.clientId) return;
  const db = getDb();
  const { data: cl } = await db.from("clients").select("subscription_until").eq("id", state.clientId).maybeSingle();
  if (cl) {
    saveSession({ subscriptionUntil: cl.subscription_until || null });
  }
  applySubscriptionUi();
}

async function loadSubscriptionPlans() {
  const db = getDb();
  const { data: plans } = await db.from("subscription_plans").select("*").eq("is_active", true);
  cachedPlans = Array.isArray(plans) ? plans.sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0)) : new Array();
  if (cachedPlans.length > 0 && !cachedPlans.some((p) => p.id === selectedPlanId)) {
    selectedPlanId = cachedPlans.at(0).id;
  }
  renderPlansList();
}

function renderPlansList() {
  const box = document.getElementById("plans-list");
  if (!box) return;
  box.innerHTML = "";
  cachedPlans.forEach((p) => {
    const picked = p.id === selectedPlanId;
    const div = document.createElement("div");
    div.className = "card";


    div.style.cssText = `cursor:pointer; margin-bottom:8px; border:2px solid ${picked ? "var(--primary)" : "var(--border)"}; background:${picked ? "#eff6ff" : "#fff"};`;
    div.innerHTML = `
      <div class="row-between">
        <div>
          <b>${p.title}</b> ${p.badge ? `<span style="background:var(--green); color:#fff; font-size:11px; padding:2px 7px; border-radius:99px; margin-left:6px;">${p.badge}</span>` : ""}
          <div style="font-size:12px; color:var(--muted);">Доступ к ИИ-Автомеханику на ${p.months} мес.</div>
        </div>
        <div style="font-size:18px; font-weight:800; color:var(--primary);">${p.price_rub} ₽</div>
      </div>`;
    div.onclick = () => { selectedPlanId = p.id; renderPlansList(); };
    box.appendChild(div);
  });
}

async function startSubscriptionPayment() {
  const cb = document.getElementById("agree-terms-cb");
  if (!cb || !cb.checked) {
    return alert("Пожалуйста, поставьте галочку согласия с условиями оферты и уведомлением о возможном изменении цен.");
  }
  const btn = document.getElementById("pay-sub-btn");
  btn.disabled = true;
  btn.textContent = "Переход к оплате...";
  try {
    const db = getDb();
    const returnUrl = Array.of("https:/", "nik6837264807.github.io", "creativavto", "").join("/");
    const { data, error } = await db.functions.invoke("create-yookassa-payment", {
      body: { client_id: state.clientId, plan_id: selectedPlanId, return_url: returnUrl }
    });
    if (error) throw error;
    if (data?.confirmation_url) {
      window.location.href = data.confirmation_url;
      return;
    }
    throw new Error("Не получена ссылка на оплату");
  } catch (e) {
    alert(e.message);
  }
  btn.disabled = false;
  btn.textContent = "💳 Оплатить подписку (ЮKassa)";
}

function openSubscriptionScreen() {
  switchTab(0);
  document.getElementById("ai-unlocked-area")?.classList.add("hidden");
  document.getElementById("ai-locked-area")?.classList.remove("hidden");
  loadSubscriptionPlans();
}
function openAiChat() {
  if (!isSubscriptionActive()) return applySubscriptionUi();
  document.getElementById("diagnost-home").classList.add("hidden");
  document.getElementById("diagnost-chat").classList.remove("hidden");
}

function closeAiChat() {
  document.getElementById("diagnost-chat").classList.add("hidden");
  document.getElementById("diagnost-home").classList.remove("hidden");
  document.getElementById("ai-answer-box").classList.add("hidden");
}

async function askAiMechanic() {
  if (!isSubscriptionActive()) return applySubscriptionUi();
  const db = getDb();
  const prompt = document.getElementById("ai-question").value.trim();
  if (!prompt) return;
  const btn = document.getElementById("ai-ask-btn");
  btn.disabled = true;
  btn.textContent = "Механик анализирует...";

  try {
    const { data, error } = await db.functions.invoke("ai-mechanic", {
      body: { mode: "text", prompt, carModel: state.carModel }
    });
    if (error) throw error;
    if (data && data.error) throw new Error(data.error);
    document.getElementById("ai-answer-text").textContent = data.reply;
    document.getElementById("ai-answer-box").classList.remove("hidden");
  } catch (e) {
    alert("Ошибка ИИ: " + e.message);
  }
  btn.disabled = false;
  btn.textContent = "Получить консультацию";
}

function resizeImageToBase64(file, maxSide = 1024) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        let w = img.width, h = img.height;
        if (w > maxSide || h > maxSide) {
          if (w > h) { h = Math.round((h * maxSide) / w); w = maxSide; }
          else { w = Math.round((w * maxSide) / h); h = maxSide; }
        }
        const canvas = document.createElement("canvas");
        canvas.width = w; canvas.height = h;
        canvas.getContext("2d").drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL("image/jpeg", 0.85));
      };
      img.onerror = reject;
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}

async function handleDashboardPhoto(event) {
  if (!isSubscriptionActive()) {
    event.target.value = "";
    return applySubscriptionUi();
  }
  const db = getDb();
  const file = event.target.files?.item(0);
  if (!file) return;
  openAiChat();
  document.getElementById("ai-question").value = `Фото приборной панели (${state.carModel}): расшифровка горящих значков`;
  const btn = document.getElementById("ai-ask-btn");
  btn.disabled = true;
  btn.textContent = "Распознаю значки по фото...";

  try {
    const imageBase64 = await resizeImageToBase64(file, 1024);
    const { data, error } = await db.functions.invoke("ai-mechanic", {
      body: { mode: "dashboard_vision", imageBase64, carModel: state.carModel }
    });
    if (error) throw error;
    if (data && data.error) throw new Error(data.error);
    document.getElementById("ai-answer-text").textContent = data.reply;
    document.getElementById("ai-answer-box").classList.remove("hidden");
  } catch (e) {
    alert("Ошибка распознавания фото: " + e.message);
  }
  btn.disabled = false;
  btn.textContent = "Получить консультацию";
  event.target.value = "";
}

function bookFromAi() {
  document.getElementById("problem-input").value = document.getElementById("ai-question").value;
  switchTab(2);
}

async function openGarageModal() {
  const db = getDb();
  document.getElementById("garage-modal").classList.remove("hidden");
  const { data: cars } = await db.from("cars").select("*").eq("client_id", state.clientId);
  const list = document.getElementById("garage-list");
  list.innerHTML = "";
  const safeCars = Array.isArray(cars) ? cars : new Array();

  safeCars.forEach((car) => {
    const active = car.id === state.activeCarId;
    const div = document.createElement("div");
    div.className = `card ${active ? "card-blue" : ""}`;
    div.innerHTML = `
      <div class="row-between">
        <div style="flex:1; cursor:pointer;" class="car-pick-area">
          <b>${car.car_model}</b> ${car.car_plate ? `(${car.car_plate})` : ""}
          <div style="font-size:12px; color:var(--muted);">Пробег: ${car.current_mileage || 0} км</div>
        </div>
        <button class="icon-btn car-transfer-btn" title="Передать авто">📤</button>
      </div>`;
    div.querySelector(".car-pick-area").onclick = () => selectCar(car);
    div.querySelector(".car-transfer-btn").onclick = () => transferCar(car.id, car.car_model);
    list.appendChild(div);
  });
}

function closeGarageModal() { document.getElementById("garage-modal").classList.add("hidden"); }

function selectCar(car) {
  saveSession({ activeCarId: car.id, carModel: car.car_model, carPlate: car.car_plate });
  closeGarageModal();
  loadServiceBook();
}

async function addCarToGarage() {
  const db = getDb();
  const model = document.getElementById("new-car-model").value.trim();
  const plate = document.getElementById("new-car-plate").value.trim();
  if (!model) return;
  const { data: added } = await db.from("cars")
    .insert({ client_id: state.clientId, car_model: model, car_plate: plate, current_mileage: 0 })
    .select().single();
  if (added) {
    document.getElementById("new-car-model").value = "";
    document.getElementById("new-car-plate").value = "";
    selectCar(added);
  }
}

async function transferCar(carId, carModel) {
  const db = getDb();
  const targetPhone = prompt(`Передача авто «${carModel}».\nВведите телефон нового владельца:`);

  if (!targetPhone) return;
  const { data: newOwner } = await db.from("clients").select("*").eq("phone", targetPhone.trim()).maybeSingle();
  if (!newOwner) return alert("Пользователь с таким номером не найден!");
  await db.from("cars").update({ client_id: newOwner.id }).eq("id", carId);
  await db.from("service_records").update({ client_id: newOwner.id }).eq("car_id", carId);
  alert(`Авто передано ${newOwner.name}!`);
  openGarageModal();
}

async function loadServiceBook() {
  const db = getDb();
  if (state.activeCarId) {
    const { data: car } = await db.from("cars").select("current_mileage").eq("id", state.activeCarId).maybeSingle();
    if (car) document.getElementById("mileage-input").value = car.current_mileage || 0;
  }
  const query = state.activeCarId
    ? db.from("service_records").select("*").eq("car_id", state.activeCarId)
    : db.from("service_records").select("*").eq("client_id", state.clientId);

  const { data: records } = await query;
  const list = document.getElementById("records-list");
  list.innerHTML = "";
  const safeRecords = Array.isArray(records) ? records.slice().reverse() : new Array();

  safeRecords.forEach((rec) => {
    const div = document.createElement("div");
    div.className = `card ${rec.is_official ? "card-green" : ""}`;
    div.innerHTML = `
      <div class="row-between">
        <b style="color:${rec.is_official ? "var(--green)" : "inherit"}">${rec.is_official ? "✅ Запись СТО CreativAvto" : "Личная заметка"}</b>
        ${!rec.is_official ? `<button class="icon-btn" style="color:var(--red); font-size:15px;" onclick="deleteRecord('${rec.id}')">🗑️</button>` : "🔒"}
      </div>
      <div style="font-size:12px; color:var(--muted); margin:4px 0;">Дата: ${rec.record_date} | Пробег: ${rec.mileage} км</div>
      <div class="pre-text">${rec.description}</div>`;
    list.appendChild(div);
  });
}

async function exportServiceBookPdf() {
  const db = getDb();
  const query = state.activeCarId
    ? db.from("service_records").select("*").eq("car_id", state.activeCarId)
    : db.from("service_records").select("*").eq("client_id", state.clientId);
  const { data: records } = await query;
  const rows = Array.isArray(records) ? records : new Array();
  const tableRows = rows.length
    ? rows.map((r) => `<tr><td>${r.record_date}</td><td>${r.mileage} км</td><td>${r.is_official ? "СТО CreativAvto" : "Личная запись"}</td><td>${String(r.description || "").replace(/\n/g, "<br>")}</td></tr>`).join("")
    : `<tr><td colspan="4">Записей в сервисной книжке пока нет</td></tr>`;
  const w = window.open("", "_blank");
  if (!w) return alert("Разрешите открытие всплывающего окна для сохранения PDF");
  w.document.write(`<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8"><title>Сервисная книжка — ${state.carModel}</title>
    <style>body{font-family:Arial,sans-serif;padding:24px;color:#111}h1{font-size:20px;margin-bottom:4px}p{color:#444;margin-top:0}table{width:100%;border-collapse:collapse;margin-top:16px}th,td{border:1px solid #ccc;padding:8px;text-align:left;font-size:13px}th{background:#f3f4f6}</style>
    </head><body><h1>Электронная сервисная книжка — CreativAvto Тамбов</h1>
    <p><b>Владелец:</b> ${state.name} (${state.phone}) | <b>Автомобиль:</b> ${state.carModel} ${state.carPlate || ""}</p>
    <table><thead><tr><th>Дата</th><th>Пробег</th><th>Источник</th><th>Выполненные работы</th></tr></thead><tbody>${tableRows}</tbody></table>
    <script>window.onload=function(){window.print();};<\/script></body></html>`);
  w.document.close();
}

async function saveMileage() {
  const db = getDb();
  const m = parseInt(document.getElementById("mileage-input").value || "0", 10);
  if (state.activeCarId) await db.from("cars").update({ current_mileage: m }).eq("id", state.activeCarId);
  await db.from("clients").update({ current_mileage: m }).eq("id", state.clientId);
  alert("Пробег передан мастеру!");
}

async function addPersonalNote() {
  const db = getDb();
  const text = prompt("Что сделали по автомобилю?");
  if (!text) return;
  const mileage = parseInt(document.getElementById("mileage-input").value || "0", 10);
  const today = new Date().toISOString().split("T").at(0);
  await db.from("service_records").insert({
    client_id: state.clientId, car_id: state.activeCarId || null,
    record_date: today, mileage, description: text.trim(), is_official: false
  });
  loadServiceBook();
}

async function deleteRecord(id) {
  const db = getDb();
  await db.from("service_records").delete().eq("id", id);
  loadServiceBook();
}

async function createAppointment() {
  const db = getDb();
  const problem = document.getElementById("problem-input").value.trim();
  if (!problem) return alert("Опишите проблему");
  const { error } = await db.from("appointments").insert({
    client_id: state.clientId, car_id: state.activeCarId || null,
    client_name: state.name, car_model: state.carModel, car_plate: state.carPlate,
    client_phone: state.phone, problem_description: problem, status: "Ожидает ответа мастера"
  });
  if (error) return alert("Ошибка: " + error.message);
  document.getElementById("problem-input").value = "";
  alert("Заявка отправлена мастеру!");
  loadAppointments();
}

function toggleArchive(arch) {
  showArchive = arch;
  document.getElementById("chip-current").classList.toggle("active", !arch);
  document.getElementById("chip-archive").classList.toggle("active", arch);
  loadAppointments();
}

async function loadAppointments() {
  const db = getDb();
  const { data: apps } = await db.from("appointments").select("*").eq("client_id", state.clientId);
  const safeApps = Array.isArray(apps) ? apps.slice().reverse() : new Array();
  const filtered = safeApps.filter((a) => {
    const done = a.status === "Готово" || a.status === "Отменено клиентом";
    return showArchive ? done : !done;
  });

  const list = document.getElementById("appointments-list");
  list.innerHTML = filtered.length ? "" : `<div style="color:var(--muted); padding:12px 0;">Список пуст</div>`;

  filtered.forEach((a) => {
    const cancelled = a.status === "Отменено клиентом";
    const cls = a.status === "Готово" ? "card-green" : cancelled ? "card-red" : "";
    const div = document.createElement("div");
    div.className = `card ${cls}`;
    div.innerHTML = `
      <b>Авто: ${a.car_model}</b>
      <div style="margin:4px 0;">Жалоба: ${a.problem_description}</div>
      ${a.visit_date ? `<div style="color:var(--primary); font-weight:700;">📅 Назначен визит: ${a.visit_date} в ${a.visit_time || ""}</div>` : ""}
      ${a.master_comment ? `<div style="color:var(--green); font-weight:600;">💬 Ответ мастера: ${a.master_comment}</div>` : ""}
      <div style="margin-top:6px; font-weight:700; color:${cancelled ? "var(--red)" : "var(--primary)"}">Статус: ${a.status}</div>
      ${a.status !== "Готово" && !cancelled ? `<button class="btn btn-danger" style="margin-top:8px; padding:8px;" onclick="cancelAppointment('${a.id}')">Отменить заявку</button>` : ""}`;
    list.appendChild(div);
  });
}

async function cancelAppointment(id) {
  const db = getDb();
  await db.from("appointments").update({ status: "Отменено клиентом" }).eq("id", id);
  loadAppointments();
}

function openMap() {
  const addr = document.getElementById("sto-address-link").textContent.replace("📍 ", "");
  const mapUrl = Array.of("https:/", "yandex.ru", "maps", "?text=").join("/") + encodeURIComponent(addr);
  window.open(mapUrl, "_blank");
}

async function loadMessages() {
  const db = getDb();
  const { data: msgs } = await db.from("master_messages").select("*").eq("client_id", state.clientId);
  const safeMsgs = Array.isArray(msgs) ? msgs.slice().reverse() : new Array();
  const list = document.getElementById("messages-list");
  list.innerHTML = safeMsgs.length ? "" : `<div style="color:var(--muted);">Новых уведомлений от мастера Николая пока нет</div>`;
  safeMsgs.forEach((m) => {
    const div = document.createElement("div");
    div.className = "card card-blue";
    div.innerHTML = `<div style="font-size:12px; font-weight:700; color:var(--primary); margin-bottom:4px;">✉️ Мастер Николай</div><div class="pre-text">${m.message_text}</div>`;
    list.appendChild(div);
  });
}

async function openSettings() {
  const db = getDb();
  Array.of(0, 1, 2, 3).forEach((i) => document.getElementById(`tab-${i}`).classList.add("hidden"));
  document.getElementById("bottom-nav").classList.add("hidden");
  document.getElementById("tab-settings").classList.remove("hidden");
  applySubscriptionUi();
  const { data: cl } = await db.from("clients").select("*").eq("id", state.clientId).maybeSingle();
  if (cl) {
    document.getElementById("set-name").value = cl.name;
    document.getElementById("set-car").value = state.carModel;
    document.getElementById("set-plate").value = state.carPlate;
    document.getElementById("set-pass").value = cl.password;
  }
}

function closeSettings() { switchTab(0); }

async function saveProfileSettings() {
  const db = getDb();
  const name = document.getElementById("set-name").value.trim();
  const carModel = document.getElementById("set-car").value.trim();
  const carPlate = document.getElementById("set-plate").value.trim();
  const password = document.getElementById("set-pass").value.trim();
  await db.from("clients").update({ name, car_model: carModel, car_plate: carPlate, password }).eq("id", state.clientId);
  if (state.activeCarId) await db.from("cars").update({ car_model: carModel, car_plate: carPlate }).eq("id", state.activeCarId);
  saveSession({ name, carModel, carPlate });
  alert("Профиль обновлён!");
  closeSettings();
}

function logout() { localStorage.removeItem("creativavto_session"); location.reload(); }

async function initApp() {
  const db = getDb();
  document.getElementById("auth-screen").classList.add("hidden");
  document.getElementById("app-shell").classList.remove("hidden");
  updateHeaderCar();
  refreshSubscriptionStatus();
  const { data: info } = await db.from("service_info").select("*").eq("id", 1).maybeSingle();
  if (info) {
    document.getElementById("sto-address-link").textContent = `📍 ${info.address}`;
    const phoneEl = document.getElementById("sto-phone-link");
    phoneEl.textContent = `📞 Мастер Николай: ${info.phone}`;
    phoneEl.href = `tel:${info.phone}`;
  }
}

if (state && state.clientId) initApp();

function getAppLinks() {
  const androidUrl = Array.of("https:/", "github.com", "nik6837264807", "creativavto", "releases", "download", "v1.0", "app-client-debug.apk").join("/");
  const iphoneUrl = Array.of("https:/", "nik6837264807.github.io", "creativavto", "").join("/");
  return { androidUrl, iphoneUrl };
}

function openShareModal() {
  const { androidUrl, iphoneUrl } = getAppLinks();
  const qrBase = Array.of("https://qrserver.com", "v1", "create-qr-code", "?size=240x240&data=").join("/");
  document.getElementById("qr-android-img").src = qrBase + encodeURIComponent(androidUrl);
  document.getElementById("qr-iphone-img").src = qrBase + encodeURIComponent(iphoneUrl);
  document.getElementById("share-modal").classList.remove("hidden");
}

function closeShareModal() { document.getElementById("share-modal").classList.add("hidden"); }

async function shareBothLinks() {
  const { androidUrl, iphoneUrl } = getAppLinks();
  const text =
    "Установи приложение автосервиса CreativAvto (Тамбов):\n\n" +
    "🤖 Для Android (скачать APK):\n" + androidUrl + "\n\n" +
    "🍎 Для iPhone (открыть в Safari → На экран «Домой»):\n" + iphoneUrl;

  if (navigator.share) {
    try { await navigator.share({ title: "CreativAvto Тамбов", text: text }); } catch (_) {}
  } else if (navigator.clipboard) {
    await navigator.clipboard.writeText(text);
    alert("Обе ссылки скопированы в буфер обмена!");
  } else {
    prompt("Скопируйте ссылки:", text);
  }
}

const VAPID_PUBLIC_KEY = "BMXC3T3ZuXjoqSH-2vTFnl5huR8fIPeXxWvtUQg7cbyMXNWJ75I2068C_NFiSoRC5QvA79SBkyFkHkl5yD_4ds8";

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) outputArray[i] = rawData.charCodeAt(i);
  return outputArray;
}

function syncPushButtonState() {
  const btn = document.getElementById("push-enable-btn");
  if (!btn || !("Notification" in window)) return;
  if (Notification.permission === "granted") btn.textContent = "✅ Уведомления включены";
}

async function enableIosPush() {
  const btn = document.getElementById("push-enable-btn");
  if (!("Notification" in window) || !("serviceWorker" in navigator)) {
    return alert("На iPhone сначала добавьте сайт на экран «Домой» через меню «Поделиться» в Safari, затем откройте иконку с рабочего стола.");
  }
  btn.disabled = true;
  btn.textContent = "Переподключение...";
  try {
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      alert("Разрешение на уведомления отклонено в настройках телефона.");
      btn.disabled = false;
      btn.textContent = "Включить уведомления";
      return;
    }
    const reg = await navigator.serviceWorker.ready;
    await reg.update();
    const oldSub = await reg.pushManager.getSubscription();
    if (oldSub) await oldSub.unsubscribe();

    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY)
    });
    const db = getDb();
    await db.from("clients").update({ push_subscription: sub.toJSON() }).eq("id", state.clientId);
    btn.textContent = "✅ Уведомления включены";
    btn.disabled = false;
    alert("Подписка iPhone обновлена на новый Service Worker!");
  } catch (e) {
    alert("Ошибка подписки: " + e.message);
    btn.disabled = false;
    btn.textContent = "Включить уведомления";
  }
}
