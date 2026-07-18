/* ============================================================
   STEEL LOG — frontend logic (vanilla, no build)
   Server is the source of truth. localStorage only remembers
   the last-selected program/day for convenience.
   ============================================================ */

"use strict";

const API = (path) => `${window.API_BASE || ""}${path}`;
const LS_KEY = "steellog.selection";

/* ------------------------------------------------------------------ */
/* Tiny DOM helpers                                                    */
/* ------------------------------------------------------------------ */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function el(tag, attrs = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "html") node.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") {
      node.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (k === "dataset") {
      Object.assign(node.dataset, v);
    } else {
      node.setAttribute(k, v);
    }
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    node.append(kid.nodeType ? kid : document.createTextNode(kid));
  }
  return node;
}

const escapeHtml = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));

/* ------------------------------------------------------------------ */
/* API layer — with cold-start "waking up" handling + retry            */
/* ------------------------------------------------------------------ */
const wakeBanner = $("#wakeBanner");
let wakeCount = 0;

function setWaking(on) {
  wakeCount = Math.max(0, wakeCount + (on ? 1 : -1));
  wakeBanner.hidden = wakeCount === 0;
}

function timeoutSignal(ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return { signal: ctrl.signal, clear: () => clearTimeout(t) };
}

/**
 * fetch JSON with resilience against a sleeping free host.
 * Retries with backoff for network errors / 5xx, surfacing the
 * "waking up the server…" banner after the first slow attempt.
 */
async function apiJSON(path, { method = "GET", body, retries = 5 } = {}) {
  let attempt = 0;
  let showedWake = false;
  const delays = [1500, 3000, 5000, 8000, 12000];

  while (true) {
    const { signal, clear } = timeoutSignal(35000);
    try {
      const res = await fetch(API(path), {
        method,
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal,
      });
      clear();

      if (res.status >= 500 && attempt < retries) throw new Error("server " + res.status);

      if (!res.ok) {
        let detail = res.statusText;
        try {
          const j = await res.json();
          if (j && j.detail) detail = j.detail;
        } catch (_) {}
        const err = new Error(detail || `HTTP ${res.status}`);
        err.status = res.status;
        throw err;
      }

      if (showedWake) setWaking(false);
      if (res.status === 204) return null;
      return await res.json();
    } catch (err) {
      clear();
      // A definitive HTTP error (4xx) should propagate, not retry.
      if (err.status && err.status < 500) {
        if (showedWake) setWaking(false);
        throw err;
      }
      if (attempt >= retries) {
        if (showedWake) setWaking(false);
        throw err;
      }
      if (!showedWake) {
        showedWake = true;
        setWaking(true);
      }
      await new Promise((r) => setTimeout(r, delays[attempt] || 12000));
      attempt++;
    }
  }
}

