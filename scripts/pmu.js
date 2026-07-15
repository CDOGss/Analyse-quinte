/**
 * Client de données turf (PMU).
 *
 * Source : API publique "turfinfo" du PMU (celle qui alimente le site/app PMU).
 * Elle n'est pas officiellement documentée : le numéro de version du client change
 * de temps en temps et le format peut évoluer. On interroge donc plusieurs versions
 * en cascade et, si tout échoue, on bascule sur des données SIMULÉES (mock) pour que
 * la simulation "à blanc" continue de tourner tous les jours sans planter.
 *
 * Endpoints utilisés :
 *   - Programme du jour  : /rest/client/{V}/programme/{DDMMYYYY}
 *   - Participants+cotes  : /rest/client/{V}/programme/{DDMMYYYY}/R{r}/C{c}/participants
 *   - Rapports définitifs : /rest/client/{V}/programme/{DDMMYYYY}/R{r}/C{c}/rapports-definitifs
 */

const API_ROOT = 'https://online.turfinfo.api.pmu.fr/rest/client';
// Versions connues du client, de la plus récente à la plus ancienne.
const CLIENT_VERSIONS = [61, 65, 62, 60, 2, 1];

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; AnalyseQuinteBot/1.0)',
  Accept: 'application/json',
};

/** Formate une date JS au format PMU DDMMYYYY (ex: 02072026). */
export function toPmuDate(date) {
  const d = String(date.getDate()).padStart(2, '0');
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const y = date.getFullYear();
  return `${d}${m}${y}`;
}

