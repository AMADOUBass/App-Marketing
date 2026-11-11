# App-Marketing

Plateforme SaaS de gestion des réseaux sociaux pour agences et équipes marketing (phase 0 : socle technique).
Les règles du projet, la stack et la feuille de route sont dans [CLAUDE.md](CLAUDE.md) ; les décisions
d'architecture dans [docs/adr](docs/adr).

## Démarrage

Prérequis : Node.js 26.13 (`.nvmrc`), pnpm 11, Docker.

```bash
pnpm install
cp infra/compose/.env.example infra/compose/.env   # optionnel : changer les ports / mots de passe
cp apps/api/.env.example apps/api/.env
cp packages/db/.env.example packages/db/.env
cp apps/worker/.env.example apps/worker/.env
pnpm infra:up      # PostgreSQL, Valkey, RustFS
pnpm db:migrate    # schéma + row-level security
pnpm dev           # API sur http://127.0.0.1:3000/api/v1/health
pnpm check         # format + types + lint + tests (comme la CI)
```