/* ------------------------------------------------------------------ */
/* Formatting helpers                                                  */
/* ------------------------------------------------------------------ */
function relTime(iso) {
  if (!iso) return "";
  const then = new Date(iso);
  const diff = (Date.now() - then.getTime()) / 1000;
  if (diff < 45) return "just now";
  if (diff < 90) return "1 min ago";
  if (diff < 3600) return `${Math.round(diff / 60)} min ago`;
  if (diff < 7200) return "1 hr ago";
  if (diff < 86400) return `${Math.round(diff / 3600)} hr ago`;
  const days = Math.floor(diff / 86400);
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  if (days < 14) return "1 wk ago";
  if (days < 60) return `${Math.round(days / 7)} wks ago`;
  return then.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

const fmtNum = (n) =>
  n == null ? "" : Number.isInteger(n) ? String(n) : String(Math.round(n * 10) / 10);

function loadDisplay(log) {
  // returns the "weight x reps" description for a log
  if (log.weight == null) {
    return `<span class="histrow__bw">BW</span> <small>×</small> ${log.reps}`;
  }
  return `${fmtNum(log.weight)}<small> lb ×</small> ${log.reps}`;
}

/* ------------------------------------------------------------------ */
/* App state                                                           */
/* ------------------------------------------------------------------ */
const state = {
  programs: [],
  program: null, // full program object
  programId: null,
  dayId: null,
  logsByExercise: new Map(), // exercise_id -> [logs]
};

function saveSelection() {
  try {
    localStorage.setItem(
      LS_KEY,
      JSON.stringify({ programId: state.programId, dayId: state.dayId })
    );
  } catch (_) {}
}
function readSelection() {
  try {
    return JSON.parse(localStorage.getItem(LS_KEY)) || {};
  } catch (_) {
    return {};
  }
}

/* ------------------------------------------------------------------ */
/* Drawer                                                              */
/* ------------------------------------------------------------------ */
const drawer = $("#drawer");
const scrim = $("#scrim");
const menuBtn = $("#menuBtn");

function openDrawer() {
  drawer.classList.add("is-open");
  scrim.hidden = false;
  menuBtn.setAttribute("aria-expanded", "true");
}
function closeDrawer() {
  drawer.classList.remove("is-open");
  scrim.hidden = true;
  menuBtn.setAttribute("aria-expanded", "false");
}
menuBtn.addEventListener("click", openDrawer);
$("#drawerClose").addEventListener("click", closeDrawer);
scrim.addEventListener("click", closeDrawer);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeDrawer();
});

/* ------------------------------------------------------------------ */
/* Toasts                                                              */
/* ------------------------------------------------------------------ */
function toast(msg, { type = "ok", icon, action } = {}) {
  const node = el(
    "div",
    { class: `toast toast--${type}`, role: "status" },
    el("span", { class: "toast__ico" }, icon || (type === "err" ? "!" : "✓")),
    el("span", {}, msg)
  );
  if (action) {
    node.append(
      el("button", { class: "toast__undo", onClick: () => { action.fn(); dismiss(); } }, action.label)
    );
  }
  $("#toaster").append(node);

  let timer;
  function dismiss() {
    clearTimeout(timer);
    node.classList.add("out");
    node.addEventListener("animationend", () => node.remove(), { once: true });
  }
  timer = setTimeout(dismiss, action ? 6000 : 3200);
  return dismiss;
}

/* ------------------------------------------------------------------ */
/* Program list (sidebar)                                              */
/* ------------------------------------------------------------------ */
function renderProgramList() {
  const list = $("#programList");
  list.innerHTML = "";
  for (const p of state.programs) {
    const card = el(
      "button",
      {
        class: "progcard" + (p.id === state.programId ? " is-active" : ""),
        type: "button",
        "aria-current": p.id === state.programId ? "true" : null,
        onClick: () => selectProgram(p.id),
      },
      el("h3", { class: "progcard__name" }, p.name),
      el("p", { class: "progcard__sub" }, p.subtitle || ""),
      el(
        "div",
        { class: "progcard__meta" },
        el("span", { html: `<b>${p.day_count}</b> days` }),
        el("span", { html: `<b>${p.exercise_count}</b> lifts` })
      )
    );
    list.append(card);
  }
}

/* ------------------------------------------------------------------ */
/* Program header + day tabs                                           */
/* ------------------------------------------------------------------ */
function renderProgramHeader() {
  const p = state.program;
  const head = $("#programHeader");
  $("#pheadName").textContent = p.name;
  $("#pheadSub").textContent = p.subtitle || "";
  const exCount = p.days.reduce((n, d) => n + d.exercises.length, 0);
  $("#pheadStats").innerHTML = "";
  const stats = [
    [p.days.length, "Days"],
    [exCount, "Lifts"],
  ];
  for (const [val, label] of stats) {
    $("#pheadStats").append(
      el("div", { class: "phead__stat" }, el("b", {}, String(val)), el("span", {}, label))
    );
  }
  head.hidden = false;

  // top bar indicator
  $("#topProgram").innerHTML = `<b>${escapeHtml(p.name)}</b>`;
}

