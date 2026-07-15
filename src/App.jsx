import { useState, useEffect } from 'react';
import {
  Chart as ChartJS,
  CategoryScale, LinearScale, PointElement, LineElement, Title, Tooltip, Legend, Filler,
} from 'chart.js';
import { Line } from 'react-chartjs-2';
import { TrendingUp, Wallet, CheckCircle, Clock, XCircle, Target, Sparkles, Trophy, MapPin } from 'lucide-react';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Title, Tooltip, Legend, Filler);

const STATUS_META = {
  en_attente: { label: 'En attente', icon: Clock, cls: 'pending' },
  gagné: { label: 'Gagné', icon: CheckCircle, cls: 'won' },
  perdu: { label: 'Perdu', icon: XCircle, cls: 'lost' },
};

const NIVEAU_LABEL = {
  ordre: '🏆 Quinté dans l’ordre',
  desordre: '✅ Quinté dans le désordre',
  bonus4: '🎯 Bonus 4',
  bonus4sur5: '🎯 Bonus 4sur5',
  bonus3: '🎯 Bonus 3',
  perdu: '— Perdu',
};

const ANALYSIS_STEPS = [
  'Initialisation du module IA (Gemini)...',
  'Lecture du programme PMU & des partants...',
  'Analyse des cotes et de la musique...',
  'Veille des actualités hippiques (RSS)...',
  'Construction des grilles Quinté+...',
  'Mise à jour de la bankroll !',
];

function HorseRow({ horse, rank, isSpare, arrivee }) {
  // 🟢 = le cheval a terminé dans les 5 premiers (l'arrivée stockée contient tout le champ).
  const inArrivee = arrivee && arrivee.slice(0, 5).includes(horse.num);
  return (
    <div className={`horse-row ${isSpare ? 'spare' : ''}`}>
      <span className="horse-num">{horse.num}</span>
      <div>
        <div className="horse-name">
          {!isSpare && <span className="rank-chip">#{rank}</span>}
          {isSpare && <span className="rank-chip">Outsider</span>}
          {horse.nom}
          {inArrivee && ' 🟢'}
        </div>
        {horse.driver && <div className="horse-sub">{horse.driver}</div>}
      </div>
      <span className="horse-cote">{horse.cote != null ? horse.cote : '—'}</span>
    </div>
  );
}

function GrilleLine({ grille }) {
  return (
    <div className="grille-line">
      <span className="grille-label">{grille.libelle}</span>
      <span className="grille-chevaux">{grille.chevaux.join(' · ')}</span>
      <span className="grille-mise">{grille.mise.toFixed(2)} €</span>
    </div>
  );
}

function ResultBox({ bet }) {
  if (!bet.arrivee) return null;
  const top5 = bet.arrivee.slice(0, 5);
  const played = new Set([...bet.base.map((b) => b.num), bet.spare?.num]);
  return (
    <div className="result-box">
      <div className="result-line">
        <span>Arrivée officielle</span>
        <span className="arrivee-nums">
          {top5.map((n, i) => (
            <span key={i} className={`arrivee-num ${played.has(n) ? 'hit' : ''}`}>{n}</span>
          ))}
        </span>
      </div>
      {(bet.resultats || []).map((r, i) => (
        <div className="result-line" key={i}>
          <span>Grille {r.grille}</span>
          <span className={`niveau-tag niveau-${r.niveau}`}>
            {NIVEAU_LABEL[r.niveau] || r.niveau}
            {r.gain > 0 ? ` · +${r.gain.toFixed(2)} €` : ''}
          </span>
        </div>
      ))}
      {bet.rapports?.estime && (
        <div className="result-line"><span className="horse-sub">Rapports estimés (rapports officiels indisponibles)</span></div>
      )}
    </div>
  );
}

function BetCard({ bet, highlight }) {
  const meta = STATUS_META[bet.statut] || STATUS_META.en_attente;
  const StatusIcon = meta.icon;
  const dateStr = new Date(bet.date).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });

  return (
    <div className={`glass-card bet-item ${highlight ? 'bet-highlight' : ''}`}>
      <div className="bet-header">
        <div>
          <strong className="bet-title">Quinté+ du {dateStr}</strong>
          <div className="bet-meta">
            <span><MapPin size={13} style={{ verticalAlign: '-2px' }} /> {bet.hippodrome}</span>
            <span>{bet.reunion}{bet.course} · {bet.discipline}</span>
            <span>{bet.nb_partants} partants</span>
            {bet.mock && <span className="mock-tag">SIMULÉ</span>}
          </div>
        </div>
        <span className={`badge ${meta.cls}`}><StatusIcon size={13} /> {meta.label}</span>
      </div>

      <div className="horses-list">
        {bet.base.map((h, i) => (
          <HorseRow key={h.num} horse={h} rank={i + 1} arrivee={bet.arrivee} />
        ))}
        {bet.spare && <HorseRow horse={bet.spare} isSpare arrivee={bet.arrivee} />}
      </div>

      <div className="grilles-box">
        {bet.grilles.map((g) => <GrilleLine key={g.id} grille={g} />)}
      </div>

      <ResultBox bet={bet} />

      <div className="analysis-box">
        <strong className="analysis-title">🧠 Analyse de l'IA</strong>
        <p>{bet.analyse}</p>
      </div>

      <div className="bet-footer">
        <span className="footer-stat">Mise totale&nbsp;<strong>{bet.mise_totale.toFixed(2)} €</strong></span>
        {bet.statut === 'en_attente' ? (
          <span className="footer-stat">Statut&nbsp;<strong>en attente d'arrivée</strong></span>
        ) : (
          <span className="footer-stat gain">Gain&nbsp;<strong>{(bet.gain || 0).toFixed(2)} €</strong></span>
        )}
      </div>
    </div>
  );
}

