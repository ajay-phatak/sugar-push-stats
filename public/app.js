/* sugar-push-stats frontend: fetches raw deviations from the API and does all
   weighting/filtering client-side so control changes re-render instantly. */

const $ = (id) => document.getElementById(id);

const METHOD_NOTES = {
  linear: "Linear: every point of disagreement counts equally.",
  logarithmic: "Logarithmic: forgiving of the occasional wild outlier mark; consistent small disagreement weighs more.",
  exponential: "Exponential (RMS): wild outlier marks are punished hardest.",
};

// Only the main WSDC levels get their own chip groups; everything else
// (Masters, Sophisticated, Juniors, Pro-Am, All American, routines, ...)
// falls into "Other".
const LEVEL_ORDER = ["Newcomer", "Novice", "Intermediate", "Advanced", "All-Star", "Champions"];
const LEVEL_KEYWORDS = {
  "Newcomer": ["newcomer"],
  "Novice": ["novice"],
  "Intermediate": ["intermediate"],
  "Advanced": ["advanced"],
  "All-Star": ["all star", "all-star", "allstar"],
  "Champions": ["champion", "invitational"],
};

const state = {
  data: null,          // AnalysisResponse from the API
  method: "linear",
  rounds: "finals",
  enabledDivisions: new Set(),
  selectedJudge: null,
  mainChart: null,
  detailChart: null,
  openGroups: new Set(),
  hideLowSample: false,
  view: "judge",        // "judge" | "division"
  marauder: false,      // Marauder's Map card revealed?
  marauderName: "",
  marauderHideLowSample: true,
  // year (string) -> { status: "loading"|"done", deviations: [], eventNames: Map(slug -> name), failures: [], noSigned: [] }
  marauderCache: new Map(),
};

/* ---------- palette (read from CSS so light/dark stays in style.css) ---------- */

function palette() {
  const cs = getComputedStyle(document.querySelector(".viz-root"));
  const v = (name) => cs.getPropertyValue(name).trim();
  return {
    series1: v("--series-1"),
    series2: v("--series-2"),
    grid: v("--grid"),
    baseline: v("--baseline"),
    muted: v("--muted"),
    textSecondary: v("--text-secondary"),
    surface: v("--surface-1"),
  };
}

/* ---------- scoring ---------- */

function weight(d, method) {
  if (method === "logarithmic") return Math.log(1 + 9 * d) / Math.log(10);
  if (method === "exponential") return d * d;
  return d;
}

function aggregate(ds, method) {
  if (!ds.length) return 0;
  const mean = ds.reduce((s, d) => s + weight(d, method), 0) / ds.length;
  return method === "exponential" ? Math.sqrt(mean) : mean;
}

function filteredDeviations() {
  const wantPrelims = state.rounds === "all";
  return state.data.deviations.filter((p) =>
    (p.round === "finals" || wantPrelims) && state.enabledDivisions.has(p.division)
  );
}

function judgeScores() {
  const byJudge = new Map();
  for (const p of filteredDeviations()) {
    if (!byJudge.has(p.judge)) byJudge.set(p.judge, []);
    byJudge.get(p.judge).push(p);
  }
  const rows = [];
  for (const [judge, pts] of byJudge) {
    const ds = pts.map((p) => p.deviation);
    rows.push({
      judge,
      score: aggregate(ds, state.method),
      n: pts.length,
      nFinals: pts.filter((p) => p.round === "finals").length,
      nPrelims: pts.filter((p) => p.round === "prelims").length,
      worst: Math.max(...ds),
      points: pts,
    });
  }
  rows.sort((a, b) => a.score - b.score);
  return rows;
}

// On narrow screens long y-axis labels would eat half the plot width; the
// tooltip still carries the full name.
function yTickLabel(chart, value) {
  const label = chart.getLabelForValue(value);
  if (window.innerWidth >= 640 || label.length <= 20) return label;
  return label.slice(0, 19) + "…";
}

