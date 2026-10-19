"""
BC School Bus Electrification and V2G Calculator
Fuse Power Management — October 2026 Prototype
BC-specific build: main_bc.py
"""

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.responses import HTMLResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, validator
from typing import Optional
import sqlite3
import json
import os
import math

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

TCO_YEARS = 10

SCHOOL_DRIVING_DAYS = 190
# Number of BC Hydro dispatch events per year used for replenishment cost modelling.
# The BC Hydro ESI manual does not specify an annual event count — events can occur
# year-round, up to twice per day, called with 24-hour notice. This value is a
# placeholder; replace it with a defensible assumption from your BC Hydro agreement
# before using replenishment costs in any client-facing output.
EXPECTED_DISPATCH_EVENTS_PER_YEAR = 50  # PLACEHOLDER — not from BC Hydro program docs

DIESEL_PRICE_PER_L = 2.50
DIESEL_L_PER_KM = 0.40

BC_ELECTRICITY_RATE = 0.0838  # CAD/kWh — illustrative Fleet Overnight Rate reference

MIN_SOC = 0.20
CHARGER_KW = 40
CHARGING_EFFICIENCY = 0.90
DISCHARGE_EFFICIENCY = 0.90

V2G_WINDOW_START = 17  # 5 PM
V2G_WINDOW_END = 21    # 9 PM

MAINTENANCE = {
    "diesel_annual": 11_000,
    "electric_annual": 4_500,
}

# Charging infrastructure: ~$80,000 CAD per port (NRCan estimate for 50 kW installed port).
# One port per bus assumed. Prototype assumption — actual cost is site-specific.
CHARGING_INFRASTRUCTURE_PER_BUS = 80_000

BUS_CONFIG = {
    "mini": {
        "model": "Representative Small Electric Bus",
        "battery_kwh": 120,
        "energy_per_km": 0.70,
        "ev_price": 300_000,
        "conventional_price": 130_000,
    },
    "midsize": {
        "model": "Micro Bird G5e",
        "battery_kwh": 175,
        "energy_per_km": 0.80,
        "ev_price": 382_646,
        "conventional_price": 140_000,
    },
    "fullsize": {
        "model": "LIONC Range Plus",
        "battery_kwh": 212,
        "energy_per_km": 0.875,
        "ev_price": 425_000,
        "conventional_price": 200_000,
    },
}

BC_HYDRO_INCENTIVE = {
    "energy_rate_factor": 10_000,
    "capacity_rate": 10_000,
    "required_duration_hours": 4,
    "eligible_cost_cap": None,  # unknown — prototype uses min(a, b) only
}

MODEL_VERSION = "1.0.0-prototype-oct2026"
DB_PATH = os.environ.get("DB_PATH", "v2g_calculator.db")

# ---------------------------------------------------------------------------
# Database
# ---------------------------------------------------------------------------

