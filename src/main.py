from datetime import datetime, timezone

from .config import Settings
from .emailer import send_email
from .hub import publish_hub
from .paper_lab import ET, PaperLab
from .premarket import (
    is_premarket_session,
    roster_event,
    scan_premarket,
    todays_roster_symbols,
)
from .scanner import AlpacaClient, prepare_risk_checks, scan


def main() -> None:
    settings = Settings()
    settings.validate()
    client = AlpacaClient(settings)
    clock = client.clock()
    now = datetime.now(timezone.utc)
    premarket = is_premarket_session(clock, now)
    lab = PaperLab()
    events: list[str] = []
    account = client.account_snapshot()

    if account.get("trading_blocked"):
        events.append(
            "MATERIAL PAPER-ACCOUNT RISK\n"
            "Alpaca reports that trading is blocked. No real orders are possible from this code."
        )

    if not clock.get("is_open") and not premarket:
        prepare_risk_checks(settings, client)
        publish_hub(
            now=now,
            phase="closed",
            clock=clock,
            candidates=[],
            events=events,
            lab=lab,
            paper_account=account,
            risk_events=getattr(client, "risk_events", []),
            source_status=getattr(client, "risk_source_status", {}),
            note="U.S. equities are closed. The next scheduled scan will refresh the research board.",
        )
        print("Outside today's premarket and regular U.S. stock session; hub refreshed.")
        return

    if premarket:
        candidates = scan_premarket(settings, client, now)
        event = roster_event(candidates, now)
        if event:
            events.append(event)
        email_sent = False
        if events:
            email_sent = send_email(
                settings,
                "PREMARKET BREAKOUT WATCH — WATCHLIST ONLY",
                "\n\n".join(events),
            )
        publish_hub(
            now=now,
            phase="premarket",
            clock=clock,
            candidates=candidates,
            events=events,
            lab=lab,
            paper_account=account,
            email_sent=email_sent,
            risk_events=getattr(client, "risk_events", []),
            source_status=getattr(client, "risk_source_status", {}),
            note=(
                "Dynamic roster updated; regular-session confirmation is still required."
                if event
                else "No meaningful premarket roster change."
            ),
        )
        print(f"Premarket hub refreshed. Candidates: {len(candidates)}")
        return

    open_symbols = lab.open_symbols()
    if open_symbols:
        events.extend(lab.process_exits(client.snapshots(open_symbols), now))

    candidates = scan(settings, client, now)
    premarket_symbols = todays_roster_symbols(now)
    for candidate in candidates:
        if candidate["symbol"] in premarket_symbols:
            candidate["setup"] = "C — premarket leader confirmed after open"

    if now.astimezone(ET).hour < 15 or (
        now.astimezone(ET).hour == 15 and now.astimezone(ET).minute < 30
    ):
        events.extend(lab.process_entries(candidates, now))

    email_sent = False
    if events:
        body = "\n\n".join(events) + "\n\nPAPER LAB METRICS\n" + lab.metrics()
        if any(event.startswith("BREAKOUT PAPER TRADE") for event in events):
            subject = "BREAKOUT PAPER TRADE — PAPER—NO REAL ORDER"
        elif any(event.startswith("PAPER TRADE RESULT") for event in events):
            subject = "PAPER TRADE RESULT — PAPER—NO REAL ORDER"
        else:
            subject = "Alpaca watcher: material account status"
        email_sent = send_email(settings, subject, body)

    publish_hub(
        now=now,
        phase="regular session",
        clock=clock,
        candidates=candidates,
        events=events,
        lab=lab,
        paper_account=account,
        email_sent=email_sent,
        risk_events=getattr(client, "risk_events", []),
        source_status=getattr(client, "risk_source_status", {}),
        note=(
            "Meaningful setup or account status recorded."
            if events
            else "No confirmed setup or account-risk change."
        ),
    )
    print(f"Regular-session hub refreshed. Candidates: {len(candidates)}")


if __name__ == "__main__":
    main()