function median(nums) {
  const s = nums.slice().sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// Hides judges with fewer than half the median mark count (min 5). If that
// would hide every judge, the filter is ignored and everyone is shown.
function applyLowSampleFilter(rows) {
  if (!state.hideLowSample || !rows.length) return { rows, hiddenCount: 0, active: false };
  const threshold = Math.max(5, Math.floor(0.5 * median(rows.map((r) => r.n))));
  const filtered = rows.filter((r) => r.n >= threshold);
  if (!filtered.length) return { rows, hiddenCount: 0, active: false };
  return { rows: filtered, hiddenCount: rows.length - filtered.length, active: true };
}

function divisionScores() {
  const byDiv = new Map();
  for (const p of filteredDeviations()) {
    if (!byDiv.has(p.division)) byDiv.set(p.division, { name: p.division, points: [], judges: new Set(), round: p.round });
    const entry = byDiv.get(p.division);
    entry.points.push(p);
    entry.judges.add(p.judge);
    if (p.round === "finals") entry.round = "finals"; // mixed divisions count as finals
  }
  const rows = [];
  for (const [, entry] of byDiv) {
    const ds = entry.points.map((p) => p.deviation);
    rows.push({
      name: entry.name,
      round: entry.round,
      score: aggregate(ds, state.method),
      judgeCount: entry.judges.size,
      n: entry.points.length,
    });
  }
  rows.sort((a, b) => a.score - b.score);
  return rows;
}

/* ---------- division grouping ---------- */

function levelOf(name) {
  const n = name.toLowerCase();
  // Pro-Am divisions mention a level ("Pro-Am ... Intermediate ...") but
  // belong in Other, so check for them before the level keywords.
  if (/pro-?\s?am/.test(n)) return "Other";
  for (const lvl of LEVEL_ORDER) {
    if (LEVEL_KEYWORDS[lvl].some((k) => n.includes(k))) return lvl;
  }
  return "Other";
}

function uniqueDivisions() {
  // Only divisions relevant to the current rounds selection get chips;
  // prelims divisions keep their enabled/disabled state while hidden.
  const wantPrelims = state.rounds === "all";
  const map = new Map();
  for (const d of state.data.divisions) {
    if (d.round === "prelims" && !wantPrelims) continue;
    if (!map.has(d.name)) map.set(d.name, { name: d.name, fieldSize: 0 });
    map.get(d.name).fieldSize += d.field_size;
  }
  return [...map.values()];
}

function groupedDivisions() {
  const divs = uniqueDivisions();
  const groups = new Map();
  for (const d of divs) {
    const lvl = levelOf(d.name);
    if (!groups.has(lvl)) groups.set(lvl, []);
    groups.get(lvl).push(d);
  }
  const ordered = [];
  for (const lvl of LEVEL_ORDER) {
    if (groups.has(lvl)) ordered.push([lvl, groups.get(lvl)]);
  }
  if (groups.has("Other")) ordered.push(["Other", groups.get("Other")]);
  return ordered;
}

/* ---------- controls ---------- */

function populateYearSelect(sel, thisYear) {
  for (let y = thisYear; y >= 2019; y--) {
    sel.add(new Option(String(y), String(y)));
  }
}

function initControls() {
  const yearSel = $("year");
  const thisYear = new Date().getFullYear();
  populateYearSelect(yearSel, thisYear);
  yearSel.addEventListener("change", () => loadEvents(Number(yearSel.value)));
  $("event").addEventListener("change", () => loadAnalysis());

  populateYearSelect($("marauder-year"), thisYear);

  wireSegmented($("rounds-toggle"), (val) => {
    state.rounds = val;
    buildChips();
    render();
  });
  wireSegmented($("method-toggle"), (val) => {
    state.method = val;
    $("method-note").textContent = METHOD_NOTES[state.method];
    render();
  });
  $("method-note").textContent = METHOD_NOTES[state.method];

  wireSegmented($("view-toggle"), (val) => {
    state.view = val;
    render();
  });

  $("hide-low-sample").addEventListener("click", () => {
    const btn = $("hide-low-sample");
    const on = btn.getAttribute("aria-pressed") === "true";
    state.hideLowSample = !on;
    btn.setAttribute("aria-pressed", String(!on));
    render();
  });

  const infoBtn = $("method-info-btn");
  const explainer = $("method-explainer");
  infoBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const open = infoBtn.getAttribute("aria-expanded") === "true";
    infoBtn.setAttribute("aria-expanded", String(!open));
    explainer.hidden = open;
  });
  document.addEventListener("click", (e) => {
    if (!explainer.hidden && !explainer.contains(e.target) && e.target !== infoBtn) {
      explainer.hidden = true;
      infoBtn.setAttribute("aria-expanded", "false");
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !explainer.hidden) {
      explainer.hidden = true;
      infoBtn.setAttribute("aria-expanded", "false");
      infoBtn.focus();
    }
  });

  $("divisions-all").addEventListener("click", () => {
    for (const d of uniqueDivisions()) state.enabledDivisions.add(d.name);
    buildChips();
    render();
  });
  $("divisions-none").addEventListener("click", () => {
    for (const d of uniqueDivisions()) state.enabledDivisions.delete(d.name);
    buildChips();
    render();
  });

  $("detail-close").addEventListener("click", () => {
    state.selectedJudge = null;
    renderDetail(judgeScores());
  });

  $("marauder-name").addEventListener("input", (e) => {
    state.marauderName = e.target.value;
    // renderMarauder never fetches — before the year is cached it just shows
    // the "Press Reveal" hint, so live re-rendering here is always safe. The
    // one exception: don't clobber an in-flight fan-out's progress line.
    const entry = state.marauderCache.get($("marauder-year").value);
    if (!entry || entry.status === "done") renderMarauder();
  });
  $("marauder-name").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      startMarauderSearch();
    }
  });
  $("marauder-go").addEventListener("click", () => startMarauderSearch());
  $("marauder-low-sample").addEventListener("click", () => {
    const btn = $("marauder-low-sample");
    state.marauderHideLowSample = !state.marauderHideLowSample;
    btn.setAttribute("aria-pressed", String(state.marauderHideLowSample));
    const entry = state.marauderCache.get($("marauder-year").value);
    if (!entry || entry.status === "done") renderMarauder();
  });
  $("marauder-year").addEventListener("change", () => {
    buildMarauderNames();
    renderMarauder();
  });
  $("mischief-managed").addEventListener("click", () => {
    state.marauder = false;
    $("marauder-card").hidden = true;
  });

  initThemeToggle();
  initMarauderTrigger();
  loadEvents(thisYear);
}

