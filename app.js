// Глобальные переменные и состояние
var isLoginMode = false;
var showArchive = false;
var selectedPlanId = "plan_6m";
var cachedPlans = [];
var state = JSON.parse(localStorage.getItem("creativavto_session") || "null");

// Ссылки на функции в Yandex Cloud
const YK_PAYMENT_URL = "https://functions.yandexcloud.net/d4e3keqoljd1erdnfb8v"; // Оплата
const YK_AI_URL = "https://d5d2rio2emd29vahujfh.6brbn2wz.apigw.yandexcloud.net/ask"; // ИИ через API Gateway

// Инициализация Service Worker
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js").catch(() => {});
}

// Проверка на iOS для баннера установки
var isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
var isStandalone = window.navigator.standalone === true || window.matchMedia("(display-mode: standalone)").matches;
if (isIos && !isStandalone) {
  document.getElementById("ios-install-hint")?.classList.remove("hidden");
}

// ==========================================
// 1. ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ И АВТОРИЗАЦИЯ
// ==========================================

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

// Убеждаемся, что пользователь анонимно авторизован в Firebase
async function ensureAuth() {
  return new Promise((resolve) => {
    window._fb.onAuthStateChanged(window._fb.auth, async (user) => {
      if (user) resolve(user);
      else {
        try { 
          const cred = await window._fb.signInAnonymously(window._fb.auth); 
          resolve(cred.user);
        } catch (e) { 
          console.error("Auth error", e); 
          alert("Ошибка авторизации: " + e.message);
        }
      }
    });
  });
}

async function handleAuth() {
  const phone = document.getElementById("auth-phone").value.trim();
  const password = document.getElementById("auth-pass").value.trim();
  const btn = document.getElementById("auth-submit-btn");
  btn.disabled = true;

  try {
    const user = await ensureAuth();
    const db = window._fb.db;

    if (isLoginMode) {
      // Вход
      const q = window._fb.query(
        window._fb.collection(db, "clients"), 
        window._fb.where("phone", "==", phone), 
        window._fb.where("password", "==", password)
      );
      const snap = await window._fb.getDocs(q);
      
      if (snap.empty) {
        alert("Неверный телефон или кодовое слово");
        btn.disabled = false;
        return;
      }
      
      const foundDoc = snap.docs[0];
      const found = foundDoc.data();
      const foundId = foundDoc.id;

      const carsQ = window._fb.query(window._fb.collection(db, "cars"), window._fb.where("client_id", "==", foundId));
      const carsSnap = await window._fb.getDocs(carsQ);
      const cars = carsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
      const firstCar = cars.length > 0 ? cars[0] : null;

      saveSession({
        clientId: foundId, name: found.name, phone: found.phone,
        activeCarId: firstCar ? firstCar.id : "",
        carModel: firstCar ? firstCar.car_model : found.car_model,
        carPlate: firstCar ? firstCar.car_plate : found.car_plate,
        subscriptionUntil: found.subscription_until || null
      });
      initApp();

    } else {
      // Регистрация
      const name = document.getElementById("auth-name").value.trim();
      const carModel = document.getElementById("auth-car").value.trim();
      const carPlate = document.getElementById("auth-plate").value.trim();
      
      if (!name || !carModel || !phone || !password) {
        alert("Заполните обязательные поля");
        btn.disabled = false;
        return;
      }

      const uid = user.uid;
      
      await window._fb.setDoc(window._fb.doc(db, "clients", uid), {
        name, car_model: carModel, car_plate: carPlate, phone, password, 
        current_mileage: 0, subscription_plan: "free", trial_granted_days: 0
      });

      const carRef = await window._fb.addDoc(window._fb.collection(db, "cars"), {
        client_id: uid, car_model: carModel, car_plate: carPlate, current_mileage: 0
      });

      saveSession({
        clientId: uid, name: name, phone: phone,
        activeCarId: carRef.id, carModel, carPlate,
        subscriptionUntil: null
      });
      initApp();
    }
  } catch (e) {
    alert("Ошибка сети: " + e.message);
  }
  btn.disabled = false;
}