function App() {
  const [bankroll, setBankroll] = useState(null);
  const [bets, setBets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analysisStep, setAnalysisStep] = useState(0);

  const fetchData = async () => {
    try {
      const b = await (await fetch(`${import.meta.env.BASE_URL}data/bankroll.json`)).json();
      const t = await (await fetch(`${import.meta.env.BASE_URL}data/bets.json`)).json();
      setBankroll(b);
      setBets(t);
    } catch (e) {
      console.error('Erreur de chargement des données', e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchData(); }, []);

  const handleRunAnalysis = async () => {
    setIsAnalyzing(true);
    setAnalysisStep(0);
    const interval = setInterval(() => setAnalysisStep((p) => (p < 4 ? p + 1 : p)), 1200);
    try {
      const res = await fetch('/api/run-analysis', { method: 'POST' });
      if (!res.ok) throw new Error("L'API d'analyse a renvoyé une erreur.");
      setAnalysisStep(5);
      setTimeout(async () => { clearInterval(interval); await fetchData(); setIsAnalyzing(false); }, 1500);
    } catch (e) {
      clearInterval(interval);
      alert('Erreur lors de l’analyse : ' + e.message);
      setIsAnalyzing(false);
    }
  };

  if (loading) return <div className="centered-msg">Chargement du pronostiqueur IA...</div>;
  if (!bankroll) return <div className="centered-msg">Aucune donnée de bankroll disponible.</div>;

  const profit = bankroll.current - bankroll.initial;
  const roi = ((profit / bankroll.initial) * 100).toFixed(2);
  const isPositive = profit >= 0;

  const resolved = bets.filter((b) => b.statut !== 'en_attente');
  const won = resolved.filter((b) => b.statut === 'gagné');
  const winRate = resolved.length ? ((won.length / resolved.length) * 100).toFixed(1) : 0;

  const pending = bets.filter((b) => b.statut === 'en_attente');
  const history = bets.filter((b) => b.statut !== 'en_attente');

  const chartData = {
    labels: bankroll.history.map((e) => e.date),
    datasets: [{
      label: 'Bankroll (€)',
      data: bankroll.history.map((e) => e.amount),
      borderColor: isPositive ? '#00e676' : '#ff1744',
      backgroundColor: isPositive ? 'rgba(0,230,118,.08)' : 'rgba(255,23,68,.08)',
      fill: true, tension: 0.4,
    }],
  };
  const chartOptions = {
    responsive: true, maintainAspectRatio: false,
    plugins: { legend: { display: false }, tooltip: { mode: 'index', intersect: false, backgroundColor: 'rgba(25,28,41,.95)' } },
    scales: {
      y: { grid: { color: 'rgba(255,255,255,.04)' }, ticks: { color: '#a0a5b1' } },
      x: { grid: { display: false }, ticks: { color: '#a0a5b1' } },
    },
  };

  return (
    <div className="animate-fade-in">
      <header className="app-header">
        <div>
          <h1>Analyse <span className="text-gradient">Quinté+</span> 🏇</h1>
          <div className="subtitle">Pronostics IA · Simulation à blanc · 5 € de mise / jour</div>
        </div>
        <button className={`btn-primary ${isAnalyzing ? 'loading' : ''}`} onClick={handleRunAnalysis} disabled={isAnalyzing}>
          <Sparkles size={18} className={isAnalyzing ? 'spin-icon' : ''} />
          {isAnalyzing ? 'Analyse...' : "Lancer l'analyse"}
        </button>
      </header>

      {isAnalyzing && (
        <div className="analysis-overlay">
          <div className="analysis-overlay-card glass-card">
            <div className="glow-spinner" />
            <h3>Le pronostiqueur IA travaille</h3>
            <p className="overlay-subtitle">Analyse du Quinté+ du jour</p>
            <div className="analysis-steps-list">
              {ANALYSIS_STEPS.map((step, idx) => {
                let status = 'pending';
                if (idx < analysisStep) status = 'completed';
                else if (idx === analysisStep) status = 'active';
                return (
                  <div key={idx} className={`analysis-step-row ${status}`}>
                    <span className="step-bullet">{status === 'completed' ? '✓' : status === 'active' ? '⚡' : '○'}</span>
                    <span className="step-text">{step}</span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      <div className="dashboard-grid">
        <div className="glass-card">
          <div className="stat-label"><Wallet size={16} />Bankroll actuelle</div>
          <div className="stat-value">{bankroll.current.toFixed(2)} €</div>
          <div className={isPositive ? 'positive' : 'negative'} style={{ fontSize: '.9rem', fontWeight: 600 }}>
            {isPositive ? '+' : ''}{profit.toFixed(2)} € (ROI : {roi}%)
          </div>
        </div>
        <div className="glass-card">
          <div className="stat-label"><TrendingUp size={16} />Taux de réussite</div>
          <div className="stat-value">{winRate}%</div>
          <div style={{ color: 'var(--text-secondary)', fontSize: '.9rem' }}>Sur {resolved.length} grilles terminées</div>
        </div>
        <div className="glass-card">
          <div className="stat-label"><Trophy size={16} />Grilles gagnantes</div>
          <div className="stat-value">{won.length}</div>
          <div style={{ color: 'var(--text-secondary)', fontSize: '.9rem' }}>{bets.length} grilles jouées au total</div>
        </div>
      </div>

      <div className="glass-card chart-container">
        <h2 className="section-title" style={{ marginTop: 0 }}>Évolution du capital</h2>
        <div style={{ height: '300px' }}><Line data={chartData} options={chartOptions} /></div>
      </div>

      <h2 className="section-title with-icon"><Target size={22} /> Grille du jour</h2>
      <div className="bets-container">
        {pending.length === 0
          ? <p className="empty-msg">Aucune grille en attente. L'IA n'a pas encore joué aujourd'hui.</p>
          : pending.map((bet) => <BetCard key={bet.id} bet={bet} highlight />)}
      </div>

      <h2 className="section-title">Historique des grilles</h2>
      <div className="bets-container">
        {history.length === 0
          ? <p className="empty-msg">Aucune grille terminée pour le moment.</p>
          : history.map((bet) => <BetCard key={bet.id} bet={bet} />)}
      </div>

      <p className="disclaimer">
        ⚠️ Simulation éducative à blanc — aucun pari réel n'est engagé. Les jeux d'argent sont interdits aux mineurs (18+) et comportent des risques.
      </p>
    </div>
  );
}

export default App;