function renderDayTabs() {
  const tabs = $("#dayTabs");
  tabs.innerHTML = "";
  state.program.days.forEach((d) => {
    tabs.append(
      el(
        "button",
        {
          class: "daytab" + (d.id === state.dayId ? " is-active" : ""),
          type: "button",
          role: "tab",
          "aria-selected": d.id === state.dayId ? "true" : "false",
          onClick: () => selectDay(d.id),
        },
        el("span", { class: "daytab__label" }, d.label),
        el("span", { class: "daytab__count" }, `${d.exercises.length} lifts`)
      )
    );
  });
  tabs.hidden = false;

  const active = tabs.querySelector(".is-active");
  if (active) active.scrollIntoView({ inline: "center", block: "nearest", behavior: "smooth" });
}

/* ------------------------------------------------------------------ */
/* Day rendering                                                       */
/* ------------------------------------------------------------------ */
const pillClass = (cat) => {
  const key = (cat || "").toLowerCase().replace(/[^a-z]/g, "");
  return { mobility: "mobility", strength: "strength", hypertrophy: "hypertrophy", core: "core", skillcore: "skillcore" }[key] || "strength";
};

function renderDay() {
  const day = state.program.days.find((d) => d.id === state.dayId);
  const titleWrap = $("#dayTitle");
  titleWrap.innerHTML = "";
  const idx = state.program.days.indexOf(day) + 1;
  titleWrap.append(
    el("span", { class: "daytitle__idx" }, `0${idx} /`),
    el("h2", { class: "daytitle__text" }, day.title)
  );
  titleWrap.hidden = false;

  const listEl = $("#exerciseList");
  listEl.innerHTML = "";
  day.exercises.forEach((ex, i) => {
    const card = buildExerciseCard(ex);
    card.style.animationDelay = `${Math.min(i * 45, 320)}ms`;
    listEl.append(card);
  });

  // hydrate last-time + history from a single program-logs fetch
  hydrateHistory();
}

function buildExerciseCard(ex) {
  const card = el("article", { class: "card", "data-ex": ex.id });
  card.dataset.name = ex.name;

  // head
  const title = el("h3", { class: "card__title" }, ex.name);
  if (ex.category) {
    title.append(
      " ",
      el("span", { class: `pill pill--${pillClass(ex.category)}` }, ex.category)
    );
  }
  const toggle = el(
    "button",
    {
      class: "card__toggle",
      type: "button",
      "aria-label": "Show history & records",
      "aria-expanded": "false",
    },
    el("span", { class: "chev" }, "▾")
  );
  toggle.addEventListener("click", () => toggleMemory(card));
  card.append(
    el("div", { class: "card__head" }, el("div", { class: "card__titlewrap" }, title), toggle)
  );

  // prescription readout
  const rx = el(
    "div",
    { class: "rx" },
    rxCell("Sets", ex.sets),
    rxCell("Reps", ex.reps),
    rxCell("Work", ex.weight, true)
  );
  card.append(rx);

  // notes (collapsible if long)
  if (ex.notes && ex.notes.trim()) {
    const long = ex.notes.length > 96;
    const notes = el("div", { class: "notes" + (long ? " is-clamped" : "") });
    notes.append(el("div", { class: "notes__body" }, ex.notes));
    if (long) {
      const more = el("button", { class: "notes__more", type: "button" }, "Show cues +");
      more.addEventListener("click", () => {
        const clamped = notes.classList.toggle("is-clamped");
        more.textContent = clamped ? "Show cues +" : "Show less −";
      });
      notes.append(more);
    }
    card.append(notes);
  }

  // logger form
  card.append(buildLogger(ex));

  // last-time strip (filled after history hydrate)
  const last = el("div", { class: "lastline", "data-last": "" }, el("span", { class: "lastline__k" }, "Last"), el("span", { class: "lastline__val" }, "—"));
  card.append(last);

  // memory panel (expandable)
  const memory = el(
    "div",
    { class: "memory" },
    el(
      "div",
      { class: "memory__inner" },
      el("div", { class: "memory__pad", "data-mempad": "" }, el("div", { class: "hist__empty" }, "Open to load records…"))
    )
  );
  card.append(memory);

  // stamp
  card.append(el("div", { class: "stamp" }, "Logged"));

  return card;
}