/* ---------- the Marauder's Map (hidden easter egg) ---------- */

// Typing this phrase anywhere on the page reveals a hidden card that ranks
// judges by how favorably they marked a given competitor. Not linked from any
// visible UI on purpose — stays secret across reloads (no localStorage).
const MARAUDER_PHRASE = "i solemnly swear that i am up to no good";

function initMarauderTrigger() {
  let buffer = "";
  document.addEventListener("keydown", (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key.length !== 1) return; // printable characters only, no Shift/Tab/etc.
    buffer = (buffer + e.key.toLowerCase()).slice(-60);
    if (buffer.endsWith(MARAUDER_PHRASE)) {
      buffer = "";
      state.marauder = true;
      $("marauder-card").hidden = false;
      // Default the year picker to whatever's loaded above, but only before
      // any fan-out has ever happened — once a year is cached, respect
      // whatever the user already picked.
      if (state.marauderCache.size === 0) {
        $("marauder-year").value = $("year").value;
      }
      buildMarauderNames();
      renderMarauder();
      $("marauder-card").scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  });
}

// Unique individual competitor names for the datalist. Couples are written
// "Alice Smith and Bob Jones" (or "... & ...") — split on the separator so
// both partners are searchable. The spaces around "and" keep names like
// "Alexandra" intact.
function buildMarauderNames() {
  // Prefer the selected year's cached aggregate once it's fully loaded;
  // otherwise fall back to whatever single event is currently on screen.
  const yearEntry = state.marauderCache.get($("marauder-year").value);
  const source = (yearEntry && yearEntry.status === "done")
    ? yearEntry.deviations
    : (state.data ? state.data.deviations : []);

  const seen = new Map(); // lowercase -> first-seen display casing
  for (const p of source) {
    for (const part of p.competitor.split(/\s+(?:and|&)\s+/i)) {
      const name = part.trim();
      if (!name) continue;
      const key = name.toLowerCase();
      if (!seen.has(key)) seen.set(key, name);
    }
  }
  const sorted = [...seen.values()].sort((a, b) => a.localeCompare(b));
  const list = $("marauder-names");
  list.innerHTML = "";
  for (const name of sorted) list.appendChild(new Option(name));
}

function marauderFavorSpan(favor) {
  const cls = favor > 0 ? "favor-pos" : favor < 0 ? "favor-neg" : "";
  const sign = favor > 0 ? "+" : favor < 0 ? "−" : "";
  return `<span class="favor ${cls}">${sign}${Math.abs(favor).toFixed(3)}</span>`;
}

function pluralize(n, word) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function marauderJudgeList(rows) {
  return `
    <ul class="marauder-judge-list">
      ${rows.map((r) => `
        <li>
          <span class="mj-name">${escapeHtml(r.judge)}</span>
          ${marauderFavorSpan(r.favor)}
          <span class="mj-n">${pluralize(r.n, "mark")} · ${pluralize(r.events.size, "event")}</span>
        </li>
      `).join("")}
    </ul>
  `;
}

