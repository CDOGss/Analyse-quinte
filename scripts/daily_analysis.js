import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI } from '@google/genai';
import Parser from 'rss-parser';
import {
  toPmuDate,
  fetchProgramme,
  findQuinteCourse,
  fetchParticipants,
  extractArrivee,
  fetchRapportsQuinte,
  mockQuinteCourse,
  mockParticipants,
} from './pmu.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BANKROLL_FILE = path.join(__dirname, '../public/data/bankroll.json');
const BETS_FILE = path.join(__dirname, '../public/data/bets.json');
const DAILY_BET_MD = path.join(__dirname, '../DAILY_BET.md');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.6-flash';

// Budget de mise quotidien, réparti sur 2 grilles (paper trading "à blanc").
const MISE_TOTALE = 5.0;
const GRILLES_MISE = { A: 3.0, B: 2.0 }; // Grille A (base) + Grille B (couverture)

let ai = null;
if (GEMINI_API_KEY) {
  ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
} else {
  console.warn('⚠️ GEMINI_API_KEY manquante. Mode simulation (MOCK) : classement par cote.');
}
const rssParser = new Parser();

const round2 = (n) => parseFloat(Number(n).toFixed(2));

/**
 * 1. Veille turf : actualités hippiques via flux RSS.
 */
async function fetchTurfNews() {
  console.log('-> Veille turf (flux RSS)...');
  const feeds = [
    'https://www.zone-turf.fr/rss/actualites.xml',
    'https://www.paris-turf.com/rss.xml',
    'https://dwh.lequipe.fr/api/edito/rss?path=/hippisme/',
  ];
  let items = [];
  for (const url of feeds) {
    try {
      const feed = await rssParser.parseURL(url);
      const latest = feed.items
        .slice(0, 6)
        .map((it) => `- ${it.title} : ${(it.contentSnippet || it.description || '').slice(0, 220)}`);
      items = items.concat(latest);
    } catch (err) {
      console.warn(`   Flux indisponible ${url} : ${err.message}`);
    }
  }
  return items.length ? items.join('\n') : '(Aucune actualité récupérée aujourd’hui.)';
}

/**
 * 2. Récupération de la course Quinté+ du jour (course, partants, cotes).
 */
async function fetchQuinteDuJour(dateObj) {
  const pmuDate = toPmuDate(dateObj);
  const programme = await fetchProgramme(pmuDate);
  if (programme) {
    const course = findQuinteCourse(programme);
    if (course) {
      const participants = await fetchParticipants(
        pmuDate,
        course.numReunion,
        course.numCourse,
        programme._clientVersion
      );
      if (participants && participants.length >= 8) {
        console.log(
          `-> Quinté trouvé : R${course.numReunion}C${course.numCourse} ${course.hippodrome} (${participants.length} partants).`
        );
        return { course, participants, mock: false };
      }
    }
    console.warn('-> Course Quinté ou partants introuvables dans le programme. Bascule en simulation.');
  } else {
    console.warn('-> API PMU injoignable. Bascule en simulation.');
  }
  const course = mockQuinteCourse();
  return { course, participants: mockParticipants(), mock: true };
}

/**
 * 3. Analyse IA : classement pronostiqué des chevaux.
 * Renvoie { classement: [num...], analyse: "..." }.
 */
