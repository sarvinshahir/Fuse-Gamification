from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel
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

BATTERY_SIZE_KWH = 255
MIN_SOC = 0.20
USABLE_BATTERY_KWH = BATTERY_SIZE_KWH * (1 - MIN_SOC)  # 204 kWh
CHARGER_KW = 40
V2G_WINDOW_HOURS = 4.0          # 5pm–9pm
ANNUAL_DAYS = 350

ENERGY_PER_KM = 1.3             # TODO validate with Lynch Excel from Rob

DIESEL_L_PER_KM = 0.40          # TODO validate with Rob
DIESEL_PRICE_PER_L = 2.30       # TODO validate — BC average

PROVISIONAL_V2G_RATE = 0.12     # $/kWh — placeholder, methodology not confirmed

UTILITY_RATES = {
    "BC": 0.12,
    "ON": 0.13,
    "QC": 0.07,
    "NS": 0.18
}

BATTERY_MAP = {
    "small": 175,
    "medium": 255,
    "large": 255
}

# ── Database ──────────────────────────────────────────────────────────────────

DATABASE_URL = os.getenv("DATABASE_URL")

def get_db():
    if DATABASE_URL:
        if psycopg2 is None:
            raise RuntimeError("DATABASE_URL is set but psycopg2 is unavailable — check requirements.txt")
        conn = psycopg2.connect(DATABASE_URL, cursor_factory=RealDictCursor)
    else:
        conn = sqlite3.connect("gamification.db")
        conn.row_factory = sqlite3.Row
    return conn

