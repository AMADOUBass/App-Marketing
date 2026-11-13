# ADR 008 — Authentification : Better Auth pour l'identité seulement

- Statut : accepté
- Date : 2026-11-13
- Tâche : MVP, étape « auth et multi-tenancy complets », partie 1 (serveur). Remplace en partie l'ADR 003.

## Contexte

CLAUDE.md prévoit Better Auth 1.6 (organisations, 2FA, passkeys), avec des sessions en cookie httpOnly.
Better Auth a un plugin `organization` qui gère ses propres tables d'organisations, de membres et
d'invitations. Or nos tables `organizations` et `memberships` existent déjà : elles portent le RLS,
les FK composites et servent de racine à toutes les données métier (règle absolue 4).

Deux options :

- **A.** Utiliser le plugin `organization` de Better Auth : on aurait deux sources de vérité, ou bien il
  faudrait migrer nos tables vers son schéma, sans RLS et hors de nos conventions.
- **B.** Utiliser Better Auth **pour l'identité seulement** (utilisateurs, sessions, comptes, vérifications).
  Nos organisations et nos adhésions restent la source de vérité.

## Décision

Option **B**.

1. **Version** : `better-auth` et `@better-auth/prisma-adapter` **1.7.15** (dernière version stable au
   2026-11-13 ; la 1.6 notée dans CLAUDE.md n'est plus la dernière). Pas de paquet communautaire
   d'intégration à Nest : le handler est monté directement sur Fastify (`/api/auth/*`), comme le montre
   l'intégration Fastify de la doc officielle.
2. **Schéma `auth` séparé** : tables `auth.users`, `auth.sessions`, `auth.accounts` et
   `auth.verifications`, avec des ids `uuidv7()` (`generateId: false`). Ces tables ne sont pas des tables
   métier : elles n'ont pas d'`organization_id`, car un utilisateur peut appartenir à plusieurs
   organisations.
3. **Rôle `app_auth`** (LOGIN) : c'est le seul rôle qui a des droits sur le schéma `auth`, et il n'en a
   aucun sur `public`. `app_user` ne peut pas lire les hachages de mot de passe ni les sessions. Le test
   `rls-coverage` fait échouer la CI si un autre rôle reçoit un droit sur `auth`.
4. **Adhésions** : `memberships.user_id` référence `auth.users(id)` avec `ON DELETE CASCADE`.
   La politique `tenant_isolation` de `memberships` et `organizations` est restreinte à `app_user`.
5. **Annuaire « mes organisations »** : avant de choisir une organisation, il faut lister celles de
   l'utilisateur, ce qui est une lecture inter-organisations. Elle passe **uniquement** par la fonction
   `SECURITY DEFINER` `list_user_organizations(user_id)`, qui appartient au rôle NOLOGIN `app_directory`.
   Ce rôle n'a qu'un droit de lecture sur les colonnes `memberships(organization_id, user_id, role)` et
   `organizations(id, name)`, avec une politique `directory_read` limitée à lui. C'est la deuxième exception
   au RLS, après le scheduler (ADR 005). Elle figure dans la liste autorisée de `rls-coverage`, et toute
   autre exception fait toujours échouer la CI.
6. **Création d'organisation** : `createOrganizationWithOwner` crée l'organisation, l'adhésion `owner` et un
   premier workspace dans une seule transaction `withTenant(nouvel id)`. Le RLS s'applique donc dès la
   première ligne.
7. **Garde (`TenantGuard`)** :
   - session Better Auth absente → **401** ;
   - en-tête `x-organization-id` absent ou invalide → **400** (aucune route métier ne s'exécute sans
     organisation) ;
   - pas d'adhésion à cette organisation (vérifiée dans `withTenant`) → **403**.
     Les routes `@SessionOnly()` (`/me`, création d'organisation) n'exigent pas d'organisation. L'en-tête de
     dev `x-dev-organization-id` (ADR 003) reste un repli quand il n'y a pas de session, toujours interdit en
     production, jusqu'à l'étape 2 (pages web).
8. **Cookie seulement** : la session est dans un cookie `ponctua.session_token` httpOnly et SameSite=Lax.
   Better Auth renvoie aussi le jeton dans le corps JSON (usage « bearer ») : nous le **retirons** de toutes
   les réponses, pour qu'aucun script de la page ne puisse le lire.
9. **Mots de passe** : 12 caractères minimum. Pas de télémétrie Better Auth.

## Conséquences

- Variables d'environnement obligatoires pour l'api : `BETTER_AUTH_SECRET` (32 caractères ou plus, type
  `Secret`), `BETTER_AUTH_URL` (l'origine du web, car le navigateur passe par le proxy Vite) et
  `AUTH_DATABASE_URL` (rôle `app_auth`). `TRUSTED_ORIGINS` est optionnelle.
- Le script d'initialisation `03-identity-roles.sh` crée `app_auth` et `app_directory`. Une base existante
  doit le rejouer, ou être recréée avec `pnpm infra:reset`.
- 2FA, passkeys, vérification d'e-mail et réinitialisation viennent à l'étape 3, comme plugins Better Auth
  sur les mêmes tables.
- Étape 2 : pages web de connexion et d'organisation, puis retrait du repli `x-dev-organization-id`.
  L'ADR 003 sera alors entièrement remplacé.