async function analyseIA(course, participants, news) {
  const partantsPourIA = participants.map((p) => ({
    num: p.num,
    cheval: p.nom,
    cote: p.cote,
    driver: p.driver,
    entraineur: p.entraineur,
    musique: p.musique,
  }));

  if (!ai) {
    // Fallback : on classe par cote croissante (les favoris d'abord).
    const classement = [...participants]
      .filter((p) => typeof p.cote === 'number')
      .sort((a, b) => a.cote - b.cote)
      .slice(0, 7)
      .map((p) => p.num);
    return {
      classement,
      analyse:
        "Analyse simulée (sans clé API Gemini) : classement fondé sur les cotes du marché. " +
        'Les favoris du marché constituent la base, complétés par deux outsiders de couverture.',
    };
  }

  const prompt = `
Tu es un PRONOSTIQUEUR HIPPIQUE PROFESSIONNEL expert du Quinté+ français (PMU).
Objectif : classer les chevaux par ordre de chance d'arriver dans les 5 premiers.

--- COURSE ---
${course.libelle} — ${course.hippodrome} — Discipline : ${course.discipline} — ${course.nbPartants || participants.length} partants.

--- ACTUALITÉS HIPPIQUES RÉCENTES (VEILLE) ---
Utilise ces infos (forme, engagement, déclarations, terrain) si pertinentes :
${news}

--- PARTANTS, COTES ET MUSIQUE ---
(La "musique" décrit les performances passées : 1=gagnant, chiffres=place, a=attelé, m=monté, D=disqualifié, 0=hors des 10 premiers.)
${JSON.stringify(partantsPourIA, null, 2)}

--- RÈGLES DE RÉPONSE ---
1. Analyse la valeur de chaque cheval (forme via la musique, cote/valeur marché, discipline).
2. Fournis un CLASSEMENT ordonné de 7 numéros : du plus probable gagnant (position 1) au 7e. Les 5 premiers sont ta base ; les 6e et 7e sont des chevaux de couverture crédibles (pas des outsiders bouchés).
3. Réponds STRICTEMENT et UNIQUEMENT avec un objet JSON :
{
  "classement": [num1, num2, num3, num4, num5, num6, num7],
  "analyse": "Ton analyse d'expert : pourquoi cette base, quel piège éviter, l'apport des actualités..."
}
Aucun texte hors du JSON.
`;

  console.log(`-> Interrogation de ${GEMINI_MODEL}...`);
  const response = await ai.models.generateContent({ model: GEMINI_MODEL, contents: prompt });
  let jsonStr = (response.text || '').trim();
  if (jsonStr.startsWith('```')) {
    jsonStr = jsonStr.replace(/```json/gi, '').replace(/```/g, '').trim();
  }
  const parsed = JSON.parse(jsonStr);
  return parsed;
}

/**
 * 4. Construction des 2 grilles à partir du classement IA.
 * - Grille A (3 €) : base = les 5 premiers du classement, dans l'ordre.
 * - Grille B (2 €) : couverture = 4 premiers + le 6e (on remplace le n°5 par un outsider).
 * Chaque grille est un ticket Quinté+ classique (mise = multiple de la base 2 €),
 * ce qui permet de scorer précisément avec les rapports officiels PMU.
 */
function construireGrilles(classement, participants) {
  const byNum = new Map(participants.map((p) => [p.num, p]));
  // On ne garde que des numéros valides et partants, sans doublon.
  const valides = [];
  for (const num of classement) {
    if (byNum.has(num) && !valides.includes(num)) valides.push(num);
    if (valides.length >= 7) break;
  }
  // Complète si l'IA a renvoyé moins de 6 chevaux exploitables (avec les favoris restants).
  if (valides.length < 6) {
    const extra = [...participants]
      .filter((p) => typeof p.cote === 'number' && !valides.includes(p.num))
      .sort((a, b) => a.cote - b.cote);
    for (const p of extra) {
      if (valides.length >= 6) break;
      valides.push(p.num);
    }
  }

  const base5 = valides.slice(0, 5);
  const spare = valides[5];
  const grilleB = [...base5.slice(0, 4), spare]; // 4 premiers + outsider

  const infoOf = (num) => {
    const p = byNum.get(num) || {};
    return { num, nom: p.nom || `Cheval ${num}`, cote: p.cote ?? null, driver: p.driver || null };
  };

  return {
    base: base5.map(infoOf),
    spare: infoOf(spare),
    grilles: [
      {
        id: 'A',
        type: 'ordre',
        libelle: 'Grille de base — Quinté+ (ordre)',
        chevaux: base5,
        mise: GRILLES_MISE.A,
      },
      {
        id: 'B',
        type: 'couverture',
        libelle: 'Grille couverture — 4 bases + outsider',
        chevaux: grilleB,
        mise: GRILLES_MISE.B,
      },
    ],
  };
}

/**
 * Score un ticket Quinté+ (5 chevaux ordonnés) contre l'arrivée réelle.
 * Cascade PMU : ordre > désordre > bonus 4 (les 4 premiers dans la grille)
 * > bonus 4sur5 (4 des 5 chevaux dans les 5 premiers) > bonus 3.
 * Les rapports sont en euros pour la mise de base de 2 €.
 */
