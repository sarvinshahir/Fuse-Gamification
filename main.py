from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Optional
import sqlite3

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Constants ─────────────────────────────────────────────────────────────────

BATTERY_SIZE_KWH = 255          # kWh — confirmed in meeting (school bus Phase 1)
MIN_SOC = 0.20                  # 20% minimum state of charge
USABLE_BATTERY_KWH = BATTERY_SIZE_KWH * (1 - MIN_SOC)  # 204 kWh
CHARGER_KW = 40                 # kW — Tellus Power, confirmed from Lynch
V2G_WINDOW_HOURS = 4.0          # 5pm–9pm
ANNUAL_DAYS = 350               # days/year — confirmed in meeting

ENERGY_PER_KM = 1.3             # kWh/km — TODO validate with Lynch Excel from Rob

# TODO: both values below need validation before using in business case
DIESEL_L_PER_KM = 0.40          # L/km — school bus estimate, unconfirmed
DIESEL_PRICE_PER_L = 2.30       # $/L — BC average, unconfirmed

# Provisional — V2G compensation methodology not yet confirmed with Rob/Bryan
PROVISIONAL_V2G_RATE = 0.12     # $/kWh — placeholder only

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

def get_db():
    conn = sqlite3.connect("gamification.db")
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    conn = get_db()
    c = conn.cursor()

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
    """True→1, False→0, None→None (unanswered stays NULL)"""
    if val is None:
        return None
    return int(val)

# ── Value Calculation ─────────────────────────────────────────────────────────

def calculate_v2g_revenue(data: SurveyInput):

    battery_size = BATTERY_MAP.get(data.vehicle_size, 255)
    usable_battery = battery_size * (1 - MIN_SOC)  # e.g. 255 × 0.8 = 204 kWh
    electricity_rate = UTILITY_RATES.get(data.province, 0.12)

    # 1. Fleet potential — assume 100% become EV
    num_evs = data.fleet_size

    # 2. Energy consumed on routes
    # NOTE: 50/50 morning/afternoon split is a working assumption
    # TODO: validate with Lynch route spreadsheet Rob mentioned
    morning_energy = (data.daily_km / 2) * ENERGY_PER_KM
    afternoon_energy = (data.daily_km / 2) * ENERGY_PER_KM
    total_energy_per_day = morning_energy + afternoon_energy

    # 3. SOC sequence through the day
    # Bus starts fully charged (204 kWh usable)
    energy_after_morning = usable_battery - morning_energy

    # Midday recharge: if available, bus recharges to full before afternoon
    energy_before_afternoon = usable_battery if data.midday_available else energy_after_morning

    # SOC arriving at 5pm (in kWh, not percentage)
    available_energy_at_5pm_kwh = max(0.0, energy_before_afternoon - afternoon_energy)

    # 4. Recharge times — two separate concepts
    # Full recharge (20% → 100%): the reference number from Slide 4 / meeting note
    full_recharge_time_hrs = usable_battery / CHARGER_KW  # 204 / 40 = 5.1 hours

    # Driving recovery recharge: how long to recover just what driving consumed
    # Useful for operations planning but not shown on Slide 4
    driving_recovery_hrs = (usable_battery - available_energy_at_5pm_kwh) / CHARGER_KW

    # 5. V2G energy available in 5–9pm window
    # Constrained by charger power × 4 hours, and actual energy available at 5pm
    if data.available_5_9pm:
        v2g_kwh_per_bus = min(
            V2G_WINDOW_HOURS * CHARGER_KW,   # 160 kWh physical max
            available_energy_at_5pm_kwh       # what's actually in battery at 5pm
        )
    else:
        v2g_kwh_per_bus = 0.0

    # 6. Annual V2G energy potential
    annual_v2g_energy_kwh = num_evs * v2g_kwh_per_bus * ANNUAL_DAYS

    # Provisional revenue — compensation methodology not confirmed
    annual_v2g_revenue = annual_v2g_energy_kwh * PROVISIONAL_V2G_RATE

    # 7. Fuel savings — calculated not asked
    # TODO: validate DIESEL_L_PER_KM and DIESEL_PRICE_PER_L with Rob
    annual_diesel_cost = (
        data.fleet_size * data.daily_km *
        DIESEL_L_PER_KM * DIESEL_PRICE_PER_L * ANNUAL_DAYS
    )
    annual_electricity_cost = (
        data.fleet_size * total_energy_per_day *
        electricity_rate * ANNUAL_DAYS
    )
    net_fuel_savings = max(0, annual_diesel_cost - annual_electricity_cost)

    # 8. Total benefit ±30% range
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

    existing = c.execute(
        "SELECT id FROM submissions WHERE session_id = ?",
        (data.session_id,)
    ).fetchone()

    if existing:
        c.execute("""
            UPDATE submissions SET
                last_completed_step = ?,
                company_name = COALESCE(?, company_name),
                province = COALESCE(?, province),
                fleet_size = COALESCE(?, fleet_size),
                vehicle_size = COALESCE(?, vehicle_size),
                daily_km = COALESCE(?, daily_km),
                morning_start = COALESCE(?, morning_start),
                morning_end = COALESCE(?, morning_end),
                afternoon_start = COALESCE(?, afternoon_start),
                afternoon_end = COALESCE(?, afternoon_end),
                available_5_9pm = CASE WHEN ? IS NOT NULL THEN ? ELSE available_5_9pm END,
                midday_available = CASE WHEN ? IS NOT NULL THEN ? ELSE midday_available END,
                other_available_times = COALESCE(?, other_available_times),
                central_depot = CASE WHEN ? IS NOT NULL THEN ? ELSE central_depot END,
                updated_at = CURRENT_TIMESTAMP
            WHERE session_id = ?
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

    # Harden: create row if /save-step was never called
    existing = c.execute(
        "SELECT id FROM submissions WHERE session_id = ?",
        (data.session_id,)
    ).fetchone()

    if existing:
        c.execute("""
            UPDATE submissions SET
                status = 'completed',
                available_energy_at_5pm_kwh = ?,
                full_recharge_time_hrs = ?,
                v2g_kwh_per_bus_per_day = ?,
                annual_v2g_energy_kwh = ?,
                v2g_revenue_low = ?,
                v2g_revenue_high = ?,
                annual_diesel_cost = ?,
                annual_electricity_cost = ?,
                net_fuel_savings = ?,
                total_benefit_low = ?,
                total_benefit_high = ?,
                updated_at = CURRENT_TIMESTAMP
            WHERE session_id = ?
        """, (
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
        # Fallback: create the row if save-step was never called
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
    c.execute("""
        INSERT INTO contacts (
            submission_id, company_name, contact_name, email, phone,
            fleet_size, depot_location, best_time, notes
        ) VALUES (?,?,?,?,?,?,?,?,?)
    """, (
        data.submission_id, data.company_name, resolved_name,
        data.email, data.phone, data.fleet_size,
        data.depot_location, data.best_time, data.notes
    ))
    conn.commit()
    conn.close()
    return {"message": "Contact saved successfully"}

@app.get("/")
def root():
    return {"message": "Fuse Gamification API is running"}