function rxCell(k, v, isWeight) {
  const val = (v ?? "").toString().trim();
  const cell = el("div", { class: "rx__cell" }, el("span", { class: "rx__k" }, k));
  if (!val) {
    cell.append(el("span", { class: "rx__v is-empty" }, isWeight ? "—" : "—"));
  } else if (isWeight) {
    cell.append(el("span", { class: "rx__v" }, el("span", {}, val), el("small", {}, " lb")));
  } else {
    cell.append(el("span", { class: "rx__v" }, val));
  }
  return cell;
}

/* ------------------------------------------------------------------ */
/* Logger form                                                         */
/* ------------------------------------------------------------------ */
function buildLogger(ex) {
  const wId = `w-${ex.id}`;
  const rId = `r-${ex.id}`;
  const nId = `n-${ex.id}`;

  const weight = el("input", {
    id: wId, type: "text", inputmode: "decimal",
    autocomplete: "off", enterkeyhint: "next", placeholder: "0",
    "aria-label": "Weight in pounds (leave empty for bodyweight)",
  });
  const reps = el("input", {
    id: rId, type: "text", inputmode: "numeric",
    autocomplete: "off", enterkeyhint: "done", placeholder: "0",
    "aria-label": "Reps performed",
  });
  const note = el("input", {
    id: nId, type: "text", maxlength: "140",
    autocomplete: "off", placeholder: "note — tempo, RPE, how it felt…",
    "aria-label": "Optional note",
  });

  const btn = el(
    "button",
    { class: "logbtn", type: "submit" },
    el("span", { class: "logbtn__label" }, "Log"),
    el("span", { class: "logbtn__spin", "aria-hidden": "true" })
  );

  const form = el(
    "form",
    { class: "logger", novalidate: "" },
    el("div", { class: "field" },
      el("label", { for: wId }, "Weight", el("span", { class: "hint" }, "blank = BW")),
      weight),
    el("div", { class: "field" }, el("label", { for: rId }, "Reps"), reps),
    btn,
    el("div", { class: "field field--note" }, el("label", { for: nId }, "Note", el("span", { class: "hint" }, "optional")), note)
  );

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    submitLog(ex, { weight, reps, note, btn, form });
  });
  return form;
}

async function submitLog(ex, { weight, reps, note, btn, form }) {
  const wRaw = weight.value.trim();
  const rRaw = reps.value.trim();

  const repsVal = parseInt(rRaw, 10);
  if (!rRaw || Number.isNaN(repsVal) || repsVal <= 0) {
    reps.focus();
    reps.style.borderColor = "var(--ember)";
    setTimeout(() => (reps.style.borderColor = ""), 1200);
    toast("Enter the reps you did.", { type: "err" });
    return;
  }

  let weightVal = null;
  if (wRaw !== "") {
    weightVal = parseFloat(wRaw.replace(",", "."));
    if (Number.isNaN(weightVal) || weightVal < 0) {
      weight.focus();
      weight.style.borderColor = "var(--ember)";
      setTimeout(() => (weight.style.borderColor = ""), 1200);
      toast("Weight must be a number (or blank for bodyweight).", { type: "err" });
      return;
    }
  }

  btn.classList.add("is-busy");
  btn.disabled = true;

  const payload = {
    program_id: state.programId,
    day_id: state.dayId,
    exercise_id: ex.id,
    exercise_name: ex.name,
    weight: weightVal,
    reps: repsVal,
    notes: note.value.trim(),
  };

  try {
    const log = await apiJSON("/api/logs", { method: "POST", body: payload });

    // update local cache
    const arr = state.logsByExercise.get(ex.id) || [];
    arr.unshift(log);
    state.logsByExercise.set(ex.id, arr);

    const card = form.closest(".card");
    celebrate(card);
    updateLastLine(card, arr);

    // if memory panel is open (or previously loaded), refresh it
    const mem = card.querySelector(".memory");
    if (mem.classList.contains("is-open") || mem.dataset.loaded) {
      loadMemory(card, ex.id, arr);
    }

    // reset inputs, keep weight (usually same across sets), clear note
    reps.value = "";
    note.value = "";
    reps.focus();

    const oneRm = log.est_1rm ? ` · est 1RM ${fmtNum(log.est_1rm)}` : "";
    toast(`Set logged${oneRm}`, { type: "ok" });
  } catch (err) {
    toast(err.message || "Could not log the set.", { type: "err" });
  } finally {
    btn.classList.remove("is-busy");
    btn.disabled = false;
  }
}