def init_db():
    conn = get_db()
    c = conn.cursor()

    if DATABASE_URL and psycopg2:
        c.execute("""
            CREATE TABLE IF NOT EXISTS submissions (
                id SERIAL PRIMARY KEY,
                session_id TEXT,
                status TEXT DEFAULT 'incomplete',
                last_completed_step INTEGER DEFAULT 0,
                company_name TEXT,
                province TEXT,
                fleet_size INTEGER,
                vehicle_size TEXT,
                daily_km REAL,
                morning_start REAL,
                morning_end REAL,
                afternoon_start REAL,
                afternoon_end REAL,
                available_5_9pm INTEGER,
                midday_available INTEGER,
                other_available_times TEXT,
                central_depot INTEGER,
                available_energy_at_5pm_kwh REAL,
                full_recharge_time_hrs REAL,
                v2g_kwh_per_bus_per_day REAL,
                annual_v2g_energy_kwh REAL,
                v2g_revenue_low REAL,
                v2g_revenue_high REAL,
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
                session_id TEXT,
                status TEXT DEFAULT 'incomplete',
                last_completed_step INTEGER DEFAULT 0,
                company_name TEXT,
                province TEXT,
                fleet_size INTEGER,
                vehicle_size TEXT,
                daily_km REAL,
                morning_start REAL,
                morning_end REAL,
                afternoon_start REAL,
                afternoon_end REAL,
                available_5_9pm INTEGER,
                midday_available INTEGER,
                other_available_times TEXT,
                central_depot INTEGER,
                available_energy_at_5pm_kwh REAL,
                full_recharge_time_hrs REAL,
                v2g_kwh_per_bus_per_day REAL,
                annual_v2g_energy_kwh REAL,
                v2g_revenue_low REAL,
                v2g_revenue_high REAL,
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
    conn.close()

init_db()

# ── Models ────────────────────────────────────────────────────────────────────

class PartialSubmission(BaseModel):
    session_id: str
    step: int
    company_name: Optional[str] = None
    province: Optional[str] = None
    fleet_size: Optional[int] = None
    vehicle_size: Optional[str] = None
    daily_km: Optional[float] = None
    morning_start: Optional[float] = None
    morning_end: Optional[float] = None
    afternoon_start: Optional[float] = None
    afternoon_end: Optional[float] = None
    available_5_9pm: Optional[bool] = None
    midday_available: Optional[bool] = None
    other_available_times: Optional[str] = None
    central_depot: Optional[bool] = None

class SurveyInput(BaseModel):
    session_id: str
    fleet_size: int
    vehicle_size: str
    daily_km: float
    morning_start: float
    morning_end: float
    afternoon_start: float
    afternoon_end: float
    available_5_9pm: bool
    midday_available: bool = False
    other_available_times: Optional[str] = None
    province: str
    central_depot: bool

class ContactInfo(BaseModel):
    submission_id: int = 0
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

# ── Value Calculation ─────────────────────────────────────────────────────────

def calculate_v2g_revenue(data: SurveyInput):

    battery_size = BATTERY_MAP.get(data.vehicle_size, 255)
    usable_battery = battery_size * (1 - MIN_SOC)
    electricity_rate = UTILITY_RATES.get(data.province, 0.12)

    # 1. Fleet potential — assume 100% become EV
    num_evs = data.fleet_size

    # 2. Energy consumed on routes
    # TODO: validate 50/50 split with Lynch route spreadsheet
    morning_energy = (data.daily_km / 2) * ENERGY_PER_KM
    afternoon_energy = (data.daily_km / 2) * ENERGY_PER_KM
    total_energy_per_day = morning_energy + afternoon_energy

    # 3. SOC sequence through the day
    energy_after_morning = usable_battery - morning_energy
    energy_before_afternoon = usable_battery if data.midday_available else energy_after_morning
    available_energy_at_5pm_kwh = max(0.0, energy_before_afternoon - afternoon_energy)

    # 4. Recharge times
    full_recharge_time_hrs = usable_battery / CHARGER_KW  # 204/40 = 5.1 hrs
    driving_recovery_hrs = (usable_battery - available_energy_at_5pm_kwh) / CHARGER_KW

    # 5. V2G energy in 5–9pm window
    if data.available_5_9pm:
        v2g_kwh_per_bus = min(
            V2G_WINDOW_HOURS * CHARGER_KW,
            available_energy_at_5pm_kwh
        )
    else:
        v2g_kwh_per_bus = 0.0

    # 6. Annual V2G energy potential
    annual_v2g_energy_kwh = num_evs * v2g_kwh_per_bus * ANNUAL_DAYS
    annual_v2g_revenue = annual_v2g_energy_kwh * PROVISIONAL_V2G_RATE

    # 7. Fuel savings
    annual_diesel_cost = (
        data.fleet_size * data.daily_km *
        DIESEL_L_PER_KM * DIESEL_PRICE_PER_L * ANNUAL_DAYS
    )
    annual_electricity_cost = (
        data.fleet_size * total_energy_per_day *
        electricity_rate * ANNUAL_DAYS
    )
    net_fuel_savings = max(0, annual_diesel_cost - annual_electricity_cost)

    # 8. Total benefit ±30%
    total_benefit = annual_v2g_revenue + net_fuel_savings

    return {
        "num_evs": num_evs,
        "usable_battery_kwh": round(usable_battery, 1),
        "available_energy_at_5pm_kwh": round(available_energy_at_5pm_kwh, 1),
        "full_recharge_time_hrs": round(full_recharge_time_hrs, 1),
        "driving_recovery_hrs": round(driving_recovery_hrs, 1),
        "v2g_kwh_per_bus_per_day": round(v2g_kwh_per_bus, 1),
        "annual_v2g_energy_kwh": round(annual_v2g_energy_kwh),
        "v2g_revenue_low": round(annual_v2g_revenue * 0.7),
        "v2g_revenue_high": round(annual_v2g_revenue * 1.3),
        "annual_diesel_cost": round(annual_diesel_cost),
        "annual_electricity_cost": round(annual_electricity_cost),
        "net_fuel_savings": round(net_fuel_savings),
        "total_benefit_low": round(total_benefit * 0.7),
        "total_benefit_high": round(total_benefit * 1.3),
        "assumptions": {
            "morning_afternoon_split": "50/50 — TODO validate with Lynch routes",
            "v2g_rate_provisional": True,
            "diesel_price_validated": False,
            "diesel_consumption_validated": False,
            "energy_per_km_validated": False
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

    # ── FIXED: separate execute and fetchone ──
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
                fleet_size = COALESCE({ph}, fleet_size),
                vehicle_size = COALESCE({ph}, vehicle_size),
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
            data.company_name, data.province, data.fleet_size,
            data.vehicle_size, data.daily_km,
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
                    company_name, province, fleet_size, vehicle_size, daily_km,
                    morning_start, morning_end, afternoon_start, afternoon_end,
                    available_5_9pm, midday_available, other_available_times, central_depot
                ) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                RETURNING id
            """, (
                data.session_id, 'incomplete', data.step,
                data.company_name, data.province, data.fleet_size,
                data.vehicle_size, data.daily_km,
                data.morning_start, data.morning_end,
                data.afternoon_start, data.afternoon_end,
                available_5_9pm, midday_available,
                data.other_available_times, central_depot
            ))
            submission_id = c.fetchone()["id"]
        else:
            c.execute("""
                INSERT INTO submissions (
                    session_id, status, last_completed_step,
                    company_name, province, fleet_size, vehicle_size, daily_km,
                    morning_start, morning_end, afternoon_start, afternoon_end,
                    available_5_9pm, midday_available, other_available_times, central_depot
                ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            """, (
                data.session_id, 'incomplete', data.step,
                data.company_name, data.province, data.fleet_size,
                data.vehicle_size, data.daily_km,
                data.morning_start, data.morning_end,
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
    conn = get_db()
    c = conn.cursor()

    ph = "%s" if (DATABASE_URL and psycopg2) else "?"

    # ── FIXED: separate execute and fetchone ──
    c.execute(
        f"SELECT id FROM submissions WHERE session_id = {ph}",
        (data.session_id,)
    )
    existing = c.fetchone()

    if existing:
        c.execute(f"""
            UPDATE submissions SET
                status = {ph},
                available_energy_at_5pm_kwh = {ph},
                full_recharge_time_hrs = {ph},
                v2g_kwh_per_bus_per_day = {ph},
                annual_v2g_energy_kwh = {ph},
                v2g_revenue_low = {ph},
                v2g_revenue_high = {ph},
                annual_diesel_cost = {ph},
                annual_electricity_cost = {ph},
                net_fuel_savings = {ph},
                total_benefit_low = {ph},
                total_benefit_high = {ph},
                updated_at = CURRENT_TIMESTAMP
            WHERE session_id = {ph}
        """, (
            'completed',
            result["available_energy_at_5pm_kwh"],
            result["full_recharge_time_hrs"],
            result["v2g_kwh_per_bus_per_day"],
            result["annual_v2g_energy_kwh"],
            result["v2g_revenue_low"],
            result["v2g_revenue_high"],
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
                    fleet_size, vehicle_size, daily_km, province,
                    available_5_9pm, midday_available, central_depot,
                    available_energy_at_5pm_kwh, full_recharge_time_hrs,
                    v2g_kwh_per_bus_per_day, annual_v2g_energy_kwh,
                    v2g_revenue_low, v2g_revenue_high,
                    annual_diesel_cost, annual_electricity_cost,
                    net_fuel_savings, total_benefit_low, total_benefit_high
                ) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                RETURNING id
            """, (
                data.session_id, 'completed', 99,
                data.fleet_size, data.vehicle_size, data.daily_km, data.province,
                int(data.available_5_9pm), int(data.midday_available), int(data.central_depot),
                result["available_energy_at_5pm_kwh"],
                result["full_recharge_time_hrs"],
                result["v2g_kwh_per_bus_per_day"],
                result["annual_v2g_energy_kwh"],
                result["v2g_revenue_low"], result["v2g_revenue_high"],
                result["annual_diesel_cost"], result["annual_electricity_cost"],
                result["net_fuel_savings"],
                result["total_benefit_low"], result["total_benefit_high"]
            ))
            submission_id = c.fetchone()["id"]
        else:
            c.execute("""
                INSERT INTO submissions (
                    session_id, status, last_completed_step,
                    fleet_size, vehicle_size, daily_km, province,
                    available_5_9pm, midday_available, central_depot,
                    available_energy_at_5pm_kwh, full_recharge_time_hrs,
                    v2g_kwh_per_bus_per_day, annual_v2g_energy_kwh,
                    v2g_revenue_low, v2g_revenue_high,
                    annual_diesel_cost, annual_electricity_cost,
                    net_fuel_savings, total_benefit_low, total_benefit_high
                ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            """, (
                data.session_id, 'completed', 99,
                data.fleet_size, data.vehicle_size, data.daily_km, data.province,
                int(data.available_5_9pm), int(data.midday_available), int(data.central_depot),
                result["available_energy_at_5pm_kwh"],
                result["full_recharge_time_hrs"],
                result["v2g_kwh_per_bus_per_day"],
                result["annual_v2g_energy_kwh"],
                result["v2g_revenue_low"], result["v2g_revenue_high"],
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