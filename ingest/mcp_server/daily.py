"""Daily wellness numbers from ``daily_stats``, per day or per period."""
from .activities import counted
from .database import Database

_NOT_METRICS = {"date", "raw", "hrv_status"}

_PERIOD_KEYS = {
    "week": "date(date, '-6 days', 'weekday 1')",
    "month": "substr(date, 1, 7)",
    "year": "substr(date, 1, 4)",
    "all": "'all'",
}


def metric_columns(db: Database) -> list[str]:
    return [r[1] for r in db.conn.execute("PRAGMA table_info(daily_stats)") if r[1] not in _NOT_METRICS]


def wellness(db: Database, date_from: str, date_to: str, metrics: list[str] | None = None,
             period: str = "day") -> dict:
    valid = metric_columns(db)
    for m in metrics or []:
        if m not in valid:
            raise ValueError(f"unknown metric {m}; metrics: {', '.join(valid)}")
    if period != "day" and period not in _PERIOD_KEYS:
        raise ValueError(f"period must be day or one of {', '.join(_PERIOD_KEYS)}")
    chosen = metrics or valid
    rules = [f"local dates {date_from}..{date_to}", "unknown values are left out, never counted as 0"]
    days = db.conn.execute("SELECT count(*) FROM daily_stats WHERE date BETWEEN ? AND ?",
                           (date_from, date_to)).fetchone()[0]
    if period == "day":
        cols = ["date", *chosen] + ([] if metrics else ["hrv_status"])
        rows = [dict(r) for r in db.conn.execute(
            f"SELECT {', '.join(cols)} FROM daily_stats WHERE date BETWEEN ? AND ? ORDER BY date",
            (date_from, date_to))]
        return {"data": {"rows": rows}, "counted": counted(rules, days)}
    aggs = ", ".join(f"avg({m}), min({m}), max({m}), count({m})" for m in chosen)
    out = []
    for r in db.conn.execute(
            f"SELECT {_PERIOD_KEYS[period]} AS period, count(*), {aggs} FROM daily_stats "
            "WHERE date BETWEEN ? AND ? GROUP BY period ORDER BY period", (date_from, date_to)):
        row = {"period": r[0], "days": r[1]}
        for i, m in enumerate(chosen):
            mean, lo, hi, n = r[2 + 4 * i: 6 + 4 * i]
            row[m] = {"mean": None if mean is None else round(mean, 2), "min": lo, "max": hi,
                      "days_with_value": n}
        out.append(row)
    rules.append("weeks start on Monday" if period == "week" else f"per {period}")
    return {"data": {"period": period, "rows": out}, "counted": counted(rules, days)}
