from dataclasses import dataclass
import os


@dataclass(frozen=True)
class Settings:
    api_key: str = os.getenv("ALPACA_API_KEY", "")
    secret_key: str = os.getenv("ALPACA_SECRET_KEY", "")
    feed: str = os.getenv("ALPACA_DATA_FEED", "iex")
    email_from: str = os.getenv("ALERT_EMAIL_FROM", "")
    email_to: str = os.getenv("ALERT_EMAIL_TO", "")
    gmail_app_password: str = os.getenv("GMAIL_APP_PASSWORD", "")
    max_symbols: int = int(os.getenv("MAX_SYMBOLS", "120"))

    min_price: float = 0.50
    max_price: float = 100.00
    min_day_move_pct: float = 2.0
    max_day_move_pct: float = 8.0
    min_relative_volume: float = 1.5
    min_latest_bar_volume: int = 50_000
    min_rsi: float = 55.0
    max_rsi: float = 72.0
    max_spread_pct: float = float(os.getenv("MAX_SPREAD_PCT", "0.40"))

    def validate(self) -> None:
        if not self.api_key or not self.secret_key:
            raise RuntimeError("Missing ALPACA_API_KEY or ALPACA_SECRET_KEY.")
