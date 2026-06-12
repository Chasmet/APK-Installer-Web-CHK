# APK Installer Web CHK

Application web personnelle pour préparer l'installation manuelle de fichiers APK depuis Android.

## Fonctionnalités

- Sélection d'un fichier `.apk`
- Sélection d'un fichier `.zip` contenant plusieurs APK
- Détection automatique des APK présentes dans un ZIP
- Bouton **Télécharger / ouvrir** pour chaque APK détectée
- Interface mobile pensée pour Android
- Mode PWA installable sur l'écran d'accueil
- Fonctionne sans Render, sans serveur, sans backend

## Limite Android obligatoire

Une application web ne peut pas installer une APK en silence.

Le fonctionnement réel est :

```txt
Choisir APK ou ZIP
↓
La web app prépare le fichier
↓
Appuyer sur Télécharger / ouvrir
↓
Android affiche l'écran officiel d'installation
↓
Valider manuellement Installer
```

C'est normal : Android bloque les installations automatiques pour protéger le téléphone.

## Activer GitHub Pages

1. Ouvrir le dépôt GitHub.
2. Aller dans **Settings**.
3. Aller dans **Pages**.
4. Dans **Build and deployment**, choisir :
   - Source : **Deploy from a branch**
   - Branch : **main**
   - Folder : **/root**
5. Cliquer sur **Save**.

Le site sera ensuite disponible ici :

```txt
https://chasmet.github.io/APK-Installer-Web-CHK/
```

## Installation sur téléphone

1. Ouvrir le lien GitHub Pages sur Android.
2. Appuyer sur **Choisir une APK ou un ZIP**.
3. Sélectionner le fichier.
4. Appuyer sur **Télécharger / ouvrir**.
5. Ouvrir le fichier téléchargé si Android ne l'ouvre pas directement.
6. Autoriser l'installation depuis Chrome si demandé.
7. Appuyer sur **Installer**.

## Formats acceptés

- `.apk`
- `.zip` contenant une ou plusieurs APK simples

Les formats `.apks`, `.xapk`, `.apkm` peuvent nécessiter une vraie application Android native ou un installateur spécialisé de split APK.
