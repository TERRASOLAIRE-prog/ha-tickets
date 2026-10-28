# Tickets Board — add-on Home Assistant façon Monday

Outil de gestion de tickets intégré à Home Assistant OS (panneau **Tickets** dans la barre latérale) :

- **Tableaux** multiples, **groupes** colorés repliables, **éléments** (tickets) glisser-déposer entre groupes
- **Colonnes personnalisables** : Texte, Nombre (avec unité + somme), Statut, Liste déroulante, Date (retard en rouge), Personne (personnes HA proposées automatiquement), Case à cocher, Lien, **Photo** (prise directe avec l'appareil photo du téléphone via l'app Companion)
- Réordonner (glisser l'en-tête), redimensionner (bord de l'en-tête), renommer, configurer les étiquettes et couleurs
- Fiche détaillée de chaque élément avec **mises à jour** (commentaires signés avec votre utilisateur HA)
- Recherche, filtre par personne, export CSV, duplication de tableau, mode sombre
- **Automatisations** simples « QUAND … SI … ALORS … » avec recettes rapides et historique

## Installation depuis GitHub (recommandé)

1. Créez un dépôt **public** sur GitHub (ex. `ha-tickets`) et placez à sa racine :
   `repository.yaml`, `README.md` et le dossier `ha_tickets/`.
2. Dans HA : **Paramètres → Modules complémentaires → Boutique → ⋮ → Dépôts**,
   collez `https://github.com/<votre-compte>/ha-tickets` puis **Ajouter**.
3. Rechargez la boutique : **Tickets Board** apparaît → **Installer** (construction 1 à 3 min).
4. Activez **Afficher dans la barre latérale**, puis **Démarrer**.

**Mise à jour :** modifiez les fichiers sur GitHub en augmentant `version` dans `ha_tickets/config.yaml`,
puis dans la boutique ⋮ → **Rechercher des mises à jour** → bouton **Mettre à jour** sur l'add-on.

## Installation en local (sans GitHub)

Copiez le dossier `ha_tickets` dans le partage `addons` (Samba / SSH), puis Boutique → ⋮ →
**Rechercher des mises à jour** → section **Modules complémentaires locaux**.

Les données (base SQLite + photos) sont stockées dans `/data` de l'add-on et sont incluses dans les sauvegardes HA.

## Automatisations

| QUAND (déclencheur) | SI (conditions, optionnel) | ALORS (actions) |
|---|---|---|
| Un élément est créé | Colonne est / n'est pas / est vide / n'est pas vide / contient | Modifier une colonne (dates : `today`, `+3`…) |
| Une colonne change (vers une valeur ou n'importe laquelle) | Groupe est / n'est pas | Déplacer vers un groupe |
| Un élément est déplacé vers un groupe | | Notification téléphone (`notify.mobile_app_…`) |
| Une date arrive (X jours avant/après, à une heure donnée) | | Notification persistante HA |
| | | Appeler n'importe quel service HA (JSON) |
| | | Déclencher un événement HA (`ha_tickets`) |
| | | Ajouter un commentaire, dupliquer, supprimer |

**Variables** dans les textes : `{item}`, `{groupe}`, `{tableau}`, `{date}`, `{id}` et `{Nom de colonne}` (ex. `{Statut}`, `{Responsable}`).

### Réagir dans Home Assistant

L'action « Déclencher un événement HA » permet d'utiliser vos tickets dans les automatisations HA classiques :

```yaml
triggers:
  - trigger: event
    event_type: ha_tickets
    event_data:
      board: Travaux maison
actions:
  - action: light.turn_on
    target: { entity_id: light.bureau }
```

Données disponibles : `item`, `item_id`, `board`, `group`, `automation`, `values` (dictionnaire Nom de colonne → valeur affichée).

## Développement local

```bash
pip install aiohttp
DATA_DIR=./data TICKETS_DEV=1 python3 ha_tickets/app/server.py   # http://localhost:8099
```
