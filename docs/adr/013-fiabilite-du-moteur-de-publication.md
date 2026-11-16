# ADR 013 — Fiabilité du moteur de publication : reprises, réconciliation, outbox

- Statut : accepté (4b-1 reprises, réconciliation et outbox ; 4b-2 contrôle préalable et limiteur)
- Date : 2026-11-16
- Tâche : MVP, moteur de publication, étape 4b

## Contexte

Après la phase 0, une cible qui échouait restait `failed`, même pour une panne passagère de la
plateforme. Une cible `unknown_outcome` y restait aussi pour toujours, et aucun événement ne signalait la
fin d'une publication. CLAUDE.md (section 5) demande :

- des reprises seulement pour les erreurs `transient` et `quota`, avec backoff exponentiel et gigue ;
- une réconciliation avant toute nouvelle tentative après un résultat inconnu ;
- une outbox transactionnelle.

## Décision

1. **Reprises** (processeur de publication) :
   - un échec que l'adaptateur marque **réessayable**, de classe `transient` ou `quota`, passe en
     `retrying`, avec `retry_at` ;
   - le délai double à chaque tentative (`RETRY_BASE_SECONDS`, 60 s par défaut, plafonné à
     `RETRY_MAX_SECONDS`, 1 h) avec une **gigue de moitié** : la moitié du délai est fixe, l'autre moitié
     aléatoire. Les reprises de nombreuses cibles s'étalent ainsi, sans jamais revenir avant la moitié du
     délai prévu ;
   - une erreur de quota attend au moins `QUOTA_RETRY_SECONDS` (15 min) ;
   - au-delà de `PUBLISH_MAX_ATTEMPTS` (5), la cible passe en `failed` avec la raison
     `retries.exhausted` ;
   - `auth` et `content` ne sont jamais réessayés : `needs_action` (reconnecter le compte) ou `failed`.
2. **Le scheduler reprend les cibles à échéance.** `claim_due_retries()` les fait passer de `retrying` à
   `queued`, avec un nouveau numéro de tentative, et la tâche est mise en file avec le délai exact jusqu'à
   `retry_at`. La récupération des tâches perdues (`requeue_stale`) couvre aussi ces cibles.
