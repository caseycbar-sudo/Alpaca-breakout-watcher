-- Casey owns QQQ and PSQ. He bought them in Robinhood, before this hub existed
-- and without any plan here. Recording them as trade plans was the only path
-- available, and it made the board lie three ways: a red "order recorded but
-- Casey has not approved the plan" on holdings nobody ordered through the hub,
-- review blocked with "too_late" on records that were never orders, and an
-- average cost sitting in fill_price, which is supposed to be a broker fill.
--
-- An existing holding is a different kind of record from a trade plan, so it
-- gets its own kind. See hub job #15.
ALTER TABLE plans ADD COLUMN record_kind TEXT NOT NULL DEFAULT 'trade_plan';

-- What the broker shows. average_cost is deliberately not fill_price: a holding
-- can be the result of several buys, and no single fill price exists for it.
ALTER TABLE plans ADD COLUMN quantity REAL;
ALTER TABLE plans ADD COLUMN average_cost REAL;

-- Where the numbers came from, since nothing here reads the broker directly.
ALTER TABLE plans ADD COLUMN observed_at INTEGER;
ALTER TABLE plans ADD COLUMN observed_source TEXT;
