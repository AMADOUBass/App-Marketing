# ADR 003 — Contexte d'organisation provisoire avant Better Auth

- Statut : accepté (temporaire — à remplacer à l'arrivée de Better Auth)
- Date : 2026-11-11
- Tâche : phase 0, 0.5

## Contexte

La tâche 0.5 doit prouver par l'API que l'organisation A ne peut ni lire ni écrire les données de B.
Il faut donc que l'API sache à quelle organisation appartient chaque requête. L'authentification
(Better Auth : utilisateurs, sessions, organisations, membres) est prévue juste après la phase 0.

Intégrer Better Auth maintenant obligerait à décider vite comment ses tables (organization, member)
cohabitent avec nos tables `organizations` / `memberships` et le RLS. Cette décision mérite son propre
plan et son propre ADR.

## Décision

1. **Un seul point d'entrée** : `TenantGuard`, garde globale. Toute route exige une organisation, sauf si
   elle est marquée `@Public()` (refus par défaut). Les routes reçoivent l'organisation par
   `@OrganizationId()` et appellent `db.withTenant()`.
2. **Résolution provisoire** : l'organisation vient de l'en-tête `x-dev-organization-id` (UUID),
   accepté **seulement** si `DEV_TENANT_HEADER=true`. Sinon : 401.
3. **Verrou** : la validation de l'environnement refuse de démarrer avec `NODE_ENV=production` et
   `DEV_TENANT_HEADER=true`.
4. **Pas d'oracle d'existence** : une ressource d'une autre organisation renvoie le même 404 qu'une
   ressource inexistante.

## Conséquences

- N'importe qui pouvant joindre une API lancée avec `DEV_TENANT_HEADER=true` peut choisir son organisation :
  usage strictement local et tests.
- Arrivée de Better Auth : remplacer la résolution dans `TenantGuard` par session + vérification de
  l'appartenance (membership) à l'organisation demandée ; supprimer `DEV_TENANT_HEADER` et cet en-tête.
  Les routes, `@OrganizationId()` et les tests d'isolation restent valables.