function scoreGrille(grille, arrivee, rapports) {
  const top5 = arrivee.slice(0, 5);
  const setTop5 = new Set(top5);
  const first4 = arrivee.slice(0, 4);
  const first3 = arrivee.slice(0, 3);
  const g = grille.chevaux;
  const setG = new Set(g);
  const factor = grille.mise / 2; // les rapports PMU sont pour une base de 2 €

  const hitsTop5 = g.filter((n) => setTop5.has(n)).length;
  const exactOrder = g.length === 5 && top5.length === 5 && g.every((n, i) => n === top5[i]);
  const allFive = g.length === 5 && top5.length === 5 && hitsTop5 === 5;
  const has4 = first4.length === 4 && first4.every((n) => setG.has(n));
  const has4sur5 = top5.length === 5 && hitsTop5 >= 4;
  const has3 = first3.length === 3 && first3.every((n) => setG.has(n));

  let niveau = 'perdu';
  let rapport = 0;
  if (exactOrder) [niveau, rapport] = ['ordre', rapports.ordre || 0];
  else if (allFive) [niveau, rapport] = ['desordre', rapports.desordre || 0];
  else if (has4) [niveau, rapport] = ['bonus4', rapports.bonus4 || 0];
  else if (has4sur5) [niveau, rapport] = ['bonus4sur5', rapports.bonus4sur5 || 0];
  else if (has3) [niveau, rapport] = ['bonus3', rapports.bonus3 || 0];

  return { grille: grille.id, niveau, rapport, gain: round2((rapport || 0) * factor) };
}

/**
 * Estimation de rapports quand les rapports officiels sont indisponibles
 * (flag "estimé" affiché dans l'interface). Ordres de grandeur réalistes du
 * Quinté+, en euros pour 2 € de mise de base.
 */
function estimerRapports(baseParticipants) {
  const cotes = baseParticipants.map((p) => p.cote || 12);
  const prod = cotes.reduce((a, c) => a * c, 1);
  return {
    ordre: round2(Math.min(prod * 2, 100000)),
    desordre: round2(Math.min(prod / 15, 2000)),
    bonus4: 15,
    bonus4sur5: 6,
    bonus3: 3,
    estime: true,
  };
}

/** Simule une arrivée plausible (mode MOCK) : favorise la base, mais réserve des surprises. */
function simulerArrivee(bet) {
  const pool = [];
  bet.base.forEach((b, i) => {
    // Poids décroissant : le favori sort plus souvent.
    const poids = Math.max(1, 6 - i) + 2;
    for (let k = 0; k < poids; k++) pool.push(b.num);
  });
  pool.push(bet.spare.num, bet.spare.num);
  // Quelques numéros "extérieurs" pour créer des non-gagnants réalistes.
  for (let n = 1; n <= 16; n++) pool.push(n);

  const arrivee = [];
  const bag = [...pool];
  while (arrivee.length < 5 && bag.length) {
    const idx = Math.floor(Math.random() * bag.length);
    const num = bag[idx];
    if (!arrivee.includes(num)) arrivee.push(num);
    // retire toutes les occurrences du numéro tiré
    for (let j = bag.length - 1; j >= 0; j--) if (bag[j] === num) bag.splice(j, 1);
  }
  return arrivee;
}

/**
 * 5. Résolution des grilles en attente (arrivées réelles + rapports officiels).
 */
async function resoudreParisEnAttente(betsData, bankrollData) {
  console.log('-> Résolution des grilles précédentes...');
  const pending = betsData.filter((b) => b.statut === 'en_attente');
  if (pending.length === 0) return false;

  let updated = false;

  for (const bet of pending) {
    let arrivee = null;
    let rapports = null;

    if (bet.mock) {
      // En simulation, on génère l'arrivée du lendemain (le vrai résultat n'existe pas).
      arrivee = simulerArrivee(bet);
      rapports = estimerRapports(bet.base);
    } else {
      const pmuDate = toPmuDate(new Date(bet.date));
      const programme = await fetchProgramme(pmuDate);
      const course = programme ? findQuinteCourse(programme) : null;
      arrivee = course ? extractArrivee(course.courseObj) : null;
      if (!arrivee || arrivee.length < 5) {
        console.log(`   ${bet.id} (${bet.date}) : arrivée pas encore disponible, laissé en attente.`);
        continue;
      }
      rapports =
        (await fetchRapportsQuinte(
          pmuDate,
          bet.reunion.replace('R', ''),
          bet.course.replace('C', ''),
          programme._clientVersion
        )) || estimerRapports(bet.base);
    }

    const resultats = bet.grilles.map((g) => scoreGrille(g, arrivee, rapports));
    const gainTotal = round2(resultats.reduce((a, r) => a + r.gain, 0));

    bet.arrivee = arrivee;
    bet.rapports = rapports;
    bet.resultats = resultats;
    bet.gain = gainTotal;
    bet.statut = gainTotal > 0 ? 'gagné' : 'perdu';
    bankrollData.current = round2(bankrollData.current + gainTotal);
    updated = true;
    console.log(
      `   ${bet.id} (${bet.date}) résolu : arrivée ${arrivee.join('-')} → gain ${gainTotal} € (${bet.statut}).`
    );
  }

  if (updated) {
    bankrollData.history.push({ date: new Date().toISOString().split('T')[0], amount: round2(bankrollData.current) });
  }
  return updated;
}