def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    conn = get_db()
    conn.execute("""
        CREATE TABLE IF NOT EXISTS submissions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            company_name TEXT,
            contact_name TEXT,
            email TEXT,
            phone TEXT,
            depot_location TEXT,
            inputs TEXT,
            results TEXT,
            model_version TEXT
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS partial_steps (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT,
            step TEXT,
            data TEXT,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)
    conn.commit()
    conn.close()

# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------

class FleetInputs(BaseModel):
    """Fleet/operational inputs only — no contact info required."""
    mini_count: int = 0
    midsize_count: int = 0
    fullsize_count: int = 0
    available_5_9pm: bool = True
    midday_charging_available: bool = False  # operator must confirm buses are plugged in during midday
    daily_km: float = 80.0
    morning_start_hour: float = 7.0
    morning_end_hour: float = 9.0
    afternoon_start_hour: float = 14.5
    afternoon_end_hour: float = 17.0

    @validator("mini_count", "midsize_count", "fullsize_count")
    def non_negative(cls, v):
        if v < 0:
            raise ValueError("Bus counts must be non-negative")
        return v

    @validator("fullsize_count")
    def fleet_not_empty(cls, v, values):
        total = values.get("mini_count", 0) + values.get("midsize_count", 0) + v
        if total == 0:
            raise ValueError("Total fleet size must be greater than zero")
        return v

    @validator("afternoon_end_hour")
    def times_are_valid(cls, v, values):
        ms = values.get("morning_start_hour", 7)
        me = values.get("morning_end_hour", 9)
        as_ = values.get("afternoon_start_hour", 14.5)
        if me <= ms:
            raise ValueError("Morning end must be after morning start")
        if as_ <= me:
            raise ValueError("Afternoon start must be after morning end")
        if v <= as_:
            raise ValueError("Afternoon end must be after afternoon start")
        return v

class SurveyInputs(FleetInputs):
    """Full submission — fleet inputs + contact info."""
    company_name: str
    contact_name: str
    email: str
    phone: Optional[str] = None
    depot_location: Optional[str] = None

class PartialStep(BaseModel):
    session_id: str
    step: str
    data: dict

class ContactInfo(BaseModel):
    contact_name: str
    email: str
    phone: Optional[str] = None
    depot_location: Optional[str] = None
    company_name: Optional[str] = None

# ---------------------------------------------------------------------------
# Schedule derivation
# ---------------------------------------------------------------------------

def derive_schedule(inputs) -> dict:
    """Derive midday hours, V2G hours, and km split from schedule inputs."""
    daily_km = inputs.daily_km
    morning_duration = inputs.morning_end_hour - inputs.morning_start_hour
    afternoon_duration = inputs.afternoon_end_hour - inputs.afternoon_start_hour
    total_drive_time = morning_duration + afternoon_duration

    if total_drive_time > 0:
        morning_km = daily_km * (morning_duration / total_drive_time)
        afternoon_km = daily_km * (afternoon_duration / total_drive_time)
    else:
        morning_km = daily_km / 2
        afternoon_km = daily_km / 2

    midday_hours = max(0.0, inputs.afternoon_start_hour - inputs.morning_end_hour)
    # Midday charging only if the operator confirmed buses are plugged in during the gap
    midday_available = inputs.midday_charging_available and midday_hours > 0

    v2g_available_start = max(float(V2G_WINDOW_START), inputs.afternoon_end_hour)
    v2g_hours = max(0.0, float(V2G_WINDOW_END) - v2g_available_start)
    if not inputs.available_5_9pm:
        v2g_hours = 0.0

    return {
        "daily_km": daily_km,
        "morning_km": morning_km,
        "afternoon_km": afternoon_km,
        "midday_hours": midday_hours,
        "midday_available": midday_available,
        "v2g_hours": v2g_hours,
    }

# ---------------------------------------------------------------------------
# Calculation functions
# ---------------------------------------------------------------------------

def calculate_fleet_size(mini: int, midsize: int, fullsize: int) -> int:
    return mini + midsize + fullsize

def calculate_daily_energy_consumption(bus_type: str, daily_km: float) -> dict:
    cfg = BUS_CONFIG[bus_type]
    driving_kwh = daily_km * cfg["energy_per_km"]
    grid_kwh = driving_kwh / CHARGING_EFFICIENCY
    return {"battery_driving_kwh": driving_kwh, "grid_driving_kwh": grid_kwh}

def calculate_battery_energy_schedule(bus_type: str, schedule: dict) -> dict:
    cfg = BUS_CONFIG[bus_type]
    battery_kwh = cfg["battery_kwh"]
    energy_per_km = cfg["energy_per_km"]
    morning_kwh = schedule["morning_km"] * energy_per_km
    afternoon_kwh = schedule["afternoon_km"] * energy_per_km
    minimum_reserve_kwh = battery_kwh * MIN_SOC

    soc_after_morning = max(battery_kwh - morning_kwh, minimum_reserve_kwh)

    midday_charge_kwh = 0.0
    if schedule["midday_available"]:
        midday_charge_kwh = calculate_midday_charging(bus_type, soc_after_morning, schedule["midday_hours"])
        soc_after_midday = min(battery_kwh, soc_after_morning + midday_charge_kwh)
    else:
        soc_after_midday = soc_after_morning

    soc_after_afternoon = max(soc_after_midday - afternoon_kwh, minimum_reserve_kwh)
    available_for_v2g = max(0.0, soc_after_afternoon - minimum_reserve_kwh)

    return {
        "battery_kwh": battery_kwh,
        "minimum_reserve_kwh": minimum_reserve_kwh,
        "morning_driving_kwh": morning_kwh,
        "midday_charge_kwh": midday_charge_kwh,
        "afternoon_driving_kwh": afternoon_kwh,
        "soc_after_afternoon_kwh": soc_after_afternoon,
        "available_for_v2g_kwh": available_for_v2g,
    }

def calculate_midday_charging(bus_type: str, soc_after_morning: float, midday_hours: float) -> float:
    cfg = BUS_CONFIG[bus_type]
    battery_kwh = cfg["battery_kwh"]
    available_space = battery_kwh - soc_after_morning
    max_charge = CHARGER_KW * midday_hours * CHARGING_EFFICIENCY
    return min(max_charge, available_space)

def calculate_v2g_export_capacity(bus_type: str, schedule: dict) -> dict:
    sched = calculate_battery_energy_schedule(bus_type, schedule)
    available_kwh = sched["available_for_v2g_kwh"]
    charger_limit_kwh = CHARGER_KW * schedule["v2g_hours"]
    v2g_export_kwh = min(available_kwh * DISCHARGE_EFFICIENCY, charger_limit_kwh)
    return {
        "available_battery_kwh": available_kwh,
        "charger_limit_kwh": charger_limit_kwh,
        "v2g_export_kwh": v2g_export_kwh,
    }

def calculate_nominated_energy(bus_type: str, schedule: dict) -> float:
    return calculate_v2g_export_capacity(bus_type, schedule)["v2g_export_kwh"]

def calculate_nominated_power(nominated_energy_kwh: float, v2g_hours: float) -> float:
    duration = max(v2g_hours, 1.0)
    return min(CHARGER_KW, nominated_energy_kwh / duration)

def calculate_preliminary_bc_hydro_incentive(nominated_energy_kwh: float, nominated_kw: float, v2g_hours: float) -> dict:
    """
    BC Hydro V2G Schedule B incentive: min(a, b) where:
      a = $10,000 × nominated_energy_kwh / required_duration_hours
      b = $10,000 × nominated_kw
    Duration is always the program's fixed 4-hour requirement, not actual available hours.
    If the bus has fewer than 4 hours available it is not fully eligible — the caller should
    check meets_4_hour_requirement before using this incentive in a TCO.
    """
    factor = BC_HYDRO_INCENTIVE["energy_rate_factor"]
    cap_rate = BC_HYDRO_INCENTIVE["capacity_rate"]
    required_duration = BC_HYDRO_INCENTIVE["required_duration_hours"]  # 4 — fixed program requirement
    a = factor * nominated_energy_kwh / required_duration
    b = cap_rate * nominated_kw
    c = BC_HYDRO_INCENTIVE["eligible_cost_cap"]
    preliminary_incentive = min(a, b) if c is None else min(a, b, c)
    return {
        "energy_component_a": round(a, 2),
        "capacity_component_b": round(b, 2),
        "eligible_cost_cap_c": c,
        "preliminary_incentive_per_bus_supporting": round(preliminary_incentive, 2),
        "is_capped": c is not None,
        "meets_4_hour_requirement": v2g_hours >= required_duration,
        "label": "Illustrative BC Hydro V2G Incentive — Before Eligible-Project-Cost Cap and Program Approval",
    }

def calculate_annual_diesel_cost(annual_km: float) -> float:
    return annual_km * DIESEL_L_PER_KM * DIESEL_PRICE_PER_L

def calculate_10_year_maintenance() -> dict:
    return {
        "diesel_10y": MAINTENANCE["diesel_annual"] * TCO_YEARS,
        "electric_10y": MAINTENANCE["electric_annual"] * TCO_YEARS,
    }

def calculate_v2g_replenishment_cost(bus_type: str, schedule: dict) -> dict:
    v2g = calculate_v2g_export_capacity(bus_type, schedule)
    export_kwh = v2g["v2g_export_kwh"]
    replenishment_grid_kwh = export_kwh / DISCHARGE_EFFICIENCY / CHARGING_EFFICIENCY
    replenishment_cost_per_event = replenishment_grid_kwh * BC_ELECTRICITY_RATE
    annual_replenishment_cost = replenishment_cost_per_event * EXPECTED_DISPATCH_EVENTS_PER_YEAR
    return {
        "export_kwh_per_event": round(export_kwh, 2),
        "replenishment_grid_kwh_per_event": round(replenishment_grid_kwh, 2),
        "replenishment_cost_per_event": round(replenishment_cost_per_event, 2),
        "annual_replenishment_cost": round(annual_replenishment_cost, 2),
        "replenishment_cost_10y": round(annual_replenishment_cost * TCO_YEARS, 2),
    }

def calculate_10_year_tco(bus_type: str, schedule: dict) -> dict:
    cfg = BUS_CONFIG[bus_type]
    annual_km = schedule["daily_km"] * SCHOOL_DRIVING_DAYS
    maintenance = calculate_10_year_maintenance()

    diesel_10y = annual_km * DIESEL_L_PER_KM * DIESEL_PRICE_PER_L * TCO_YEARS

    # Diesel financing: 10% down, 90% financed at 8% for 10 years
    monthly_rate = 0.08 / 12
    n_payments = 10 * 12
    diesel_down_payment = cfg["conventional_price"] * 0.10
    diesel_loan_amount = cfg["conventional_price"] * 0.90
    diesel_monthly_payment = diesel_loan_amount * (monthly_rate * (1 + monthly_rate)**n_payments) / ((1 + monthly_rate)**n_payments - 1)
    financed_diesel_cost = diesel_down_payment + diesel_monthly_payment * n_payments
    conventional_tco = financed_diesel_cost + diesel_10y + maintenance["diesel_10y"]

    annual_grid_kwh = annual_km * cfg["energy_per_km"] / CHARGING_EFFICIENCY
    electricity_10y = annual_grid_kwh * BC_ELECTRICITY_RATE * TCO_YEARS

    # EV financing: 10% down, 90% financed at 8% for 10 years
    ev_down_payment = cfg["ev_price"] * 0.10
    ev_loan_amount = cfg["ev_price"] * 0.90
    ev_monthly_payment = ev_loan_amount * (monthly_rate * (1 + monthly_rate)**n_payments) / ((1 + monthly_rate)**n_payments - 1)
    financed_ev_cost = ev_down_payment + ev_monthly_payment * n_payments
    ev_tco_before_v2g = financed_ev_cost + electricity_10y + maintenance["electric_10y"]

    meets_4_hour_requirement = schedule["v2g_hours"] >= BC_HYDRO_INCENTIVE["required_duration_hours"]

    # Technical V2G capacity — calculated regardless of program eligibility, for display only
    if schedule["v2g_hours"] > 0:
        nom_energy = calculate_nominated_energy(bus_type, schedule)
        nom_kw = calculate_nominated_power(nom_energy, schedule["v2g_hours"])
    else:
        nom_energy = 0.0
        nom_kw = 0.0

    # Financial model — only enters TCO if the fleet meets the 4-hour program requirement
    if meets_4_hour_requirement and nom_energy > 0:
        incentive_result = calculate_preliminary_bc_hydro_incentive(nom_energy, nom_kw, schedule["v2g_hours"])
        replenishment = calculate_v2g_replenishment_cost(bus_type, schedule)
        replenishment_10y = replenishment["replenishment_cost_10y"]
    else:
        incentive_result = {
            "energy_component_a": 0, "capacity_component_b": 0,
            "eligible_cost_cap_c": None, "preliminary_incentive_per_bus_supporting": 0,
            "is_capped": False, "meets_4_hour_requirement": meets_4_hour_requirement,
            "label": (
                f"V2G window ({round(schedule['v2g_hours'], 1)} hrs) is below the 4-hour program requirement — no V2G costs or incentive applied to TCO"
                if schedule["v2g_hours"] > 0
                else "V2G not available — no incentive calculated"
            ),
        }
        replenishment_10y = 0.0

    # V2G replenishment is Fuse's cost — excluded from fleet operator TCO
    ev_tco_with_v2g = ev_tco_before_v2g - incentive_result["preliminary_incentive_per_bus_supporting"]
    net_savings = conventional_tco - ev_tco_with_v2g

    return {
        "bus_type": bus_type,
        "model": cfg["model"],
        "conventional_purchase": round(financed_diesel_cost, 2),
        "conventional_financing_cost": round(financed_diesel_cost - cfg["conventional_price"], 2),
        "ev_purchase": round(financed_ev_cost, 2),
        "ev_financing_cost": round(financed_ev_cost - cfg["ev_price"], 2),
        "diesel_fuel_10y": round(diesel_10y, 2),
        "electricity_10y": round(electricity_10y, 2),
        "diesel_maintenance_10y": maintenance["diesel_10y"],
        "ev_maintenance_10y": maintenance["electric_10y"],
        "conventional_tco": round(conventional_tco, 2),
        "ev_tco_before_v2g": round(ev_tco_before_v2g, 2),
        # Unrounded values for fleet-level aggregation — never used for display
        "_conventional_tco_exact": conventional_tco,
        "_ev_tco_before_v2g_exact": ev_tco_before_v2g,
        "_diesel_fuel_10y_exact": diesel_10y,
        "_electricity_10y_exact": electricity_10y,
        "nominated_energy_kwh": round(nom_energy, 2),
        "nominated_kw": round(nom_kw, 2),
        "incentive": incentive_result,
        "v2g_replenishment_10y": round(replenishment_10y, 2),
        "ev_tco_with_v2g_per_bus_supporting": round(ev_tco_with_v2g, 2),
        "net_savings_10y_per_bus_supporting": round(net_savings, 2),
    }

def calculate_fleet_savings(inputs) -> dict:
    schedule = derive_schedule(inputs)
    counts = {
        "mini": inputs.mini_count,
        "midsize": inputs.midsize_count,
        "fullsize": inputs.fullsize_count,
    }
    fleet_size = inputs.mini_count + inputs.midsize_count + inputs.fullsize_count
    fleet_conventional_purchase = 0
    fleet_conventional_financing_cost = 0
    fleet_ev_purchase = 0
    fleet_ev_financing_cost = 0
    fleet_conventional_tco = 0
    fleet_ev_tco_before_v2g = 0
    fleet_diesel_10y = 0
    fleet_electricity_10y = 0
    fleet_diesel_maint_10y = 0
    fleet_ev_maint_10y = 0
    total_nominated_energy = 0.0
    total_nominated_kw = 0.0
    per_bus_results = []

    for bus_type, count in counts.items():
        if count == 0:
            continue
        tco = calculate_10_year_tco(bus_type, schedule)
        per_bus_results.append({
            "bus_type": bus_type,
            "count": count,
            "conventional_tco_10y": tco["conventional_tco"],
            "ev_tco_before_v2g": tco["ev_tco_before_v2g"],
            "v2g_replenishment_10y": tco["v2g_replenishment_10y"],
            "preliminary_incentive_per_bus_supporting": tco["incentive"]["preliminary_incentive_per_bus_supporting"],
            "meets_4_hour_requirement": tco["incentive"]["meets_4_hour_requirement"],
            "net_savings_10y_per_bus_supporting": tco["net_savings_10y_per_bus_supporting"],
        })

        fleet_conventional_purchase += tco["conventional_purchase"] * count
        fleet_conventional_financing_cost += tco["conventional_financing_cost"] * count
        fleet_ev_purchase += BUS_CONFIG[bus_type]["ev_price"] * count
        fleet_ev_financing_cost += tco["ev_financing_cost"] * count
        fleet_conventional_tco += tco["_conventional_tco_exact"] * count
        fleet_ev_tco_before_v2g += tco["_ev_tco_before_v2g_exact"] * count
        fleet_diesel_10y += tco["_diesel_fuel_10y_exact"] * count
        fleet_electricity_10y += tco["_electricity_10y_exact"] * count
        fleet_diesel_maint_10y += tco["diesel_maintenance_10y"] * count
        fleet_ev_maint_10y += tco["ev_maintenance_10y"] * count

        # Technical capacity — accumulate for display regardless of eligibility
        if schedule["v2g_hours"] > 0:
            total_nominated_energy += tco["nominated_energy_kwh"] * count
            total_nominated_kw += tco["nominated_kw"] * count

    fleet_meets_4_hour = schedule["v2g_hours"] >= BC_HYDRO_INCENTIVE["required_duration_hours"]

    # Financial model — project incentive and replenishment only enter TCO if eligible
    if fleet_meets_4_hour and total_nominated_energy > 0:
        agg_nominated_kw = min(total_nominated_kw, CHARGER_KW * fleet_size)
        project_incentive = calculate_preliminary_bc_hydro_incentive(
            total_nominated_energy, agg_nominated_kw, schedule["v2g_hours"]
        )
    else:
        project_incentive = {
            "energy_component_a": 0,
            "capacity_component_b": 0,
            "eligible_cost_cap_c": None,
            "preliminary_incentive_per_bus_supporting": 0,
            "is_capped": False,
            "meets_4_hour_requirement": fleet_meets_4_hour,
            "label": (
                f"V2G window ({round(schedule['v2g_hours'], 1)} hrs) is below the 4-hour program requirement — no V2G costs or incentive applied to TCO"
                if schedule["v2g_hours"] > 0
                else "V2G not available — no incentive calculated"
            ),
        }

    # Fleet-level incentive label uses project-wide name
    preliminary_project_incentive = project_incentive["preliminary_incentive_per_bus_supporting"]

    # V2G replenishment is Fuse's cost — excluded from fleet operator TCO
    fleet_ev_tco_with_v2g = (
        fleet_ev_tco_before_v2g
        - preliminary_project_incentive
    )
    fleet_net_savings = fleet_conventional_tco - fleet_ev_tco_with_v2g

    return {
        "fleet_size": fleet_size,
        "bus_counts": counts,
        "v2g_available": schedule["v2g_hours"] > 0,
        "meets_4_hour_requirement": schedule["v2g_hours"] >= BC_HYDRO_INCENTIVE["required_duration_hours"],
        "fleet_conventional_purchase": round(fleet_conventional_purchase, 2),
        "fleet_conventional_financing_cost": round(fleet_conventional_financing_cost, 2),
        "fleet_ev_purchase": round(fleet_ev_purchase, 2),
        "fleet_ev_financing_cost": round(fleet_ev_financing_cost, 2),
        "fleet_fuel_10y": round(fleet_diesel_10y, 2),
        "fleet_electricity_10y": round(fleet_electricity_10y, 2),
        "fleet_maintenance_conventional_10y": round(fleet_diesel_maint_10y, 2),
        "fleet_maintenance_electric_10y": round(fleet_ev_maint_10y, 2),
        "fleet_conventional_tco": round(fleet_conventional_tco, 2),
        "fleet_ev_tco_before_v2g": round(fleet_ev_tco_before_v2g, 2),
        "preliminary_project_incentive": round(preliminary_project_incentive, 2),
        "bc_hydro_incentive": {
            "nominated_energy_kwh": round(total_nominated_energy, 2),
            "nominated_kw": round(total_nominated_kw, 2),
            **project_incentive,
        },
        "fleet_ev_tco_with_v2g": round(fleet_ev_tco_with_v2g, 2),
        "fleet_net_savings_10y": round(fleet_net_savings, 2),
        "per_bus_results": per_bus_results,
        "model_version": MODEL_VERSION,
        "assumptions": {
            "tco_years": TCO_YEARS,
            "daily_km": schedule["daily_km"],
            "morning_km": round(schedule["morning_km"], 1),
            "afternoon_km": round(schedule["afternoon_km"], 1),
            "route_distance_split_method": "Daily distance allocated between morning and afternoon in proportion to operating duration",
            "midday_hours": round(schedule["midday_hours"], 2),
            "midday_charging_available": schedule["midday_available"],
            "v2g_hours": round(schedule["v2g_hours"], 2),
            "v2g_required_duration_hours": BC_HYDRO_INCENTIVE["required_duration_hours"],
            "school_driving_days": SCHOOL_DRIVING_DAYS,
            "expected_dispatch_events_per_year": EXPECTED_DISPATCH_EVENTS_PER_YEAR,
            "diesel_price_per_l": DIESEL_PRICE_PER_L,
            "diesel_l_per_km": DIESEL_L_PER_KM,
            "bc_electricity_rate": BC_ELECTRICITY_RATE,
            "min_soc": MIN_SOC,
            "charger_kw": CHARGER_KW,
            "charging_efficiency": CHARGING_EFFICIENCY,
            "discharge_efficiency": DISCHARGE_EFFICIENCY,
            "v2g_window": f"{V2G_WINDOW_START}:00–{V2G_WINDOW_END}:00",
        },
        "disclaimer": (
            "Results are illustrative estimates for the October 2026 prototype. "
            "The BC Hydro V2G incentive is a one-time upfront payment in exchange for a "
            "10-year commitment to maintain nominated V2G capacity and meet BC Hydro "
            "performance requirements (≥85% nominated capacity for ≥85% of dispatch events). "
            "The incentive shown is preliminary and uncapped — the final approved amount "
            "depends on the eligible-project-cost cap, program eligibility, and your "
            "specific BC Hydro agreement. "
            "Maintenance, fuel, and electricity figures are modelling assumptions and have "
            "not been validated against actual fleet data."
        ),
    }

def validate_inputs(inputs: FleetInputs):
    errors = []
    if inputs.mini_count < 0 or inputs.midsize_count < 0 or inputs.fullsize_count < 0:
        errors.append("Bus counts must be non-negative.")
    total = inputs.mini_count + inputs.midsize_count + inputs.fullsize_count
    if total == 0:
        errors.append("Total fleet size must be greater than zero.")
    if inputs.daily_km <= 0:
        errors.append("Daily km must be greater than zero.")
    hour_fields = {
        "morning_start_hour": inputs.morning_start_hour,
        "morning_end_hour": inputs.morning_end_hour,
        "afternoon_start_hour": inputs.afternoon_start_hour,
        "afternoon_end_hour": inputs.afternoon_end_hour,
    }
    for field, value in hour_fields.items():
        if value < 0 or value > 24:
            errors.append(f"{field} must be between 0 and 24.")
    return errors

# ---------------------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------------------

app = FastAPI(
    title="BC School Bus V2G Calculator",
    description="Fuse Power Management — BC School Bus Electrification and V2G Calculator",
    version=MODEL_VERSION,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.on_event("startup")
def startup():
    init_db()

@app.get("/")
def root():
    return FileResponse("ui_test.html")

@app.get("/survey", response_class=HTMLResponse, summary="Survey interface")
def survey():
    return """
    <html><head><title>BC School Bus V2G Calculator</title></head>
    <body>
    <h1>BC School Bus Electrification and V2G Calculator</h1>
    <p>API is running. Connect the frontend survey to POST /calculate.</p>
    </body></html>
    """

@app.post("/save-step", summary="Save partial survey answers")
def save_step(step: PartialStep):
    conn = get_db()
    conn.execute(
        "INSERT INTO partial_steps (session_id, step, data) VALUES (?, ?, ?)",
        (step.session_id, step.step, json.dumps(step.data))
    )
    conn.commit()
    conn.close()
    return {"status": "saved", "session_id": step.session_id, "step": step.step}

@app.post("/calculate", summary="Calculate V2G and TCO results (no contact info required)")
def calculate(inputs: FleetInputs):
    errors = validate_inputs(inputs)
    if errors:
        raise HTTPException(status_code=422, detail=errors)
    results = calculate_fleet_savings(inputs)
    return {
        "inputs": inputs.dict(),
        "results": results,
    }

@app.post("/submit", summary="Save completed calculation submission")
def submit(inputs: SurveyInputs):
    errors = validate_inputs(inputs)
    if errors:
        raise HTTPException(status_code=422, detail=errors)
    results = calculate_fleet_savings(inputs)
    conn = get_db()
    conn.execute(
        """INSERT INTO submissions
           (company_name, contact_name, email, phone, depot_location, inputs, results, model_version)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            inputs.company_name,
            inputs.contact_name,
            inputs.email,
            inputs.phone,
            inputs.depot_location,
            json.dumps(inputs.dict()),
            json.dumps(results),
            MODEL_VERSION,
        )
    )
    conn.commit()
    submission_id = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
    conn.close()
    return {
        "status": "submitted",
        "submission_id": submission_id,
        "company_name": inputs.company_name,
        "results": results,
    }

@app.post("/contact", summary="Save contact information")
def contact(info: ContactInfo):
    conn = get_db()
    conn.execute(
        """INSERT INTO submissions
           (company_name, contact_name, email, phone, depot_location, inputs, results, model_version)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            info.company_name or "",
            info.contact_name,
            info.email,
            info.phone or "",
            info.depot_location or "",
            json.dumps(info.dict()),
            json.dumps({}),
            MODEL_VERSION,
        )
    )
    conn.commit()
    conn.close()
    return {"status": "saved", "contact_name": info.contact_name, "email": info.email}