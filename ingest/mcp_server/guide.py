"""The data guide: static text plus the coverage read from the database."""
import os

from .database import Database

_GUIDE_MD = os.path.join(os.path.dirname(os.path.abspath(__file__)), "guide.md")


def coverage_text(db: Database) -> str:
    c = db.conn
    first, last, n = c.execute(
        "SELECT min(substr(start_local, 1, 10)), max(substr(start_local, 1, 10)), count(*) "
        "FROM activities WHERE visible = 1").fetchone()
    lines = ["## Coverage (read from the data now)", "",
             f"Activities: {n} visible, local dates {first}..{last}. By type:"]
    lines += [f"- {t}: {k}" for t, k in c.execute(
        "SELECT type, count(*) FROM activities WHERE visible = 1 GROUP BY type ORDER BY count(*) DESC, type")]
    d_first, d_last, d_n = c.execute("SELECT min(date), max(date), count(*) FROM daily_stats").fetchone()
    lines += ["", f"Daily wellness (`daily_stats`): {d_n} days, {d_first}..{d_last}.",
              "", "All-day series (`daily_series`), per channel:"]
    lines += [f"- {ch}: {a}..{b} ({k} days)" for ch, a, b, k in c.execute(
        "SELECT channel, min(date), max(date), count(*) FROM daily_series GROUP BY channel ORDER BY channel")]
    return "\n".join(lines) + "\n"


def guide_text(db: Database) -> str:
    with open(_GUIDE_MD, encoding="utf-8") as fh:
        return fh.read().rstrip() + "\n\n" + coverage_text(db)
