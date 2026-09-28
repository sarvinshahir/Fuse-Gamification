from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator, model_validator
from typing import Optional
import sqlite3
import os

try:
    import psycopg2
    from psycopg2.extras import RealDictCursor
except ImportError:
    psycopg2 = None
    RealDictCursor = None

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Constants ─────────────────────────────────────────────────────────────────

BATTERY_KWH = {
    "mini":     80,    # Mini Bus 10–24 seats — TODO validate
    "midsize":  125,   # Mid-Size 25–47 seats — TODO validate
    "fullsize": 185,   # Full-Size 48–71 seats — TODO validate
}

ENERGY_PER_KM = {
    "mini":     0.9,   # kWh/km — TODO validate
    "midsize":  1.3,   # kWh/km — TODO validate
    "fullsize": 1.8,   # kWh/km — TODO validate
}

MIN_SOC = 0.20
CHARGER_KW = 40
CHARGING_EFFICIENCY = 0.90      # Used for both midday charging and V2G replenishment
                                 # Bidirectional discharge losses not separately modelled — TODO
V2G_WINDOW_START = 17
V2G_WINDOW_END = 21

ANNUAL_V2G_DAYS = 350           # Confirmed by Rob
ANNUAL_DRIVING_DAYS = 350       # TODO confirm with Rob — may be V2G days only

PROVISIONAL_V2G_RATE = 0.12     # $/kWh — BC Hydro methodology not confirmed

UTILITY_RATES = {
    "BC": 0.12,
    "ON": 0.13,
    "QC": 0.07,
    "NS": 0.18,
}

DIESEL_L_PER_KM = 0.40          # TODO validate
DIESEL_PRICE_PER_L = 2.30       # TODO validate — BC average

# ── Database ──────────────────────────────────────────────────────────────────

DATABASE_URL = os.getenv("DATABASE_URL")

def get_db():
    if DATABASE_URL:
        if psycopg2 is None:
            raise RuntimeError("DATABASE_URL is set but psycopg2 is unavailable")
        conn = psycopg2.connect(DATABASE_URL, cursor_factory=RealDictCursor)
    else:
        conn = sqlite3.connect("gamification.db")
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
    return conn

def verify_schema(conn, is_postgres: bool) -> bool:
    """Verify required columns exist in submissions table."""
    c = conn.cursor()
    required_columns = {
        "mini_count", "midsize_count", "fullsize_count",
        "gross_v2g_revenue_low", "gross_v2g_revenue_high",
        "total_replenishment_cost",
        "net_v2g_revenue_low", "net_v2g_revenue_high",
    }
    if is_postgres:
        c.execute("""
            SELECT column_name FROM information_schema.columns
            WHERE table_name = 'submissions'
        """)
        existing = {row["column_name"] for row in c.fetchall()}
    else:
        c.execute("PRAGMA table_info(submissions)")
        existing = {row["name"] for row in c.fetchall()}
    missing = required_columns - existing
    if missing:
        raise RuntimeError(
            f"Database schema is outdated. Missing columns: {missing}. "
            f"Please recreate the submissions table."
        )
    return True

