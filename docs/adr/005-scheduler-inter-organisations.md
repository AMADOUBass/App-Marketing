# ADR 005 — Scheduler : seul chemin inter-organisations, et rôle de migration

- Statut : accepté
- Date : 2026-11-11
- Tâche : phase 0, 0.7 (complété en 0.8 : balayage par bail)

## Contexte

Le scheduler doit trouver toutes les cibles de publication dues, quelle que soit l'organisation. Or la
règle 4 de CLAUDE.md impose le RLS sur chaque table et interdit toute requête sans contexte d'organisation.

Par ailleurs, en ajoutant des clés étrangères vers `organizations`, PostgreSQL valide la contrainte en
lisant la table référencée : avec le RLS forcé, la migration échouait pour le rôle `app_migrator`.

## Décision

1. **Une seule porte inter-organisations**, en base : trois fonctions `SECURITY DEFINER`,
   `claim_due_publication_targets()`, `requeue_stale_publication_targets()` et (0.8)
   `expire_stuck_publications()`.
   - Propriétaire : `app_scheduler`, rôle **NOLOGIN** (personne ne peut s'y connecter), sans BYPASSRLS.
   - Droits de ce rôle : lecture de 7 colonnes de `publication_targets` (identifiants, état, dates,
     n° de tentative) et mise à jour de 4 colonnes, sous des politiques RLS qui ne permettent que de
     passer une cible à `queued` (réclamation) ou de `publishing` à `unknown_outcome` (bail expiré).
     Aucun accès aux posts, comptes ou autres tables. Les politiques UPDATE étant permissives, elles se
     cumulent : la vraie limite est le SQL figé des fonctions, les politiques sont une seconde barrière.
   - Les fonctions ne renvoient que `(organization_id, target_id, scheduled_at, attempt_no)`, jamais de
     contenu. `app_user` peut les exécuter, mais ne peut pas devenir `app_scheduler`.
   - Le traitement du job repasse par `withTenant(organization_id)`.
   - La politique `tenant_isolation` de `publication_targets` s'applique à `app_user` seulement, pour que
     les fonctions du scheduler n'évaluent jamais `current_setting('app.org_id')`.
2. **Garde-fous automatiques** (`packages/db/test/rls-coverage.test.ts`) : toute nouvelle politique autre
   que `tenant_isolation`, ou toute nouvelle fonction `SECURITY DEFINER`, fait échouer la CI tant qu'elle
   n'est pas ajoutée explicitement à la liste revue.
3. **`app_migrator` reçoit BYPASSRLS** : c'est le rôle propriétaire du schéma, utilisé uniquement pour les
   migrations (validation de clés étrangères, reprises de données). Le rôle de l'application, `app_user`,
   reste sans BYPASSRLS (CLAUDE.md section 6).
4. **`jobId` BullMQ = `${targetId}_${attemptNo}`** : BullMQ 6 refuse un identifiant contenant un seul `:`
   (« Custom Id cannot contain : »), contrairement à ce que prévoyait CLAUDE.md.
5. **Outbox reportée** : PostgreSQL reste la source de vérité. Si le processus meurt entre la réclamation
   (`queued`) et l'ajout du job, `requeue_stale_publication_targets()` rend la cible au scheduler après un
   délai de grâce, avec le même n° de tentative : le `jobId` déterministe rend la remise en file idempotente.
   Le worker ne traite une cible que si elle est encore `queued` pour cette tentative exacte.
6. **Une exécution au plus par tentative, aucune disparition (0.8)** :
   - dans la même transaction que `queued → publishing`, le worker insère `publish_attempts` avec une
     contrainte unique `(target_id, attempt_no)` : deuxième barrière, indépendante de la première ;
   - un job qui trouve la cible dans un autre état ne fait rien. Le worker ne tente **pas** de deviner qu'un
     job relivré vient d'un crash (impossible à distinguer d'un doublon pendant une publication saine) ;
   - à la place, `expire_stuck_publications()` passe en `unknown_outcome` toute cible restée en cours de
     publication au-delà du bail (`PUBLISH_LEASE_SECONDS`, 30 min par défaut) : crash avec job relivré ou
     job perdu, même traitement. `unknown_outcome` impose une réconciliation avant toute nouvelle tentative ;
   - si l'adaptateur répond après l'expiration du bail, sa réponse est gardée dans `publish_attempts`
     (preuve pour la réconciliation) et la cible reste en `unknown_outcome`.

## Conséquences

- Le rôle `app_scheduler` est créé par `infra/compose/postgres/init/02-scheduler-role.sh` (idempotent).
  Base existante : `docker exec -i -e APP_DB_NAME=app app-dev-postgres-1 sh < infra/compose/postgres/init/02-scheduler-role.sh`.
  En production, ce script fait partie du provisionnement de la base, avant les migrations.
- Le verrou de leader (Valkey, TTL renouvelé à chaque tick) évite le travail en double ; la justesse ne
  dépend pas de lui (`FOR UPDATE SKIP LOCKED` + `jobId` déterministe + transition conditionnelle).
- Outbox transactionnelle complète à ajouter avec le moteur de publication (événements vers d'autres
  modules).