3. **Réconciliation** (nouveau processeur, file `reconcile`). Elle ne publie jamais : elle demande à la
   plateforme ce qu'est devenue la dernière tentative.
   - `claim_due_reconciliations()` prend un **bail** (`retry_at = now() + RECONCILE_LEASE_SECONDS`) pour
     qu'une vérification ne soit pas lancée deux fois. Une tâche d'un numéro de vérification périmé ne
     fait rien.
   - Publication confirmée → `published` (raison `outcome.confirmed`).
   - **Certainement** pas publiée → traitée comme un échec : reprise si possible, sinon `failed` ou
     `needs_action`.
   - Toujours incertain → nouvelle vérification plus tard, avec un délai croissant. Après
     `RECONCILE_MAX_CHECKS` (5), la cible passe en `needs_action` (`outcome.unconfirmed`) : une personne
     regarde le compte et décide. Nous ne devinons jamais (règles 2 et 6).
   - **Instagram** : l'identifiant du conteneur est enregistré **avant** l'appel `media_publish`
     (vérifié dans l'adaptateur). Donc pas de conteneur enregistré veut dire que `media_publish` n'a jamais
     été appelé, et une reprise est sûre. Avec un conteneur, son statut décide : `PUBLISHED` → publiée ;
     `FINISHED`, `EXPIRED` ou `ERROR` → jamais publiée ; `IN_PROGRESS` ou pas de réponse → incertain.
   - L'état `reconciled` du schéma de CLAUDE.md n'est pas utilisé : une publication confirmée par
     réconciliation **est** publiée, et un seul état final simplifie l'affichage et les mesures. La
     vérification reste tracée par `status_reason = outcome.confirmed` et par la tentative
     (`reconciliation: published`).
4. **Outbox transactionnelle** (table `outbox_events`, protégée par RLS) :
   - l'événement (`publication.published`, `publication.failed` ou `publication.needs_action`) est écrit
     dans **la même transaction** que le changement d'état ;
   - charge utile : identifiants et codes seulement (`targetId`, `socialAccountId`, `state`, `reason`) ;
   - le relais (scheduler leader) loue les événements (`claim_outbox_events()`, bail
     `OUTBOX_LEASE_SECONDS`), les met dans la file `events` avec **l'identifiant de l'événement comme
     identifiant de tâche**, puis les marque livrés (`complete_outbox_events()`). Après un crash entre ces
     deux étapes, l'événement revient après le bail, et la deuxième mise en file est sans effet ;
   - le consommateur ne fait que journaliser pour l'instant. Les notifications et le temps réel (SSE) s'y
     brancheront.
5. **Exceptions au RLS revues** (test `rls-coverage`). Cinq nouvelles fonctions `SECURITY DEFINER`
   appartiennent à `app_scheduler` et ne renvoient que des identifiants :
   - `claim_due_retries` ;
   - `claim_due_reconciliations` ;
   - `claim_due_prechecks`, pour l'étape 4b-2 ;
   - `claim_outbox_events` ;
   - `complete_outbox_events`.

   Les politiques sont étroites, un état d'entrée et un état de sortie chacune : `scheduler_retry`,
   `scheduler_reconcile`, `scheduler_precheck`, `relay_read` et `relay_mark`. Les politiques d'UPDATE de
   PostgreSQL se combinent par OU, mais `app_scheduler` est NOLOGIN : seules ces fonctions revues
   s'exécutent avec son identité.

6. **Raison affichée.** `status_reason` est un code (`platform.transient`, `account.reconnect`,
   `retries.exhausted`…). L'API l'expose avec `retryAt`, et le web le traduit (FR/EN), avec un texte
   générique pour un code inconnu.

7. **Contrôle 15 minutes avant l'heure** (4b-2, file `precheck`). `claim_due_prechecks()` marque une
   cible programmée dans les `PRECHECK_LEAD_SECONDS` (900 s) une seule fois (`prechecked_at`), et une
   reprogrammation le relance. Le gestionnaire de la plateforme vérifie le jeton (présent, pas expiré avant
   l'heure), les permissions (si la plateforme en a donné la liste), le média (règles du registre) et le
   quota restant (lu sur la plateforme ; c'est le seul appel réseau, et il ne publie rien).
   - **Bloquant** (`account.not_connected`, `account.reconnect`, `account.permissions`,
     `media.required`, `image.format`…) → `needs_action` **tout de suite**, avec un événement, pendant
     qu'il est encore temps de corriger.
   - **Avertissement** (`quota.exhausted`) → la cible reste programmée, avec la raison. La publication
     attendra et réessaiera comme une erreur de quota.
   - **Pas de réponse** → rien ne change ; la publication fera ses propres vérifications.
   - Une tâche d'un horaire périmé (cible reprogrammée) ne fait rien.
8. **Limiteur Valkey** (4b-2). Ce sont des seaux à jetons pris **atomiquement** par un script Lua avec
   l'horloge de Valkey (`TIME`) : soit tous les niveaux ont un jeton et on en prend un à chacun, soit on
   n'en prend aucun et le script renvoie l'attente du plus lent.
   - Niveaux : `app` (partagé par la plateforme) et `account` (par compte social), chacun avec sa
     fenêtre, ce qui couvre le quota du jour. Les valeurs viennent du **registre de capacités**
     (`rateLimitRules()`, règle 7) et sont sourcées : pour Instagram, 50 publications par compte sur
     24 h glissantes, soit la plus stricte des deux valeurs documentées (50 et 100).
   - Aucun nombre n'est inventé : la doc ne donne pas de limite au niveau de l'application pour la
     publication Instagram, donc pas de seau `app`.
   - Le contrôle a lieu **avant** le passage en `publishing`. Une cible limitée reste `queued` avec le
     même numéro de tentative, sa tâche est retardée du temps demandé (`moveToDelayed`), et la raison
     `platform.rate_limited` s'affiche. Aucune tentative n'est consommée.
   - `RATE_LIMITS_ENABLED` (vrai par défaut) existe seulement pour les tests qui en ont besoin.

## Conséquences

- Une tâche de réconciliation est supprimée dès qu'elle se termine (`removeOnComplete: true`) : après un
  bail expiré, la même vérification peut être redonnée avec le même identifiant.
- Reprogrammer une cible remet à zéro `retry_at`, `status_reason` et `prechecked_at`.
- Le délai d'attente des E2E (`expect`) passe à 10 s : un rechargement complet de page pendant des tests
  axe en parallèle dépasse parfois 5 s sur une machine chargée.
