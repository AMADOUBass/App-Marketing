# ADR 012 — API de programmation et clés d'idempotence

- Statut : accepté
- Date : 2026-11-16
- Tâche : MVP, moteur de publication, étape 4a

## Contexte

Jusqu'ici, seul le script `dev:test-post` créait des cibles de publication. Pour que l'application
programme elle-même, il faut une API. CLAUDE.md impose une clé d'idempotence sur la création de post et
de programmation : un client qui renvoie sa requête après une coupure réseau ne doit pas créer un second
post, ni publier deux fois (règle 6).

## Décision

1. **Routes** (module `scheduling`, propriétaire de `publication_targets`) :
   - `POST /api/v1/posts` (module `content`) crée un post dans un workspace de l'organisation, avec
     `imageUrl` HTTPS facultative (média de la phase 0, en attendant la médiathèque) ;
   - `POST /api/v1/posts/:id/schedule` prend `socialAccountIds` (1 à 20) et `scheduledAt`, en ISO 8601
     **avec décalage horaire** ;
   - `POST /api/v1/publication-targets/:id/cancel` annule une cible ;
   - `GET /api/v1/publication-targets?postId=…` lit les cibles des posts affichés, en une requête.
2. **Frontières de modules (règle 5)** : le module `scheduling` lit les posts par `PostsService` et les
   comptes par `SocialAccountsService`, nouveau service public du module `integrations`. Il n'accède
   jamais à leurs tables. Le web obtient les noms des comptes par `/social-accounts`, pas par une jointure.
3. **Contrôles avant d'écrire.** Toute anomalie donne **422** et la liste `issues` (membre d'extension de
   la RFC 9457), et rien n'est écrit :
   - compte d'un autre workspace que le post ;
   - compte non connecté ;
   - date passée, ou à plus de 365 jours ;
   - post incompatible avec la plateforme, selon `checkDraftForPlatform` de `@ponctua/integrations`.
     Cette fonction est pure et lit le registre de capacités : par exemple, Instagram exige une image sur
     une URL HTTPS publique. Une plateforme sans adaptateur répond `platform.unavailable`.

   Format, poids et ratio du média sont revérifiés par l'adaptateur au moment de publier.

4. **Reprogrammer ou annuler** n'est possible qu'avant la remise à la file d'attente : `draft`,
   `scheduled` ou `cancelled` pour reprogrammer ; `draft`, `scheduled`, `retrying` ou `needs_action` pour
   annuler. Ensuite, **409** : la publication est peut-être déjà sur la plateforme (règle 6). Annuler deux
   fois est sans effet.
5. **Clés d'idempotence** (`Idempotency-Key`, de 8 à 255 caractères imprimables, obligatoire sinon 400) :
   - table `idempotency_keys`, protégée par RLS, unique sur `(organization_id, key)` ;
   - `db.idempotent()` insère la clé **d'abord** (`INSERT … ON CONFLICT DO NOTHING`). Une requête
     concurrente avec la même clé attend la fin de la transaction, puis **rejoue** la réponse
     enregistrée (testé avec 5 requêtes simultanées : un seul post créé) ;
   - le changement métier et la réponse sont écrits dans **la même transaction**. Si la requête échoue
     (404, 409, 422…), rien n'est gardé et la clé peut resservir ;
   - même clé avec une autre requête (autre opération ou autre contenu, par empreinte SHA-256) → **422** ;
   - un rejeu porte l'en-tête `Idempotent-Replayed: true` ;
   - les réponses sont gardées 24 h. Une clé expirée est supprimée quand elle resert ; un nettoyage
     périodique des clés expirées viendra avec les tâches de maintenance du worker.
6. **Web** : chaque post affiche ses cibles (« Instagram · compte · Programmé le … », états en FR/EN, mise
   en évidence des états qui demandent attention) et un bouton « Annuler » pour celles qui ne sont pas
   encore parties. Le composer arrivera avec le calendrier ; d'ici là, on programme par l'API ou par
   `dev:test-post`.

## Conséquences

- Les rôles de workspace (`editor`, `publisher`…) ne sont pas encore appliqués : tout membre de
  l'organisation peut programmer. Ils viendront avec la gestion des membres.
- La fiabilité d'exécution (reprises, réconciliation, contrôle 15 minutes avant l'heure, limiteur,
  outbox) fait l'objet de l'étape 4b (ADR 013).