// ==========================================
// 2. НАВИГАЦИЯ И ПОДПИСКА
// ==========================================

function switchTab(idx) {
  const tabs = [0, 1, 2, 3];
  const navItems = document.querySelectorAll(".nav-item");
  tabs.forEach((i) => {
    const el = document.getElementById(`tab-${i}`);
    if (el) el.classList.toggle("hidden", i !== idx);
    if (navItems[i]) navItems[i].classList.toggle("active", i === idx);
  });
  document.getElementById("tab-settings")?.classList.add("hidden");
  document.getElementById("bottom-nav")?.classList.remove("hidden");

  if (idx === 0) refreshSubscriptionStatus();
  if (idx === 1) loadServiceBook();
  if (idx === 2) loadAppointments();
  if (idx === 3) { loadMessages(); syncPushButtonState(); }
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
  try {
    const docSnap = await window._fb.getDoc(window._fb.doc(window._fb.db, "clients", state.clientId));
    if (docSnap.exists()) {
      saveSession({ subscriptionUntil: docSnap.data().subscription_until || null });
    }
  } catch (e) { console.error(e); }
  applySubscriptionUi();
}

async function loadSubscriptionPlans() {
  try {
    const q = window._fb.query(window._fb.collection(window._fb.db, "subscription_plans"), window._fb.where("is_active", "==", true));
    const snap = await window._fb.getDocs(q);
    let plans = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    
    if (plans.length === 0) {
      plans = [
        { id: "plan_3m", title: "Пакет 3 месяца", months: 3, price_rub: 285, badge: "Базовый", is_active: true, sort_order: 1 },
        { id: "plan_6m", title: "Пакет 6 месяцев", months: 6, price_rub: 540, badge: "Выгодно", is_active: true, sort_order: 2 },
        { id: "plan_12m", title: "Пакет 12 месяцев", months: 12, price_rub: 900, badge: "Максимум", is_active: true, sort_order: 3 }
      ];
    }

    cachedPlans = plans.sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
    if (cachedPlans.length > 0 && !cachedPlans.some((p) => p.id === selectedPlanId)) {
      selectedPlanId = cachedPlans[0].id;
    }
    renderPlansList();
  } catch (e) { console.error("Ошибка загрузки тарифов", e); }
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
    return alert("Поставьте галочку согласия с условиями оферты.");
  }
  if (!state || !state.clientId) {
    return alert("Ошибка сессии. Пожалуйста, войдите заново.");
  }
  const btn = document.getElementById("pay-sub-btn");
  btn.disabled = true;
  btn.textContent = "Переход к оплате...";
  try {
    const r = await fetch(YK_PAYMENT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: state.clientId, plan_id: selectedPlanId, return_url: "https://nik6837264807.github.io/creativavto/" })
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || "Ошибка оплаты");
    if (data.confirmation_url) {
      window.location.href = data.confirmation_url;
      return;
    }
    throw new Error("Не получена ссылка на оплату");
  } catch (e) {
    alert("Ошибка: " + e.message);
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

// ==========================================
// 3. ИИ-АВТОМЕХАНИК
// ==========================================

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
  if (!state || !state.clientId) return alert("Ошибка сессии. Войдите заново.");
  
  const prompt = document.getElementById("ai-question").value.trim();
  if (!prompt) return;
  
  const btn = document.getElementById("ai-ask-btn");
  btn.disabled = true;
  btn.textContent = "Механик анализирует...";

  try {
    const r = await fetch(YK_AI_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "text", prompt, carModel: state.carModel })
    });
    
    const textResponse = await r.text();
    let data;
    try {
      data = JSON.parse(textResponse);
    } catch (parseError) {
      throw new Error("Сервер вернул некорректный ответ. Попробуйте позже.");
    }

    if (!r.ok) throw new Error(data.error || "Ошибка ИИ на сервере");
    if (!data.reply) throw new Error("Сервер не прислал ответ");

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
  if (!state || !state.clientId) {
    event.target.value = "";
    return alert("Ошибка сессии. Войдите заново.");
  }

  const file = event.target.files?.[0];
  if (!file) return;
  openAiChat();
  document.getElementById("ai-question").value = `Фото приборной панели (${state.carModel}): расшифровка горящих значков`;
  const btn = document.getElementById("ai-ask-btn");
  btn.disabled = true;
  btn.textContent = "Распознаю значки по фото...";

  try {
    const imageBase64 = await resizeImageToBase64(file, 1024);
    const r = await fetch(YK_AI_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "dashboard_vision", imageBase64, carModel: state.carModel })
    });
    
    const textResponse = await r.text();
    let data;
    try {
      data = JSON.parse(textResponse);
    } catch (parseError) {
      throw new Error("Сервер вернул некорректный ответ. Попробуйте позже.");
    }

    if (!r.ok) throw new Error(data.error || "Ошибка распознавания");
    if (!data.reply) throw new Error("Сервер не прислал ответ");

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