// Fetches every event of `year` and folds their deviations into
// state.marauderCache, updating a progress line in #marauder-results as
// each event settles. Guards against a second fan-out for the same year.
async function loadMarauderYear(year) {
  const already = state.marauderCache.get(year);
  if (already && already.status === "loading") return;

  const entry = { status: "loading", deviations: [], eventNames: new Map(), failures: [], noSigned: [] };
  state.marauderCache.set(year, entry);

  const box = $("marauder-results");
  let events;
  try {
    const resp = await fetch(`/api/events?year=${year}`);
    if (!resp.ok) throw new Error((await resp.json()).detail || resp.statusText);
    events = await resp.json();
  } catch (err) {
    state.marauderCache.delete(year);
    box.innerHTML = `<p class="card-note">Could not load the ${escapeHtml(String(year))} event list: ${escapeHtml(err.message)}</p>`;
    return;
  }

  for (const ev of events) entry.eventNames.set(ev.slug, ev.name);

  const total = events.length;
  let done = 0;
  const updateProgress = (currentName) => {
    box.innerHTML = `
      <p class="card-note">Summoning scoresheets… ${done} of ${total} events${currentName ? ` (${escapeHtml(currentName)})` : ""}</p>
      <p class="marauder-footnote">First fetches of an event can be slow.</p>
    `;
  };
  updateProgress("");

  const CONCURRENCY = 4;
  let idx = 0;
  async function worker() {
    while (idx < events.length) {
      const ev = events[idx++];
      try {
        const resp = await fetch(`/api/analysis?year=${year}&event=${encodeURIComponent(ev.slug)}`);
        if (!resp.ok) throw new Error((await resp.json()).detail || resp.statusText);
        const data = await resp.json();
        const all = data.deviations || [];
        const withSigned = all.filter((p) => p.signed !== undefined && p.signed !== null);
        if (all.length && !withSigned.length) {
          entry.noSigned.push(ev.name);
        } else {
          for (const p of withSigned) entry.deviations.push({ ...p, event: ev.name });
        }
      } catch (err) {
        entry.failures.push(ev.name);
      }
      done++;
      updateProgress(ev.name);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, events.length) }, () => worker()));

  entry.status = "done";
  buildMarauderNames();
  renderMarauder();
}

// Wired to #marauder-go and Enter in the name field: fetches the selected
// year if it isn't cached yet, otherwise just re-renders against the cache.
function startMarauderSearch() {
  const year = $("marauder-year").value;
  const entry = state.marauderCache.get(year);
  if (entry && entry.status === "loading") return; // fan-out already in flight
  if (entry && entry.status === "done") {
    renderMarauder();
    return;
  }
  loadMarauderYear(year);
}