/** 6. Rapport Markdown lisible du jour. */
function genererMarkdown(bet) {
  const dateStr = new Date(bet.date).toLocaleDateString('fr-FR', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
  let md = `# 🏇 Grille Quinté+ du Jour — ${dateStr}\n\n`;
  md += `**${bet.hippodrome}** · R${String(bet.reunion).replace('R', '')}C${String(bet.course).replace('C', '')} · ${bet.discipline}`;
  if (bet.mock) md += ` · _(données simulées)_`;
  md += `\n\n`;
  md += `## 🎯 Base pronostiquée (dans l'ordre)\n\n`;
  md += `| Rang | N° | Cheval | Cote |\n|---|---|---|---|\n`;
  bet.base.forEach((b, i) => {
    md += `| ${i + 1} | **${b.num}** | ${b.nom} | ${b.cote ?? '—'} |\n`;
  });
  md += `| Outsider | **${bet.spare.num}** | ${bet.spare.nom} | ${bet.spare.cote ?? '—'} |\n\n`;

  md += `## 🎫 Grilles jouées (${bet.mise_totale.toFixed(2)} €)\n\n`;
  bet.grilles.forEach((g) => {
    md += `- **${g.libelle}** (${g.mise.toFixed(2)} €) : ${g.chevaux.join(' - ')}\n`;
  });
  md += `\n## 🧠 Analyse de l'IA\n\n> ${bet.analyse.replace(/\n/g, '\n> ')}\n\n`;
  md += `---\n*Généré automatiquement par Gemini · Simulation à blanc. Jouer comporte des risques (18+).*`;
  return md;
}

/**
 * Fonction principale.
 */
async function main() {
  console.log("=== ANALYSE QUINTÉ+ QUOTIDIENNE ===");
  try {
    const today = new Date().toISOString().split('T')[0];
    const betsData = JSON.parse(await fs.readFile(BETS_FILE, 'utf-8'));
    const bankrollData = JSON.parse(await fs.readFile(BANKROLL_FILE, 'utf-8'));

    // Résoudre d'abord les grilles précédentes (met à jour la bankroll).
    await resoudreParisEnAttente(betsData, bankrollData);

    // Garde-fou anti-doublon : une seule grille par jour.
    if (betsData.some((b) => b.date === today)) {
      console.log(`Une grille existe déjà pour ${today}. Nouvelle analyse ignorée.`);
      await fs.writeFile(BANKROLL_FILE, JSON.stringify(bankrollData, null, 2));
      await fs.writeFile(BETS_FILE, JSON.stringify(betsData, null, 2));
      process.exit(0);
    }

    const news = await fetchTurfNews();
    const { course, participants, mock } = await fetchQuinteDuJour(new Date());

    const { classement, analyse } = await analyseIA(course, participants, news);
    const { base, spare, grilles } = construireGrilles(classement, participants);

    const newBet = {
      id: Date.now().toString(),
      date: today,
      mock,
      hippodrome: course.hippodrome,
      reunion: `R${course.numReunion}`,
      course: `C${course.numCourse}`,
      discipline: course.discipline,
      nb_partants: course.nbPartants || participants.length,
      base,
      spare,
      grilles,
      mise_totale: MISE_TOTALE,
      analyse,
      statut: 'en_attente',
      arrivee: null,
      gain: null,
    };

    // Déduire la mise du jour de la bankroll.
    bankrollData.current = round2(bankrollData.current - MISE_TOTALE);
    bankrollData.history.push({ date: today, amount: round2(bankrollData.current) });

    betsData.unshift(newBet);

    await fs.writeFile(BANKROLL_FILE, JSON.stringify(bankrollData, null, 2));
    await fs.writeFile(BETS_FILE, JSON.stringify(betsData, null, 2));
    await fs.writeFile(DAILY_BET_MD, genererMarkdown(newBet), 'utf-8');

    console.log(`-> Grille du ${today} générée (${mock ? 'SIMULÉE' : 'réelle'}). Base : ${base.map((b) => b.num).join('-')}.`);
    console.log('-> Fichiers mis à jour. Terminé.');
  } catch (error) {
    console.error('ERREUR FATALE :', error);
    process.exit(1);
  }
}

main();
