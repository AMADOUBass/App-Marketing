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
     Les routes `@SessionOnly()` (`/me`, création d'organisation) n'exigent pas d'organisation. Il n'y a
     plus d'autre moyen de choisir une organisation : l'en-tête de dev `x-dev-organization-id` et
     `DEV_TENANT_HEADER` (ADR 003) sont supprimés depuis l'étape 2.
8. **Cookie seulement** : la session est dans un cookie `ponctua.session_token` httpOnly et SameSite=Lax.
   Better Auth renvoie aussi le jeton dans le corps JSON (usage « bearer ») : nous le **retirons** de toutes
   les réponses, pour qu'aucun script de la page ne puisse le lire.
9. **Mots de passe** : 12 caractères minimum (`PASSWORD_MIN_LENGTH` dans `@ponctua/contracts`, partagé par
   le formulaire web et Better Auth). Pas de télémétrie Better Auth.
10. **Limite de débit** (force brute) : 10 connexions et 5 inscriptions par minute et par adresse IP.
    L'adresse vient de Fastify (`request.ip`, donc du socket, ou d'un proxy de confiance via `trustProxy`),
    passée à Better Auth dans un en-tête interne qui **écrase** toute valeur envoyée par le client : un
    `X-Forwarded-For` forgé ne remet pas le compteur à zéro (testé). Stockage en mémoire : suffisant pour
    une instance d'api, à passer dans Valkey avant d'en lancer plusieurs.
11. **Vérification d'origine (CSRF) forcée** : Better Auth la désactive tout seul quand il croit tourner
    en test (`isTest()`). Nous fixons `disableOriginCheck: false` et `disableCSRFCheck: false` : aucune
    détection d'environnement ne peut la couper, et les tests vérifient le vrai comportement. Sans cookie,
    Better Auth ne contrôle l'origine que si la requête porte les en-têtes Fetch Metadata (`Sec-Fetch-*`),
    ce que font tous les navigateurs actuels ; un client hors navigateur peut forger `Origin` de toute façon.
12. **Messages d'erreur** : « courriel ou mot de passe incorrect » est identique que le compte existe ou
    non (testé). L'inscription, elle, dit « adresse déjà utilisée » : c'est la limite connue de toute
    inscription ouverte ; la vérification d'e-mail (étape 3) permettra de répondre de façon neutre.
13. **Logs** : les messages de Better Auth passent par le logger Nest (pino, JSON), sans leurs arguments
    supplémentaires, qui pourraient contenir des données de requête.

## Conséquences

- Variables d'environnement obligatoires pour l'api : `BETTER_AUTH_SECRET` (32 caractères ou plus, type
  `Secret`), `BETTER_AUTH_URL` (l'origine du web, car le navigateur passe par le proxy Vite) et
  `AUTH_DATABASE_URL` (rôle `app_auth`). `TRUSTED_ORIGINS` est optionnelle.
- Le script d'initialisation `03-identity-roles.sh` crée `app_auth` et `app_directory`. Une base existante
  doit le rejouer, ou être recréée avec `pnpm infra:reset`.
- 2FA, passkeys, vérification d'e-mail et réinitialisation viennent à l'étape 3, comme plugins Better Auth
  sur les mêmes tables.
- Étape 2 (faite) : pages web d'inscription, de connexion, de choix et de création d'organisation,
  déconnexion. Le web garde seulement l'organisation choisie (`sessionStorage`), revérifiée contre `/me`
  à chaque navigation ; le cache des requêtes est vidé à chaque changement d'organisation et à la
  déconnexion. L'ADR 003 est entièrement remplacé.
- Données de démo : `pnpm db:seed` crée aussi l'utilisateur local `demo@ponctua.local`, propriétaire des
  organisations de démo (`-- --org <id>` pour en rejoindre une autre).
