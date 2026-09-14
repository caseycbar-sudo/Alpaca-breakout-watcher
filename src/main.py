from datetime import datetime, timezone

from .config import Settings
from .emailer import send_email
from .paper_lab import ET, PaperLab
from .premarket import is_premarket_session, roster_event, scan_premarket
from .scanner import AlpacaClient, scan


def main() -> None:
    settings = Settings()
    settings.validate()
    client = AlpacaClient(settings)
    clock = client.clock()
    now = datetime.now(timezone.utc)
    premarket = is_premarket_session(clock, now)
    if not clock.get("is_open") and not premarket:
        print("Outside today's premarket and regular U.S. stock session; no scan.")
        return

    lab = PaperLab()
    events: list[str] = []
    account = client.account_snapshot()
    if account.get("trading_blocked"):
        events.append(
            "MATERIAL PAPER-ACCOUNT RISK\n"
            "Alpaca reports that trading is blocked. No real orders are possible from this code."
        )

    if premarket:
        candidates = scan_premarket(settings, client, now)
        event = roster_event(candidates, now)
        if event:
            events.append(event)
        if not events:
            print(f"No meaningful premarket roster change. Candidates: {len(candidates)}")
            return
        send_email(
            settings,
            "PREMARKET BREAKOUT WATCH — WATCHLIST ONLY",
            "\n\n".join(events),
        )
        return

    open_symbols = lab.open_symbols()
    if open_symbols:
        events.extend(lab.process_exits(client.snapshots(open_symbols), now))

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
