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
  view: "train", // "train" | "progress"
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

// Central Escape handling: confirm dialog > builder > card menus/drawer.
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (document.querySelector(".cdlg")) return; // the dialog handles its own Escape
  if (builder.open) {
    cancelBuilder();
    return;
  }
  closeAllCardMenus();
  closeDrawer();
});

/* ------------------------------------------------------------------ */
/* Collapsible desktop sidebar (Feature A)                             */
/* ------------------------------------------------------------------ */
const SB_KEY = "steellog.sidebar";
const sidebarToggle = $("#sidebarToggle");

function applySidebar(collapsed) {
  document.body.classList.toggle("sidebar-collapsed", collapsed);
  sidebarToggle.setAttribute("aria-expanded", collapsed ? "false" : "true");
  sidebarToggle.setAttribute("aria-label", collapsed ? "Show sidebar" : "Collapse sidebar");
  sidebarToggle.title = collapsed ? "Show sidebar" : "Collapse sidebar";
  const ico = sidebarToggle.querySelector(".rail-ico");
  if (ico) ico.textContent = collapsed ? "»" : "«";
}

sidebarToggle.addEventListener("click", () => {
  const collapsed = !document.body.classList.contains("sidebar-collapsed");
  applySidebar(collapsed);
  try {
    localStorage.setItem(SB_KEY, collapsed ? "1" : "0");
  } catch (_) {}
});

applySidebar(
  (() => {
    try {
      return localStorage.getItem(SB_KEY) === "1";
    } catch (_) {
      return false;
    }
  })()
);

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
    list.append(buildProgramCard(p));
  }
}

function buildProgramCard(p) {
  const active = p.id === state.programId;
  const isSeed = p.origin === "seed";

  const main = el(
    "button",
    {
      class: "progcard__main",
      type: "button",
      "aria-current": active ? "true" : null,
      onClick: () => selectProgram(p.id),
    },
    el("h3", { class: "progcard__name" }, p.name),
    el("p", { class: "progcard__sub" }, p.subtitle || ""),
    el(
      "div",
      { class: "progcard__meta" },
      el("span", { html: `<b>${p.day_count}</b> days` }),
      el("span", { html: `<b>${p.exercise_count}</b> lifts` }),
      el(
        "span",
        { class: "progcard__origin" + (isSeed ? "" : " progcard__origin--custom") },
        isSeed ? "Original" : "Custom"
      )
    )
  );

  const kebab = el(
    "button",
    {
      class: "progcard__kebab",
      type: "button",
      "aria-label": `Actions for ${p.name}`,
      "aria-expanded": "false",
      "aria-haspopup": "true",
    },
    "⋯"
  );

  const actions = el(
    "div",
    { class: "progcard__actions", role: "menu" },
    actionBtn("Edit", "edit", () => openBuilderEdit(p.id)),
    actionBtn("Duplicate", "duplicate", () => openBuilderDuplicate(p.id)),
    isSeed
      ? actionBtn("Reset to original", "reset", () => resetProgram(p), false)
      : actionBtn("Delete", "delete", () => deleteProgram(p), true)
  );

  const card = el(
    "div",
    { class: "progcard" + (active ? " is-active" : ""), "data-id": p.id },
    main,
    kebab,
    actions
  );
  kebab.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleCardMenu(card);
  });
  return card;
}

function actionBtn(label, act, fn, danger) {
  return el(
    "button",
    {
      class: "progcard__act" + (danger ? " progcard__act--danger" : ""),
      type: "button",
      role: "menuitem",
      "data-act": act,
      onClick: (e) => {
        e.stopPropagation();
        closeAllCardMenus();
        fn();
      },
    },
    label
  );
}

function closeAllCardMenus(except) {
  $$(".progcard.is-menuopen").forEach((c) => {
    if (c === except) return;
    c.classList.remove("is-menuopen");
    const k = c.querySelector(".progcard__kebab");
    if (k) k.setAttribute("aria-expanded", "false");
  });
}

function toggleCardMenu(card) {
  const willOpen = !card.classList.contains("is-menuopen");
  closeAllCardMenus();
  card.classList.toggle("is-menuopen", willOpen);
  card.querySelector(".progcard__kebab").setAttribute("aria-expanded", willOpen ? "true" : "false");
}

document.addEventListener("click", (e) => {
  if (!e.target.closest(".progcard")) closeAllCardMenus();
});

