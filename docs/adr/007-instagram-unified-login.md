# ADR 007 — Instagram : « Instagram API with Unified Login »

- Statut : accepté
- Date : 2026-11-13
- Tâche : phase 0, 0.9 (partie b)

## Contexte

CLAUDE.md prévoyait « OAuth (Instagram Login) ». En créant l'application Meta (Amadoo), le tableau de bord
propose deux parcours : « API setup with Unified login » et « API setup with Instagram login ». La
documentation officielle (vérifiée le 2026-11-13) indique :

- « The Instagram API with Unified Login is the recommended setup for new integrations. »
- « New Instagram API features are released only for this setup. »
- Le client se connecte avec Instagram **ou** Facebook, sans Page Facebook.
- L'application doit appartenir à un **portefeuille d'entreprise** (Business portfolio).
- Le jeton obtenu est un « Business Integration System User Access Token » : il appartient au portefeuille
  du client, pas à la personne connectée, et survit au départ de cette personne. Le tableau de bord affiche
  « Expiration : Never (system-user token) ».
- Les appels passent par `graph.facebook.com` (v27.0), et non `graph.instagram.com`.

## Décision

1. Utiliser **Instagram API with Unified Login** pour Instagram (`packages/integrations`).
2. **Moindre privilège** : la configuration ne demandera que `instagram_basic` et
   `instagram_content_publish`. Jamais `ads_management` / `ads_read` (gestion publicitaire hors périmètre).
   La configuration par défaut de Meta les inclut : il faudra les retirer (« Edit permissions »).
3. Jeton stocké dans le coffre (ADR 006) avec l'id du portefeuille client, les ids des comptes Instagram et le
   `config_id`, comme le recommande la doc. Pas de rafraîchissement automatique (pas d'expiration) ; un jeton
   devenu invalide (application retirée du portefeuille, compte déplacé) → erreur `auth` → `needs_action`,
   reconnexion du client, pas de nouvel essai.
4. Toutes les limites viennent du registre de capacités, avec source et date. La doc se contredit sur la
   limite de publication (100 vs « currently 50 ») : on lit toujours `content_publishing_limit` avant de
   publier, et à défaut on prend la plus basse.
5. Réconciliation par le statut du conteneur : `PUBLISHED` confirme la publication ; on ne republie jamais à
   l'aveugle après `unknown_outcome`.

## Conséquences

- Il faut un portefeuille d'entreprise (gratuit) dès les tests ; la Business Verification reste nécessaire pour
  passer en Live et accueillir d'autres clients (App Review, accès avancé).
- L'URL de redirection doit être en HTTPS : en local, il faudra un tunnel HTTPS en 9c.
- À confirmer sur le compte réel (9c) : paramètres exacts de la boîte de dialogue de connexion (format
  Facebook Login for Business supposé), champs de `/me/assigned_instagram_accounts`, possibilité de retirer
  `instagram_manage_messages` (marquée requise par défaut).
- Les fixtures de test sont issues de la documentation et marquées comme telles ; elles seront remplacées par
  des réponses enregistrées.
