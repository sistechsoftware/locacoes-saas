-- Snapshot the old shared prices into independent profiles. Existing calculations and values remain intact.
INSERT OR IGNORE INTO settings(key,value) VALUES
 ('freight_fuel_type','Etanol'),('freight_fuel_price_cents','332'),('freight_consumption','10'),
 ('freight_cost_per_km_cents','50'),('freight_margin_percent','30'),('freight_minimum_cents','3000'),
 ('freight_rounding_cents','500'),('freight_labor_cents','0');
INSERT OR IGNORE INTO settings(key,value)
 SELECT 'freight_comum_' || substr(key,9),value FROM settings WHERE key IN
 ('freight_fuel_type','freight_fuel_price_cents','freight_consumption','freight_cost_per_km_cents','freight_margin_percent','freight_minimum_cents','freight_rounding_cents','freight_labor_cents');
INSERT OR IGNORE INTO settings(key,value)
 SELECT 'freight_locacao_' || substr(key,9),value FROM settings WHERE key IN
 ('freight_fuel_type','freight_fuel_price_cents','freight_consumption','freight_cost_per_km_cents','freight_margin_percent','freight_minimum_cents','freight_rounding_cents','freight_labor_cents');
CREATE TABLE route_cache (
 cache_key TEXT PRIMARY KEY, payload TEXT NOT NULL, expires_at INTEGER NOT NULL
);
CREATE TABLE api_rate_limits (
 bucket TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at INTEGER NOT NULL
);