async function tryFetchJson(url) {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/**
 * Récupère le programme du jour en essayant chaque version de client.
 * Renvoie l'objet programme brut ou null si tout échoue.
 */
export async function fetchProgramme(pmuDate) {
  for (const v of CLIENT_VERSIONS) {
    const url = `${API_ROOT}/${v}/programme/${pmuDate}?meteo=false&specialisation=INTERNET`;
    try {
      const data = await tryFetchJson(url);
      if (data && data.programme && Array.isArray(data.programme.reunions)) {
        console.log(`   PMU: programme récupéré (client v${v}).`);
        return { ...data.programme, _clientVersion: v };
      }
    } catch (err) {
      // On tente la version suivante.
      console.log(`   PMU: client v${v} indisponible (${err.message}).`);
    }
  }
  return null;
}

/**
 * Identifie LA course "Quinté+" du jour dans le programme.
 * Le marqueur le plus fiable est la présence de "QUINTE" dans les paris de la course
 * (typePari E_QUINTE_PLUS) ; à défaut on cherche le mot-clé dans la course sérialisée.
 */
export function findQuinteCourse(programme) {
  if (!programme) return null;
  for (const reunion of programme.reunions || []) {
    for (const course of reunion.courses || []) {
      const raw = JSON.stringify(course);
      if (/QUINTE/i.test(raw)) {
        return {
          numReunion: reunion.numOfficiel ?? reunion.numExterne ?? course.numReunion,
          numCourse: course.numOrdre ?? course.numExterne,
          hippodrome:
            (reunion.hippodrome && (reunion.hippodrome.libelleLong || reunion.hippodrome.libelleCourt)) ||
            reunion.nature ||
            'Hippodrome',
          discipline: course.discipline || course.specialite || 'Plat',
          libelle: course.libelle || course.libelleCourt || 'Quinté+',
          heureDepart: course.heureDepart || null,
          nbPartants: course.nombreDeclaresPartants || course.nombrePartants || null,
          courseObj: course,
        };
      }
    }
  }
  return null;
}

/**
 * Récupère les participants (avec cotes) d'une course.
 * Renvoie un tableau normalisé [{num, nom, cote, driver, entraineur, musique, statut}].
 */
export async function fetchParticipants(pmuDate, numReunion, numCourse, clientVersion) {
  const versions = clientVersion ? [clientVersion, ...CLIENT_VERSIONS] : CLIENT_VERSIONS;
  for (const v of versions) {
    const url = `${API_ROOT}/${v}/programme/${pmuDate}/R${numReunion}/C${numCourse}/participants?specialisation=INTERNET`;
    try {
      const data = await tryFetchJson(url);
      const list = data.participants || data;
      if (Array.isArray(list) && list.length > 0) {
        return list.map(normalizeParticipant).filter((p) => p.statut !== 'NON_PARTANT');
      }
    } catch {
      // version suivante
    }
  }
  return null;
}

function coteOf(p) {
  const direct = p.dernierRapportDirect && p.dernierRapportDirect.rapport;
  const ref = p.dernierRapportReference && p.dernierRapportReference.rapport;
  const c = direct || ref || null;
  return typeof c === 'number' ? c : null;
}

function normalizeParticipant(p) {
  return {
    num: p.numPmu ?? p.numero ?? p.num,
    nom: p.nom || p.nomCheval || `Cheval ${p.numPmu}`,
    cote: coteOf(p),
    driver: p.driver || p.jockey || null,
    entraineur: p.entraineur || null,
    musique: p.musique || null,
    statut: p.statut || 'PARTANT',
    sexe: p.sexe || null,
    age: p.age || null,
  };
}

/**
 * Récupère l'ordre d'arrivée (top 5 des numéros) d'une course déjà courue.
 * Cherche d'abord dans l'objet course du programme, sinon via rapports-definitifs.
 */
export function extractArrivee(courseObj) {
  const oa = courseObj && (courseObj.ordreArrivee || courseObj.arrivee);
  if (Array.isArray(oa) && oa.length > 0) {
    // Format PMU : [[7],[3],[12],[5],[9]] -> on aplatit en [7,3,12,5,9]
    return oa.map((x) => (Array.isArray(x) ? x[0] : x)).filter((n) => n != null);
  }
  return null;
}

/** Supprime les accents et met en majuscules ("Désordre" -> "DESORDRE"). */
function normLabel(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase();
}

/**
 * Récupère les rapports officiels du Quinté+ : ordre, désordre, bonus 4,
 * bonus 4sur5, bonus 3 — en EUROS pour la mise de base de 2 €.
 *
 * ⚠️ Unités API : les champs `dividende` / `dividendePourUneMiseDeBase` /
 * `dividendePourUnEuro` sont exprimés en CENTIMES (ex: 300 = 3,00 €).
 * Vérifié sur les données réelles (dividendeUnite: "PourUneMiseDeBase").
 */
export async function fetchRapportsQuinte(pmuDate, numReunion, numCourse, clientVersion) {
  const versions = clientVersion ? [clientVersion, ...CLIENT_VERSIONS] : CLIENT_VERSIONS;
  for (const v of versions) {
    const url = `${API_ROOT}/${v}/programme/${pmuDate}/R${numReunion}/C${numCourse}/rapports-definitifs?specialisation=INTERNET`;
    try {
      const data = await tryFetchJson(url);
      const paris = Array.isArray(data) ? data : data.rapports || [];
      const quinte = paris.find((p) => /QUINTE/i.test(JSON.stringify(p.typePari || p.pari || p)));
      if (!quinte) continue;
      const rapports = quinte.rapports || quinte.rapportsDefinitifs || [];

      // Valeur en euros pour la mise de base (2 €) : centimes -> euros.
      const euros = (r) => {
        const centimes =
          r.dividendePourUneMiseDeBase ??
          r.dividende ??
          (r.dividendePourUnEuro != null ? r.dividendePourUnEuro * 2 : null);
        return centimes != null ? centimes / 100 : null;
      };
      const pick = (test) => {
        const r = rapports.find((x) => test(normLabel(x.libelle || x.typeRapport)));
        return r ? euros(r) : null;
      };

      // Attention aux libellés : "Ordre" est une sous-chaîne de "Désordre",
      // et le désordre s'écrit avec un accent ("Désordre") -> matching normalisé.
      const result = {
        ordre: pick((l) => l.includes('ORDRE') && !l.includes('DESORDRE')),
        desordre: pick((l) => l.includes('DESORDRE')),
        bonus4sur5: pick((l) => /BONUS.?4.?SUR.?5/.test(l)),
        bonus4: pick((l) => /BONUS.?4/.test(l) && !/SUR/.test(l)),
        bonus3: pick((l) => /BONUS.?3/.test(l)),
        estime: false,
      };
      // Le palier "Bonus 4" simple n'existe pas sur toutes les courses :
      // on retombe sur le Bonus 4sur5 (avoir les 4 premiers implique 4 sur 5).
      if (result.bonus4 == null) result.bonus4 = result.bonus4sur5;
      return result;
    } catch {
      // version suivante
    }
  }
  return null;
}

/* ----------------------------------------------------------------------------
 * DONNÉES SIMULÉES (fallback quand l'API PMU est injoignable / hors-course).
 * Permet de ne jamais bloquer la simulation "à blanc".
 * -------------------------------------------------------------------------- */
export function mockQuinteCourse() {
  return {
    numReunion: 1,
    numCourse: 4,
    hippodrome: 'Vincennes (SIMULÉ)',
    discipline: 'Attelé',
    libelle: 'Prix Simulé — Quinté+',
    heureDepart: null,
    nbPartants: 16,
    mock: true,
  };
}

export function mockParticipants() {
  // 16 partants avec cotes plausibles.
  const noms = [
    'Idao De Tillard', 'Gioia Du Chene', 'Feliz Diamant', 'Hasard Du Pommeau',
    'Gemini Star', 'Joyau Des Bordes', 'Fakir Du Lorault', 'Highland Turgot',
    'Excalibur Jenilat', 'Diable De Vauvert', 'Cash And Play', 'Belina Josselyn',
    'Aetos Kronos', 'Face Time Bourbon', 'Davidson Du Pont', 'Bahia Quesnot',
  ];
  const cotes = [4.5, 6.2, 8.1, 3.2, 12.4, 15.0, 9.7, 21.3, 7.4, 33.0, 18.5, 5.8, 2.7, 11.2, 14.6, 27.0];
  return noms.map((nom, i) => ({
    num: i + 1,
    nom,
    cote: cotes[i],
    driver: `Driver ${i + 1}`,
    entraineur: `Entraîneur ${i + 1}`,
    musique: '1a 2a 3a Da 1a',
    statut: 'PARTANT',
  }));
}