async function reloadPrograms() {
  const programs = await apiJSON("/api/programs");
  state.programs = programs;
  renderProgramList();
  return programs;
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

    const load = log.weight == null ? `BW × ${log.reps}` : `${fmtNum(log.weight)} lb × ${log.reps}`;
    toast(`Set logged · ${load}`, { type: "ok" });
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
  valEl.innerHTML = `<b>${load}</b> · ${relTime(l.performed_at)}`;
}

// Returns a promise that resolves once the panel's async content (if any)
// has rendered — callers that need to act on the settled layout can await it.
function toggleMemory(card) {
  const mem = card.querySelector(".memory");
  const toggle = card.querySelector(".card__toggle");
  const open = mem.classList.toggle("is-open");
  toggle.setAttribute("aria-expanded", open ? "true" : "false");
  if (open && !mem.dataset.loaded) {
    const exId = card.dataset.ex;
    return loadMemory(card, exId, state.logsByExercise.get(exId));
  }
  return Promise.resolve();
}

async function loadMemory(card, exId, cachedLogs) {
  const mem = card.querySelector(".memory");
  const pad = mem.querySelector("[data-mempad]");
  mem.dataset.loaded = "1";

  // stats fetch (totals + best/last over all logs)
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
  const lastLog = logs[0] || null;

  let lastVal = "—";
  if (stats && stats.last_reps != null) {
    lastVal =
      stats.last_weight == null
        ? `BW×${stats.last_reps}`
        : `${fmtNum(stats.last_weight)}×${stats.last_reps}`;
  } else if (lastLog) {
    lastVal =
      lastLog.weight == null
        ? `BW×${lastLog.reps}`
        : `${fmtNum(lastLog.weight)}×${lastLog.reps}`;
  }

  pad.append(
    el(
      "div",
      { class: "stats" },
      statbox(String(total), "Total sets"),
      statbox(bestW != null ? `${fmtNum(bestW)}` : "—", "Best load", true),
      statbox(lastVal, "Last set", false)
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

  const loadCell = el("span", { class: "histrow__load", html: loadDisplay(log) });
  if (log.notes) loadCell.append(" ", el("span", { class: "histrow__note", title: log.notes }, "✎"));

  return el(
    "li",
    { class: "histrow", "data-log": log.id },
    loadCell,
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
async function selectProgram(programId, preferredDayId, opts = {}) {
  if (!opts.force && state.programId === programId && state.program) {
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
    if (state.view === "progress") renderProgress();
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
/* View toggle: TRAIN <-> PROGRESS                                     */
/* ------------------------------------------------------------------ */
function setView(view) {
  if (view !== "train" && view !== "progress") return;
  state.view = view;
  $("#trainView").hidden = view !== "train";
  $("#progressView").hidden = view !== "progress";
  $$("#viewToggle .viewtoggle__btn").forEach((b) => {
    const active = b.dataset.view === view;
    b.classList.toggle("is-active", active);
    b.setAttribute("aria-selected", active ? "true" : "false");
  });
  if (view === "progress") renderProgress();
}

$$("#viewToggle .viewtoggle__btn").forEach((b) =>
  b.addEventListener("click", () => setView(b.dataset.view))
);

/* ------------------------------------------------------------------ */
/* Progress view — best top-set + progressive-overload trend           */
/* ------------------------------------------------------------------ */

// Local calendar-day key (so sessions are grouped by the user's day).
function dayKey(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

// The "top set" of a day: heaviest weight (tie -> more reps); for a
// bodyweight exercise, the set with the most reps.
function topSetOfDay(sets, isBodyweight) {
  return sets.reduce((best, s) => {
    if (!best) return s;
    if (isBodyweight) return s.reps > best.reps ? s : best;
    const w = s.weight ?? -Infinity;
    const bw = best.weight ?? -Infinity;
    if (w > bw) return s;
    if (w === bw && s.reps > best.reps) return s;
    return best;
  }, null);
}

/**
 * Reduce one exercise's logs (newest first) to a headline number and a
 * progressive-overload trend, comparing the most recent training day's
 * top set against the previous training day's.
 */
function analyzeExercise(logs) {
  if (!logs || !logs.length) return { state: "none" };

  const isBW = logs.every((l) => l.weight == null);

  // group by calendar day, preserving newest-first order
  const byDay = new Map();
  for (const l of logs) {
    const k = dayKey(l.performed_at);
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push(l);
  }
  const dayKeys = [...byDay.keys()]; // newest first (logs are newest first)
  const recent = topSetOfDay(byDay.get(dayKeys[0]), isBW);
  const prev = dayKeys.length > 1 ? topSetOfDay(byDay.get(dayKeys[1]), isBW) : null;

  // headline: best ever top-set weight (or best reps for bodyweight)
  let best;
  if (isBW) {
    best = { load: null, reps: Math.max(...logs.map((l) => l.reps)) };
  } else {
    best = { load: Math.max(...logs.filter((l) => l.weight != null).map((l) => l.weight)), reps: null };
  }

  // trend: only meaningful with two distinct training days
  let trend = "new";
  if (prev) {
    if (isBW) {
      trend = recent.reps > prev.reps ? "up" : recent.reps < prev.reps ? "down" : "flat";
    } else {
      const rw = recent.weight ?? -Infinity;
      const pw = prev.weight ?? -Infinity;
      if (rw > pw) trend = "up";
      else if (rw < pw) trend = "down";
      else trend = recent.reps > prev.reps ? "up" : recent.reps < prev.reps ? "down" : "flat";
    }
  }

  return { state: "data", isBW, best, trend, sessions: dayKeys.length };
}

const TREND = {
  up: { arrow: "↑", label: "Progressing up", cls: "trend--up" },
  flat: { arrow: "→", label: "Holding steady", cls: "trend--flat" },
  down: { arrow: "↓", label: "Stalling — down from last session", cls: "trend--down" },
  new: { arrow: "•", label: "New — one session logged", cls: "trend--new" },
  none: { arrow: "", label: "No data yet", cls: "trend--none" },
};

let progressToken = 0;

async function renderProgress() {
  const wrap = $("#progressView");
  const program = state.program;
  if (!program) return;

  const token = ++progressToken;
  wrap.innerHTML = "";
  wrap.append(
    el(
      "div",
      { class: "statepanel" },
      el("div", { class: "statepanel__dot" }),
      el("p", { class: "statepanel__msg" }, "Reading the ledger…")
    )
  );

  let logs;
  try {
    logs = await apiJSON(`/api/logs?program_id=${encodeURIComponent(program.id)}&limit=1000`);
  } catch (err) {
    if (token !== progressToken) return;
    wrap.innerHTML = "";
    const panel = el(
      "div",
      { class: "statepanel statepanel--error" },
      el("div", { class: "statepanel__dot" }, "!"),
      el("p", { class: "statepanel__msg" }, "Couldn't load progress."),
      el("button", { class: "statepanel__retry", type: "button", onClick: renderProgress }, "Retry")
    );
    wrap.append(panel);
    return;
  }
  if (token !== progressToken) return; // superseded (program/view changed)

  // group logs by exercise (newest first, preserved)
  const byEx = new Map();
  for (const l of logs) {
    if (!byEx.has(l.exercise_id)) byEx.set(l.exercise_id, []);
    byEx.get(l.exercise_id).push(l);
  }

  wrap.innerHTML = "";

  // header + legend
  wrap.append(
    el(
      "header",
      { class: "progress__head" },
      el("p", { class: "phead__eyebrow" }, "Progress"),
      el("h1", { class: "progress__name" }, program.name),
      el(
        "div",
        { class: "progress__legend" },
        legendItem("up"),
        legendItem("flat"),
        legendItem("down")
      )
    )
  );

  const loggedCount = byEx.size;
  const groups = el("div", { class: "pgroups" });
  program.days.forEach((day, di) => {
    const group = el("section", { class: "pgroup" });
    group.style.animationDelay = `${Math.min(di * 60, 240)}ms`;
    group.append(
      el(
        "header",
        { class: "pgroup__head" },
        el("span", { class: "pgroup__label" }, day.label),
        el("span", { class: "pgroup__title" }, day.title)
      )
    );
    const ul = el("ul", { class: "prows" });
    day.exercises.forEach((ex) => ul.append(buildProgressRow(ex, day, byEx.get(ex.id))));
    group.append(ul);
    groups.append(group);
  });
  wrap.append(groups);

  if (loggedCount === 0) {
    wrap.append(
      el(
        "p",
        { class: "progress__empty" },
        "No sets logged for this program yet. Log a few in ",
        el("button", { class: "progress__inlinebtn", type: "button", onClick: () => setView("train") }, "Train"),
        " and your trends will appear here."
      )
    );
  }
}

function legendItem(kind) {
  const t = TREND[kind];
  return el(
    "span",
    { class: "legend__item " + t.cls },
    el("span", { class: "legend__arrow", "aria-hidden": "true" }, t.arrow),
    el("span", {}, { up: "progressing", flat: "holding", down: "stalling" }[kind])
  );
}

function buildProgressRow(ex, day, logs) {
  const info = analyzeExercise(logs);

  const name = el("span", { class: "prow__name" }, ex.name);
  if (ex.category) {
    name.append(" ", el("span", { class: `pill pill--${pillClass(ex.category)}` }, ex.category));
  }

  // headline number
  let bestNode;
  if (info.state === "none") {
    bestNode = el("span", { class: "prow__best is-empty" }, "—");
  } else if (info.isBW) {
    bestNode = el("span", { class: "prow__best" }, el("span", { class: "prow__bw" }, "BW"), el("small", {}, " ×"), String(info.best.reps));
  } else {
    bestNode = el("span", { class: "prow__best" }, fmtNum(info.best.load), el("small", {}, " lb"));
  }

  const trendKind = info.state === "none" ? "none" : info.trend;
  const t = TREND[trendKind];
  const trend = el(
    "span",
    { class: "prow__trend " + t.cls, role: "img", "aria-label": t.label, title: t.label },
    el("span", { class: "prow__arrow", "aria-hidden": "true" }, t.arrow || "·")
  );

  const row = el(
    "li",
    {
      class: "prow" + (info.state === "none" ? " is-cold" : ""),
      role: "button",
      tabindex: "0",
      "aria-label": `${ex.name} — ${info.state === "none" ? "no data" : t.label}. Open history.`,
      "data-ex": ex.id,
      "data-day": day.id,
    },
    name,
    bestNode,
    trend
  );

  const open = () => openInTrain(ex.id, day.id);
  row.addEventListener("click", open);
  row.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      open();
    }
  });
  return row;
}

// Drill-in: jump to the TRAIN view with the exercise's day selected and
// its history panel expanded + scrolled into view. selectDay() renders the
// day's cards synchronously, so the target card exists immediately.
async function openInTrain(exId, dayId) {
  setView("train");
  selectDay(dayId); // no-op if already the active day; cards already exist

  const card = document.querySelector(`.card[data-ex="${cssEsc(exId)}"]`);
  if (!card) return;

  // Expand the history panel and WAIT for its async stats/history to render.
  // The panel loads via a /stats fetch and re-renders, changing card heights;
  // scrolling before that settles is what left the target out of view.
  const mem = card.querySelector(".memory");
  if (mem && !mem.classList.contains("is-open")) {
    await toggleMemory(card);
  }

  // Scroll to the card's own (stable) top: the panel expands downward, so the
  // card top doesn't move as content loads. Land it just below the sticky top
  // bar + day tabs. Reading getBoundingClientRect() flushes pending layout, so
  // the target is computed against the settled DOM (no rAF dependency).
  const topbar = document.querySelector(".topbar");
  const daytabs = $("#dayTabs");
  const offset =
    (topbar ? topbar.offsetHeight : 0) +
    (daytabs && !daytabs.hidden ? daytabs.offsetHeight : 0) +
    14;
  const y = card.getBoundingClientRect().top + window.scrollY - offset;
  // Instant (not smooth): this is a full view swap from the Progress grid, so
  // there's no scroll continuity to preserve, and it lands deterministically.
  window.scrollTo({ top: Math.max(0, y), behavior: "auto" });

  card.classList.remove("is-logged");
  void card.offsetWidth;
  card.classList.add("is-logged"); // brief highlight to orient the user
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
/* Confirm dialog (in-aesthetic, promise-based)                        */
/* ------------------------------------------------------------------ */
function confirmDialog({ title, message, confirmLabel = "Confirm", danger = false }) {
  return new Promise((resolve) => {
    const cancelBtn = el("button", { class: "cdlg__btn cdlg__cancel", type: "button" }, "Cancel");
    const okBtn = el(
      "button",
      { class: "cdlg__btn cdlg__ok" + (danger ? " cdlg__ok--danger" : ""), type: "button" },
      confirmLabel
    );
    const box = el(
      "div",
      { class: "cdlg__box", role: "alertdialog", "aria-modal": "true", "aria-label": title },
      el("h3", { class: "cdlg__title" }, title),
      message ? el("p", { class: "cdlg__msg" }, message) : null,
      el("div", { class: "cdlg__actions" }, cancelBtn, okBtn)
    );
    const overlay = el("div", { class: "cdlg" }, box);

    function close(val) {
      overlay.classList.add("out");
      document.removeEventListener("keydown", onKey, true);
      setTimeout(() => overlay.remove(), 160);
      resolve(val);
    }
    function onKey(e) {
      if (e.key === "Escape") {
        e.stopPropagation();
        close(false);
      } else if (e.key === "Enter") {
        e.preventDefault();
        close(true);
      }
    }
    cancelBtn.addEventListener("click", () => close(false));
    okBtn.addEventListener("click", () => close(true));
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close(false);
    });
    document.addEventListener("keydown", onKey, true);
    document.body.append(overlay);
    okBtn.focus();
  });
}

/* ------------------------------------------------------------------ */
/* Delete / Reset program                                              */
/* ------------------------------------------------------------------ */
async function deleteProgram(p) {
  const ok = await confirmDialog({
    title: "Delete routine?",
    message: `"${p.name}" and its plan will be removed. Logged sets stay in your history.`,
    confirmLabel: "Delete",
    danger: true,
  });
  if (!ok) return;
  try {
    await apiJSON(`/api/programs/${encodeURIComponent(p.id)}`, { method: "DELETE" });
    const programs = await reloadPrograms();
    if (state.programId === p.id) {
      state.program = null;
      state.programId = null;
      if (programs.length) await selectProgram(programs[0].id, null, { force: true });
    }
    toast("Routine deleted.", { type: "ok" });
  } catch (err) {
    toast(err.message || "Couldn't delete this routine.", { type: "err" });
  }
}

async function resetProgram(p) {
  const ok = await confirmDialog({
    title: "Restore original?",
    message: `"${p.name}" will be reset to its original plan. Your logged sets are kept.`,
    confirmLabel: "Restore",
  });
  if (!ok) return;
  try {
    const fresh = await apiJSON(`/api/programs/${encodeURIComponent(p.id)}/reset`, { method: "POST" });
    await reloadPrograms();
    await selectProgram(fresh.id, null, { force: true });
    setView("train");
    toast("Routine restored to original.", { type: "ok" });
  } catch (err) {
    toast(err.message || "Couldn't reset this routine.", { type: "err" });
  }
}

/* ------------------------------------------------------------------ */
/* Workout builder (Feature B) — create + edit share one UI            */
/* ------------------------------------------------------------------ */
const builder = {
  open: false,
  mode: "create", // "create" | "edit"
  programId: null,
  origin: null,
  dirty: false,
  name: "",
  subtitle: "",
  days: [],
};

const blankExercise = () => ({ name: "", category: "", sets: "", reps: "", weight: "", notes: "" });
const blankDay = () => ({ label: "", title: "", exercises: [blankExercise()] });

function cloneDay(d, keepIds) {
  return {
    ...(keepIds && d.id != null ? { id: d.id } : {}),
    label: d.label || "",
    title: d.title || "",
    exercises: (d.exercises || []).map((e) => ({
      ...(keepIds && e.id != null ? { id: e.id } : {}),
      name: e.name || "",
      category: e.category || "",
      sets: e.sets || "",
      reps: e.reps || "",
      weight: e.weight || "",
      notes: e.notes || "",
    })),
  };
}

const markDirty = () => {
  builder.dirty = true;
};

function showBuilder() {
  builder.open = true;
  $("#builder").hidden = false;
  document.body.classList.add("modal-open");
}
function hideBuilder() {
  builder.open = false;
  $("#builder").hidden = true;
  document.body.classList.remove("modal-open");
}

function showBuilderLoading(title) {
  const root = $("#builder");
  root.innerHTML = "";
  root.append(
    el(
      "div",
      { class: "builder__bar" },
      el("span", { class: "builder__x builder__x--ghost", "aria-hidden": "true" }, "✕"),
      el("h2", { class: "builder__title" }, title || "Loading…"),
      el("span", { class: "builder__save builder__save--ghost", "aria-hidden": "true" }, "Save")
    ),
    el(
      "div",
      { class: "builder__body" },
      el(
        "div",
        { class: "statepanel" },
        el("div", { class: "statepanel__dot" }),
        el("p", { class: "statepanel__msg" }, "Loading routine…")
      )
    )
  );
  showBuilder();
}

function openBuilderCreate() {
  closeDrawer();
  Object.assign(builder, {
    open: true,
    mode: "create",
    programId: null,
    origin: null,
    dirty: false,
    name: "",
    subtitle: "",
    days: [blankDay()],
  });
  renderBuilder();
  showBuilder();
}

async function openBuilderEdit(id) {
  closeDrawer();
  showBuilderLoading("Edit routine");
  try {
    const p = await apiJSON(`/api/programs/${encodeURIComponent(id)}`);
    Object.assign(builder, {
      mode: "edit",
      programId: p.id,
      origin: p.origin,
      dirty: false,
      name: p.name,
      subtitle: p.subtitle || "",
      days: p.days.map((d) => cloneDay(d, true)),
    });
    renderBuilder();
  } catch (err) {
    hideBuilder();
    toast(err.message || "Couldn't open this routine.", { type: "err" });
  }
}

async function openBuilderDuplicate(id) {
  closeDrawer();
  showBuilderLoading("New routine");
  try {
    const p = await apiJSON(`/api/programs/${encodeURIComponent(id)}`);
    Object.assign(builder, {
      mode: "create",
      programId: null,
      origin: null,
      dirty: false,
      name: `${p.name} (copy)`,
      subtitle: p.subtitle || "",
      days: p.days.map((d) => cloneDay(d, false)),
    });
    renderBuilder();
  } catch (err) {
    hideBuilder();
    toast(err.message || "Couldn't duplicate this routine.", { type: "err" });
  }
}

/* ---- rendering ---- */
function renderBuilder() {
  const root = $("#builder");
  root.innerHTML = "";

  const xBtn = el("button", { class: "builder__x", type: "button", "aria-label": "Close builder" }, "✕");
  xBtn.addEventListener("click", cancelBuilder);

  const saveBtn = el(
    "button",
    { id: "builderSave", class: "builder__save", type: "button" },
    el("span", { class: "builder__save-label" }, "Save"),
    el("span", { class: "builder__save-spin", "aria-hidden": "true" })
  );
  saveBtn.addEventListener("click", saveBuilder);

  const bar = el(
    "div",
    { class: "builder__bar" },
    xBtn,
    el("h2", { id: "builderTitle", class: "builder__title" }, builder.mode === "edit" ? "Edit routine" : "New routine"),
    saveBtn
  );

  const body = el("div", { class: "builder__body" });

  // meta
  const nameField = builderField("Routine name", "bName", builder.name, "e.g. Push / Pull / Legs", (v) => {
    builder.name = v;
  });
  nameField.querySelector("input").setAttribute("required", "");
  const subField = builderField("Subtitle", "bSubtitle", builder.subtitle, "optional — e.g. 4 days / week", (v) => {
    builder.subtitle = v;
  });
  body.append(el("div", { class: "builder__meta" }, nameField, subField));

  // template (create only)
  if (builder.mode === "create") body.append(templateBlock());

  // days
  body.append(el("div", { class: "builder__sechead" }, el("h3", {}, "Days")));
  body.append(el("div", { id: "builderDays", class: "builder__days" }));
  const addDayBtn = el("button", { class: "builder__adddaybtn", type: "button" }, "+ Add day");
  addDayBtn.addEventListener("click", addDay);
  body.append(addDayBtn);

  root.append(bar, body);
  renderDays();
}

function builderField(label, id, value, placeholder, onInput) {
  const input = el("input", {
    id,
    class: "bfield__input",
    type: "text",
    value: value || "",
    placeholder,
    autocomplete: "off",
  });
  input.addEventListener("input", () => {
    onInput(input.value);
    markDirty();
    input.classList.remove("is-error");
  });
  return el("label", { class: "bfield" }, el("span", { class: "bfield__label" }, label), input);
}

function templateBlock() {
  const sel = el("select", { id: "bTemplate", class: "bfield__input bfield__select" });
  sel.append(el("option", { value: "" }, "Blank"));
  state.programs.forEach((p) => sel.append(el("option", { value: p.id }, `Duplicate: ${p.name}`)));
  sel.addEventListener("change", () => onTemplateChange(sel));
  return el(
    "label",
    { class: "bfield bfield--template" },
    el("span", { class: "bfield__label" }, "Start from"),
    sel
  );
}

async function onTemplateChange(sel) {
  const val = sel.value;
  const hasEntries =
    builder.name.trim() || builder.days.some((d) => d.label.trim() || d.exercises.some((e) => e.name.trim()));
  if (builder.dirty && hasEntries) {
    const ok = await confirmDialog({
      title: "Replace draft?",
      message: "Loading a template replaces your current entries.",
      confirmLabel: "Replace",
      danger: true,
    });
    if (!ok) {
      sel.value = "";
      return;
    }
  }
  if (!val) {
    Object.assign(builder, { name: "", subtitle: "", days: [blankDay()] });
  } else {
    try {
      const p = await apiJSON(`/api/programs/${encodeURIComponent(val)}`);
      Object.assign(builder, {
        name: `${p.name} (copy)`,
        subtitle: p.subtitle || "",
        days: p.days.map((d) => cloneDay(d, false)),
      });
    } catch (err) {
      toast(err.message || "Couldn't load template.", { type: "err" });
      sel.value = "";
      return;
    }
  }
  builder.dirty = true;
  renderBuilder();
}

function renderDays() {
  const wrap = $("#builderDays");
  wrap.innerHTML = "";
  if (!builder.days.length) {
    wrap.append(el("p", { class: "builder__empty" }, "No days yet — add your first training day."));
    return;
  }
  builder.days.forEach((d, i) => wrap.append(buildDayEditor(d, i)));
}

function buildDayEditor(d, i) {
  const first = i === 0;
  const last = i === builder.days.length - 1;

  const up = moveButton("Move day up", first, () => moveDay(i, -1), "↑");
  const down = moveButton("Move day down", last, () => moveDay(i, 1), "↓");
  const del = el("button", { class: "bdel", type: "button", "aria-label": `Remove day ${i + 1}` }, "✕");
  del.addEventListener("click", () => removeDay(i));

  const labelInput = el("input", {
    class: "bday__label",
    type: "text",
    value: d.label || "",
    placeholder: "Label — e.g. Push",
    autocomplete: "off",
    "aria-label": `Day ${i + 1} label`,
  });
  labelInput.addEventListener("input", () => {
    d.label = labelInput.value;
    markDirty();
    labelInput.classList.remove("is-error");
  });
  const titleInput = el("input", {
    class: "bday__title",
    type: "text",
    value: d.title || "",
    placeholder: "Title (optional) — e.g. Push — Chest + Shoulders",
    autocomplete: "off",
    "aria-label": `Day ${i + 1} title`,
  });
  titleInput.addEventListener("input", () => {
    d.title = titleInput.value;
    markDirty();
  });

  const exList = el("div", { class: "bexlist" });
  d.exercises.forEach((e, j) => exList.append(buildExEditor(d, e, i, j)));

  const addEx = el("button", { class: "bexadd", type: "button" }, "+ Add exercise");
  addEx.addEventListener("click", () => addExercise(i));

  return el(
    "section",
    { class: "bday", "data-i": String(i) },
    el(
      "div",
      { class: "bday__head" },
      el("span", { class: "bday__num" }, `Day ${i + 1}`),
      el("div", { class: "bday__tools" }, up, down, del)
    ),
    el("div", { class: "bday__fields" }, labelInput, titleInput),
    exList,
    addEx
  );
}

function buildExEditor(d, e, i, j) {
  const first = j === 0;
  const last = j === d.exercises.length - 1;

  const up = moveButton("Move exercise up", first, () => moveExercise(i, j, -1), "↑");
  const down = moveButton("Move exercise down", last, () => moveExercise(i, j, 1), "↓");
  const del = el("button", { class: "bdel bdel--sm", type: "button", "aria-label": "Remove exercise" }, "✕");
  del.addEventListener("click", () => removeExercise(i, j));

  const nameInput = el("input", {
    class: "bex__name",
    type: "text",
    value: e.name || "",
    placeholder: "Exercise name",
    autocomplete: "off",
    "aria-label": "Exercise name",
  });
  nameInput.addEventListener("input", () => {
    e.name = nameInput.value;
    markDirty();
    nameInput.classList.remove("is-error");
  });

  const grid = el(
    "div",
    { class: "bex__grid" },
    exField(e, "category", "Category", { list: "catPresets" }),
    exField(e, "sets", "Sets"),
    exField(e, "reps", "Reps"),
    exField(e, "weight", "Weight")
  );

  const notes = el("input", {
    class: "bex__notes",
    type: "text",
    value: e.notes || "",
    placeholder: "Notes / cues (optional)",
    autocomplete: "off",
    "aria-label": "Notes",
  });
  notes.addEventListener("input", () => {
    e.notes = notes.value;
    markDirty();
  });

  return el(
    "div",
    { class: "bex", "data-j": String(j) },
    el("div", { class: "bex__top" }, nameInput, el("div", { class: "bex__tools" }, up, down, del)),
    grid,
    notes
  );
}

function exField(e, key, placeholder, extra = {}) {
  const input = el("input", {
    class: "bex__in",
    type: "text",
    value: e[key] || "",
    placeholder,
    autocomplete: "off",
    "aria-label": placeholder,
    ...extra,
  });
  input.addEventListener("input", () => {
    e[key] = input.value;
    markDirty();
  });
  return input;
}

function moveButton(label, disabled, fn, glyph) {
  const b = el("button", { class: "bmove", type: "button", "aria-label": label, disabled: disabled ? "" : null }, glyph);
  if (!disabled) b.addEventListener("click", fn);
  return b;
}

/* ---- structural mutations ---- */
function addDay() {
  builder.days.push(blankDay());
  markDirty();
  renderDays();
  focusSel(`.bday[data-i="${builder.days.length - 1}"] .bday__label`);
}
function removeDay(i) {
  builder.days.splice(i, 1);
  markDirty();
  renderDays();
}
function moveDay(i, dir) {
  const j = i + dir;
  if (j < 0 || j >= builder.days.length) return;
  [builder.days[i], builder.days[j]] = [builder.days[j], builder.days[i]];
  markDirty();
  renderDays();
}
function addExercise(i) {
  builder.days[i].exercises.push(blankExercise());
  markDirty();
  renderDays();
  focusSel(`.bday[data-i="${i}"] .bex[data-j="${builder.days[i].exercises.length - 1}"] .bex__name`);
}
function removeExercise(i, j) {
  builder.days[i].exercises.splice(j, 1);
  markDirty();
  renderDays();
}
function moveExercise(i, j, dir) {
  const arr = builder.days[i].exercises;
  const k = j + dir;
  if (k < 0 || k >= arr.length) return;
  [arr[j], arr[k]] = [arr[k], arr[j]];
  markDirty();
  renderDays();
}
function focusSel(sel) {
  const node = $(sel);
  if (node) node.focus();
}

/* ---- validation + save ---- */
function validateBuilder() {
  $$("#builder .is-error").forEach((n) => n.classList.remove("is-error"));
  const bad = [];
  const nameEl = $("#bName");
  if (!builder.name.trim() && nameEl) {
    nameEl.classList.add("is-error");
    bad.push(nameEl);
  }
  if (!builder.days.length) {
    toast("Add at least one day.", { type: "err" });
  }
  builder.days.forEach((d, i) => {
    if (!d.label.trim()) {
      const n = $(`.bday[data-i="${i}"] .bday__label`);
      if (n) {
        n.classList.add("is-error");
        bad.push(n);
      }
    }
    d.exercises.forEach((e, j) => {
      if (!e.name.trim()) {
        const n = $(`.bday[data-i="${i}"] .bex[data-j="${j}"] .bex__name`);
        if (n) {
          n.classList.add("is-error");
          bad.push(n);
        }
      }
    });
  });
  return bad;
}

function buildPayload() {
  const keepIds = builder.mode === "edit";
  return {
    name: builder.name.trim(),
    subtitle: builder.subtitle.trim(),
    days: builder.days.map((d) => {
      const day = {
        ...(keepIds && d.id != null ? { id: d.id } : {}),
        label: d.label.trim(),
        title: (d.title || "").trim(),
        exercises: d.exercises.map((e) => ({
          ...(keepIds && e.id != null ? { id: e.id } : {}),
          name: e.name.trim(),
          category: (e.category || "").trim(),
          sets: (e.sets || "").trim(),
          reps: (e.reps || "").trim(),
          weight: (e.weight || "").trim(),
          notes: (e.notes || "").trim(),
        })),
      };
      return day;
    }),
  };
}

async function saveBuilder() {
  const bad = validateBuilder();
  if (bad.length || !builder.days.length) {
    if (bad.length) {
      bad[0].focus();
      bad[0].scrollIntoView({ block: "center", behavior: "smooth" });
      toast("Fill in the highlighted required fields.", { type: "err" });
    }
    return;
  }

  const payload = buildPayload();
  const saveBtn = $("#builderSave");
  saveBtn.classList.add("is-busy");
  saveBtn.disabled = true;

  const isEdit = builder.mode === "edit";
  try {
    const saved = isEdit
      ? await apiJSON(`/api/programs/${encodeURIComponent(builder.programId)}`, { method: "PUT", body: payload })
      : await apiJSON("/api/programs", { method: "POST", body: payload });

    builder.dirty = false;
    hideBuilder();
    await reloadPrograms();
    await selectProgram(saved.id, null, { force: true });
    setView("train");
    toast(isEdit ? "Routine saved." : "Routine created.", { type: "ok" });
  } catch (err) {
    toast(err.message || "Couldn't save this routine.", { type: "err" });
  } finally {
    saveBtn.classList.remove("is-busy");
    saveBtn.disabled = false;
  }
}

async function cancelBuilder() {
  if (builder.dirty) {
    const ok = await confirmDialog({
      title: "Discard changes?",
      message: "Your unsaved routine changes will be lost.",
      confirmLabel: "Discard",
      danger: true,
    });
    if (!ok) return;
  }
  builder.dirty = false;
  hideBuilder();
}

$("#newRoutineBtn").addEventListener("click", openBuilderCreate);

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