def init_db():
    conn = get_db()
    c = conn.cursor()
    is_postgres = bool(DATABASE_URL and psycopg2)

    if is_postgres:
        c.execute("""
            CREATE TABLE IF NOT EXISTS submissions (
                id SERIAL PRIMARY KEY,
                session_id TEXT UNIQUE NOT NULL,
                status TEXT DEFAULT 'incomplete',
                last_completed_step INTEGER DEFAULT 0,
                company_name TEXT,
                province TEXT,
                mini_count INTEGER DEFAULT 0,
                midsize_count INTEGER DEFAULT 0,
                fullsize_count INTEGER DEFAULT 0,
                fleet_size INTEGER,
                daily_km REAL,
                morning_start REAL,
                morning_end REAL,
                afternoon_start REAL,
                afternoon_end REAL,
                available_5_9pm INTEGER,
                midday_available INTEGER,
                other_available_times TEXT,
                central_depot INTEGER,
                mini_v2g_kwh REAL,
                midsize_v2g_kwh REAL,
                fullsize_v2g_kwh REAL,
                mini_flagged BOOLEAN,
                midsize_flagged BOOLEAN,
                fullsize_flagged BOOLEAN,
                total_v2g_energy_kwh REAL,
                gross_v2g_revenue_low REAL,
                gross_v2g_revenue_high REAL,
                total_replenishment_cost REAL,
                net_v2g_revenue_low REAL,
                net_v2g_revenue_high REAL,
                annual_diesel_cost REAL,
                annual_electricity_cost REAL,
                net_fuel_savings REAL,
                total_benefit_low REAL,
                total_benefit_high REAL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)
        c.execute("""
            CREATE TABLE IF NOT EXISTS contacts (
                id SERIAL PRIMARY KEY,
                submission_id INTEGER REFERENCES submissions(id),
                company_name TEXT,
                contact_name TEXT,
                email TEXT,
                phone TEXT,
                fleet_size INTEGER,
                depot_location TEXT,
                best_time TEXT,
                notes TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)
    else:
        c.execute("""
            CREATE TABLE IF NOT EXISTS submissions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT UNIQUE NOT NULL,
                status TEXT DEFAULT 'incomplete',
                last_completed_step INTEGER DEFAULT 0,
                company_name TEXT,
                province TEXT,
                mini_count INTEGER DEFAULT 0,
                midsize_count INTEGER DEFAULT 0,
                fullsize_count INTEGER DEFAULT 0,
                fleet_size INTEGER,
                daily_km REAL,
                morning_start REAL,
                morning_end REAL,
                afternoon_start REAL,
                afternoon_end REAL,
                available_5_9pm INTEGER,
                midday_available INTEGER,
                other_available_times TEXT,
                central_depot INTEGER,
                mini_v2g_kwh REAL,
                midsize_v2g_kwh REAL,
                fullsize_v2g_kwh REAL,
                mini_flagged BOOLEAN,
                midsize_flagged BOOLEAN,
                fullsize_flagged BOOLEAN,
                total_v2g_energy_kwh REAL,
                gross_v2g_revenue_low REAL,
                gross_v2g_revenue_high REAL,
                total_replenishment_cost REAL,
                net_v2g_revenue_low REAL,
                net_v2g_revenue_high REAL,
                annual_diesel_cost REAL,
                annual_electricity_cost REAL,
                net_fuel_savings REAL,
                total_benefit_low REAL,
                total_benefit_high REAL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)
        c.execute("""
            CREATE TABLE IF NOT EXISTS contacts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                submission_id INTEGER REFERENCES submissions(id),
                company_name TEXT,
                contact_name TEXT,
                email TEXT,
                phone TEXT,
                fleet_size INTEGER,
                depot_location TEXT,
                best_time TEXT,
                notes TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)

    conn.commit()
    verify_schema(conn, is_postgres)
    conn.close()

init_db()

# ── Models ────────────────────────────────────────────────────────────────────

def validate_time(v, field_name="time"):
    if v is not None and not (0 <= v <= 24):
        raise ValueError(f'{field_name} must be between 0 and 24')
    return v

class PartialSubmission(BaseModel):
    session_id: str
    step: int
    company_name: Optional[str] = None
    province: Optional[str] = None
    mini_count: Optional[int] = None
    midsize_count: Optional[int] = None
    fullsize_count: Optional[int] = None
    daily_km: Optional[float] = None
    morning_start: Optional[float] = None
    morning_end: Optional[float] = None
    afternoon_start: Optional[float] = None
    afternoon_end: Optional[float] = None
    available_5_9pm: Optional[bool] = None
    midday_available: Optional[bool] = None
    other_available_times: Optional[str] = None
    central_depot: Optional[bool] = None

    @field_validator('mini_count', 'midsize_count', 'fullsize_count')
    @classmethod
    def counts_non_negative(cls, v):
        if v is not None and v < 0:
            raise ValueError('Bus counts cannot be negative')
        return v

    @field_validator('daily_km')
    @classmethod
    def km_positive(cls, v):
        if v is not None and v <= 0:
            raise ValueError('Daily km must be positive')
        return v

    @field_validator('morning_start', 'morning_end', 'afternoon_start', 'afternoon_end')
    @classmethod
    def time_in_range(cls, v):
        return validate_time(v)


class SurveyInput(BaseModel):
    session_id: str
    company_name: Optional[str] = None
    mini_count: int = 0
    midsize_count: int = 0
    fullsize_count: int = 0
    daily_km: float
    morning_start: float
    morning_end: float
    afternoon_start: Optional[float] = None
    afternoon_end: Optional[float] = None
    available_5_9pm: bool
    midday_available: bool = False
    other_available_times: Optional[str] = None
    province: str
    central_depot: bool

    @field_validator('mini_count', 'midsize_count', 'fullsize_count')
    @classmethod
    def counts_non_negative(cls, v):
        if v < 0:
            raise ValueError('Bus counts cannot be negative')
        return v

    @field_validator('daily_km')
    @classmethod
    def km_positive(cls, v):
        if v <= 0:
            raise ValueError('Daily km must be positive')
        return v

    @field_validator('morning_start', 'morning_end', 'afternoon_start', 'afternoon_end')
    @classmethod
    def time_in_range(cls, v):
        return validate_time(v)

    @field_validator('morning_end')
    @classmethod
    def morning_end_after_start(cls, v, info):
        if 'morning_start' in info.data and v <= info.data['morning_start']:
            raise ValueError('morning_end must be after morning_start')
        return v

    @model_validator(mode='after')
    def validate_afternoon(self):
        if (self.afternoon_start is None) != (self.afternoon_end is None):
            raise ValueError(
                'afternoon_start and afternoon_end must both be provided or both omitted'
            )
        if self.afternoon_start is not None:
            if self.afternoon_end <= self.afternoon_start:
                raise ValueError('afternoon_end must be after afternoon_start')
            if self.afternoon_start < self.morning_end:
                raise ValueError('afternoon_start must be >= morning_end')
        return self

    @model_validator(mode='after')
    def fleet_not_empty(self):
        if self.mini_count + self.midsize_count + self.fullsize_count == 0:
            raise ValueError('Fleet must have at least one bus')
        return self

    @model_validator(mode='after')
    def province_valid(self):
        if self.province not in UTILITY_RATES:
            raise ValueError(f'Province must be one of {list(UTILITY_RATES.keys())}')
        return self


class ContactInfo(BaseModel):
    submission_id: int = Field(gt=0)
    company_name: str = ""
    contact_name: str = ""
    name: str = ""
    email: str
    phone: str = ""
    fleet_size: int = 0
    depot_location: str = ""
    best_time: str = ""
    notes: str = ""

# ── Helpers ───────────────────────────────────────────────────────────────────

def optional_bool_to_int(val: Optional[bool]) -> Optional[int]:
    if val is None:
        return None
    return int(val)

# ── Per-category V2G calculation ──────────────────────────────────────────────

def calculate_bus_v2g(
    category: str,
    daily_km: float,
    morning_end: float,
    afternoon_start: Optional[float],
    afternoon_end: Optional[float],
    midday_available: bool,
    available_5_9pm: bool,
    electricity_rate: float,
) -> dict:

    capacity = BATTERY_KWH[category]
    reserve = capacity * MIN_SOC
    consumption = ENERGY_PER_KM[category]

    has_afternoon = afternoon_start is not None and afternoon_end is not None

    if has_afternoon:
        morning_energy = (daily_km / 2) * consumption
        afternoon_energy = (daily_km / 2) * consumption
    else:
        morning_energy = daily_km * consumption
        afternoon_energy = 0.0

    after_morning = capacity - morning_energy
    morning_route_flag = after_morning < reserve

    if has_afternoon and midday_available:
        charging_hours = max(0.0, afternoon_start - morning_end)
        energy_added = min(
            charging_hours * CHARGER_KW * CHARGING_EFFICIENCY,
            max(0.0, capacity - after_morning)
        )
    else:
        energy_added = 0.0

    before_afternoon = min(capacity, after_morning + energy_added)
    energy_after_afternoon_route = before_afternoon - afternoon_energy

    route_flag = morning_route_flag or (energy_after_afternoon_route < reserve)

    available_for_v2g = max(0.0, energy_after_afternoon_route - reserve)

    if has_afternoon and afternoon_end is not None:
        v2g_hours = max(0.0, V2G_WINDOW_END - max(V2G_WINDOW_START, afternoon_end))
    else:
        v2g_hours = float(V2G_WINDOW_END - V2G_WINDOW_START)

    if available_5_9pm and not route_flag:
        v2g_kwh = min(available_for_v2g, CHARGER_KW * v2g_hours)
    else:
        v2g_kwh = 0.0

    annual_v2g_energy_kwh = v2g_kwh * ANNUAL_V2G_DAYS
    gross_v2g_revenue_per_bus = annual_v2g_energy_kwh * PROVISIONAL_V2G_RATE

    replenishment_cost_per_bus = (
        v2g_kwh * ANNUAL_V2G_DAYS * electricity_rate
    ) / CHARGING_EFFICIENCY

    net_v2g_revenue_per_bus = gross_v2g_revenue_per_bus - replenishment_cost_per_bus

    return {
        "battery_kwh": capacity,
        "reserve_kwh": round(reserve, 2),
        "morning_energy_kwh": round(morning_energy, 2),
        "midday_energy_added_kwh": round(energy_added, 2),
        "energy_after_afternoon_route_kwh": round(energy_after_afternoon_route, 2),
        "available_for_v2g_kwh": round(available_for_v2g, 2),
        "v2g_hours": round(v2g_hours, 2),
        "v2g_kwh_per_bus_per_day": round(v2g_kwh, 2),
        "annual_v2g_energy_kwh_per_bus": round(annual_v2g_energy_kwh, 2),
        "gross_v2g_revenue_per_bus": round(gross_v2g_revenue_per_bus, 2),
        "replenishment_cost_per_bus": round(replenishment_cost_per_bus, 2),
        "net_v2g_revenue_per_bus": round(net_v2g_revenue_per_bus, 2),
        "route_flagged": route_flag,
        "no_v2g_available": v2g_kwh == 0,
    }

# ── Fleet-level calculation ───────────────────────────────────────────────────

def calculate_v2g_revenue(data: SurveyInput) -> dict:

    fleet_size = data.mini_count + data.midsize_count + data.fullsize_count
    electricity_rate = UTILITY_RATES.get(data.province, 0.12)

    categories = {
        "mini":     data.mini_count,
        "midsize":  data.midsize_count,
        "fullsize": data.fullsize_count,
    }

    per_category = {}
    total_v2g_energy_kwh = 0.0
    total_gross_v2g_revenue = 0.0
    total_replenishment_cost = 0.0
    total_electricity_kwh = 0.0

    for cat, count in categories.items():
        if count == 0:
            per_category[cat] = {
                "count": 0,
                "v2g_kwh_per_bus_per_day": 0,
                "annual_v2g_energy_kwh_per_bus": 0,
                "gross_v2g_revenue_per_bus": 0,
                "replenishment_cost_per_bus": 0,
                "net_v2g_revenue_per_bus": 0,
                "annual_v2g_energy_kwh_fleet": 0,
                "gross_v2g_revenue_fleet_low": 0,
                "gross_v2g_revenue_fleet_high": 0,
                "net_v2g_revenue_fleet_low": 0,
                "net_v2g_revenue_fleet_high": 0,
                "route_flagged": False,
                "no_v2g_available": True,
            }
            continue

        result = calculate_bus_v2g(
            category=cat,
            daily_km=data.daily_km,
            morning_end=data.morning_end,
            afternoon_start=data.afternoon_start,
            afternoon_end=data.afternoon_end,
            midday_available=data.midday_available,
            available_5_9pm=data.available_5_9pm,
            electricity_rate=electricity_rate,
        )

        fleet_v2g_energy = count * result["annual_v2g_energy_kwh_per_bus"]
        fleet_gross_revenue = count * result["gross_v2g_revenue_per_bus"]
        fleet_replenishment = count * result["replenishment_cost_per_bus"]

        total_v2g_energy_kwh += fleet_v2g_energy
        total_gross_v2g_revenue += fleet_gross_revenue
        total_replenishment_cost += fleet_replenishment

        daily_energy = data.daily_km * ENERGY_PER_KM[cat]
        total_electricity_kwh += count * daily_energy * ANNUAL_DRIVING_DAYS

        per_category[cat] = {
            "count": count,
            "battery_kwh": result["battery_kwh"],
            "reserve_kwh": result["reserve_kwh"],
            "morning_energy_kwh": result["morning_energy_kwh"],
            "midday_energy_added_kwh": result["midday_energy_added_kwh"],
            "energy_after_afternoon_route_kwh": result["energy_after_afternoon_route_kwh"],
            "available_for_v2g_kwh": result["available_for_v2g_kwh"],
            "v2g_hours": result["v2g_hours"],
            "v2g_kwh_per_bus_per_day": result["v2g_kwh_per_bus_per_day"],
            "annual_v2g_energy_kwh_per_bus": result["annual_v2g_energy_kwh_per_bus"],
            "gross_v2g_revenue_per_bus": result["gross_v2g_revenue_per_bus"],
            "replenishment_cost_per_bus": result["replenishment_cost_per_bus"],
            "net_v2g_revenue_per_bus": result["net_v2g_revenue_per_bus"],
            "annual_v2g_energy_kwh_fleet": round(fleet_v2g_energy),
            "gross_v2g_revenue_fleet_low": round(fleet_gross_revenue * 0.7),
            "gross_v2g_revenue_fleet_high": round(fleet_gross_revenue * 1.3),
            "net_v2g_revenue_fleet_low": round(fleet_gross_revenue * 0.7 - fleet_replenishment),
            "net_v2g_revenue_fleet_high": round(fleet_gross_revenue * 1.3 - fleet_replenishment),
            "route_flagged": result["route_flagged"],
            "no_v2g_available": result["no_v2g_available"],
        }

    total_net_v2g_revenue = total_gross_v2g_revenue - total_replenishment_cost

    annual_diesel_cost = (
        fleet_size * data.daily_km *
        DIESEL_L_PER_KM * DIESEL_PRICE_PER_L * ANNUAL_DRIVING_DAYS
    )
    annual_electricity_cost = total_electricity_kwh * electricity_rate
    net_fuel_savings = annual_diesel_cost - annual_electricity_cost

    total_benefit_low = round(
        total_gross_v2g_revenue * 0.7
        - total_replenishment_cost
        + net_fuel_savings
    )
    total_benefit_high = round(
        total_gross_v2g_revenue * 1.3
        - total_replenishment_cost
        + net_fuel_savings
    )

    return {
        "fleet_size": fleet_size,
        "per_category": per_category,
        "total_v2g_energy_kwh": round(total_v2g_energy_kwh),
        "gross_v2g_revenue_low": round(total_gross_v2g_revenue * 0.7),
        "gross_v2g_revenue_high": round(total_gross_v2g_revenue * 1.3),
        "total_replenishment_cost": round(total_replenishment_cost),
        "net_v2g_revenue_low": round(total_gross_v2g_revenue * 0.7 - total_replenishment_cost),
        "net_v2g_revenue_high": round(total_gross_v2g_revenue * 1.3 - total_replenishment_cost),
        "annual_diesel_cost": round(annual_diesel_cost),
        "annual_electricity_cost": round(annual_electricity_cost),
        "net_fuel_savings": round(net_fuel_savings),
        "total_benefit_low": total_benefit_low,
        "total_benefit_high": total_benefit_high,
        "assumptions": {
            "battery_kwh_validated": False,
            "energy_per_km_validated": False,
            "v2g_rate_provisional": True,
            "diesel_price_validated": False,
            "diesel_consumption_validated": False,
            "driving_days_confirmed": False,
            "charging_efficiency": CHARGING_EFFICIENCY,
            "annual_v2g_days": ANNUAL_V2G_DAYS,
            "annual_driving_days": ANNUAL_DRIVING_DAYS,
            "range_note": "±30% range applied to gross V2G compensation only; replenishment costs and fuel savings held fixed",
            "v2g_days_note": "Illustrative 350-day scenario — applies school-day route profile to all days including non-school days",
        }
    }

# ── Endpoints ─────────────────────────────────────────────────────────────────

@app.post("/save-step")
def save_step(data: PartialSubmission):
    conn = get_db()
    c = conn.cursor()

    available_5_9pm = optional_bool_to_int(data.available_5_9pm)
    midday_available = optional_bool_to_int(data.midday_available)
    central_depot = optional_bool_to_int(data.central_depot)

    ph = "%s" if (DATABASE_URL and psycopg2) else "?"

    c.execute(
        f"SELECT id FROM submissions WHERE session_id = {ph}",
        (data.session_id,)
    )
    existing = c.fetchone()

    if existing:
        c.execute(f"""
            UPDATE submissions SET
                last_completed_step = {ph},
                company_name = COALESCE({ph}, company_name),
                province = COALESCE({ph}, province),
                mini_count = COALESCE({ph}, mini_count),
                midsize_count = COALESCE({ph}, midsize_count),
                fullsize_count = COALESCE({ph}, fullsize_count),
                daily_km = COALESCE({ph}, daily_km),
                morning_start = COALESCE({ph}, morning_start),
                morning_end = COALESCE({ph}, morning_end),
                afternoon_start = COALESCE({ph}, afternoon_start),
                afternoon_end = COALESCE({ph}, afternoon_end),
                available_5_9pm = CASE WHEN {ph} IS NOT NULL THEN {ph} ELSE available_5_9pm END,
                midday_available = CASE WHEN {ph} IS NOT NULL THEN {ph} ELSE midday_available END,
                other_available_times = COALESCE({ph}, other_available_times),
                central_depot = CASE WHEN {ph} IS NOT NULL THEN {ph} ELSE central_depot END,
                updated_at = CURRENT_TIMESTAMP
            WHERE session_id = {ph}
        """, (
            data.step,
            data.company_name, data.province,
            data.mini_count, data.midsize_count, data.fullsize_count,
            data.daily_km,
            data.morning_start, data.morning_end,
            data.afternoon_start, data.afternoon_end,
            available_5_9pm, available_5_9pm,
            midday_available, midday_available,
            data.other_available_times,
            central_depot, central_depot,
            data.session_id
        ))
        submission_id = existing["id"]
    else:
        if DATABASE_URL and psycopg2:
            c.execute("""
                INSERT INTO submissions (
                    session_id, status, last_completed_step,
                    company_name, province,
                    mini_count, midsize_count, fullsize_count,
                    daily_km, morning_start, morning_end,
                    afternoon_start, afternoon_end,
                    available_5_9pm, midday_available,
                    other_available_times, central_depot
                ) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                RETURNING id
            """, (
                data.session_id, 'incomplete', data.step,
                data.company_name, data.province,
                data.mini_count, data.midsize_count, data.fullsize_count,
                data.daily_km, data.morning_start, data.morning_end,
                data.afternoon_start, data.afternoon_end,
                available_5_9pm, midday_available,
                data.other_available_times, central_depot
            ))
            submission_id = c.fetchone()["id"]
        else:
            c.execute("""
                INSERT INTO submissions (
                    session_id, status, last_completed_step,
                    company_name, province,
                    mini_count, midsize_count, fullsize_count,
                    daily_km, morning_start, morning_end,
                    afternoon_start, afternoon_end,
                    available_5_9pm, midday_available,
                    other_available_times, central_depot
                ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            """, (
                data.session_id, 'incomplete', data.step,
                data.company_name, data.province,
                data.mini_count, data.midsize_count, data.fullsize_count,
                data.daily_km, data.morning_start, data.morning_end,
                data.afternoon_start, data.afternoon_end,
                available_5_9pm, midday_available,
                data.other_available_times, central_depot
            ))
            submission_id = c.lastrowid

    conn.commit()
    conn.close()
    return {"submission_id": submission_id, "step": data.step}


@app.post("/calculate")
def calculate(data: SurveyInput):
    return calculate_v2g_revenue(data)


@app.post("/submit")
def submit(data: SurveyInput):
    result = calculate_v2g_revenue(data)
    fleet_size = data.mini_count + data.midsize_count + data.fullsize_count
    conn = get_db()
    c = conn.cursor()

    ph = "%s" if (DATABASE_URL and psycopg2) else "?"

    c.execute(
        f"SELECT id FROM submissions WHERE session_id = {ph}",
        (data.session_id,)
    )
    existing = c.fetchone()

    mini = result["per_category"].get("mini", {})
    midsize = result["per_category"].get("midsize", {})
    fullsize = result["per_category"].get("fullsize", {})

    if existing:
        c.execute(f"""
            UPDATE submissions SET
                status = {ph},
                company_name = COALESCE({ph}, company_name),
                province = {ph},
                mini_count = {ph},
                midsize_count = {ph},
                fullsize_count = {ph},
                fleet_size = {ph},
                daily_km = {ph},
                morning_start = {ph},
                morning_end = {ph},
                afternoon_start = {ph},
                afternoon_end = {ph},
                available_5_9pm = {ph},
                midday_available = {ph},
                central_depot = {ph},
                mini_v2g_kwh = {ph},
                midsize_v2g_kwh = {ph},
                fullsize_v2g_kwh = {ph},
                mini_flagged = {ph},
                midsize_flagged = {ph},
                fullsize_flagged = {ph},
                total_v2g_energy_kwh = {ph},
                gross_v2g_revenue_low = {ph},
                gross_v2g_revenue_high = {ph},
                total_replenishment_cost = {ph},
                net_v2g_revenue_low = {ph},
                net_v2g_revenue_high = {ph},
                annual_diesel_cost = {ph},
                annual_electricity_cost = {ph},
                net_fuel_savings = {ph},
                total_benefit_low = {ph},
                total_benefit_high = {ph},
                updated_at = CURRENT_TIMESTAMP
            WHERE session_id = {ph}
        """, (
            'completed',
            data.company_name,
            data.province,
            data.mini_count, data.midsize_count, data.fullsize_count,
            fleet_size,
            data.daily_km,
            data.morning_start, data.morning_end,
            data.afternoon_start, data.afternoon_end,
            int(data.available_5_9pm), int(data.midday_available),
            int(data.central_depot),
            mini.get("v2g_kwh_per_bus_per_day", 0),
            midsize.get("v2g_kwh_per_bus_per_day", 0),
            fullsize.get("v2g_kwh_per_bus_per_day", 0),
            mini.get("route_flagged", False),
            midsize.get("route_flagged", False),
            fullsize.get("route_flagged", False),
            result["total_v2g_energy_kwh"],
            result["gross_v2g_revenue_low"],
            result["gross_v2g_revenue_high"],
            result["total_replenishment_cost"],
            result["net_v2g_revenue_low"],
            result["net_v2g_revenue_high"],
            result["annual_diesel_cost"],
            result["annual_electricity_cost"],
            result["net_fuel_savings"],
            result["total_benefit_low"],
            result["total_benefit_high"],
            data.session_id
        ))
        submission_id = existing["id"]
    else:
        if DATABASE_URL and psycopg2:
            c.execute("""
                INSERT INTO submissions (
                    session_id, status, last_completed_step,
                    company_name, province,
                    mini_count, midsize_count, fullsize_count, fleet_size,
                    daily_km, morning_start, morning_end,
                    afternoon_start, afternoon_end,
                    available_5_9pm, midday_available, central_depot,
                    mini_v2g_kwh, midsize_v2g_kwh, fullsize_v2g_kwh,
                    mini_flagged, midsize_flagged, fullsize_flagged,
                    total_v2g_energy_kwh,
                    gross_v2g_revenue_low, gross_v2g_revenue_high,
                    total_replenishment_cost,
                    net_v2g_revenue_low, net_v2g_revenue_high,
                    annual_diesel_cost, annual_electricity_cost,
                    net_fuel_savings, total_benefit_low, total_benefit_high
                ) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                RETURNING id
            """, (
                data.session_id, 'completed', 99,
                data.company_name, data.province,
                data.mini_count, data.midsize_count, data.fullsize_count, fleet_size,
                data.daily_km, data.morning_start, data.morning_end,
                data.afternoon_start, data.afternoon_end,
                int(data.available_5_9pm), int(data.midday_available), int(data.central_depot),
                mini.get("v2g_kwh_per_bus_per_day", 0),
                midsize.get("v2g_kwh_per_bus_per_day", 0),
                fullsize.get("v2g_kwh_per_bus_per_day", 0),
                mini.get("route_flagged", False),
                midsize.get("route_flagged", False),
                fullsize.get("route_flagged", False),
                result["total_v2g_energy_kwh"],
                result["gross_v2g_revenue_low"], result["gross_v2g_revenue_high"],
                result["total_replenishment_cost"],
                result["net_v2g_revenue_low"], result["net_v2g_revenue_high"],
                result["annual_diesel_cost"], result["annual_electricity_cost"],
                result["net_fuel_savings"],
                result["total_benefit_low"], result["total_benefit_high"]
            ))
            submission_id = c.fetchone()["id"]
        else:
            c.execute("""
                INSERT INTO submissions (
                    session_id, status, last_completed_step,
                    company_name, province,
                    mini_count, midsize_count, fullsize_count, fleet_size,
                    daily_km, morning_start, morning_end,
                    afternoon_start, afternoon_end,
                    available_5_9pm, midday_available, central_depot,
                    mini_v2g_kwh, midsize_v2g_kwh, fullsize_v2g_kwh,
                    mini_flagged, midsize_flagged, fullsize_flagged,
                    total_v2g_energy_kwh,
                    gross_v2g_revenue_low, gross_v2g_revenue_high,
                    total_replenishment_cost,
                    net_v2g_revenue_low, net_v2g_revenue_high,
                    annual_diesel_cost, annual_electricity_cost,
                    net_fuel_savings, total_benefit_low, total_benefit_high
                ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            """, (
                data.session_id, 'completed', 99,
                data.company_name, data.province,
                data.mini_count, data.midsize_count, data.fullsize_count, fleet_size,
                data.daily_km, data.morning_start, data.morning_end,
                data.afternoon_start, data.afternoon_end,
                int(data.available_5_9pm), int(data.midday_available), int(data.central_depot),
                mini.get("v2g_kwh_per_bus_per_day", 0),
                midsize.get("v2g_kwh_per_bus_per_day", 0),
                fullsize.get("v2g_kwh_per_bus_per_day", 0),
                mini.get("route_flagged", False),
                midsize.get("route_flagged", False),
                fullsize.get("route_flagged", False),
                result["total_v2g_energy_kwh"],
                result["gross_v2g_revenue_low"], result["gross_v2g_revenue_high"],
                result["total_replenishment_cost"],
                result["net_v2g_revenue_low"], result["net_v2g_revenue_high"],
                result["annual_diesel_cost"], result["annual_electricity_cost"],
                result["net_fuel_savings"],
                result["total_benefit_low"], result["total_benefit_high"]
            ))
            submission_id = c.lastrowid

    conn.commit()
    conn.close()

    result["submission_id"] = submission_id
    return result


@app.post("/contact")
def save_contact(data: ContactInfo):
    resolved_name = data.contact_name or data.name
    conn = get_db()
    c = conn.cursor()

    ph = "%s" if (DATABASE_URL and psycopg2) else "?"

    c.execute(
        f"SELECT id FROM submissions WHERE id = {ph}",
        (data.submission_id,)
    )
    if not c.fetchone():
        conn.close()
        raise HTTPException(
            status_code=404,
            detail=f"Submission {data.submission_id} not found"
        )

    c.execute(f"""
        INSERT INTO contacts (
            submission_id, company_name, contact_name, email, phone,
            fleet_size, depot_location, best_time, notes
        ) VALUES ({ph},{ph},{ph},{ph},{ph},{ph},{ph},{ph},{ph})
    """, (
        data.submission_id, data.company_name, resolved_name,
        data.email, data.phone, data.fleet_size,
        data.depot_location, data.best_time, data.notes
    ))
    conn.commit()
    conn.close()
    return {"message": "Contact saved successfully"}


@app.get("/survey")
def survey_page():
    return FileResponse("sarvin-frontend/index.html")

@app.get("/test")
def test_page():
    return FileResponse("test.html")

@app.get("/")
def root():
    return {"message": "Fuse Gamification API is running"}

app.mount("/v2g", StaticFiles(directory="public", html=True), name="public")