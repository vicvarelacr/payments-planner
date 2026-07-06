/* Payments Planner - single-file app logic.
   Data lives in the phone browser (localStorage). No account, no server.
   Optional read-only sync from a GitHub secret Gist (set in Settings). */

(() => {
  "use strict";

  const STORAGE_KEY = "payments-planner-v1";
  const CURRENCIES = ["USD", "CRC"];
  const CATEGORIES = ["Housing", "Utilities", "Card", "Loan", "Subscription", "Insurance", "Transport", "Other"];

  // ---------- State ----------
  const defaultState = () => ({
    settings: {
      payDay: 30,          // day of month the paycheck lands
      paycheckNet: 0,      // net paycheck in USD
      startingCash: 0,     // optional cash on hand at start of cycle (USD)
      fxRate: 447,         // colones (CRC) per 1 USD - BCR compra rate (you convert USD->CRC); update in Settings
      fxAuto: true,        // auto-refresh the rate once a day when the app opens
      fxUpdated: "",       // YYYY-MM-DD of last auto-refresh
      fxSource: "BCR (manual)",
      buffer: 0,           // minimum USD to keep as cushion
      reminderDaysBefore: 2,
      gistRawUrl: "",      // sync source: private repo API URL or a gist raw URL
      syncToken: ""        // read-only GitHub token (stays on this device); needed for a private repo
    },
    payments: [],
    paid: {}               // { "paymentId": { "YYYY-MM": actualAmount } }
  });

  let state = load();

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return defaultState();
      const parsed = JSON.parse(raw);
      const d = defaultState();
      return {
        settings: Object.assign(d.settings, parsed.settings || {}),
        payments: Array.isArray(parsed.payments) ? parsed.payments : [],
        paid: parsed.paid || {}
      };
    } catch (e) {
      return defaultState();
    }
  }

  function save() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  function uid() {
    return "p_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  // ---------- Date helpers ----------
  function daysInMonth(year, monthIndex) {
    return new Date(year, monthIndex + 1, 0).getDate();
  }
  function clampDay(year, monthIndex, day) {
    return Math.min(day, daysInMonth(year, monthIndex));
  }
  function dateFor(year, monthIndex, day) {
    return new Date(year, monthIndex, clampDay(year, monthIndex, day));
  }
  function monthKey(date) {
    return date.getFullYear() + "-" + String(date.getMonth() + 1).padStart(2, "0");
  }
  function startOfDay(d) {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
  }
  const MS_DAY = 86400000;

  function nextPayday(from) {
    const today = startOfDay(from);
    const thisMonth = dateFor(today.getFullYear(), today.getMonth(), state.settings.payDay);
    if (today < thisMonth) return thisMonth;
    // payday already reached/passed this month -> next month
    return dateFor(today.getFullYear(), today.getMonth() + 1, state.settings.payDay);
  }
  function lastPayday(from) {
    const np = nextPayday(from);
    return dateFor(np.getFullYear(), np.getMonth() - 1, state.settings.payDay);
  }
  function daysUntil(date, from) {
    return Math.round((startOfDay(date) - startOfDay(from)) / MS_DAY);
  }

  // Due date of a payment within a given month window
  function dueDateInMonth(payment, year, monthIndex) {
    return dateFor(year, monthIndex, payment.dueDay);
  }

  // ---------- Money helpers ----------
  function toUSD(amount, currency) {
    if (currency === "USD") return amount;
    const rate = Number(state.settings.fxRate) || 1;
    return amount / rate;
  }
  function fmtMoney(amount, currency) {
    const n = Number(amount) || 0;
    if (currency === "CRC") {
      return "\u20a1" + Math.round(n).toLocaleString("en-US");
    }
    return "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function fmtUSD(n) {
    return "$" + (Number(n) || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  // ---------- Estimate / actual ----------
  function history(payment) {
    return Array.isArray(payment.history) ? payment.history : [];
  }
  function estimateFor(payment) {
    if (payment.type === "fixed") return Number(payment.amount) || 0;
    const h = history(payment).slice(-3);
    if (h.length) {
      const sum = h.reduce((s, x) => s + (Number(x.amount) || 0), 0);
      return sum / h.length;
    }
    return Number(payment.estimate) || 0;
  }
  function paidAmount(payment, mKey) {
    const rec = state.paid[payment.id];
    if (rec && rec[mKey] != null) return Number(rec[mKey]);
    return null;
  }
  function isPaid(payment, mKey) {
    return paidAmount(payment, mKey) != null;
  }
  // Effective amount to plan with (native currency)
  function effectiveAmount(payment, mKey) {
    const p = paidAmount(payment, mKey);
    if (p != null) return p;
    return estimateFor(payment);
  }
  function needsAmount(payment, mKey, from) {
    if (payment.type !== "variable") return false;
    if (isPaid(payment, mKey)) return false;
    // no confirmed history-based estimate yet, and due within 10 days
    const due = dueDateInMonth(payment, from.getFullYear(), from.getMonth());
    const d = daysUntil(due, from);
    return d >= 0 && d <= 10;
  }

  // ---------- Rendering framework ----------
  const viewEl = document.getElementById("view");
  let currentTab = "dashboard";

  function setTab(tab) {
    currentTab = tab;
    document.querySelectorAll(".tab").forEach(b => b.classList.toggle("active", b.dataset.tab === tab));
    render();
  }

  function render() {
    const now = new Date();
    if (currentTab === "dashboard") viewEl.innerHTML = renderDashboard(now);
    else if (currentTab === "payments") viewEl.innerHTML = renderPayments(now);
    else if (currentTab === "optimize") viewEl.innerHTML = renderOptimize(now);
    else if (currentTab === "settings") viewEl.innerHTML = renderSettings();
    bindViewEvents();
    window.scrollTo(0, 0);
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[c]));
  }

  // ---------- Dashboard ----------
  function renderDashboard(now) {
    const mKey = monthKey(now);
    const np = nextPayday(now);
    const daysToPay = daysUntil(np, now);

    if (state.settings.paycheckNet <= 0 && state.payments.length === 0) {
      return `<div class="card"><div class="empty">
        Welcome. Start by adding your paycheck in <b>Settings</b>, then add your monthly payments under <b>Payments</b>.
      </div></div>`;
    }

    // Native totals per currency (no FX). FX is used only for the consolidated line.
    const tot = { USD: { due: 0, paid: 0 }, CRC: { due: 0, paid: 0 } };
    const dueSoon = [];

    state.payments.forEach(p => {
      const amt = effectiveAmount(p, mKey);
      const cur = p.currency === "CRC" ? "CRC" : "USD";
      tot[cur].due += amt;
      if (isPaid(p, mKey)) tot[cur].paid += amt;

      const due = dueDateInMonth(p, now.getFullYear(), now.getMonth());
      const d = daysUntil(due, now);
      if (!isPaid(p, mKey) && d >= -3 && d <= 14) {
        dueSoon.push({ p, due, d });
      }
    });
    dueSoon.sort((a, b) => a.due - b.due);

    const remUSD = tot.USD.due - tot.USD.paid;
    const remCRC = tot.CRC.due - tot.CRC.paid;
    const consolidatedRem = remUSD + toUSD(remCRC, "CRC");
    const pctUSD = tot.USD.due > 0 ? Math.round((tot.USD.paid / tot.USD.due) * 100) : 0;
    const pctCRC = tot.CRC.due > 0 ? Math.round((tot.CRC.paid / tot.CRC.due) * 100) : 0;

    let html = "";

    html += `<div class="card">
      <div class="row">
        <div>
          <div class="sub">Next paycheck</div>
          <div class="big-number">${daysToPay}d</div>
          <div class="sub">${np.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}</div>
        </div>
        <div style="text-align:right">
          <div class="sub">Consolidated left (USD equiv)</div>
          <div class="big-number">${fmtUSD(consolidatedRem)}</div>
          <div class="sub">at \u20a1${state.settings.fxRate}/USD</div>
        </div>
      </div>
    </div>`;

    html += `<div class="grid-2">
      <div class="card">
        <div class="sub">USD payments</div>
        <div class="big-number" style="font-size:22px">${fmtMoney(remUSD, "USD")}</div>
        <div class="sub">left of ${fmtMoney(tot.USD.due, "USD")}</div>
        <div class="pill-progress"><span style="width:${pctUSD}%"></span></div>
      </div>
      <div class="card">
        <div class="sub">CRC payments</div>
        <div class="big-number" style="font-size:22px">${fmtMoney(remCRC, "CRC")}</div>
        <div class="sub">left of ${fmtMoney(tot.CRC.due, "CRC")}</div>
        <div class="pill-progress"><span style="width:${pctCRC}%"></span></div>
      </div>
    </div>`;

    html += `<div class="card"><h2>Due soon</h2>`;
    if (!dueSoon.length) {
      html += `<div class="empty">Nothing due in the next 2 weeks. Nice.</div>`;
    } else {
      html += dueSoon.map(({ p, due, d }) => payRow(p, mKey, now, due, d)).join("");
    }
    html += `</div>`;

    return html;
  }

  function payRow(p, mKey, now, due, d) {
    const amt = effectiveAmount(p, mKey);
    const paid = isPaid(p, mKey);
    const est = p.type === "variable" && !paid;
    const needs = needsAmount(p, mKey, now);
    const dueLabel = due
      ? (d === 0 ? "Today" : d < 0 ? Math.abs(d) + "d overdue" : "in " + d + "d")
      : "";
    return `<div class="pay-item">
      <div class="pay-main">
        <div class="pay-name">
          ${esc(p.name)}
          <span class="badge ${p.country === "CR" ? "cr" : "us"}">${p.country === "CR" ? "CR" : "US"}</span>
          ${p.autopay ? '<span class="badge auto">auto</span>' : ""}
          ${paid ? '<span class="badge paid">paid</span>' : est ? '<span class="badge est">est</span>' : ""}
          ${needs ? '<span class="badge needs">needs amount</span>' : ""}
        </div>
        <div class="pay-meta">${esc(p.category || "")} &middot; day ${p.dueDay} ${dueLabel ? "&middot; " + dueLabel : ""}</div>
      </div>
      <div class="pay-amount">${fmtMoney(amt, p.currency)}</div>
      ${!paid ? `<button class="btn small" data-pay="${p.id}">Pay</button>` : `<button class="btn small secondary" data-unpay="${p.id}">Undo</button>`}
    </div>`;
  }

  // ---------- Payments list ----------
  function renderPayments(now) {
    const mKey = monthKey(now);
    let html = `<div class="btn-inline" style="margin-bottom:14px">
      <button class="btn" id="add-payment">Add payment</button>
    </div>`;

    if (!state.payments.length) {
      html += `<div class="card"><div class="empty">No payments yet. Tap <b>Add payment</b> to start.</div></div>`;
      return html;
    }

    const totUSD = state.payments.filter(p => p.currency !== "CRC").reduce((s, p) => s + effectiveAmount(p, mKey), 0);
    const totCRC = state.payments.filter(p => p.currency === "CRC").reduce((s, p) => s + effectiveAmount(p, mKey), 0);

    html += `<div class="grid-2">
      <div class="card"><div class="sub">USD total</div><div class="big-number" style="font-size:20px">${fmtMoney(totUSD, "USD")}</div></div>
      <div class="card"><div class="sub">CRC total</div><div class="big-number" style="font-size:20px">${fmtMoney(totCRC, "CRC")}</div></div>
    </div>`;

    const renderGroup = (label, cur) => {
      const list = state.payments.filter(p => (cur === "CRC" ? p.currency === "CRC" : p.currency !== "CRC"))
        .sort((a, b) => a.dueDay - b.dueDay);
      if (!list.length) return "";
      let g = `<div class="card"><h2>${label}</h2>`;
      g += list.map(p => {
        const amt = effectiveAmount(p, mKey);
        const paid = isPaid(p, mKey);
        const est = p.type === "variable" && !paid;
        return `<div class="pay-item" data-edit="${p.id}">
          <div class="pay-main">
            <div class="pay-name">${esc(p.name)}
              <span class="badge ${p.country === "CR" ? "cr" : "us"}">${p.country === "CR" ? "CR" : "US"}</span>
              ${p.type === "variable" ? '<span class="badge est">variable</span>' : ""}
              ${paid ? '<span class="badge paid">paid</span>' : ""}
            </div>
            <div class="pay-meta">${esc(p.category || "")} &middot; due day ${p.dueDay} ${est ? "&middot; est" : ""}</div>
          </div>
          <div class="pay-amount">${fmtMoney(amt, p.currency)}</div>
        </div>`;
      }).join("");
      g += `</div>`;
      return g;
    };

    html += renderGroup("USD payments", "USD");
    html += renderGroup("CRC payments", "CRC");
    return html;
  }

  // ---------- Optimize ----------
  function renderOptimize(now) {
    const s = state.settings;
    if (s.paycheckNet <= 0) {
      return `<div class="card"><div class="empty">Add your paycheck amount in <b>Settings</b> to see the cash-flow plan.</div></div>`;
    }
    const start = lastPayday(now);
    const end = nextPayday(now);

    // Payments falling within [start, end)
    const items = [];
    let dueUSD = 0, dueCRC = 0;
    state.payments.forEach(p => {
      // candidate due dates in the two months the window can span
      [dueDateInMonth(p, start.getFullYear(), start.getMonth()),
       dueDateInMonth(p, end.getFullYear(), end.getMonth())].forEach(due => {
        if (due >= start && due < end) {
          const mKey = monthKey(due);
          const amt = effectiveAmount(p, mKey);
          const cur = p.currency === "CRC" ? "CRC" : "USD";
          if (cur === "CRC") dueCRC += amt; else dueUSD += amt;
          items.push({ p, due, mKey, amt, cur, usd: toUSD(amt, p.currency), paid: isPaid(p, mKey) });
        }
      });
    });
    items.sort((a, b) => a.due - b.due);

    let bal = (Number(s.paycheckNet) || 0) + (Number(s.startingCash) || 0);
    const buffer = Number(s.buffer) || 0;
    let minBal = bal;
    const totalDue = items.reduce((sum, it) => sum + it.usd, 0);

    let rows = items.map(it => {
      bal -= it.usd;
      if (bal < minBal) minBal = bal;
      const low = bal < buffer;
      const nativeLine = it.cur === "CRC"
        ? `-${fmtMoney(it.amt, "CRC")} (~${fmtUSD(it.usd)})`
        : `-${fmtMoney(it.amt, "USD")}`;
      return `<div class="timeline-row">
        <div class="tl-date">${it.due.toLocaleDateString("en-US", { month: "short", day: "numeric" })}</div>
        <div class="tl-body">
          <div class="tl-name">${esc(it.p.name)} ${it.paid ? '<span class="badge paid">paid</span>' : ""}</div>
          <div class="pay-meta">${nativeLine}</div>
        </div>
        <div class="tl-bal ${low ? "low" : ""}">${fmtUSD(bal)}</div>
      </div>`;
    }).join("");

    let html = `<div class="card">
      <h2>This cycle (native amounts)</h2>
      <div class="grid-2">
        <div><div class="sub">USD due</div><div class="big-number" style="font-size:20px">${fmtMoney(dueUSD, "USD")}</div></div>
        <div style="text-align:right"><div class="sub">CRC due</div><div class="big-number" style="font-size:20px">${fmtMoney(dueCRC, "CRC")}</div></div>
      </div>
      <hr class="hr"/>
      <div class="row">
        <div><div class="sub">Paycheck + cash</div><div class="big-number" style="font-size:20px">${fmtUSD((Number(s.paycheckNet)||0)+(Number(s.startingCash)||0))}</div></div>
        <div style="text-align:right"><div class="sub">Consolidated due (USD equiv)</div><div class="big-number" style="font-size:20px">${fmtUSD(totalDue)}</div></div>
      </div>
      <hr class="hr"/>
      <div class="row"><div class="sub">Projected lowest balance (USD equiv)</div><div class="tl-bal ${minBal < buffer ? "low" : ""}">${fmtUSD(minBal)}</div></div>
      <div class="sub">${start.toLocaleDateString("en-US",{month:"short",day:"numeric"})} to ${end.toLocaleDateString("en-US",{month:"short",day:"numeric"})} &middot; at \u20a1${s.fxRate}/USD</div>
    </div>`;

    // Tips
    html += `<div class="card"><h2>Suggestions</h2>`;
    html += tips(items, totalDue, minBal, buffer, now).join("");
    html += `</div>`;

    // Timeline
    html += `<div class="card"><h2>Cash-flow timeline (balance in USD equiv)</h2>`;
    html += rows || `<div class="empty">No payments in this cycle.</div>`;
    html += `</div>`;

    return html;
  }

  function tips(items, totalDue, minBal, buffer, now) {
    const s = state.settings;
    const pay = (Number(s.paycheckNet) || 0) + (Number(s.startingCash) || 0);
    const out = [];
    if (totalDue > pay) {
      out.push(`<div class="tip bad">Your bills this cycle (${fmtUSD(totalDue)}) are more than your paycheck (${fmtUSD(pay)}). Move a flexible bill to next cycle, or cover the gap from savings.</div>`);
    } else if (minBal < buffer) {
      out.push(`<div class="tip warn">Balance dips to ${fmtUSD(minBal)}, below your ${fmtUSD(buffer)} cushion. Consider paying non-urgent bills a few days later.</div>`);
    } else {
      out.push(`<div class="tip good">You stay above your cushion all cycle. You can pay fixed and autopay bills right after payday.</div>`);
    }
    const needsList = state.payments.filter(p => needsAmount(p, monthKey(now), now));
    if (needsList.length) {
      out.push(`<div class="tip warn">Confirm real amounts for: ${needsList.map(p => esc(p.name)).join(", ")}. They are due soon and still use an estimate.</div>`);
    }
    const autopay = items.filter(it => it.p.autopay && !it.paid);
    if (autopay.length) {
      out.push(`<div class="tip">${autopay.length} autopay bill(s) will pull automatically. Make sure the balance is there on their dates.</div>`);
    }
    return out;
  }

  // ---------- Settings ----------
  function renderSettings() {
    const s = state.settings;
    return `
    <div class="card">
      <h2>Paycheck</h2>
      <label>Pay day of month (1-28 recommended)</label>
      <input id="set-payday" type="number" min="1" max="31" value="${s.payDay}" />
      <label>Net paycheck (USD)</label>
      <input id="set-paycheck" type="number" min="0" step="0.01" value="${s.paycheckNet}" />
      <label>Cash on hand at start of cycle (USD, optional)</label>
      <input id="set-cash" type="number" min="0" step="0.01" value="${s.startingCash}" />
    </div>

    <div class="card">
      <h2>Rules</h2>
      <label>Exchange rate (colones per 1 USD)</label>
      <input id="set-fx" type="number" min="1" step="0.01" value="${s.fxRate}" />
      <div class="sub" style="margin-top:6px">Source: ${esc(s.fxSource || "manual")}${s.fxUpdated ? " &middot; updated " + esc(s.fxUpdated) : ""}</div>
      <label style="margin-top:12px"><input type="checkbox" id="set-fxauto" ${s.fxAuto ? "checked" : ""} style="width:auto;margin-right:8px" />Auto-refresh rate daily when I open the app</label>
      <button class="btn secondary small" id="fx-now" style="margin-top:8px">Update rate now</button>
      <label style="margin-top:14px">Minimum cash cushion to keep (USD)</label>
      <input id="set-buffer" type="number" min="0" step="0.01" value="${s.buffer}" />
      <label>Reminder days before due date</label>
      <input id="set-remind" type="number" min="0" max="14" value="${s.reminderDaysBefore}" />
      <button class="btn" id="save-settings" style="margin-top:16px">Save settings</button>
    </div>

    <div class="card">
      <h2>Reminders (Apple Calendar)</h2>
      <div class="sub" style="margin-bottom:12px">Creates a calendar file with all payments, recurring monthly, with alerts. Open it once and choose your calendar. Re-export only if you add/remove a payment or change a due date.</div>
      <button class="btn secondary" id="export-ics">Create calendar reminders</button>
    </div>

    <div class="card">
      <h2>Private sync (optional)</h2>
      <div class="sub" style="margin-bottom:12px">Reads updated amounts from your private data source (set up by the weekly automation). The key stays only on this device. Leave blank if you are not using it yet.</div>
      <label>Data URL</label>
      <input id="set-gist" type="url" placeholder="https://api.github.com/repos/USER/payments-data/contents/payments.json" value="${esc(s.gistRawUrl)}" />
      <label>Read-only key (kept on this device)</label>
      <input id="set-token" type="password" placeholder="github_pat_... (only needed for a private repo)" value="${esc(s.syncToken)}" />
      <button class="btn secondary" id="save-gist" style="margin-top:12px">Save sync settings</button>
    </div>

    <div class="card">
      <h2>Backup</h2>
      <div class="sub" style="margin-bottom:12px">Your data lives on this phone. Export a backup now and then, so clearing Safari never loses it.</div>
      <div class="btn-inline">
        <button class="btn secondary" id="export-json">Export backup</button>
        <button class="btn secondary" id="import-json">Import backup</button>
      </div>
      <input id="import-file" type="file" accept="application/json" hidden />
    </div>

    <div class="card">
      <h2>Reset</h2>
      <button class="btn danger" id="reset-all">Erase all data</button>
    </div>
    `;
  }

  // ---------- Modal (add/edit payment, mark paid) ----------
  function openModal(html) {
    const root = document.getElementById("modal-root");
    root.innerHTML = `<div class="modal-backdrop"><div class="modal">${html}</div></div>`;
    root.querySelector(".modal-backdrop").addEventListener("click", e => {
      if (e.target.classList.contains("modal-backdrop")) closeModal();
    });
  }
  function closeModal() {
    document.getElementById("modal-root").innerHTML = "";
  }

  function paymentForm(p) {
    const isNew = !p;
    p = p || { type: "fixed", currency: "USD", country: "US", autopay: false, dueDay: 1, category: "Other" };
    return `
      <h2>${isNew ? "Add payment" : "Edit payment"}</h2>
      <label>Name</label>
      <input id="f-name" value="${esc(p.name || "")}" placeholder="e.g. Rent, Credit card, ICE electricity" />

      <div class="field-inline">
        <div><label>Type</label>
          <select id="f-type">
            <option value="fixed" ${p.type === "fixed" ? "selected" : ""}>Fixed (same each month)</option>
            <option value="variable" ${p.type === "variable" ? "selected" : ""}>Variable (changes)</option>
          </select>
        </div>
        <div><label>Country</label>
          <select id="f-country">
            <option value="US" ${p.country === "US" ? "selected" : ""}>US</option>
            <option value="CR" ${p.country === "CR" ? "selected" : ""}>Costa Rica</option>
          </select>
        </div>
      </div>

      <div class="field-inline">
        <div><label id="lbl-amount">${p.type === "variable" ? "Estimate" : "Amount"}</label>
          <input id="f-amount" type="number" min="0" step="0.01" value="${p.type === "variable" ? (p.estimate ?? "") : (p.amount ?? "")}" />
        </div>
        <div><label>Currency</label>
          <select id="f-currency">
            ${CURRENCIES.map(c => `<option value="${c}" ${p.currency === c ? "selected" : ""}>${c}</option>`).join("")}
          </select>
        </div>
      </div>

      <div class="field-inline">
        <div><label>Due day of month</label>
          <input id="f-dueday" type="number" min="1" max="31" value="${p.dueDay || 1}" />
        </div>
        <div><label>Category</label>
          <select id="f-category">
            ${CATEGORIES.map(c => `<option value="${c}" ${p.category === c ? "selected" : ""}>${c}</option>`).join("")}
          </select>
        </div>
      </div>

      <label><input type="checkbox" id="f-autopay" ${p.autopay ? "checked" : ""} style="width:auto;margin-right:8px" />Autopay (pulls automatically)</label>
      <label>Account / source (optional)</label>
      <input id="f-account" value="${esc(p.account || "")}" placeholder="e.g. Chase checking" />
      <label>Notes (optional)</label>
      <input id="f-notes" value="${esc(p.notes || "")}" />

      <div class="btn-stack" style="margin-top:18px">
        <button class="btn" id="f-save">${isNew ? "Add payment" : "Save changes"}</button>
        ${!isNew ? `<button class="btn danger" id="f-delete">Delete payment</button>` : ""}
        <button class="btn ghost" id="f-cancel">Cancel</button>
      </div>
    `;
  }

  function markPaidForm(p, mKey) {
    const suggested = estimateFor(p);
    return `
      <h2>Mark paid: ${esc(p.name)}</h2>
      <div class="sub" style="margin-bottom:8px">Enter the amount you actually paid this month (${p.currency}). ${p.type === "variable" ? "This is stored and improves next month's estimate." : ""}</div>
      <label>Actual amount (${p.currency})</label>
      <input id="paid-amount" type="number" min="0" step="0.01" value="${suggested ? (Math.round(suggested * 100) / 100) : ""}" />
      <div class="btn-stack" style="margin-top:16px">
        <button class="btn" id="paid-save">Confirm paid</button>
        <button class="btn ghost" id="paid-cancel">Cancel</button>
      </div>
    `;
  }

  // ---------- Event binding ----------
  function bindViewEvents() {
    // Dashboard pay / unpay
    viewEl.querySelectorAll("[data-pay]").forEach(b =>
      b.addEventListener("click", e => { e.stopPropagation(); openMarkPaid(b.dataset.pay); }));
    viewEl.querySelectorAll("[data-unpay]").forEach(b =>
      b.addEventListener("click", e => { e.stopPropagation(); unpay(b.dataset.unpay); }));

    // Payments edit
    viewEl.querySelectorAll("[data-edit]").forEach(row =>
      row.addEventListener("click", () => openEdit(row.dataset.edit)));
    const add = viewEl.querySelector("#add-payment");
    if (add) add.addEventListener("click", () => openAdd());

    // Settings
    bind("#save-settings", saveSettings);
    bind("#fx-now", () => refreshFX(true));
    bind("#export-ics", exportICS);
    bind("#save-gist", saveGist);
    bind("#export-json", exportJSON);
    bind("#import-json", () => viewEl.querySelector("#import-file").click());
    const imp = viewEl.querySelector("#import-file");
    if (imp) imp.addEventListener("change", importJSON);
    bind("#reset-all", resetAll);
  }
  function bind(sel, fn) {
    const el = viewEl.querySelector(sel);
    if (el) el.addEventListener("click", fn);
  }

  function openAdd() {
    openModal(paymentForm(null));
    wirePaymentForm(null);
  }
  function openEdit(id) {
    const p = state.payments.find(x => x.id === id);
    if (!p) return;
    openModal(paymentForm(p));
    wirePaymentForm(p);
  }
  function wirePaymentForm(existing) {
    const root = document.getElementById("modal-root");
    const typeSel = root.querySelector("#f-type");
    const lbl = root.querySelector("#lbl-amount");
    typeSel.addEventListener("change", () => {
      lbl.textContent = typeSel.value === "variable" ? "Estimate" : "Amount";
    });
    root.querySelector("#f-cancel").addEventListener("click", closeModal);
    const del = root.querySelector("#f-delete");
    if (del) del.addEventListener("click", () => {
      if (confirm("Delete this payment?")) {
        state.payments = state.payments.filter(x => x.id !== existing.id);
        delete state.paid[existing.id];
        save(); closeModal(); render(); toast("Payment deleted");
      }
    });
    root.querySelector("#f-save").addEventListener("click", () => {
      const name = root.querySelector("#f-name").value.trim();
      if (!name) { alert("Please enter a name"); return; }
      const type = root.querySelector("#f-type").value;
      const amount = parseFloat(root.querySelector("#f-amount").value) || 0;
      const data = {
        name,
        type,
        country: root.querySelector("#f-country").value,
        currency: root.querySelector("#f-currency").value,
        dueDay: Math.max(1, Math.min(31, parseInt(root.querySelector("#f-dueday").value) || 1)),
        category: root.querySelector("#f-category").value,
        autopay: root.querySelector("#f-autopay").checked,
        account: root.querySelector("#f-account").value.trim(),
        notes: root.querySelector("#f-notes").value.trim()
      };
      if (type === "fixed") data.amount = amount; else data.estimate = amount;

      if (existing) {
        Object.assign(existing, data);
      } else {
        data.id = uid();
        data.history = [];
        state.payments.push(data);
      }
      save(); closeModal(); render(); toast("Saved");
    });
  }

  function openMarkPaid(id) {
    const p = state.payments.find(x => x.id === id);
    if (!p) return;
    const mKey = monthKey(new Date());
    openModal(markPaidForm(p, mKey));
    const root = document.getElementById("modal-root");
    root.querySelector("#paid-cancel").addEventListener("click", closeModal);
    root.querySelector("#paid-save").addEventListener("click", () => {
      const amt = parseFloat(root.querySelector("#paid-amount").value);
      if (isNaN(amt) || amt < 0) { alert("Enter a valid amount"); return; }
      if (!state.paid[p.id]) state.paid[p.id] = {};
      state.paid[p.id][mKey] = amt;
      if (p.type === "variable") {
        if (!Array.isArray(p.history)) p.history = [];
        // replace any existing entry for this month
        p.history = p.history.filter(h => h.month !== mKey);
        p.history.push({ month: mKey, amount: amt });
        if (p.history.length > 12) p.history = p.history.slice(-12);
      }
      save(); closeModal(); render(); toast("Marked paid");
    });
  }

  function unpay(id) {
    const p = state.payments.find(x => x.id === id);
    if (!p) return;
    const mKey = monthKey(new Date());
    if (state.paid[p.id]) delete state.paid[p.id][mKey];
    if (p.type === "variable" && Array.isArray(p.history)) {
      p.history = p.history.filter(h => h.month !== mKey);
    }
    save(); render(); toast("Undone");
  }

  // ---------- Settings actions ----------
  function saveSettings() {
    const g = id => viewEl.querySelector(id);
    state.settings.payDay = Math.max(1, Math.min(31, parseInt(g("#set-payday").value) || 1));
    state.settings.paycheckNet = parseFloat(g("#set-paycheck").value) || 0;
    state.settings.startingCash = parseFloat(g("#set-cash").value) || 0;
    const newFx = parseFloat(g("#set-fx").value) || 1;
    if (newFx !== state.settings.fxRate) {
      state.settings.fxSource = "BCR (manual)";
      state.settings.fxUpdated = todayKey();
    }
    state.settings.fxRate = newFx;
    state.settings.fxAuto = g("#set-fxauto").checked;
    state.settings.buffer = parseFloat(g("#set-buffer").value) || 0;
    state.settings.reminderDaysBefore = Math.max(0, Math.min(14, parseInt(g("#set-remind").value) || 0));
    save(); render(); toast("Settings saved");
  }
  function saveGist() {
    state.settings.gistRawUrl = viewEl.querySelector("#set-gist").value.trim();
    state.settings.syncToken = viewEl.querySelector("#set-token").value.trim();
    save(); toast("Sync settings saved");
  }

  function resetAll() {
    if (confirm("Erase ALL payments and settings on this device? This cannot be undone.")) {
      state = defaultState();
      save(); render(); toast("All data erased");
    }
  }

  // ---------- Backup ----------
  function download(filename, text, type) {
    const blob = new Blob([text], { type: type || "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function exportJSON() {
    download("payments-backup-" + monthKey(new Date()) + ".json", JSON.stringify(state, null, 2), "application/json");
    toast("Backup downloaded");
  }
  function importJSON(e) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        if (!data.settings || !Array.isArray(data.payments)) throw new Error("bad");
        state = {
          settings: Object.assign(defaultState().settings, data.settings),
          payments: data.payments,
          paid: data.paid || {}
        };
        save(); render(); toast("Backup restored");
      } catch (err) {
        alert("That file could not be read as a backup.");
      }
    };
    reader.readAsText(file);
  }

  // ---------- Calendar export (.ics) ----------
  function pad(n) { return String(n).padStart(2, "0"); }
  function icsDate(d) {
    return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate());
  }
  function exportICS() {
    if (!state.payments.length) { alert("Add some payments first."); return; }
    const now = new Date();
    const before = state.settings.reminderDaysBefore || 0;
    let lines = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Payments Planner//EN",
      "CALSCALE:GREGORIAN",
      "METHOD:PUBLISH"
    ];
    state.payments.forEach(p => {
      // first occurrence: this month if not passed, else next month
      let due = dueDateInMonth(p, now.getFullYear(), now.getMonth());
      if (daysUntil(due, now) < 0) due = dueDateInMonth(p, now.getFullYear(), now.getMonth() + 1);
      const uidStr = p.id + "@payments-planner";
      const stamp = icsDate(now) + "T090000";
      lines.push("BEGIN:VEVENT");
      lines.push("UID:" + uidStr);
      lines.push("DTSTAMP:" + stamp);
      lines.push("DTSTART;VALUE=DATE:" + icsDate(due));
      lines.push("RRULE:FREQ=MONTHLY;BYMONTHDAY=" + p.dueDay);
      lines.push("SUMMARY:Pay: " + icsEsc(p.name) + " (check app for amount)");
      lines.push("DESCRIPTION:" + icsEsc((p.category || "") + " payment. Open Payments Planner for the current amount."));
      // alert on due day
      lines.push("BEGIN:VALARM");
      lines.push("TRIGGER:PT0S");
      lines.push("ACTION:DISPLAY");
      lines.push("DESCRIPTION:Payment due today: " + icsEsc(p.name));
      lines.push("END:VALARM");
      if (before > 0) {
        lines.push("BEGIN:VALARM");
        lines.push("TRIGGER:-P" + before + "D");
        lines.push("ACTION:DISPLAY");
        lines.push("DESCRIPTION:Payment coming up: " + icsEsc(p.name));
        lines.push("END:VALARM");
      }
      lines.push("END:VEVENT");
    });
    lines.push("END:VCALENDAR");
    download("payments-reminders.ics", lines.join("\r\n"), "text/calendar");
    toast("Calendar file created");
  }
  function icsEsc(s) {
    return String(s || "").replace(/([,;\\])/g, "\\$1").replace(/\n/g, "\\n");
  }

  // ---------- Cloud sync (read-only from Gist) ----------
  async function syncFromCloud() {
    const url = state.settings.gistRawUrl;
    if (!url) { toast("Add a sync link in Settings first"); setTab("settings"); return; }
    toast("Syncing...");
    try {
      const headers = {};
      const token = (state.settings.syncToken || "").trim();
      const isApi = url.indexOf("api.github.com") !== -1;
      if (token) headers["Authorization"] = "Bearer " + token;
      if (isApi) headers["Accept"] = "application/vnd.github.raw+json";
      // cache-bust so we always get the latest
      const res = await fetch(url + (url.includes("?") ? "&" : "?") + "t=" + Date.now(), { cache: "no-store", headers });
      if (!res.ok) throw new Error("http " + res.status);
      const data = await res.json();
      const items = Array.isArray(data.items) ? data.items : [];
      let updated = 0;
      const mKey = monthKey(new Date());
      // exact BCR rate written by the weekly automation
      if (data.fx && Number(data.fx.rate)) {
        state.settings.fxRate = Math.round(Number(data.fx.rate) * 100) / 100;
        state.settings.fxSource = "BCR ventanilla";
        state.settings.fxUpdated = todayKey();
        updated++;
      }
      items.forEach(it => {
        const match = state.payments.find(p =>
          (it.key && p.id === it.key) ||
          (it.name && p.name.toLowerCase() === String(it.name).toLowerCase()));
        if (!match) return;
        const amount = Number(it.amount);
        if (isNaN(amount)) return;
        // treat detected amount as an updated estimate (not auto-paid)
        if (match.type === "variable") {
          match.estimate = amount;
        } else {
          match.amount = amount;
        }
        match.notes = (match.notes ? match.notes + " " : "") + "[from email " + mKey + "]";
        updated++;
      });
      if (updated) { save(); render(); }
      toast(updated ? ("Synced " + updated + " amount(s)") : "Nothing new to sync");
    } catch (err) {
      alert("Sync failed. Check the Gist link in Settings.\n\n" + err.message);
    }
  }

  // ---------- FX daily auto-refresh ----------
  function todayKey() {
    const d = new Date();
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  }
  // Free, no-key, CORS-friendly reference rate. Used only as a daily approximation
  // between the weekly automation's exact BCR pull.
  async function refreshFX(manualTrigger) {
    try {
      const res = await fetch("https://open.er-api.com/v6/latest/USD", { cache: "no-store" });
      if (!res.ok) throw new Error("http " + res.status);
      const data = await res.json();
      const crc = data && data.rates && Number(data.rates.CRC);
      if (!crc || isNaN(crc)) throw new Error("no CRC rate");
      state.settings.fxRate = Math.round(crc * 100) / 100;
      state.settings.fxUpdated = todayKey();
      state.settings.fxSource = "reference (auto)";
      save();
      if (manualTrigger) { render(); toast("Rate updated: \u20a1" + state.settings.fxRate); }
      else if (currentTab === "settings" || currentTab === "dashboard" || currentTab === "optimize") render();
      return true;
    } catch (err) {
      if (manualTrigger) alert("Could not refresh the rate right now. Your saved rate is unchanged.\n\n" + err.message);
      return false;
    }
  }
  function maybeAutoRefreshFX() {
    if (!state.settings.fxAuto) return;
    if (state.settings.fxUpdated === todayKey()) return;
    refreshFX(false);
  }

  // ---------- Toast ----------
  let toastTimer;
  function toast(msg) {
    const el = document.getElementById("toast");
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 2200);
  }

  // ---------- Boot ----------
  document.querySelectorAll(".tab").forEach(b =>
    b.addEventListener("click", () => setTab(b.dataset.tab)));
  document.getElementById("sync-btn").addEventListener("click", syncFromCloud);

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }

  setTab("dashboard");
  maybeAutoRefreshFX();
})();
