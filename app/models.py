from pydantic import BaseModel


class EventPage(BaseModel):
    file: str
    label: str


class Event(BaseModel):
    slug: str
    name: str
    dates: str
    pages: list[EventPage]


class DeviationPoint(BaseModel):
    judge: str
    competitor: str
    division: str
    round: str  # "finals" | "prelims"
    deviation: float  # normalized to [0, 1]
    signed: float  # normalized to [-1, 1]; + = judge marked better than the outcome, - = worse
    detail: str


class DivisionResult(BaseModel):
    name: str
    round: str
    page: str
    field_size: int
    judges: list[str]


class AnalysisResponse(BaseModel):
    year: int
    event: str
    event_name: str
    divisions: list[DivisionResult]
    deviations: list[DeviationPoint]
    warnings: list[str]