/* satisfying stamp + edge flash */
function celebrate(card) {
  card.classList.remove("is-logged");
  void card.offsetWidth; // reflow to restart animation
  card.classList.add("is-logged");

  const stamp = card.querySelector(".stamp");
  stamp.classList.remove("go");
  void stamp.offsetWidth;
  stamp.classList.add("go");

  if (navigator.vibrate) navigator.vibrate(18);
}

/* ------------------------------------------------------------------ */
/* Last-time line + memory panel                                       */
/* ------------------------------------------------------------------ */
function updateLastLine(card, logs) {
  const line = card.querySelector('[data-last]');
  const valEl = line.querySelector(".lastline__val");
  if (!logs || !logs.length) {
    valEl.innerHTML = `<span style="color:var(--ash)">no sets yet — set the baseline</span>`;
    return;
  }
  const l = logs[0];
  const load = l.weight == null ? `BW × ${l.reps}` : `${fmtNum(l.weight)} lb × ${l.reps}`;
  const rm = l.est_1rm ? ` · <span class="pr">1RM ${fmtNum(l.est_1rm)}</span>` : "";
  valEl.innerHTML = `<b>${load}</b> · ${relTime(l.performed_at)}${rm}`;
}

function toggleMemory(card) {
  const mem = card.querySelector(".memory");
  const toggle = card.querySelector(".card__toggle");
  const open = mem.classList.toggle("is-open");
  toggle.setAttribute("aria-expanded", open ? "true" : "false");
  if (open && !mem.dataset.loaded) {
    const exId = card.dataset.ex;
    loadMemory(card, exId, state.logsByExercise.get(exId));
  }
}

async function loadMemory(card, exId, cachedLogs) {
  const mem = card.querySelector(".memory");
  const pad = mem.querySelector("[data-mempad]");
  mem.dataset.loaded = "1";

  // stats fetch (best/1RM over all logs)
  let stats = null;
  try {
    stats = await apiJSON(`/api/exercises/${encodeURIComponent(exId)}/stats`);
  } catch (_) {
    /* non-fatal — we still show history from cache */
  }

  const logs = cachedLogs || state.logsByExercise.get(exId) || [];
  renderMemory(pad, exId, stats, logs);
}

function renderMemory(pad, exId, stats, logs) {
  pad.innerHTML = "";

  // stat boxes
  const total = stats ? stats.total_sets : logs.length;
  const bestW = stats ? stats.best_weight : null;
  const best1 = stats ? stats.best_est_1rm : null;
  pad.append(
    el(
      "div",
      { class: "stats" },
      statbox(String(total), "Total sets"),
      statbox(bestW != null ? `${fmtNum(bestW)}` : "—", "Best load", false),
      statbox(best1 != null ? `${fmtNum(best1)}` : "—", "Best 1RM", true)
    )
  );

  // history header
  pad.append(
    el(
      "div",
      { class: "hist__head" },
      el("span", {}, "Recent sets"),
      logs.length ? el("span", {}, `${logs.length} shown`) : ""
    )
  );

  if (!logs.length) {
    pad.append(
      el("div", { class: "hist__empty", html: "No history yet. <b>Log your first set</b> to start the ledger." })
    );
    return;
  }

  const ul = el("ul", { class: "hist" });
  logs.slice(0, 12).forEach((log) => ul.append(buildHistRow(log, exId)));
  pad.append(ul);
}

