"""Turn parsed divisions into per-judge deviation points.

Deviations are normalized to [0, 1] so different field sizes and round types
are comparable. The weighting method (linear / logarithmic / exponential) is
applied client-side so toggling it doesn't refetch anything.
"""

from .models import DeviationPoint, DivisionResult
from .parser import Division, mark_value, ordinal_value


def _ordinal_points(div: Division) -> list[DeviationPoint]:
    norm = max(len(div.rows) - 1, 1)
    points = []
    for row in div.rows:
        for judge, raw in row.marks.items():
            mark = ordinal_value(raw)
            if mark is None:
                continue
            # Lower ordinal mark than the official place is better, so a positive
            # signed value means the judge marked the competitor better than they placed.
            s = max(-1.0, min(1.0, (row.place - mark) / norm))
            points.append(DeviationPoint(
                judge=judge, competitor=row.competitor, division=div.name,
                round=div.round, deviation=round(abs(s), 4), signed=round(s, 4),
                detail=f"marked {raw}, placed {row.place}",
            ))
    return points


def _callback_points(div: Division) -> list[DeviationPoint]:
    points = []
    for row in div.rows:
        baseline = 1.0 if row.promoted else 0.0
        outcome = "promoted" if row.promoted else "not promoted"
        for judge, raw in row.marks.items():
            # Blank callback cells mean the judge passed the competitor over
            # (only Y/ALT marks get written) — that's a "No".
            v = mark_value(raw)
            if v is None:
                v = 0.0
                raw = raw or "(blank)"
            # Positive means the judge marked them better than the outcome (e.g. Y when not promoted).
            s = v - baseline
            points.append(DeviationPoint(
                judge=judge, competitor=row.competitor, division=div.name,
                round=div.round, deviation=round(abs(s), 4), signed=round(s, 4),
                detail=f"marked {raw}, {outcome}",
            ))
    return points


def _scores_points(div: Division) -> list[DeviationPoint]:
    """Point-scored divisions (0-100 per judge, e.g. All American / routines):
    convert each judge's scores to ranks (highest score = rank 1, ties get the
    average rank) and compare to the official ranking. The Place column is only
    filled for the placed cutoff, but rows are listed sorted by the official
    Avg, so row order carries the full official ranking."""
    norm = max(len(div.rows) - 1, 1)
    official = {id(row): i + 1 for i, row in enumerate(div.rows)}
    points = []
    for judge in div.judges:
        scored = []
        for row in div.rows:
            v = ordinal_value(row.marks.get(judge, ""))
            if v is not None:
                scored.append((row, v))
        if not scored:
            continue
        ranks: dict[int, float] = {}  # id(row) -> judge's rank
        by_score = sorted(scored, key=lambda rv: -rv[1])
        i = 0
        while i < len(by_score):
            j = i
            while j < len(by_score) and by_score[j][1] == by_score[i][1]:
                j += 1
            avg_rank = (i + 1 + j) / 2  # mean of positions i+1 .. j
            for k in range(i, j):
                ranks[id(by_score[k][0])] = avg_rank
            i = j
        for row, score in scored:
            rank = ranks[id(row)]
            # A better (lower) rank than official means the judge favored them.
            s = max(-1.0, min(1.0, (official[id(row)] - rank) / norm))
            points.append(DeviationPoint(
                judge=judge, competitor=row.competitor, division=div.name,
                round=div.round, deviation=round(abs(s), 4), signed=round(s, 4),
                detail=f"scored {score:g} (rank {rank:g}), official {official[id(row)]}",
            ))
    return points


def analyze_division(div: Division, page: str) -> tuple[DivisionResult, list[DeviationPoint], list[str]]:
    if div.kind == "callback":
        points = _callback_points(div)
    elif div.kind == "scores":
        points = _scores_points(div)
    else:
        points = _ordinal_points(div)

    result = DivisionResult(
        name=div.name,
        round=div.round,
        page=page,
        field_size=len(div.rows),
        judges=div.judges,
    )
    return result, points, []
