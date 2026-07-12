# sugar-push-stats

Statistical analysis of judges at West Coast Swing events, built on the public
scoresheets at [eepro.com/results](https://eepro.com/results/). Pick a year and
event and see how closely each judge's marks tracked the official outcome —
with a choice of how harshly to punish wildly outlier marks.

## How it works

- **Finals**: each judge assigns an ordinal placement per couple. Deviation =
  |judge's ordinal − official place|, normalized by (field size − 1) so a
  5-couple final and a 15-couple final compare fairly.
- **Prelims/Semis**: judges give Y / ALT / N callback marks (valued on eepro's
  own Y=10 … N=0 scale, rescaled to 0–1). Deviation = distance between the
  mark's value and the official promotion outcome.
- **Weighting methods** (applied per mark, averaged per judge; lower score =
  closer to consensus):
  - **Linear** — every point of disagreement counts equally
  - **Logarithmic** — forgives the occasional wild outlier
  - **Exponential (RMS)** — punishes wild outliers hardest

The FastAPI backend scrapes and disk-caches the eepro pages (the site has no
CORS headers, so the browser can't fetch them directly). Raw deviations are
sent to the frontend, which does all weighting/filtering client-side — so
switching method, rounds, or divisions re-renders instantly.

## Running locally

```
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt
.venv\Scripts\uvicorn app.main:app --port 8210
```

Then open http://localhost:8210/.

## Deploying (Vercel)

The repo is Vercel-ready with framework preset "Other" and no build command:
`public/` is served as static files by the CDN, and `vercel.json` rewrites
`/api/*` to the FastAPI function at `api/index.py`. The page cache lives in
`/tmp` there, and API responses carry `s-maxage` headers so the CDN caches
them (a week for past years, 30 minutes for the current year).

## Layout

- `app/scraper.py` — fetch + disk cache (`data/cache/`, or `/tmp` on Vercel)
- `app/parser.py` — BeautifulSoup parsing of index/finals/prelims pages
- `app/analysis.py` — deviation math
- `app/main.py` — API (`/api/events`, `/api/analysis`) + local static hosting
- `api/index.py` — Vercel serverless entry point
- `public/` — vanilla JS + vendored Chart.js frontend
