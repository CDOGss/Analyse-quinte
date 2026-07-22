# 🏇 Analyse Quinté+ — Pronostics IA (simulation à blanc)

Simulation quotidienne et **automatique** de paris Quinté+ (PMU) pilotée par une IA
(Google **Gemini**), sur le même principe que mes projets *Analyse boursière* et
*Analyse paris sportifs*.

Chaque jour de course, l'IA :

1. récupère le **programme PMU** du jour et identifie la course **Quinté+** ;
2. lit les **partants, cotes et musiques** (forme des chevaux) ;
3. fait une **veille d'actualités hippiques** via flux RSS ;
4. **classe** les chevaux et compose **2 grilles** pour un total de **5 € de mise** ;
5. le lendemain, **résout** les grilles avec l'arrivée réelle et les **rapports officiels**,
   puis met à jour la **bankroll**.

Le tout tourne en **GitHub Actions (cron quotidien)** et s'affiche sur un **dashboard**
publié via **GitHub Pages** : évolution du capital, taux de réussite, grilles passées.

> ⚠️ **Simulation éducative** : aucun pari réel n'est engagé. Objectif = mesurer sur
> le long terme si l'IA est performante. Les jeux d'argent sont interdits aux mineurs
> (18+) et comportent des risques.

---

## 🧮 Stratégie de mise (5 € / jour)

À partir du classement de l'IA (7 chevaux, du plus probable au moins probable) :

| Grille | Composition | Mise |
|---|---|---|
| **A — Base** | Les 5 premiers du classement, dans l'ordre | 3,00 € |
| **B — Couverture** | Les 4 premiers + un outsider (6ᵉ) | 2,00 € |

Chaque grille est un **ticket Quinté+ classique** (mise = multiple de la base de 2 €),
ce qui permet un **scoring précis** avec les rapports officiels PMU selon la cascade :
**ordre → désordre → Bonus 4 → Bonus 3**. Gain = `rapport (pour 2 €) × (mise / 2)`.

Tout est paramétrable en haut de [`scripts/daily_analysis.js`](scripts/daily_analysis.js)
(`MISE_TOTALE`, `GRILLES_MISE`).

---

## 🚀 Mise en route

### 1. Installer et tester en local
```bash
npm install --legacy-peer-deps
npm run dev            # dashboard sur http://localhost:5173
npm run analyze        # génère une grille (sans clé API => mode SIMULÉ)
```

### 2. Clé API Gemini
Crée un fichier `.env` (voir [`.env.example`](.env.example)) :
```
GEMINI_API_KEY=ta_clef
GEMINI_MODEL=gemini-3.6-flash
```
Sans clé, le script tourne en **mode simulation** (classement par cotes) : pratique
pour vérifier le pipeline sans consommer de quota.

### 3. Déploiement GitHub
1. Crée un dépôt et pousse ce dossier (branche **`main`**).
2. **Settings → Secrets and variables → Actions** :
   - *Secret* `GEMINI_API_KEY` = ta clé Gemini.
   - *Variable* (optionnel) `GEMINI_MODEL` = `gemini-3.6-flash`.
3. **Settings → Pages** : Source = *GitHub Actions*.
4. Le workflow **Analyse Quinté quotidienne** tourne chaque matin (heure de Paris)
   et pousse la nouvelle grille ; le dashboard se redéploie automatiquement.

Tu peux aussi lancer l'analyse à la main : onglet **Actions → Analyse Quinté
quotidienne → Run workflow**.

---

## 🗂️ Structure

```
scripts/
  pmu.js              Client de données PMU (programme, cotes, arrivées, rapports) + fallback simulé
  daily_analysis.js   Orchestrateur : veille RSS, appel Gemini, grilles, résolution, bankroll
public/data/
  bankroll.json       Capital + historique (alimente le graphe)
  bets.json           Historique des grilles
src/                  Dashboard React (Vite)
.github/workflows/    Cron quotidien + déploiement Pages
DAILY_BET.md          Rapport lisible de la grille du jour (régénéré chaque jour)
```

---

## 🔌 Source de données PMU

Les données viennent de l'API publique **turfinfo** du PMU
(`online.turfinfo.api.pmu.fr`), non officiellement documentée. Le client essaie
plusieurs versions d'API et, si tout échoue (API indisponible, jour sans Quinté),
bascule sur des **données simulées** pour ne jamais bloquer la simulation.

Si le format de l'API change, l'essentiel de l'adaptation se fait dans
[`scripts/pmu.js`](scripts/pmu.js) (détection de la course Quinté, cotes, arrivée,
rapports définitifs).

---

## 📈 Limites connues

- Les **rapports officiels** ne sont pas toujours exposés par l'API : dans ce cas le
  gain est **estimé** (signalé « rapports estimés » dans l'interface) — à affiner en
  branchant une source de rapports fiable.
- En **mode simulé**, l'arrivée est tirée aléatoirement (pondérée vers la base) juste
  pour illustrer le mouvement de bankroll ; ce n'est **pas** un résultat réel.
