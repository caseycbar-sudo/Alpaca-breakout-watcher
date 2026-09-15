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
    sec_user_agent: str = os.getenv("SEC_USER_AGENT", "")
    max_symbols: int = int(os.getenv("MAX_SYMBOLS", "180"))
    stream_max_symbols: int = int(os.getenv("STREAM_MAX_SYMBOLS", "180"))
    crypto_enabled: bool = os.getenv("CRYPTO_STREAM_ENABLED", "true").lower() not in {
        "0", "false", "no", "off"
    }
    crypto_location: str = os.getenv("CRYPTO_DATA_LOCATION", "us")
    crypto_symbols: str = os.getenv(
        "CRYPTO_STREAM_SYMBOLS",
        "BTC/USD,ETH/USD,SOL/USD,XRP/USD,DOGE/USD,AVAX/USD,LINK/USD,LTC/USD,BCH/USD,UNI/USD",
    )
    options_enabled: bool = os.getenv("OPTIONS_VOLUME_ENABLED", "true").lower() not in {
        "0", "false", "no", "off"
    }
    options_feed: str = os.getenv("OPTIONS_DATA_FEED", "indicative")
    options_core_symbols: str = os.getenv("OPTIONS_CORE_SYMBOLS", "SPY,QQQ")
    options_top_symbols: int = int(os.getenv("OPTIONS_TOP_SYMBOLS", "5"))
    options_poll_seconds: int = int(os.getenv("OPTIONS_POLL_SECONDS", "120"))
    options_expiration_days: int = int(os.getenv("OPTIONS_EXPIRATION_DAYS", "21"))
    options_strike_band_pct: float = float(os.getenv("OPTIONS_STRIKE_BAND_PCT", "12"))
    options_max_contracts_per_symbol: int = int(
        os.getenv("OPTIONS_MAX_CONTRACTS_PER_SYMBOL", "250")
    )
    stream_refresh_seconds: int = int(os.getenv("STREAM_REFRESH_SECONDS", "60"))
    stream_cooldown_seconds: int = int(os.getenv("STREAM_COOLDOWN_SECONDS", "600"))
    stream_min_trade_count: int = int(os.getenv("STREAM_MIN_TRADE_COUNT", "20"))
    stream_min_rolling_dollar_volume: float = float(
        os.getenv("STREAM_MIN_ROLLING_DOLLAR_VOLUME", "100000")
    )
    stream_min_15s_move_pct: float = float(
        os.getenv("STREAM_MIN_15S_MOVE_PCT", "0.25")
    )
    stream_max_15s_move_pct: float = float(
        os.getenv("STREAM_MAX_15S_MOVE_PCT", "2.50")
    )
    stream_trigger_proximity_pct: float = float(
        os.getenv("STREAM_TRIGGER_PROXIMITY_PCT", "0.35")
    )
    crypto_min_day_move_pct: float = float(os.getenv("CRYPTO_MIN_DAY_MOVE_PCT", "1.0"))
    crypto_max_day_move_pct: float = float(os.getenv("CRYPTO_MAX_DAY_MOVE_PCT", "10.0"))
    crypto_min_15s_move_pct: float = float(os.getenv("CRYPTO_MIN_15S_MOVE_PCT", "0.15"))
    crypto_max_15s_move_pct: float = float(os.getenv("CRYPTO_MAX_15S_MOVE_PCT", "2.0"))
    crypto_min_rolling_dollar_volume: float = float(
        os.getenv("CRYPTO_MIN_ROLLING_DOLLAR_VOLUME", "50000")
    )
    crypto_max_spread_pct: float = float(os.getenv("CRYPTO_MAX_SPREAD_PCT", "0.50"))
    stream_state_path: str = os.getenv("STREAM_STATE_PATH", "data/stream_state.json")
    alert_webhook_url: str = os.getenv("ALERT_WEBHOOK_URL", "")
    alert_webhook_token: str = os.getenv("ALERT_WEBHOOK_TOKEN", "")
    health_port: int = int(os.getenv("PORT", "8080"))

    min_price: float = 0.50
    max_price: float = 100.00
    min_day_move_pct: float = 2.0
    max_day_move_pct: float = 8.0
    min_five_minute_move_pct: float = 0.40
    max_five_minute_move_pct: float = 2.00
    min_relative_volume: float = 1.5
    min_five_minute_dollar_volume: float = 250_000
    min_rsi: float = 52.0
    preferred_min_rsi: float = 55.0
    preferred_max_rsi: float = 72.0
    max_rsi: float = 78.0
    max_spread_pct: float = float(os.getenv("MAX_SPREAD_PCT", "0.40"))
    max_vwap_distance_atr: float = 1.0
    catalyst_max_age_hours: int = 24

    def validate(self) -> None:
        if not self.api_key or not self.secret_key:
            raise RuntimeError("Missing ALPACA_API_KEY or ALPACA_SECRET_KEY.")
