from datetime import date
from pathlib import Path

from fastapi import FastAPI, HTTPException, Response
from fastapi.staticfiles import StaticFiles

from . import analysis, parser, scraper
from .models import AnalysisResponse, Event

app = FastAPI(title="sugar-push-stats")

STATIC_DIR = Path(__file__).resolve().parent.parent / "public"


def _cdn_cache(response: Response, year: int) -> None:
    """Let Vercel's CDN cache API responses: past-year results are immutable,
    current-year events are still being posted. No effect when self-hosted."""
    if year < date.today().year:
        response.headers["Cache-Control"] = "s-maxage=604800, stale-while-revalidate=86400"
    else:
        response.headers["Cache-Control"] = "s-maxage=1800, stale-while-revalidate=86400"


@app.get("/api/events", response_model=list[Event])
def list_events(year: int, response: Response) -> list[Event]:
    if not 2000 <= year <= 2100:
        raise HTTPException(400, "year out of range")
    try:
        html = scraper.fetch(f"{year}/", year)
    except scraper.FetchError as e:
        raise HTTPException(502, str(e))
    events = parser.parse_year_index(html, year)
    if not events:
        raise HTTPException(404, f"No events found for {year}")
    _cdn_cache(response, year)
    return events


@app.get("/api/analysis", response_model=AnalysisResponse)
def analyze_event(year: int, event: str, response: Response) -> AnalysisResponse:
    try:
        index_html = scraper.fetch(f"{year}/", year)
    except scraper.FetchError as e:
        raise HTTPException(502, str(e))
    events = {e.slug: e for e in parser.parse_year_index(index_html, year)}
    ev = events.get(event)
    if ev is None:
        raise HTTPException(404, f"Event '{event}' not found in {year}")

    divisions, deviations, warnings = [], [], []
    for page in ev.pages:
        try:
            html = scraper.fetch(f"{ev.slug}/{page.file}", year)
        except scraper.FetchError as e:
            warnings.append(f"{page.label}: {e}")
            continue
        parsed = parser.parse_results_page(html)
        if not parsed:
            warnings.append(f"{page.label}: no parseable division tables")
            continue
        for div in parsed:
            result, points, w = analysis.analyze_division(div, page.label)
            divisions.append(result)
            deviations.extend(points)
            warnings.extend(w)

    if not deviations:
        raise HTTPException(404, f"No judge marks could be parsed for '{ev.name}'")

    _cdn_cache(response, year)
    return AnalysisResponse(
        year=year,
        event=ev.slug,
        event_name=ev.name,
        divisions=divisions,
        deviations=deviations,
        warnings=warnings,
    )


# Local/self-hosted serving; on Vercel the CDN serves public/ directly and
# only /api/* reaches this app (and the directory may be absent from the
# function bundle, hence the guard).
if STATIC_DIR.is_dir():
    app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
