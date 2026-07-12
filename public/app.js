/* sugar-push-stats frontend: fetches raw deviations from the API and does all
   weighting/filtering client-side so control changes re-render instantly. */

const $ = (id) => document.getElementById(id);

const METHOD_NOTES = {
  linear: "Linear: every point of disagreement counts equally.",
  logarithmic: "Logarithmic: forgiving of the occasional wild outlier mark; consistent small disagreement weighs more.",
  exponential: "Exponential (RMS): wild outlier marks are punished hardest.",
};

const state = {
  data: null,          // AnalysisResponse from the API
  method: "linear",
  rounds: "finals",
  enabledDivisions: new Set(),
  selectedJudge: null,
  mainChart: null,
  detailChart: null,
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

/* ---------- controls ---------- */

function initControls() {
  const yearSel = $("year");
  const thisYear = new Date().getFullYear();
  for (let y = thisYear; y >= 2019; y--) {
    const opt = new Option(String(y), String(y));
    yearSel.add(opt);
  }
  yearSel.addEventListener("change", () => loadEvents(Number(yearSel.value)));
  $("event").addEventListener("change", () => loadAnalysis());
  $("rounds").addEventListener("change", (e) => {
    state.rounds = e.target.value;
    render();
  });
  $("method").addEventListener("change", (e) => {
    state.method = e.target.value;
    $("method-note").textContent = METHOD_NOTES[state.method];
    render();
  });
  $("method-note").textContent = METHOD_NOTES[state.method];
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", render);
  loadEvents(thisYear);
}

function setStatus(msg, isError = false) {
  const el = $("status");
  el.hidden = !msg;
  el.textContent = msg || "";
  el.classList.toggle("error", isError);
}

async function loadEvents(year) {
  const evSel = $("event");
  evSel.disabled = true;
  evSel.innerHTML = "<option>Loading…</option>";
  $("results").hidden = true;
  setStatus(`Loading ${year} events…`);
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
    setStatus(`${events.length} events found for ${year}. Pick one to analyze.`);
  } catch (err) {
    evSel.innerHTML = "<option>—</option>";
    setStatus(`Could not load events for ${year}: ${err.message}`, true);
  }
}

async function loadAnalysis() {
  const year = $("year").value;
  const slug = $("event").value;
  if (!slug) return;
  setStatus("Fetching and parsing scoresheets… (first load of an event can take a few seconds)");
  $("results").hidden = true;
  try {
    const resp = await fetch(`/api/analysis?year=${year}&event=${encodeURIComponent(slug)}`);
    if (!resp.ok) throw new Error((await resp.json()).detail || resp.statusText);
    state.data = await resp.json();
    state.enabledDivisions = new Set(state.data.divisions.map((d) => d.name));
    state.selectedJudge = null;
    setStatus("");
    buildChips();
    renderWarnings();
    $("results").hidden = false;
    render();
  } catch (err) {
    setStatus(`Analysis failed: ${err.message}`, true);
  }
}

function buildChips() {
  const box = $("division-chips");
  box.innerHTML = "";
  for (const div of state.data.divisions) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = div.name;
    btn.setAttribute("aria-pressed", "true");
    btn.addEventListener("click", () => {
      const on = btn.getAttribute("aria-pressed") === "true";
      btn.setAttribute("aria-pressed", String(!on));
      if (on) state.enabledDivisions.delete(div.name);
      else state.enabledDivisions.add(div.name);
      render();
    });
    box.appendChild(btn);
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
  const rows = judgeScores();
  renderMainChart(rows);
  renderTable(rows);
  if (state.selectedJudge && !rows.some((r) => r.judge === state.selectedJudge)) {
    state.selectedJudge = null;
  }
  renderDetail(rows);
}

function renderMainChart(rows) {
  const pal = palette();
  const box = $("main-chart").parentElement;
  box.style.height = `${Math.max(rows.length * 32 + 70, 160)}px`;
  $("main-title").textContent =
    `Judge consensus scores — ${state.data.event_name} ${state.data.year}` +
    (state.rounds === "all" ? " (finals + prelims)" : " (finals only)");

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
          ticks: { color: pal.textSecondary, autoSkip: false },
        },
      },
    },
  });
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
  $("detail-title").textContent = `${row.judge} — individual marks (${row.n})`;

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
    borderWidth: 1,
    pointRadius: 5,
    pointHoverRadius: 7,
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
            callback: (v) => Number.isInteger(v) ? (divisions[v] ?? "") : "",
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
  const tbody = $("score-table").querySelector("tbody");
  tbody.innerHTML = "";
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
