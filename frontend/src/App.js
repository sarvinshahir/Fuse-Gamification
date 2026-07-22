import { useState } from "react";

function App() {
  const [step, setStep] = useState(1);
  const [answers, setAnswers] = useState({});
  const [result, setResult] = useState(null);
  const [contact, setContact] = useState({});
  const [submitted, setSubmitted] = useState(false);

  const handleAnswer = (field, value) => {
    setAnswers({ ...answers, [field]: value });
    setStep(step + 1);
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
          <div style={{ background: "#fff9f0", padding: "20px", borderRadius: "10px", marginBottom: "20px" }}>
            <h3>Total Annual Benefit</h3>
            <p style={{ fontSize: "28px", color: "orange" }}>${result.total_benefit_low.toLocaleString()} – ${result.total_benefit_high.toLocaleString()}</p>
          </div>
          <button onClick={() => setStep(9)} style={{ ...btnStyle, background: "#2e7d32", color: "white", fontWeight: "bold" }}>
            Secure my contribution eligibility →
          </button>
          <button onClick={() => { setStep(1); setAnswers({}); setResult(null); }} style={btnStyle}>
            Start Over
          </button>
        </div>
      )}

      {step === 9 && !submitted && (
        <div>
          <h2>Hold my place in the program</h2>
          <p style={{ color: "#666" }}>Leave a few details so we can hold your place and begin the review.</p>
          {[["company_name", "Company name"], ["contact_name", "Your name"], ["email", "Email address"], ["phone", "Phone number"], ["depot_location", "Primary depot location"], ["best_time", "Best time to contact you (e.g. morning, afternoon)"], ["notes", "Anything important about your fleet or timing (optional)"]].map(([field, label]) => (
            <input
              key={field}
              placeholder={label}
              onChange={e => setContact({ ...contact, [field]: e.target.value })}
              style={{ display: "block", width: "100%", padding: "12px", marginBottom: "10px", fontSize: "16px", borderRadius: "8px", border: "1px solid #ddd", boxSizing: "border-box" }}
            />
          ))}
          <button onClick={async () => {
            await fetch("http://localhost:8000/contact", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                ...contact,
                fleet_size: answers.fleet_size,
                ev_count: Math.round(answers.fleet_size * answers.pct_ev / 100),
              }),
            });
            setSubmitted(true);
          }} style={{ ...btnStyle, background: "#2e7d32", color: "white", fontWeight: "bold" }}>
            Secure my contribution eligibility
          </button>
        </div>
      )}

      {submitted && (
        <div style={{ textAlign: "center", padding: "40px" }}>
          <h1>✅ You're on the list!</h1>
          <p style={{ fontSize: "18px", color: "#666" }}>Thank you. We'll be in touch shortly to review your fleet and next steps.</p>
          <button onClick={() => { setStep(1); setAnswers({}); setResult(null); setContact({}); setSubmitted(false); }} style={btnStyle}>
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