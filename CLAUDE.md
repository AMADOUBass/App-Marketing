# CLAUDE.md — SaaS de gestion des réseaux sociaux

> Fichier d'instructions pour Claude Code. À placer à la racine du dépôt.
> Référence complète : document « SaaS social media — Revue critique et spécification v2 ».
> Nom du produit : **[À DÉFINIR]** — remplacer `@app` partout quand il est choisi.

---

## 1. Le produit en 30 secondes

Plateforme SaaS pour **agences et équipes marketing de 2 à 50 personnes** (Canada d'abord, FR/EN) :
créer un post une fois, l'adapter par réseau, le programmer, le publier de façon **fiable**, le faire
**valider par le client sans compte**, et produire des **rapports en marque blanche**.
Prix par workspace, pas par utilisateur.

MVP : Facebook, Instagram, Threads, YouTube, LinkedIn, TikTok — composer avec variantes, calendrier,
médiathèque, moteur de publication fiable, liens de validation client, 4 rôles, entitlements.

Hors périmètre (ne pas coder) : gestion publicitaire, écoute sociale, CRM, éditeur vidéo complet.

---

## 2. Règles absolues (ne jamais enfreindre)

1. **Jamais** d'API non officielle, de scraping ni d'automatisation de navigateur vers les réseaux sociaux.
2. **Jamais** afficher « publié » sans confirmation de la plateforme.
3. **Jamais** de jeton OAuth en clair : ni en base, ni dans les logs, ni dans les erreurs, ni dans un prompt d'IA, ni envoyé au frontend.
4. **Toute** table métier porte `organization_id` et est protégée par RLS. Aucune requête sans contexte d'organisation.
5. Un module **n'accède jamais** aux tables d'un autre module : il passe par son service public ou par un événement outbox.
6. Une publication **ne peut pas partir deux fois** (idempotence) et **ne disparaît jamais** (statut final obligatoire).
7. Les limites des plateformes viennent du **registre de capacités** (données), jamais de constantes codées en dur.
8. L'IA **ne publie jamais** et ne modifie jamais une programmation sans approbation humaine.
9. Pas de nouvelle dépendance sans le signaler et sans justification dans la PR.
10. Pas de microservice : modular monolith, processus séparés seulement (api, scheduler, workers).

---

## 3. Stack

> Versions vérifiées le 8 nov. 2026. **Au moment d'installer, vérifier la dernière version stable et l'épingler** (pas de `latest` dans les Dockerfiles).

| Couche | Choix |
| --- | --- |
| Runtime | Node.js 26 LTS (26.13.0, voir ADR 001) |
| Langage | TypeScript 6.0 strict. TS 7 testé (0.6, ADR 004) : compatible avec notre code et les décorateurs, mais typescript-eslint et le CLI Nest exigent TS 6 — migrer quand ils le supporteront |
| Monorepo | pnpm workspaces + Turborepo |
| Backend | NestJS 12 en ESM (adaptateur Fastify), émission SWC — voir ADR 002 |
| Validation | Zod 4 (schémas partagés front/back) → OpenAPI 3.1 généré |
| Base de données | PostgreSQL 18 (`uuidv7()`), Prisma 7 (`prisma-client`, adaptateur `@prisma/adapter-pg`) |
| Files / cache / limites | Valkey 8.1 + BullMQ |
| Auth | Better Auth 1.6 (organisations, 2FA, passkeys) — sessions en cookie httpOnly |
| Frontend | React 19 + Vite 8 + TanStack Router + TanStack Query + Zustand, en SPA |
| UI | Tailwind CSS 4 + shadcn/ui + dnd-kit |
| Médias | Cloudflare R2 (S3 compatible), upload direct par URL signée ; FFmpeg 8 dans worker-media |
| IA | AI SDK 6 (Vercel), multi-fournisseur |
| Tests | Vitest 5, Playwright, Testcontainers, k6 |
| Lint / format | ESLint 10 + typescript-eslint (règles typées), Prettier 3 |
| Observabilité | OpenTelemetry + Sentry (pas `@nestjs/observe`, service hébergé payant — ADR 002) |
| Paiement | Stripe Billing + Stripe Tax (V1 commerciale ; entitlements dès le MVP) |
| Hébergement | Gratuit au départ (local Docker, puis offres gratuites), on paie seulement quand nécessaire. Tout doit tourner en conteneurs, sans dépendance à un cloud précis |

---

## 4. Structure du monorepo

```
.
├── apps/
│   ├── api/            # NestJS : HTTP REST /api/v1, SSE, webhooks entrants
│   ├── worker/         # NestJS standalone : scheduler, worker-publish, worker-media, worker-sync
│   │                   #   (un seul code, rôle choisi par la variable PROCESS_ROLE)
│   └── web/            # React + Vite (SPA)
├── packages/
│   ├── db/             # schéma Prisma, migrations, migrations SQL (RLS, partitions), client avec contexte tenant
│   ├── contracts/      # schémas Zod partagés, types d'API, client API généré
│   ├── integrations/   # un dossier par plateforme + interface PlatformAdapter + registre de capacités
│   ├── ui/             # composants partagés (shadcn)
│   └── config/         # tsconfig, eslint/oxlint, prettier partagés
├── infra/
│   ├── docker/         # Dockerfiles par processus
│   └── compose/        # docker-compose.dev.yml (postgres, valkey, rustfs pour imiter R2 — ADR 001)
├── docs/
│   └── adr/            # Architecture Decision Records (001-xxx.md)
└── CLAUDE.md
```

Modules backend (dans `apps/api/src/modules/` et partagés avec le worker) :
`identity`, `tenancy`, `billing`, `integrations`, `content`, `media`, `scheduling`, `publishing`,
`analytics`, `collaboration`, `reporting`, `ai`, `audit`.

---

## 5. Architecture clé

### Hiérarchie multi-tenant
`Organization` (client payant) › `Workspace` (un client de l'agence ou une marque ; frontière de permissions) › ressources.
La « marque » est une **étiquette**, pas un niveau. Les validateurs clients sont des **invités externes** (lien signé), pas des membres.

Rôles MVP — organisation : `owner`, `admin`, `member` ; workspace : `admin`, `editor`, `publisher`, `viewer`.

### Unité d'exécution : la cible de publication
Un post × un compte social = une `publication_target`. États :

```
draft → pending_approval → scheduled → queued → publishing → published
                                                  ├─ uploading / remote_processing / publishing (sous-étapes)
erreurs : retrying | failed | needs_action | unknown_outcome → reconciled | cancelled
```

- Contrainte unique `(post_id, social_account_id)` ; jobId BullMQ = `${targetId}_${attemptNo}` (BullMQ 6 refuse un `:` seul — ADR 005).
- Timeout après l'appel de publication → `unknown_outcome` → **réconciliation avant toute nouvelle tentative**.
- Erreurs classées : `transient`, `quota`, `auth`, `content`, `unknown`. Seules `transient` et `quota` sont réessayées (backoff exponentiel + gigue).
- Chaque tentative est journalisée dans `publish_attempts` (requête/réponse assainies).

### Ordonnancement
- PostgreSQL est la source de vérité des programmations. Valkey/BullMQ sert seulement à l'exécution.
- Le scheduler (une instance active, verrou de leader) tourne toutes les 10 s :
  `SELECT … WHERE state='scheduled' AND scheduled_at < now() + interval '60 seconds' FOR UPDATE SKIP LOCKED`,
  passe la cible en `queued`, met le job en file avec le délai exact.
- Cette requête inter-organisations passe **uniquement** par les fonctions `SECURITY DEFINER`
  `claim_due_publication_targets()` / `requeue_stale_publication_targets()` / `expire_stuck_publications()` (rôle NOLOGIN `app_scheduler`,
  identifiants seulement) ; le job repasse par `withTenant`. Toute autre exception au RLS fait échouer la CI (ADR 005).
- Contrôle 15 min avant l'heure : jeton, permissions, quota restant, conformité du média.

### Événements
Outbox transactionnelle (`outbox_events`) écrite dans la même transaction que le changement d'état, relayée vers BullMQ.

### Médias
Navigateur → URL multipart signée → R2. Puis worker-media : ffprobe, SHA-256, miniature.
Les plateformes qui téléchargent (Instagram, Threads, Facebook, TikTok PULL_FROM_URL) reçoivent une URL signée courte
sur un sous-domaine vérifié (`media.<domaine>`). Les autres reçoivent le fichier en flux par morceaux.

### Temps réel
Server-Sent Events (Valkey pub/sub entre instances). Pas de WebSocket au MVP.

---

## 6. Base de données — conventions

- PK : `uuid DEFAULT uuidv7()`. Dates : `timestamptz` UTC. Fuseau horaire stocké par workspace.
- Chaque table métier : `organization_id uuid NOT NULL` + `UNIQUE (organization_id, id)` ; FK **composites** `(organization_id, xxx_id)`.
- RLS sur chaque table métier :

```sql
ALTER TABLE posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE posts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON posts
  USING (organization_id = current_setting('app.org_id')::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id')::uuid);
```

- Le rôle applicatif n'a **pas** `BYPASSRLS`. Chaque requête passe par `withTenant(orgId, fn)` qui ouvre une transaction et fait
  `SELECT set_config('app.org_id', $1, true)`. Les jobs reçoivent `organizationId` dans leur payload et appellent `withTenant`.
- Jetons OAuth : table `oauth_credentials`, chiffrement AES-256-GCM par enveloppe (clé de données par organisation, clé maître hors base),
  identifiant du compte en données associées. Déchiffrement autorisé seulement dans le worker.
  Enveloppe à clé publique (X25519) : l'api n'a que des clés publiques et ne peut pas relire un jeton (ADR 006).
- `metric_snapshots` et `audit_events` partitionnées par mois ; colonne `expires_at` pour la rétention par plateforme
  (YouTube : rafraîchir ou supprimer après 30 jours pour la plupart des données).
- Migrations : Prisma Migrate pour le schéma ; fichiers SQL manuels pour RLS, partitions, index partiels. Stratégie expand puis contract.

---

## 7. Intégrations

Chaque plateforme implémente `PlatformAdapter` dans `packages/integrations/<platform>/` :

```ts
interface PlatformAdapter {
  readonly platform: PlatformId;
  capabilities(account: SocialAccountRef): Promise<CapabilitySet>;
  validate(variant: PostVariant, caps: CapabilitySet): ValidationIssue[]; // pur, sans réseau
  prepareMedia(job: PublishJob): Promise<PreparedMedia>;
  publish(job: PublishJob, media: PreparedMedia): Promise<PublishOutcome>;
  pollStatus(handle: RemoteHandle): Promise<RemoteStatus>;
  reconcile(job: PublishJob): Promise<RemotePost | null>;
  refreshToken(cred: OAuthCredential): Promise<OAuthCredential>;
  fetchMetrics(req: MetricsRequest): Promise<MetricPoint[]>;
  classifyError(err: unknown): ErrorClass;
}
```

- Limiteur à trois niveaux dans Valkey (seau à jetons en Lua) : app × plateforme, compte social, quota quotidien.
- Webhooks entrants : signature HMAC vérifiée (comparaison en temps constant), stockage brut, déduplication par id d'événement, traitement asynchrone.
- Tests de contrat par adaptateur sur des réponses enregistrées (fixtures), + suite nocturne sur comptes de test réels.

Contraintes à respecter dès le code (détails et sources dans la spec, section 7) :
- **Instagram** (Unified Login, `graph.facebook.com`, ADR 007) : comptes professionnels seulement ; images JPEG ≤ 8 Mio, ratio 4:5 à 1,91:1 ;
  média sur URL publique ; limite de publication lue en direct (`content_publishing_limit`, doc contradictoire : 50 ou 100 / 24 h) ;
  conteneur expire après 24 h ; statut du conteneur interrogé 1×/min, 5 min max ; permissions : `instagram_basic` + `instagram_content_publish` seulement.
- **TikTok** : appeler `creator_info` avant d'afficher l'écran de publication ; proposer seulement les `privacy_level_options` renvoyées ; respecter `max_video_post_duration_sec` ; ~15 posts/jour/créateur ; sans audit → `SELF_ONLY`.
- **YouTube** : 100 `videos.insert`/jour par projet par défaut ; programmation native via `status.publishAt` sur vidéo privée ; identifier la chaîne et obtenir le consentement avant chaque action.
- **LinkedIn** : en-têtes `Linkedin-Version: YYYYMM` et `X-Restli-Protocol-Version: 2.0.0` ; Development Tier = 500 appels/jour/app.
- **Threads** : 250 posts API / 24 h / profil.

---

## 8. Conventions de code

- TypeScript `strict: true`, `noUncheckedIndexedAccess: true`. Pas de `any` (sinon commentaire justifié).
- Entrées/sorties d'API validées par Zod ; types dérivés des schémas (`z.infer`).
- Erreurs API au format RFC 9457 (`application/problem+json`).
- Pagination par curseur (UUIDv7). Clé d'idempotence (`Idempotency-Key`) obligatoire sur création de post et de programmation.
- Nommage : fichiers `kebab-case`, classes `PascalCase`, tables et colonnes `snake_case`.
- Logs JSON structurés (pino), jamais de secret ni de donnée personnelle en clair.
- Textes d'interface en **FR et EN** dès le départ (i18n), aucun texte en dur dans les composants.
- Accessibilité WCAG 2.2 AA : navigation clavier, labels, contrastes.
- Commits : Conventional Commits (`feat:`, `fix:`, `chore:`…). Une PR = un sujet.

### Définition de « terminé »
Tests unitaires et d'intégration verts ; test d'isolation multi-tenant si la fonctionnalité lit des données ;
E2E pour les flux critiques ; traces et métriques ; textes FR/EN ; accessibilité vérifiée ; doc à jour ; derrière un feature flag.

---

## 9. Comment travailler avec moi (Claude)

1. **Planifier avant de coder** : pour toute tâche de plus de ~50 lignes, proposer un plan court (fichiers touchés, étapes, tests) et attendre mon accord.
2. **Petites étapes** : une étape = du code qui compile + ses tests qui passent.
3. **Toujours écrire les tests** avec le code, en commençant par le cas multi-tenant quand des données sont lues.
4. **Lancer** `pnpm typecheck`, `pnpm lint` et `pnpm test` avant de dire qu'une étape est finie.
5. **Ne jamais inventer** une capacité d'API sociale : si un comportement n'est pas certain, le signaler et proposer de vérifier dans la doc officielle.
6. **Décision d'architecture** nouvelle ou contraire à ce fichier → proposer un ADR dans `docs/adr/` au lieu de changer en silence.
7. Me parler en français ; code, noms et commentaires de code en anglais.

---

## 10. Commandes

> À compléter pendant la phase 0.

```bash
pnpm install
pnpm infra:up       # postgres, valkey, rustfs (attend qu'ils soient healthy) ; infra:down, infra:reset, infra:logs, infra:ps
pnpm check          # format:check + typecheck + lint + test (comme la CI)
pnpm format         # Prettier --write
pnpm dev            # web (http://localhost:5173) + api (:3000) + worker (PROCESS_ROLE=all) en watch — copier apps/*/.env.example → .env
pnpm db:seed        # organisations de démonstration (ids fixes, affichés) pour se connecter sur le web
pnpm vault:keygen   # nouvelle paire de clés maître du coffre à jetons : publique → api, privée → worker SEULEMENT (ADR 006)
pnpm db:migrate     # applique les migrations (schéma + RLS) — copier packages/db/.env.example → .env
pnpm db:migrate:dev # crée une migration depuis schema.prisma (RLS : migration --create-only éditée à la main)
pnpm db:generate    # régénère le client Prisma (packages/db/src/generated, non versionné)
pnpm typecheck
pnpm lint
pnpm test           # unitaires + intégration (Testcontainers)
pnpm e2e            # Playwright + axe (apps/web, API simulée) — 1re fois : pnpm --filter @app/web exec playwright install chromium
```

---

## 11. État actuel et prochaines tâches

**Phase actuelle : Phase 0 — spike technique (en local, gratuit).** Objectif : prouver le socle avant le MVP.

- [x] 0.1 Monorepo pnpm + Turborepo, `packages/config` (tsconfig strict, lint, prettier), CI GitHub Actions (typecheck, lint, test)
- [x] 0.2 `infra/compose/docker-compose.dev.yml` : PostgreSQL 18, Valkey 8.1, RustFS (imite R2 ; MinIO n'a plus d'image — ADR 001).
  Rôles Postgres : `app_migrator` (propriétaire, migrations) et `app_user` (runtime, sans BYPASSRLS).
  Port Postgres local surchargeable via `infra/compose/.env` (`POSTGRES_PORT`).
- [x] 0.3 `apps/api` NestJS 12 + Fastify, route `/api/v1/health`, logs pino, OpenTelemetry minimal (ADR 002)
- [x] 0.4 `packages/db` : Prisma 7, tables `organizations`, `workspaces`, `memberships`, `posts` ; migration SQL RLS ; helper `withTenant`
  (isolation testée au niveau base avec Testcontainers ; `test/rls-coverage.test.ts` fait échouer toute nouvelle table sans RLS)
- [x] 0.5 Test d'isolation : l'organisation A ne peut ni lire ni écrire les données de B (doit renvoyer 0 ligne / 404)
  — base (Testcontainers) et API (`GET/PATCH /api/v1/posts/:id` → 404 identique à « inexistant ») ; `/api/v1/health/ready` ;
  organisation provisoire par en-tête `x-dev-organization-id` derrière `DEV_TENANT_HEADER`, interdit en production (ADR 003)
- [x] 0.6 Vérifier si TypeScript 7 fonctionne avec les décorateurs NestJS ; sinon rester sur TS 6 → noter la décision dans un ADR
  (TS 7 OK pour le code et les décorateurs, mais on reste sur TS 6 à cause de typescript-eslint et du CLI Nest — ADR 004)
- [x] 0.7 `apps/worker` : BullMQ + Valkey ; scheduler toutes les 10 s avec `FOR UPDATE SKIP LOCKED` ; un job programmé part à l'heure (test)
  (tables `social_accounts`, `publication_targets` ; verrou de leader Valkey ; récupération des jobs perdus ;
  sans adaptateur → `needs_action` ; `app_migrator` a BYPASSRLS pour les migrations — ADR 005)
- [x] 0.8 Idempotence : deux workers ne peuvent pas exécuter la même cible (test)
  (transition conditionnelle + `publish_attempts` unique `(target_id, attempt_no)` dans la même transaction ;
  bail `PUBLISH_LEASE_SECONDS` : cible bloquée en publication → `unknown_outcome`, jamais republiée à l'aveugle — ADR 005)
- [ ] 0.9 `packages/integrations/instagram` : OAuth (Instagram Login), création de conteneur, publication d'une image sur un **compte de test**
  - [x] 9a coffre à jetons `packages/vault` : tables `organization_keys` / `oauth_credentials` ; X25519 + AES-256-GCM ;
    l'API scelle (`@app/vault/seal`), seul le worker ouvre (`@app/vault/open`, interdit dans l'api par ESLint) ; type `Secret` (ADR 006)
  - [x] 9b `packages/integrations` : `PlatformAdapter`, registre de capacités (valeurs sourcées et datées), adaptateur Instagram
    en **Unified Login** (ADR 007) : connexion, conteneur → statut → publication, réconciliation, classement des erreurs ;
    fixtures issues de la doc, à remplacer par des réponses enregistrées en 9c
  - [ ] 9c essai réel sur le compte Instagram de test (compte développeur Meta requis)
- [x] 0.10 `apps/web` : React + Vite + TanStack Router + Tailwind + shadcn, page de connexion et liste de posts (lecture via API)
  (connexion de dev = choix d'organisation, ADR 003 ; FR/EN i18next ; composants dans `packages/ui` ;
  routes déclarées en code (pas de fichier généré) ; E2E Playwright + axe WCAG 2.2 AA en CI)

**Après la phase 0 (ordre du MVP)** : auth et multi-tenancy complets (Better Auth ; remplace la résolution provisoire de `TenantGuard`, ADR 003) → moteur de publication + adaptateurs Meta →
composer, variantes, vérificateur, médiathèque, calendrier → liens de validation client → YouTube, LinkedIn, TikTok → entitlements.

**En parallèle, hors code** : nom du produit, entreprise enregistrée, domaine, politique de confidentialité,
Business Verification Meta, comptes développeur Google / LinkedIn / TikTok, entretiens agences.
