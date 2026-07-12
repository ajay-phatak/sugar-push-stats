"""Parse eepro.com year-index and results pages into structured data."""

import re
from dataclasses import dataclass, field

from bs4 import BeautifulSoup

from .models import Event, EventPage

# Header cells that are never judge names. Matched case-insensitively after
# stripping; anything else in a header row is treated as a judge column.
_NON_JUDGE_EXACT = {
    "place", "competitor", "bib", "count", "sum", "promote", "score",
    "total", "points", "result", "rank", "alt", "alternate", "avg", "average",
}
_NON_JUDGE_SUBSTRINGS = ("marks sorted", "counts", "y-a-n", "yes-alt-no")

# Callback mark values, mirroring eepro's own weighting (Y=10, ALT1=4.5,
# ALT2=4.3, ALT3=4.2, N=0) rescaled to [0, 1].
_MARK_VALUES = {
    "Y": 1.0, "YES": 1.0,
    "ALT1": 0.45, "A1": 0.45,
    "ALT2": 0.43, "A2": 0.43,
    "ALT3": 0.42, "A3": 0.42,
    "ALT": 0.45, "A": 0.45,
    "N": 0.0, "NO": 0.0,
}


@dataclass
class CompetitorRow:
    competitor: str
    place: int | None  # ordinal/scores divisions
    promoted: bool | None  # callback divisions
    marks: dict[str, str]  # judge name -> raw mark text


@dataclass
class Division:
    name: str
    # Mark structure: "ordinal" (judges place 1..N), "callback" (Y/ALT/N with
    # a Promote column), or "scores" (0-100 point scores with an Avg column).
    kind: str
    round: str  # "finals" | "prelims"
    judges: list[str] = field(default_factory=list)
    rows: list[CompetitorRow] = field(default_factory=list)


def parse_year_index(html: str, year: int) -> list[Event]:
    soup = BeautifulSoup(html, "html.parser")
    events: list[Event] = []
    for li in soup.select("li.has-children"):
        label_el = li.find("label")
        if not label_el:
            continue
        label = label_el.get_text(strip=True)
        # Labels look like "July 9-12, 2026 - Big Apple Dance Festival"
        dates, _, name = label.partition(" - ")
        if not name:
            name, dates = label, ""

        pages: list[EventPage] = []
        slug = ""
        for a in li.select("ul a[href]"):
            href = a["href"]
            m = re.match(r"\.\./([^/]+)/([^/]+\.html)$", href)
            if not m:
                continue
            slug = m.group(1)
            pages.append(EventPage(file=m.group(2), label=a.get_text(strip=True)))
        if slug and pages:
            events.append(Event(slug=slug, name=name.strip(), dates=dates.strip(), pages=pages))
    return events


def _is_judge_header(text: str) -> bool:
    t = text.strip().lower()
    if not t or t in _NON_JUDGE_EXACT:
        return False
    return not any(s in t for s in _NON_JUDGE_SUBSTRINGS)


def _cell_texts(tr) -> list[str]:
    return [td.get_text(" ", strip=True) for td in tr.find_all(["td", "th"])]


def _banner_name(td) -> str:
    """Division name from a banner cell.

    Finals banners look like "Division: Jack & Jill Advanced Finals"; prelims
    banners like "Jack & Jill Follower Advanced Prelims - 46 competed<br>
    <tie-break notes>". Take the first line, strip prefix/suffix noise.
    """
    first_line = td.get_text("\n", strip=True).split("\n")[0]
    name = re.sub(r"(?i)^\s*division:\s*", "", first_line)
    name = re.sub(r"(?i)\s*-\s*\d+\s+competed.*$", "", name)
    return name.strip()


def parse_results_page(html: str) -> list[Division]:
    """Parse one results page into its divisions.

    Pages hold one or more <table>s; inside, a single-cell banner row names
    the division, followed by a header row (containing "Competitor") naming
    the judge columns, then one data row per competitor.
    """
    soup = BeautifulSoup(html, "html.parser")
    divisions: list[Division] = []
    current: Division | None = None
    columns: list[str] = []
    pending_name: str | None = None

    for table in soup.find_all("table"):
        for tr in table.find_all("tr"):
            tds = tr.find_all(["td", "th"])
            if not tds:
                continue

            if len(tds) == 1:
                name = _banner_name(tds[0])
                if name:
                    pending_name = name
                continue

            cells = _cell_texts(tr)
            lowered = [c.strip().lower() for c in cells]
            if "competitor" in lowered:  # header row starts a new division
                name = pending_name or "(unnamed division)"
                if "promote" in lowered:
                    kind = "callback"
                elif "avg" in lowered or "average" in lowered:
                    kind = "scores"
                else:
                    kind = "ordinal"
                if re.search(r"(?i)prelim|semi|quarter", name):
                    round_ = "prelims"
                else:
                    round_ = "prelims" if kind == "callback" else "finals"
                current = Division(
                    name=name,
                    kind=kind,
                    round=round_,
                    judges=[c.strip() for c in cells if _is_judge_header(c)],
                )
                divisions.append(current)
                columns = cells
                pending_name = None
                continue

            if current is None or not columns or len(cells) != len(columns):
                continue

            row = _parse_data_row(cells, columns, current.kind)
            if row is not None:
                current.rows.append(row)

    return [d for d in divisions if d.rows and d.judges]


def _parse_data_row(cells: list[str], columns: list[str], kind: str) -> CompetitorRow | None:
    competitor = ""
    place: int | None = None
    promoted: bool | None = None
    marks: dict[str, str] = {}

    for header, value in zip(columns, cells):
        h = header.strip().lower()
        if h == "competitor":
            competitor = value
        elif h == "place":
            m = re.search(r"\d+", value)
            place = int(m.group()) if m else None
        elif h == "promote":
            promoted = bool(value.strip())
        elif _is_judge_header(header):
            marks[header.strip()] = value.strip()

    if not competitor or not marks:
        return None
    # Scores pages leave Place blank below the placed cutoff; row order (sorted
    # by Avg) still carries the official ranking, so those rows are kept.
    if kind == "ordinal" and place is None:
        return None
    if kind == "callback" and promoted is None:
        promoted = False
    return CompetitorRow(competitor=competitor, place=place, promoted=promoted, marks=marks)


def mark_value(raw: str) -> float | None:
    """Numeric value of a prelims callback mark, or None if unparseable/blank."""
    t = raw.strip().upper().replace("*", "")
    if not t or t == "-":
        return None
    if t in _MARK_VALUES:
        return _MARK_VALUES[t]
    try:
        v = float(t)
    except ValueError:
        return None
    # Some sheets show eepro's numeric weights directly (Y=10 scale).
    return max(0.0, min(v / 10.0, 1.0))


def ordinal_value(raw: str) -> float | None:
    """Numeric value of a finals ordinal mark, or None if blank/unparseable."""
    t = raw.strip().replace("*", "")
    if not t or t == "-":
        return None
    try:
        return float(t)
    except ValueError:
        m = re.search(r"\d+(\.\d+)?", t)
        return float(m.group()) if m else None
