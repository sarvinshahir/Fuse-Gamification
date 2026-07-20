import { useState } from "react";

function App() {
  const [step, setStep] = useState(1);
  const [answers, setAnswers] = useState({});
  const [result, setResult] = useState(null);

  const handleAnswer = (field, value) => {
    setAnswers({ ...answers, [field]: value });
    setStep(step + 1);
  };

  const submitSurvey = async () => {
    const response = await fetch("http://localhost:8000/calculate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fleet_size: answers.fleet_size,
        pct_ev: answers.pct_ev,
        vehicle_size: answers.vehicle_size,
        daily_km: answers.daily_km,
        operating_hours: answers.operating_hours,
        province: answers.province,
        annual_fuel_spend: answers.annual_fuel_spend,
      }),
    });
    const data = await response.json();
    setResult(data);
    setStep(8);
  };

  return (
    <div style={{ maxWidth: "600px", margin: "60px auto", fontFamily: "sans-serif", padding: "20px" }}>
      
      {step === 1 && (
        <div>
          <h2>How many buses do you operate?</h2>
          {[5, 10, 25, 50, 100].map(n => (
            <button key={n} onClick={() => handleAnswer("fleet_size", n)}
              style={btnStyle}>{n} buses</button>
          ))}
        </div>
      )}

      {step === 2 && (
        <div>
          <h2>How many are electric today or within 3 years?</h2>
          {[10, 25, 50, 75, 100].map(n => (
            <button key={n} onClick={() => handleAnswer("pct_ev", n)}
              style={btnStyle}>{n}%</button>
          ))}
        </div>
      )}

      {step === 3 && (
        <div>
          <h2>What size are your buses?</h2>
          {[["small", "Small (Microbird ~140 kWh)"], ["medium", "Medium (Lion C ~210 kWh)"], ["large", "Large (Blue Bird Vision ~185 kWh)"]].map(([val, label]) => (
            <button key={val} onClick={() => handleAnswer("vehicle_size", val)}
              style={btnStyle}>{label}</button>
          ))}
        </div>
      )}

      {step === 4 && (
        <div>
          <h2>How far does each bus travel daily?</h2>
          {[["under_50", "Under 50 km"], ["50_100", "50–100 km"], ["100_150", "100–150 km"], ["150_plus", "150+ km"]].map(([val, label]) => (
            <button key={val} onClick={() => handleAnswer("daily_km", val)}
              style={btnStyle}>{label}</button>
          ))}
        </div>
      )}

      {step === 5 && (
        <div>
          <h2>How many hours per day are buses operating?</h2>
          {[4, 6, 8, 10].map(n => (
            <button key={n} onClick={() => handleAnswer("operating_hours", n)}
              style={btnStyle}>{n} hours</button>
          ))}
        </div>
      )}

      {step === 6 && (
        <div>
          <h2>What province are you in?</h2>
          {[["BC", "British Columbia"], ["ON", "Ontario"], ["QC", "Québec"], ["NS", "Nova Scotia"]].map(([val, label]) => (
            <button key={val} onClick={() => handleAnswer("province", val)}
              style={btnStyle}>{label}</button>
          ))}
        </div>
      )}
      {step === 7 && (
        <div>
          <h2>What is your approximate annual fuel spend?</h2>
          {[[50000, "$50,000"], [100000, "$100,000"], [150000, "$150,000"], [300000, "$300,000+"]].map(([val, label]) => (
            <button key={val} onClick={async () => {
              const updatedAnswers = { ...answers, annual_fuel_spend: val };
              setAnswers(updatedAnswers);
              const response = await fetch("http://localhost:8000/calculate", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  fleet_size: updatedAnswers.fleet_size,
                  pct_ev: updatedAnswers.pct_ev,
                  vehicle_size: updatedAnswers.vehicle_size,
                  daily_km: updatedAnswers.daily_km,
                  operating_hours: updatedAnswers.operating_hours,
                  province: updatedAnswers.province,
                  annual_fuel_spend: updatedAnswers.annual_fuel_spend,
                }),
              });
              const data = await response.json();
              setResult(data);
              setStep(8);
            }} style={btnStyle}>{label}</button>
          ))}
        </div>
      )}

      {step === 8 && result && (
        <div>
          <h1>Your V2G Revenue Estimate</h1>
          <div style={{ background: "#f0f9f0", padding: "20px", borderRadius: "10px", marginBottom: "20px" }}>
            <h3>Annual V2G Revenue</h3>
            <p style={{ fontSize: "28px", color: "green" }}>${result.v2g_revenue_low.toLocaleString()} – ${result.v2g_revenue_high.toLocaleString()}</p>
          </div>
          <div style={{ background: "#f0f0f9", padding: "20px", borderRadius: "10px", marginBottom: "20px" }}>
            <h3>Diesel Savings</h3>
            <p style={{ fontSize: "28px", color: "blue" }}>${result.diesel_savings.toLocaleString()}</p>
          </div>
          <div style={{ background: "#fff9f0", padding: "20px", borderRadius: "10px" }}>
            <h3>Total Annual Benefit</h3>
            <p style={{ fontSize: "28px", color: "orange" }}>${result.total_benefit_low.toLocaleString()} – ${result.total_benefit_high.toLocaleString()}</p>
          </div>
          <button onClick={() => { setStep(1); setAnswers({}); setResult(null); }} style={btnStyle}>
            Start Over
          </button>
        </div>
      )}

    </div>
  );
}

const btnStyle = {
  display: "block",
  width: "100%",
  padding: "15px",
  marginBottom: "10px",
  fontSize: "16px",
  cursor: "pointer",
  borderRadius: "8px",
  border: "1px solid #ddd",
  background: "white",
  textAlign: "left"
};

export default App;