function renderMarauder() {
  const box = $("marauder-results");
  const year = $("marauder-year").value;
  const query = state.marauderName.trim();

  if (query.length < 3) {
    box.innerHTML = "";
    return;
  }

  const cacheEntry = state.marauderCache.get(year);
  if (cacheEntry && cacheEntry.status === "loading") {
    box.innerHTML = `<p class="card-note">Summoning ${escapeHtml(year)} scoresheets…</p>`;
    return;
  }
  if (!cacheEntry) {
    box.innerHTML = `<p class="card-note">Press Reveal to fetch all ${escapeHtml(year)} events.</p>`;
    return;
  }

  const q = query.toLowerCase();
  const matched = cacheEntry.deviations.filter((p) => p.competitor.toLowerCase().includes(q));
  if (!matched.length) {
    box.innerHTML = `<p class="card-note">No competitor matching that name in ${escapeHtml(year)}.</p>`;
    return;
  }

  const byJudge = new Map();
  for (const p of matched) {
    if (!byJudge.has(p.judge)) byJudge.set(p.judge, []);
    byJudge.get(p.judge).push(p);
  }
  const judgeRows = [];
  for (const [judge, pts] of byJudge) {
    judgeRows.push({
      judge,
      favor: pts.reduce((s, p) => s + p.signed, 0) / pts.length,
      n: pts.length,
      events: new Set(pts.map((p) => p.event)),
      points: pts,
    });
  }
  judgeRows.sort((a, b) => b.favor - a.favor);

  const distinctCompetitors = [...new Set(matched.map((p) => p.competitor))];
  const distinctEvents = new Set(matched.map((p) => p.event));
  const namesShown = distinctCompetitors.slice(0, 6).map((c) => escapeHtml(c)).join(", ");
  const namesMore = distinctCompetitors.length - 6;

  const summary = `<strong>${pluralize(matched.length, "mark")}</strong> matched "${escapeHtml(query)}" ` +
    `across ${pluralize(judgeRows.length, "judge")} and ${pluralize(distinctEvents.size, "event")}`;
  const namesLine = namesShown + (namesMore > 0 ? ` +${namesMore} more` : "");

  // Year-wide data exists precisely so a single lucky mark can't dominate:
  // rank only judges with a decent sample, as long as enough of them qualify
  // to fill both lists. The toggle lets the curious rank everyone anyway.
  let minMarks = 1;
  if (state.marauderHideLowSample) {
    for (const t of [3, 2]) {
      if (judgeRows.filter((r) => r.n >= t).length >= 6) { minMarks = t; break; }
    }
  }
  const ranked = judgeRows.filter((r) => r.n >= minMarks);

  const top3 = ranked.slice(0, 3);
  const bottom3 = ranked.slice(-3).reverse();

  box.innerHTML = `
    <p class="card-note">${summary}</p>
    <p class="card-note">${namesLine}</p>
    <div class="marauder-lists">
      <div>
        <h3 class="marauder-list-title">Most favorable</h3>
        ${marauderJudgeList(top3)}
      </div>
      <div>
        <h3 class="marauder-list-title">Least favorable</h3>
        ${marauderJudgeList(bottom3)}
      </div>
    </div>
    <p class="marauder-footnote">Favor = average signed deviation from the official result: + means the judge marked them better than they placed, − worse. Values near 0 mean the judge agreed with the outcome.</p>
    ${minMarks > 1 ? `<p class="marauder-footnote">Ranked among the ${pluralize(ranked.length, "judge")} with at least ${minMarks} marks on this competitor; single-mark judges are too noisy to rank.</p>` : ""}
    ${cacheEntry.failures.length ? `<p class="marauder-footnote">Couldn't load: ${cacheEntry.failures.map((n) => escapeHtml(n)).join(", ")}.</p>` : ""}
    ${cacheEntry.noSigned.length ? `<p class="marauder-footnote">No favor data (stale cache): ${cacheEntry.noSigned.map((n) => escapeHtml(n)).join(", ")}.</p>` : ""}
  `;
}

/* The head script resolves data-theme before first paint; this button flips
   it, persists the choice, and re-renders the charts (they read colors from
   the CSS variables at draw time). */
function initThemeToggle() {
  const btn = $("theme-toggle");
  const apply = (theme) => {
    document.documentElement.dataset.theme = theme;
    btn.textContent = theme === "dark" ? "☀" : "☾";
    btn.setAttribute("aria-label", theme === "dark" ? "Switch to light mode" : "Switch to dark mode");
    render();
  };
  btn.addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    localStorage.setItem("theme", next);
    apply(next);
  });
  // While no explicit choice is stored, keep following the system setting.
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", (e) => {
    if (!localStorage.getItem("theme")) apply(e.matches ? "dark" : "light");
  });
  apply(document.documentElement.dataset.theme || "light");
}

function wireSegmented(container, onChange) {
  container.addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn || !container.contains(btn)) return;
    for (const b of container.querySelectorAll("button")) b.setAttribute("aria-pressed", String(b === btn));
    onChange(btn.dataset.value);
  });
}

/* ---------- status region ---------- */

function setStatus(html) {
  $("status-region").innerHTML = html;
}

function clearStatus() {
  $("status-region").innerHTML = "";
}

function statusLoading(msg) {
  setStatus(`
    <div class="state-card">
      <div class="state-icon">⟳</div>
      <div>
        <p class="state-title">Fetching scoresheets…</p>
        <p class="state-body">${escapeHtml(msg)}</p>
      </div>
    </div>
    <div class="card">
      <div class="skeleton-bars">
        ${Array.from({ length: 6 }).map(() => `
          <div class="sk-row">
            <div class="sk-label"></div>
            <div class="sk-bar" style="max-width:${30 + Math.random() * 55}%"></div>
          </div>`).join("")}
      </div>
    </div>
  `);
}

function statusError(msg) {
  setStatus(`
    <div class="state-card error">
      <div class="state-icon">!</div>
      <div>
        <p class="state-title">Couldn't load that</p>
        <p class="state-body">${escapeHtml(msg)}</p>
      </div>
    </div>
  `);
}

function statusEmpty() {
  setStatus(`
    <div class="state-card">
      <div class="state-icon">♪</div>
      <div>
        <p class="state-title">Pick a year and event</p>
        <p class="state-body">Once you choose an event, its scoresheets are fetched and parsed — first load can take a few seconds.</p>
      </div>
    </div>
  `);
}

function escapeHtml(s) {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

async function loadEvents(year) {
  const evSel = $("event");
  evSel.disabled = true;
  evSel.innerHTML = "<option>Loading…</option>";
  $("results").hidden = true;
  statusEmpty();
  try {
    const resp = await fetch(`/api/events?year=${year}`);
    if (!resp.ok) throw new Error((await resp.json()).detail || resp.statusText);
    const events = await resp.json();
    evSel.innerHTML = "";
    evSel.add(new Option("Choose an event…", ""));
    for (const ev of events) {
      evSel.add(new Option(`${ev.name} (${ev.dates})`, ev.slug));
    }
    evSel.disabled = false;
    statusEmpty();
  } catch (err) {
    evSel.innerHTML = "<option>—</option>";
    statusError(`Could not load events for ${year}: ${err.message}`);
  }
}

async function loadAnalysis() {
  const year = $("year").value;
  const slug = $("event").value;
  if (!slug) { statusEmpty(); return; }
  statusLoading("First load of an event can take a few seconds while scoresheets are fetched and parsed.");
  $("results").hidden = true;
  try {
    const resp = await fetch(`/api/analysis?year=${year}&event=${encodeURIComponent(slug)}`);
    if (!resp.ok) throw new Error((await resp.json()).detail || resp.statusText);
    state.data = await resp.json();
    state.enabledDivisions = new Set(state.data.divisions.map((d) => d.name));
    state.selectedJudge = null;
    state.openGroups = new Set(); // all chip groups start collapsed
    clearStatus();
    buildChips();
    renderWarnings();
    buildMarauderNames();
    renderMarauder();
    $("results").hidden = false;
    render();
  } catch (err) {
    statusError(`Analysis failed: ${err.message}`);
  }
}

function buildChips() {
  const groups = groupedDivisions();
  const total = uniqueDivisions().length;
  const enabled = uniqueDivisions().filter((d) => state.enabledDivisions.has(d.name)).length;
  $("division-count").innerHTML = `<strong>${enabled}</strong> of ${total} divisions included`;

  const box = $("division-groups");
  box.innerHTML = "";
  for (const [level, divs] of groups) {
    const wrap = document.createElement("div");
    wrap.className = "division-group";

    const enabledInGroup = divs.filter((d) => state.enabledDivisions.has(d.name)).length;
    const isOpen = state.openGroups.has(level);

    const header = document.createElement("button");
    header.type = "button";
    header.className = "group-header";
    header.setAttribute("aria-expanded", String(isOpen));
    header.innerHTML = `
      <span class="g-name">${escapeHtml(level)}</span>
      <span class="g-meta"><span>${enabledInGroup}/${divs.length}</span><span class="chevron">›</span></span>
    `;
    header.addEventListener("click", () => {
      if (state.openGroups.has(level)) state.openGroups.delete(level);
      else state.openGroups.add(level);
      buildChips();
    });

    const body = document.createElement("div");
    body.className = "group-body" + (isOpen ? " open" : "");

    const toolbar = document.createElement("div");
    toolbar.className = "group-toolbar";
    const allBtn = document.createElement("button");
    allBtn.type = "button";
    allBtn.textContent = "All";
    allBtn.addEventListener("click", () => {
      for (const d of divs) state.enabledDivisions.add(d.name);
      buildChips();
      render();
    });
    const noneBtn = document.createElement("button");
    noneBtn.type = "button";
    noneBtn.textContent = "None";
    noneBtn.style.marginLeft = "10px";
    noneBtn.addEventListener("click", () => {
      for (const d of divs) state.enabledDivisions.delete(d.name);
      buildChips();
      render();
    });
    toolbar.append(allBtn, noneBtn);

    const chipsRow = document.createElement("div");
    chipsRow.className = "chips";
    for (const div of divs) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "chip";
      btn.textContent = div.name;
      btn.setAttribute("aria-pressed", String(state.enabledDivisions.has(div.name)));
      btn.addEventListener("click", () => {
        const on = btn.getAttribute("aria-pressed") === "true";
        btn.setAttribute("aria-pressed", String(!on));
        if (on) state.enabledDivisions.delete(div.name);
        else state.enabledDivisions.add(div.name);
        buildChips();
        render();
      });
      chipsRow.appendChild(btn);
    }

    body.append(toolbar, chipsRow);
    wrap.append(header, body);
    box.appendChild(wrap);
  }
}

function renderWarnings() {
  const box = $("warnings");
  box.innerHTML = "";
  for (const w of state.data.warnings) {
    const p = document.createElement("p");
    p.textContent = `Note: ${w}`;
    box.appendChild(p);
  }
}

/* ---------- charts ---------- */

function render() {
  if (!state.data) return;
  if (state.view === "division") {
    renderDivisionView();
  } else {
    renderJudgeView();
  }
}

function renderJudgeView() {
  $("division-legend").hidden = true;
  $("low-sample-tools").hidden = false;
  $("chart-hint").textContent = "Click a bar to see that judge's individual marks.";

  const allRows = judgeScores();
  const { rows, hiddenCount, active } = applyLowSampleFilter(allRows);

  renderMainChart(rows);
  renderTable(rows);

  $("hidden-count").textContent = active && hiddenCount ? `· ${hiddenCount} hidden` : "";

  if (state.selectedJudge && !rows.some((r) => r.judge === state.selectedJudge)) {
    state.selectedJudge = null;
  }
  renderDetail(rows);
}

function renderDivisionView() {
  $("low-sample-tools").hidden = true;
  $("chart-hint").textContent = "";
  state.selectedJudge = null;
  renderDetail([]);

  const divRows = divisionScores();
  renderDivisionChart(divRows);
  renderTable(divRows);
}

function renderMainChart(rows) {
  const pal = palette();
  const box = $("main-chart").parentElement;
  box.style.height = `${Math.max(rows.length * 32 + 70, 160)}px`;
  $("main-title").textContent =
    `Judge consensus scores — ${state.data.event_name} ${state.data.year}` +
    (state.rounds === "all" ? " (finals + prelims)" : " (finals only)");
  $("main-note").textContent = "Lower = closer to the official outcome. Score is the weighted average deviation, normalized so different field sizes compare fairly.";

  if (state.mainChart) state.mainChart.destroy();
  state.mainChart = new Chart($("main-chart"), {
    type: "bar",
    data: {
      labels: rows.map((r) => r.judge),
      datasets: [{
        data: rows.map((r) => r.score),
        backgroundColor: pal.series1,
        borderRadius: 4,
        barThickness: 14,
      }],
    },
    options: {
      indexAxis: "y",
      maintainAspectRatio: false,
      animation: { duration: 200 },
      onClick(_, els) {
        if (!els.length) return;
        state.selectedJudge = rows[els[0].index].judge;
        renderDetail(judgeScores());
        $("detail-card").scrollIntoView({ behavior: "smooth", block: "nearest" });
      },
      onHover(evt, els) {
        evt.native.target.style.cursor = els.length ? "pointer" : "default";
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label(ctx) {
              const r = rows[ctx.dataIndex];
              const parts = [`score ${r.score.toFixed(3)}`, `${r.n} marks`];
              if (r.nPrelims) parts.push(`${r.nFinals} finals / ${r.nPrelims} prelims`);
              return parts;
            },
          },
        },
      },
      scales: {
        x: {
          beginAtZero: true,
          title: { display: true, text: "weighted average deviation (lower = more consensus)", color: pal.muted, font: { size: 11 } },
          grid: { color: pal.grid },
          border: { color: pal.baseline },
          ticks: { color: pal.muted },
        },
        y: {
          grid: { display: false },
          border: { color: pal.baseline },
          ticks: {
            color: pal.textSecondary,
            autoSkip: false,
            callback(value) { return yTickLabel(this.chart.scales.y, value); },
          },
        },
      },
    },
  });
}

function renderDivisionChart(divRows) {
  const pal = palette();
  const box = $("main-chart").parentElement;
  box.style.height = `${Math.max(divRows.length * 32 + 70, 160)}px`;
  $("main-title").textContent = `Division consensus — ${state.data.event_name} ${state.data.year}`;
  $("main-note").textContent = "Lower = judges agreed more on this division's marks; higher = the panel's marks were more scattered.";

  const hasFinals = divRows.some((d) => d.round === "finals");
  const hasPrelims = divRows.some((d) => d.round === "prelims");

  if (state.mainChart) state.mainChart.destroy();
  state.mainChart = new Chart($("main-chart"), {
    type: "bar",
    data: {
      labels: divRows.map((d) => d.name),
      datasets: [{
        data: divRows.map((d) => d.score),
        backgroundColor: divRows.map((d) => (d.round === "prelims" ? pal.series2 : pal.series1)),
        borderRadius: 4,
        barThickness: 14,
      }],
    },
    options: {
      indexAxis: "y",
      maintainAspectRatio: false,
      animation: { duration: 200 },
      onClick() {}, // division bars aren't interactive
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label(ctx) {
              const d = divRows[ctx.dataIndex];
              return `score ${d.score.toFixed(3)} · ${d.judgeCount} judges · ${d.n} marks`;
            },
          },
        },
      },
      scales: {
        x: {
          beginAtZero: true,
          title: { display: true, text: "average weighted deviation across all judges (lower = more agreement)", color: pal.muted, font: { size: 11 } },
          grid: { color: pal.grid },
          border: { color: pal.baseline },
          ticks: { color: pal.muted },
        },
        y: {
          grid: { display: false },
          border: { color: pal.baseline },
          ticks: {
            color: pal.textSecondary,
            autoSkip: false,
            callback(value) { return yTickLabel(this.chart.scales.y, value); },
          },
        },
      },
    },
  });

  const legend = $("division-legend");
  legend.innerHTML = "";
  if (hasFinals && hasPrelims) {
    legend.hidden = false;
    for (const [label, color] of [["Finals", pal.series1], ["Prelims", pal.series2]]) {
      const span = document.createElement("span");
      const sw = document.createElement("span");
      sw.className = "swatch";
      sw.style.background = color;
      span.append(sw, label);
      legend.appendChild(span);
    }
  } else {
    legend.hidden = true;
  }
}

function renderDetail(rows) {
  const card = $("detail-card");
  if (!state.selectedJudge) {
    card.hidden = true;
    if (state.detailChart) { state.detailChart.destroy(); state.detailChart = null; }
    return;
  }
  const row = rows.find((r) => r.judge === state.selectedJudge);
  if (!row) { card.hidden = true; return; }
  card.hidden = false;

  const pal = palette();
  $("detail-title").textContent = row.judge;

  const rank = rows.findIndex((r) => r.judge === state.selectedJudge) + 1;
  $("detail-badges").innerHTML = `
    <span class="badge rank">Rank <strong>#${rank}</strong> of ${rows.length}</span>
    <span class="badge">Score <strong>${row.score.toFixed(3)}</strong></span>
    <span class="badge"><strong>${row.n}</strong> marks</span>
    <span class="badge">Worst <strong>${row.worst.toFixed(3)}</strong></span>
  `;

  const divisions = [...new Set(row.points.map((p) => p.division))];
  const jitter = () => (Math.random() - 0.5) * 0.5;
  const toPoint = (p) => ({
    x: p.deviation,
    y: divisions.indexOf(p.division) + jitter(),
    meta: p,
  });
  const finalsPts = row.points.filter((p) => p.round === "finals").map(toPoint);
  const prelimPts = row.points.filter((p) => p.round === "prelims").map(toPoint);

  const box = $("detail-chart").parentElement;
  box.style.height = `${Math.max(divisions.length * 44 + 80, 180)}px`;

  const dataset = (label, pts, color) => ({
    label,
    data: pts,
    backgroundColor: color,
    borderColor: pal.surface,
    borderWidth: 1.5,
    pointRadius: 6,
    pointHoverRadius: 8,
  });

  if (state.detailChart) state.detailChart.destroy();
  state.detailChart = new Chart($("detail-chart"), {
    type: "scatter",
    data: {
      datasets: [
        dataset("Finals", finalsPts, pal.series1),
        ...(prelimPts.length ? [dataset("Prelims", prelimPts, pal.series2)] : []),
      ],
    },
    options: {
      maintainAspectRatio: false,
      animation: { duration: 200 },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label(ctx) {
              const m = ctx.raw.meta;
              return [`${m.competitor} — ${m.division}`, `${m.detail} (deviation ${m.deviation.toFixed(3)})`];
            },
          },
        },
      },
      scales: {
        x: {
          min: 0,
          max: 1,
          title: { display: true, text: "deviation from official result", color: pal.muted, font: { size: 11 } },
          grid: { color: pal.grid },
          border: { color: pal.baseline },
          ticks: { color: pal.muted },
        },
        y: {
          min: -0.6,
          max: divisions.length - 0.4,
          grid: { color: pal.grid },
          border: { color: pal.baseline },
          ticks: {
            color: pal.textSecondary,
            autoSkip: false,
            stepSize: 1,
            callback: (v) => {
              if (!Number.isInteger(v)) return "";
              const label = divisions[v] ?? "";
              if (window.innerWidth >= 640 || label.length <= 20) return label;
              return label.slice(0, 19) + "…";
            },
          },
        },
      },
    },
  });

  const legend = $("detail-legend");
  legend.innerHTML = "";
  const entries = [["Finals", pal.series1]];
  if (prelimPts.length) entries.push(["Prelims", pal.series2]);
  for (const [label, color] of entries) {
    const span = document.createElement("span");
    const sw = document.createElement("span");
    sw.className = "swatch";
    sw.style.background = color;
    span.append(sw, label);
    legend.appendChild(span);
  }
}

function renderTable(rows) {
  const table = $("score-table");
  const thead = table.querySelector("thead");
  const tbody = table.querySelector("tbody");
  tbody.innerHTML = "";

  if (state.view === "division") {
    thead.innerHTML = "<tr><th>Division</th><th>Round</th><th>Score</th><th>Judges</th><th>Marks</th></tr>";
    for (const d of rows) {
      const tr = document.createElement("tr");
      const vals = [d.name, d.round === "prelims" ? "Prelims" : "Finals", d.score.toFixed(3), d.judgeCount, d.n];
      for (const val of vals) {
        const td = document.createElement("td");
        td.textContent = String(val);
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    return;
  }

  thead.innerHTML = "<tr><th>Judge</th><th>Score</th><th>Marks</th><th>Finals marks</th><th>Prelims marks</th><th>Worst deviation</th></tr>";
  for (const r of rows) {
    const tr = document.createElement("tr");
    for (const val of [r.judge, r.score.toFixed(3), r.n, r.nFinals, r.nPrelims, r.worst.toFixed(3)]) {
      const td = document.createElement("td");
      td.textContent = String(val);
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
}

initControls();
