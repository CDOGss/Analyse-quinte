import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { exec } from 'child_process'

// base relatif ('./') : le site fonctionne quel que soit le nom du dépôt GitHub Pages
// (ex: https://user.github.io/Analyse-quinte/) sans avoir à coder le chemin en dur.
export default defineConfig({
  base: './',
  plugins: [
    react(),
    {
      // Petit endpoint local pour le bouton "Lancer l'analyse" en dev (npm run dev).
      // En production (GitHub Pages) c'est le cron GitHub Actions qui génère la grille.
      name: 'run-analysis-api',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url === '/api/run-analysis' && req.method === 'POST') {
            exec('node scripts/daily_analysis.js', (error, stdout, stderr) => {
              res.setHeader('Content-Type', 'application/json');
              if (error) {
                console.error("Erreur de script :", error);
                res.statusCode = 500;
                res.end(JSON.stringify({ error: error.message, stderr }));
                return;
              }
              res.end(JSON.stringify({ success: true, stdout }));
            });
          } else {
            next();
          }
        });
      }
    }
  ],
})
