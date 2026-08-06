from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import sqlite3

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Database setup
def init_db():
    conn = sqlite3.connect("gamification.db")
    c = conn.cursor()
    c.execute("""
        CREATE TABLE IF NOT EXISTS submissions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            fleet_size INTEGER,
            pct_ev REAL,
            vehicle_size TEXT,
            daily_km TEXT,
            operating_hours REAL,
            province TEXT,
            annual_fuel_spend REAL,
            v2g_revenue_low REAL,
            v2g_revenue_high REAL,
            diesel_savings REAL,
            total_benefit_low REAL,
            total_benefit_high REAL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
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
            ev_count INTEGER,
            depot_location TEXT,
            best_time TEXT,
            notes TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)
    conn.commit()
    conn.close()

init_db()

# Survey input model
class SurveyInput(BaseModel):
    fleet_size: int
    pct_ev: float
    vehicle_size: str
    daily_km: str
    operating_hours: float
    province: str
    annual_fuel_spend: float

# Contact input model
class ContactInfo(BaseModel):
    submission_id: int = 0
    company_name: str = ""
    contact_name: str = ""
    name: str = ""
    email: str
    phone: str = ""
    fleet_size: int = 0
    ev_count: int = 0
    depot_location: str = ""
    best_time: str = ""
    notes: str = ""

# Value calc function
def calculate_v2g_revenue(data: SurveyInput):
    battery_map = {"small": 157, "medium": 210, "large": 185}
    km_map = {"under_50": 35, "50_100": 75, "100_150": 125, "150_plus": 160}
    utility_rates = {"BC": 0.12, "ON": 0.13, "QC": 0.07, "NS": 0.18}

    battery_size = battery_map.get(data.vehicle_size, 210)
    daily_km = km_map.get(data.daily_km, 75)
    rate = utility_rates.get(data.province, 0.12)

    energy_per_km = 1.3
    operating_days = 190
    charger_kw = 40

    num_evs = data.fleet_size * (data.pct_ev / 100)
    energy_used = daily_km * energy_per_km
    battery_remaining = battery_size - energy_used
    recharge_time = energy_used / charger_kw
    v2g_uptime = 24 - data.operating_hours - recharge_time
    v2g_kwh = min(v2g_uptime * charger_kw * 0.5, battery_remaining * 0.5)
    annual_v2g = max(0, num_evs * v2g_kwh * operating_days * rate)
    diesel_savings = data.annual_fuel_spend * 0.7

    return {
        "v2g_revenue_low": round(annual_v2g * 0.7),
        "v2g_revenue_high": round(annual_v2g * 1.3),
        "diesel_savings": round(diesel_savings),
        "total_benefit_low": round((annual_v2g + diesel_savings) * 0.7),
        "total_benefit_high": round((annual_v2g + diesel_savings) * 1.3)
    }

# Calculate only — no saving
@app.post("/calculate")
def calculate(data: SurveyInput):
    return calculate_v2g_revenue(data)

# Calculate and save — called on final submit
@app.post("/submit")
def submit(data: SurveyInput):
    result = calculate_v2g_revenue(data)

    conn = sqlite3.connect("gamification.db")
    c = conn.cursor()
    c.execute("""
        INSERT INTO submissions (
            fleet_size, pct_ev, vehicle_size, daily_km, operating_hours,
            province, annual_fuel_spend, v2g_revenue_low, v2g_revenue_high,
            diesel_savings, total_benefit_low, total_benefit_high
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    """, (
        data.fleet_size, data.pct_ev, data.vehicle_size, data.daily_km,
        data.operating_hours, data.province, data.annual_fuel_spend,
        result["v2g_revenue_low"], result["v2g_revenue_high"],
        result["diesel_savings"], result["total_benefit_low"], result["total_benefit_high"]
    ))
    submission_id = c.lastrowid
    conn.commit()
    conn.close()

    result["submission_id"] = submission_id
    return result

# Save contact info
@app.post("/contact")
def save_contact(data: ContactInfo):
    resolved_name = data.contact_name or data.name

    conn = sqlite3.connect("gamification.db")
    c = conn.cursor()
    c.execute("""
        INSERT INTO contacts (
            submission_id, company_name, contact_name, email, phone,
            fleet_size, ev_count, depot_location, best_time, notes
        ) VALUES (?,?,?,?,?,?,?,?,?,?)
    """, (
        data.submission_id, data.company_name, resolved_name, data.email, data.phone,
        data.fleet_size, data.ev_count, data.depot_location,
        data.best_time, data.notes
    ))
    conn.commit()
    conn.close()
    return {"message": "Contact saved successfully"}

@app.get("/")
def root():
    return {"message": "Fuse Gamification API is running"}