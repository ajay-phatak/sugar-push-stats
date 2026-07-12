from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles

from . import analysis, parser, scraper
from .models import AnalysisResponse, Event

app = FastAPI(title="sugar-push-stats")

STATIC_DIR = Path(__file__).resolve().parent.parent / "static"


@app.get("/api/events", response_model=list[Event])
def list_events(year: int) -> list[Event]:
    if not 2000 <= year <= 2100:
        raise HTTPException(400, "year out of range")
    try:
        html = scraper.fetch(f"{year}/", year)
    except scraper.FetchError as e:
        raise HTTPException(502, str(e))
    events = parser.parse_year_index(html, year)
    if not events:
        raise HTTPException(404, f"No events found for {year}")
    return events


@app.get("/api/analysis", response_model=AnalysisResponse)
def analyze_event(year: int, event: str) -> AnalysisResponse:
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

    return AnalysisResponse(
        year=year,
        event=ev.slug,
        event_name=ev.name,
        divisions=divisions,
        deviations=deviations,
        warnings=warnings,
    )


app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