function statbox(value, label, highlight) {
  return el(
    "div",
    { class: "statbox" + (highlight ? " hl" : "") },
    el("b", {}, value),
    el("span", {}, label)
  );
}

function buildHistRow(log, exId) {
  const del = el("button", { class: "histrow__del", type: "button", "aria-label": "Delete this set", title: "Delete set" }, "✕");
  del.addEventListener("click", () => deleteLog(log, exId, del.closest(".histrow")));

  const rm = log.est_1rm ? el("span", { class: "histrow__1rm", html: `<b>${fmtNum(log.est_1rm)}</b> 1rm` }) : el("span", { class: "histrow__1rm" }, "—");

  const loadCell = el("span", { class: "histrow__load", html: loadDisplay(log) });
  if (log.notes) loadCell.append(" ", el("span", { class: "histrow__note", title: log.notes }, "✎"));

  return el(
    "li",
    { class: "histrow", "data-log": log.id },
    loadCell,
    rm,
    el("span", { class: "histrow__when" }, relTime(log.performed_at)),
    del
  );
}

async function deleteLog(log, exId, rowEl) {
  // optimistic remove
  const arr = state.logsByExercise.get(exId) || [];
  const idx = arr.findIndex((l) => l.id === log.id);
  if (idx >= 0) arr.splice(idx, 1);
  if (rowEl) rowEl.remove();

  const card = document.querySelector(`.card[data-ex="${cssEsc(exId)}"]`);
  if (card) {
    updateLastLine(card, arr);
    const pad = card.querySelector("[data-mempad]");
    // refresh stats after delete
    let stats = null;
    try {
      stats = await apiJSON(`/api/exercises/${encodeURIComponent(exId)}/stats`);
    } catch (_) {}
    if (pad) renderMemory(pad, exId, stats, arr);
  }

  try {
    await apiJSON(`/api/logs/${log.id}`, { method: "DELETE" });
    toast("Set removed.", {
      type: "ok",
      icon: "↺",
      action: { label: "Undo", fn: () => restoreLog(log, exId) },
    });
  } catch (err) {
    // rollback
    arr.splice(Math.min(idx, arr.length), 0, log);
    state.logsByExercise.set(exId, arr);
    if (card) {
      updateLastLine(card, arr);
      const pad = card.querySelector("[data-mempad]");
      if (pad) renderMemory(pad, exId, null, arr);
    }
    toast("Could not delete — restored.", { type: "err" });
  }
}

async function restoreLog(log, exId) {
  try {
    const recreated = await apiJSON("/api/logs", {
      method: "POST",
      body: {
        program_id: log.program_id,
        day_id: log.day_id,
        exercise_id: log.exercise_id,
        exercise_name: log.exercise_name,
        weight: log.weight,
        reps: log.reps,
        notes: log.notes || "",
        performed_at: log.performed_at,
      },
    });
    const arr = state.logsByExercise.get(exId) || [];
    arr.push(recreated);
    arr.sort((a, b) => new Date(b.performed_at) - new Date(a.performed_at));
    state.logsByExercise.set(exId, arr);

    const card = document.querySelector(`.card[data-ex="${cssEsc(exId)}"]`);
    if (card) {
      updateLastLine(card, arr);
      const pad = card.querySelector("[data-mempad]");
      if (pad) {
        let stats = null;
        try { stats = await apiJSON(`/api/exercises/${encodeURIComponent(exId)}/stats`); } catch (_) {}
        renderMemory(pad, exId, stats, arr);
      }
    }
    toast("Set restored.", { type: "ok" });
  } catch (_) {
    toast("Could not restore the set.", { type: "err" });
  }
}

