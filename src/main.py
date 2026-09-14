from datetime import datetime, timezone

from .config import Settings
from .emailer import send_email
from .paper_lab import ET, PaperLab
from .scanner import AlpacaClient, scan


def main() -> None:
    settings = Settings()
    settings.validate()
    client = AlpacaClient(settings)
    clock = client.clock()
    if not clock.get("is_open"):
        print("U.S. regular market is closed; no stock scan.")
        return

    now = datetime.now(timezone.utc)
    lab = PaperLab()
    events: list[str] = []

    open_symbols = lab.open_symbols()
    if open_symbols:
        events.extend(lab.process_exits(client.snapshots(open_symbols), now))

    account = client.account_snapshot()
    if account.get("trading_blocked"):
        events.append(
            "MATERIAL PAPER-ACCOUNT RISK\n"
            "Alpaca reports that trading is blocked. No real orders are possible from this code."
        )

    candidates = scan(settings, client, now)
    if now.astimezone(ET).hour < 15 or (
        now.astimezone(ET).hour == 15 and now.astimezone(ET).minute < 30
    ):
        events.extend(lab.process_entries(candidates, now))

    if not events:
        print(f"No confirmed setup or account-risk change. Candidates: {len(candidates)}")
        return

    body = "\n\n".join(events) + "\n\nPAPER LAB METRICS\n" + lab.metrics()
    if any(event.startswith("BREAKOUT PAPER TRADE") for event in events):
        subject = "BREAKOUT PAPER TRADE — PAPER—NO REAL ORDER"
    elif any(event.startswith("PAPER TRADE RESULT") for event in events):
        subject = "PAPER TRADE RESULT — PAPER—NO REAL ORDER"
    else:
        subject = "Alpaca watcher: material account status"
    send_email(settings, subject, body)


if __name__ == "__main__":
    main()