// ==========================================
// 4. ГАРАЖ И МАШИНЫ
// ==========================================

async function openGarageModal() {
  if (!state || !state.clientId) return alert("Ошибка сессии. Войдите заново.");
  document.getElementById("garage-modal").classList.remove("hidden");
  try {
    const q = window._fb.query(window._fb.collection(window._fb.db, "cars"), window._fb.where("client_id", "==", state.clientId));
    const snap = await window._fb.getDocs(q);
    const cars = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    
    const list = document.getElementById("garage-list");
    list.innerHTML = "";

    cars.forEach((car) => {
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
  } catch (e) { console.error(e); }
}

function closeGarageModal() { document.getElementById("garage-modal").classList.add("hidden"); }

function selectCar(car) {
  saveSession({ activeCarId: car.id, carModel: car.car_model, carPlate: car.car_plate });
  closeGarageModal();
  loadServiceBook();
}

async function addCarToGarage() {
  if (!state || !state.clientId) return alert("Ошибка сессии. Войдите заново.");
  const model = document.getElementById("new-car-model").value.trim();
  const plate = document.getElementById("new-car-plate").value.trim();
  if (!model) return;
  
  try {
    const carRef = await window._fb.addDoc(window._fb.collection(window._fb.db, "cars"), {
      client_id: state.clientId, car_model: model, car_plate: plate, current_mileage: 0
    });
    document.getElementById("new-car-model").value = "";
    document.getElementById("new-car-plate").value = "";
    selectCar({ id: carRef.id, car_model: model, car_plate: plate });
  } catch (e) { alert("Ошибка добавления авто: " + e.message); }
}

async function transferCar(carId, carModel) {
  if (!state || !state.clientId) return alert("Ошибка сессии. Войдите заново.");
  const targetPhone = prompt(`Передача авто «${carModel}».\nВведите телефон нового владельца:`);
  if (!targetPhone) return;
  
  try {
    const q = window._fb.query(window._fb.collection(window._fb.db, "clients"), window._fb.where("phone", "==", targetPhone.trim()));
    const snap = await window._fb.getDocs(q);
    if (snap.empty) return alert("Пользователь с таким номером не найден!");
    
    const newOwnerId = snap.docs[0].id;
    await window._fb.updateDoc(window._fb.doc(window._fb.db, "cars", carId), { client_id: newOwnerId });
    
    const recQ = window._fb.query(window._fb.collection(window._fb.db, "service_records"), window._fb.where("car_id", "==", carId));
    const recSnap = await window._fb.getDocs(recQ);
    for (const doc of recSnap.docs) {
      await window._fb.updateDoc(doc.ref, { client_id: newOwnerId });
    }
    alert(`Авто передано ${snap.docs[0].data().name}!`);
    openGarageModal();
  } catch (e) { alert("Ошибка передачи: " + e.message); }
}

// ==========================================
// 5. СЕРВИСНАЯ КНИЖКА (ЖУРНАЛ ТО)
// ==========================================

async function loadServiceBook() {
  if (!state || !state.clientId) return;
  const list = document.getElementById("records-list");
  list.innerHTML = "<div style='color:gray;'>Загрузка...</div>";
  
  try {
    let q;
    if (state.activeCarId) {
      const carSnap = await window._fb.getDoc(window._fb.doc(window._fb.db, "cars", state.activeCarId));
      if (carSnap.exists()) document.getElementById("mileage-input").value = carSnap.data().current_mileage || 0;
      
      q = window._fb.query(window._fb.collection(window._fb.db, "service_records"), window._fb.where("car_id", "==", state.activeCarId));
    } else {
      q = window._fb.query(window._fb.collection(window._fb.db, "service_records"), window._fb.where("client_id", "==", state.clientId));
    }

    const snap = await window._fb.getDocs(q);
    const records = snap.docs.map(d => ({ id: d.id, ...d.data() })).reverse();

    list.innerHTML = "";
    records.forEach((rec) => {
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
  } catch (e) {
    list.innerHTML = `<div style="color:red;">Ошибка загрузки: ${e.message}</div>`;
  }
}

async function exportServiceBookPdf() {
  if (!state || !state.clientId) return alert("Ошибка сессии. Войдите заново.");
  try {
    let q;
    if (state.activeCarId) {
      q = window._fb.query(window._fb.collection(window._fb.db, "service_records"), window._fb.where("car_id", "==", state.activeCarId));
    } else {
      q = window._fb.query(window._fb.collection(window._fb.db, "service_records"), window._fb.where("client_id", "==", state.clientId));
    }
    const snap = await window._fb.getDocs(q);
    const records = snap.docs.map(d => d.data());
    
    const tableRows = records.length
      ? records.map((r) => `<tr><td>${r.record_date}</td><td>${r.mileage} км</td><td>${r.is_official ? "СТО CreativAvto" : "Личная запись"}</td><td>${String(r.description || "").replace(/\n/g, "<br>")}</td></tr>`).join("")
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
  } catch (e) { alert("Ошибка экспорта: " + e.message); }
}

async function saveMileage() {
  if (!state || !state.clientId) return alert("Ошибка сессии. Войдите заново.");
  const m = parseInt(document.getElementById("mileage-input").value || "0", 10);
  try {
    if (state.activeCarId) await window._fb.updateDoc(window._fb.doc(window._fb.db, "cars", state.activeCarId), { current_mileage: m });
    await window._fb.updateDoc(window._fb.doc(window._fb.db, "clients", state.clientId), { current_mileage: m });
    alert("Пробег передан мастеру!");
  } catch (e) { alert("Ошибка сохранения пробега: " + e.message); }
}

async function addPersonalNote() {
  if (!state || !state.clientId) return alert("Ошибка сессии. Войдите заново.");
  const text = prompt("Что сделали по автомобилю?");
  if (!text) return;
  const mileage = parseInt(document.getElementById("mileage-input").value || "0", 10);
  const today = new Date().toISOString().split("T").at(0);
  
  try {
    await window._fb.addDoc(window._fb.collection(window._fb.db, "service_records"), {
      client_id: state.clientId, car_id: state.activeCarId || null,
      record_date: today, mileage, description: text.trim(), is_official: false
    });
    loadServiceBook();
  } catch (e) { alert("Ошибка добавления записи: " + e.message); }
}

async function deleteRecord(id) {
  try {
    await window._fb.deleteDoc(window._fb.doc(window._fb.db, "service_records", id));
    loadServiceBook();
  } catch (e) { alert("Ошибка удаления: " + e.message); }
}

// ==========================================
// 6. ЗАЯВКИ И СТО
// ==========================================

async function createAppointment() {
  if (!state || !state.clientId) return alert("Ошибка сессии. Войдите заново.");
  const problem = document.getElementById("problem-input").value.trim();
  if (!problem) return alert("Опишите проблему");
  
  try {
    await window._fb.addDoc(window._fb.collection(window._fb.db, "appointments"), {
      client_id: state.clientId, car_id: state.activeCarId || null,
      client_name: state.name, car_model: state.carModel, car_plate: state.carPlate,
      client_phone: state.phone, problem_description: problem, status: "Ожидает ответа мастера"
    });
    document.getElementById("problem-input").value = "";
    alert("Заявка отправлена мастеру!");
    loadAppointments();
  } catch (e) { alert("Ошибка отправки заявки: " + e.message); }
}

function toggleArchive(arch) {
  showArchive = arch;
  document.getElementById("chip-current").classList.toggle("active", !arch);
  document.getElementById("chip-archive").classList.toggle("active", arch);
  loadAppointments();
}

async function loadAppointments() {
  if (!state || !state.clientId) return;
  const list = document.getElementById("appointments-list");
  list.innerHTML = "<div style='color:gray;'>Загрузка...</div>";
  
  try {
    const q = window._fb.query(window._fb.collection(window._fb.db, "appointments"), window._fb.where("client_id", "==", state.clientId));
    const snap = await window._fb.getDocs(q);
    const apps = snap.docs.map(d => ({ id: d.id, ...d.data() })).reverse();
    
    const filtered = apps.filter((a) => {
      const done = a.status === "Готово" || a.status === "Отменено клиентом";
      return showArchive ? done : !done;
    });

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
  } catch (e) {
    list.innerHTML = `<div style="color:red;">Ошибка загрузки: ${e.message}</div>`;
  }
}

async function cancelAppointment(id) {
  try {
    await window._fb.updateDoc(window._fb.doc(window._fb.db, "appointments", id), { status: "Отменено клиентом" });
    loadAppointments();
  } catch (e) { alert("Ошибка отмены: " + e.message); }
}

function openMap() {
  const addr = document.getElementById("sto-address-link").textContent.replace("📍 ", "");
  const mapUrl = "https://yandex.ru/maps/?text=" + encodeURIComponent(addr);
  window.open(mapUrl, "_blank");
}

// ==========================================
// 7. УВЕДОМЛЕНИЯ
// ==========================================

async function loadMessages() {
  if (!state || !state.clientId) return;
  const list = document.getElementById("messages-list");
  list.innerHTML = "<div style='color:gray;'>Загрузка...</div>";
  
  try {
    const q = window._fb.query(window._fb.collection(window._fb.db, "master_messages"), window._fb.where("client_id", "==", state.clientId));
    const snap = await window._fb.getDocs(q);
    const msgs = snap.docs.map(d => ({ id: d.id, ...d.data() })).reverse();

    list.innerHTML = msgs.length ? "" : `<div style="color:var(--muted);">Новых уведомлений от мастера Николая пока нет</div>`;
    
    msgs.forEach((m) => {
      const div = document.createElement("div");
      div.className = "card card-blue";
      div.innerHTML = `<div style="font-size:12px; font-weight:700; color:var(--primary); margin-bottom:4px;">✉️ Мастер Николай</div><div class="pre-text">${m.message_text}</div>`;
      list.appendChild(div);
    });
  } catch (e) {
    list.innerHTML = `<div style="color:red;">Ошибка загрузки: ${e.message}</div>`;
  }
}

// ==========================================
// 8. НАСТРОЙКИ И ПРОФИЛЬ
// ==========================================

async function openSettings() {
  if (!state || !state.clientId) return alert("Ошибка сессии. Войдите заново.");
  Array.of(0, 1, 2, 3).forEach((i) => document.getElementById(`tab-${i}`).classList.add("hidden"));
  document.getElementById("bottom-nav").classList.add("hidden");
  document.getElementById("tab-settings").classList.remove("hidden");
  applySubscriptionUi();
  
  try {
    const docSnap = await window._fb.getDoc(window._fb.doc(window._fb.db, "clients", state.clientId));
    if (docSnap.exists()) {
      const cl = docSnap.data();
      document.getElementById("set-name").value = cl.name || "";
      document.getElementById("set-car").value = state.carModel || "";
      document.getElementById("set-plate").value = state.carPlate || "";
      document.getElementById("set-pass").value = cl.password || "";
    }
  } catch (e) { console.error(e); }
}

function closeSettings() { switchTab(0); }

async function saveProfileSettings() {
  if (!state || !state.clientId) return alert("Ошибка сессии. Войдите заново.");
  const name = document.getElementById("set-name").value.trim();
  const carModel = document.getElementById("set-car").value.trim();
  const carPlate = document.getElementById("set-plate").value.trim();
  const password = document.getElementById("set-pass").value.trim();
  
  try {
    await window._fb.updateDoc(window._fb.doc(window._fb.db, "clients", state.clientId), { name, car_model: carModel, car_plate: carPlate, password });
    if (state.activeCarId) {
      await window._fb.updateDoc(window._fb.doc(window._fb.db, "cars", state.activeCarId), { car_model: carModel, car_plate: carPlate });
    }
    saveSession({ name, carModel, carPlate });
    alert("Профиль обновлён!");
    closeSettings();
  } catch (e) { alert("Ошибка сохранения профиля: " + e.message); }
}

function logout() { localStorage.removeItem("creativavto_session"); location.reload(); }

// ==========================================
// 9. ИНИЦИАЛИЗАЦИЯ ПРИЛОЖЕНИЯ
// ==========================================

async function initApp() {
  document.getElementById("auth-screen").classList.add("hidden");
  document.getElementById("app-shell").classList.remove("hidden");
  updateHeaderCar();
  refreshSubscriptionStatus();
  
  try {
    const docSnap = await window._fb.getDoc(window._fb.doc(window._fb.db, "service_info", "1"));
    if (docSnap.exists()) {
      const info = docSnap.data();
      document.getElementById("sto-address-link").textContent = `📍 ${info.address}`;
      const phoneEl = document.getElementById("sto-phone-link");
      phoneEl.textContent = `📞 Мастер Николай: ${info.phone}`;
      phoneEl.href = `tel:${info.phone}`;
    }
  } catch (e) { console.error("Ошибка загрузки контактов СТО", e); }
}

if (state && state.clientId) initApp();

function getAppLinks() {
  const androidUrl = "https://github.com/nik6837264807/creativavto/releases/download/v1.0/app-client-debug.apk";
  const iphoneUrl = "https://nik6837264807.github.io/creativavto/";
  return { androidUrl, iphoneUrl };
}

function openShareModal() {
  const { androidUrl, iphoneUrl } = getAppLinks();
  const qrBase = "https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=";
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

// ==========================================
// 10. PUSH-УВЕДОМЛЕНИЯ
// ==========================================

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
  if (!state || !state.clientId) return alert("Ошибка сессии. Войдите заново.");
  const btn = document.getElementById("push-enable-btn");
  if (!("Notification" in window) || !("serviceWorker" in navigator)) {
    return alert("На iPhone сначала добавьте сайт на экран «Домой», затем откройте иконку с рабочего стола.");
  }
  btn.disabled = true;
  btn.textContent = "Переподключение...";
  
  try {
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      alert("Разрешение на уведомления отклонено.");
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
    
    await window._fb.updateDoc(window._fb.doc(window._fb.db, "clients", state.clientId), { 
      push_subscription: sub.toJSON() 
    });
    
    btn.textContent = "✅ Уведомления включены";
    btn.disabled = false;
    alert("Подписка на уведомления обновлена!");
  } catch (e) {
    alert("Ошибка подписки: " + e.message);
    btn.disabled = false;
    btn.textContent = "Включить уведомления";
  }
}