const cssEsc = (s) =>
  window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/"/g, '\\"');

/* ------------------------------------------------------------------ */
/* History hydration (one fetch per day view)                          */
/* ------------------------------------------------------------------ */
async function hydrateHistory() {
  let logs = [];
  try {
    logs = await apiJSON(`/api/logs?program_id=${encodeURIComponent(state.programId)}&limit=500`);
  } catch (_) {
    // History is a nice-to-have; a failure here shouldn't break the day view.
    return;
  }

  const map = new Map();
  for (const log of logs) {
    if (!map.has(log.exercise_id)) map.set(log.exercise_id, []);
    map.get(log.exercise_id).push(log);
  }
  // logs already come newest-first from the API
  state.logsByExercise = map;

  // paint last-line for every visible card
  $$(".card").forEach((card) => {
    const exId = card.dataset.ex;
    updateLastLine(card, map.get(exId) || []);
    // refresh any already-open memory panels
    const mem = card.querySelector(".memory");
    if (mem.classList.contains("is-open")) {
      loadMemory(card, exId, map.get(exId) || []);
    }
  });
}

/* ------------------------------------------------------------------ */
/* Selection flow                                                      */
/* ------------------------------------------------------------------ */
async function selectProgram(programId, preferredDayId) {
  if (state.programId === programId && state.program) {
    closeDrawer();
    return;
  }
  state.programId = programId;
  renderProgramList(); // reflect active state immediately
  closeDrawer();

  showLoading("Loading program…");
  try {
    const program = await apiJSON(`/api/programs/${encodeURIComponent(programId)}`);
    state.program = program;

    // choose day: preferred -> saved -> first
    const saved = readSelection();
    let dayId = preferredDayId || saved.dayId;
    if (!program.days.some((d) => d.id === dayId)) dayId = program.days[0].id;
    state.dayId = dayId;

    renderProgramHeader();
    renderDayTabs();
    renderDay();
    saveSelection();
    $("#main").focus({ preventScroll: true });
  } catch (err) {
    showError("Couldn't load this program.", () => selectProgram(programId, preferredDayId));
  }
}

function selectDay(dayId) {
  if (state.dayId === dayId) return;
  state.dayId = dayId;
  renderDayTabs();
  renderDay();
  saveSelection();
}

/* ------------------------------------------------------------------ */
/* State panels                                                        */
/* ------------------------------------------------------------------ */
function showLoading(msg) {
  const list = $("#exerciseList");
  list.innerHTML = "";
  list.append(
    el(
      "div",
      { class: "statepanel" },
      el("div", { class: "statepanel__dot" }),
      el("p", { class: "statepanel__msg" }, msg)
    )
  );
}

function showError(msg, retryFn) {
  const list = $("#exerciseList");
  list.innerHTML = "";
  const panel = el(
    "div",
    { class: "statepanel statepanel--error" },
    el("div", { class: "statepanel__dot" }, "!"),
    el("p", { class: "statepanel__msg" }, msg)
  );
  if (retryFn) {
    panel.append(el("button", { class: "statepanel__retry", type: "button", onClick: retryFn }, "Retry"));
  }
  list.append(panel);
}

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */
async function boot() {
  try {
    const programs = await apiJSON("/api/programs");
    state.programs = programs;
    renderProgramList();

    if (!programs.length) {
      showError("No programs found on the server.");
      return;
    }

    const saved = readSelection();
    const startId = programs.some((p) => p.id === saved.programId)
      ? saved.programId
      : programs[0].id;
    await selectProgram(startId, saved.dayId);
  } catch (err) {
    $("#programList").innerHTML = "";
    showError("Can't reach the server. Check your connection and retry.", boot);
  }
}

boot();
