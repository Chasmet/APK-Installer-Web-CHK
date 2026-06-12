const fileInput = document.getElementById('fileInput');
const resetButton = document.getElementById('resetButton');
const statusBox = document.getElementById('statusBox');
const resultsCard = document.getElementById('resultsCard');
const apkList = document.getElementById('apkList');
const apkCount = document.getElementById('apkCount');
const template = document.getElementById('apkItemTemplate');
const installPwaButton = document.getElementById('installPwaButton');

let objectUrls = [];
let deferredInstallPrompt = null;

const APK_MIME = 'application/vnd.android.package-archive';

function setStatus(message, type = '') {
  if (!message) {
    statusBox.innerHTML = '';
    return;
  }

  const div = document.createElement('div');
  div.className = `status ${type}`.trim();
  div.textContent = message;
  statusBox.replaceChildren(div);
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return 'taille inconnue';
  const units = ['o', 'Ko', 'Mo', 'Go'];
  let size = bytes;
  let unit = 0;

  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }

  return `${size.toFixed(size >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function revokeObjectUrls() {
  objectUrls.forEach((url) => URL.revokeObjectURL(url));
  objectUrls = [];
}

function resetUI() {
  revokeObjectUrls();
  fileInput.value = '';
  apkList.innerHTML = '';
  apkCount.textContent = '0';
  resultsCard.hidden = true;
  setStatus('');
}

function saveLastAction(name, count) {
  const payload = {
    fileName: name,
    apkCount: count,
    date: new Date().toISOString(),
  };
  localStorage.setItem('apkInstallerChk:lastAction', JSON.stringify(payload));
}

function renderApks(apks) {
  apkList.innerHTML = '';
  apkCount.textContent = String(apks.length);
  resultsCard.hidden = apks.length === 0;

  apks.forEach((apk, index) => {
    const item = template.content.cloneNode(true);
    const article = item.querySelector('.apk-item');
    const name = item.querySelector('.apk-name');
    const meta = item.querySelector('.apk-meta');
    const link = item.querySelector('.install-link');
    const copyButton = item.querySelector('.copy-name');

    name.textContent = apk.name;
    meta.textContent = `APK ${index + 1} - ${formatBytes(apk.size)}`;
    link.href = apk.url;
    link.download = apk.name.endsWith('.apk') ? apk.name : `${apk.name}.apk`;

    link.addEventListener('click', () => {
      setStatus('Téléchargement lancé. Ouvre le fichier APK téléchargé puis valide Installer dans Android.', 'success');
    });

    copyButton.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(apk.name);
        setStatus(`Nom copié : ${apk.name}`, 'success');
      } catch {
        setStatus('Impossible de copier le nom automatiquement sur ce navigateur.', 'error');
      }
    });

    article.dataset.apkName = apk.name;
    apkList.appendChild(item);
  });
}

function buildApkFromFile(file) {
  const blob = file.type === APK_MIME ? file : file.slice(0, file.size, APK_MIME);
  const url = URL.createObjectURL(blob);
  objectUrls.push(url);
  return {
    name: file.name,
    size: file.size,
    url,
  };
}

async function buildApksFromZip(file) {
  if (!window.JSZip) {
    throw new Error('La librairie ZIP n’est pas chargée. Vérifie ta connexion internet et recharge la page.');
  }

  const zip = await JSZip.loadAsync(file);
  const entries = Object.values(zip.files).filter((entry) => {
    return !entry.dir && entry.name.toLowerCase().endsWith('.apk');
  });

  if (entries.length === 0) {
    return [];
  }

  const apks = [];

  for (const entry of entries) {
    const blob = await entry.async('blob');
    const apkBlob = blob.type === APK_MIME ? blob : blob.slice(0, blob.size, APK_MIME);
    const url = URL.createObjectURL(apkBlob);
    objectUrls.push(url);
    const cleanName = entry.name.split('/').pop() || entry.name;
    apks.push({
      name: cleanName,
      size: apkBlob.size,
      url,
    });
  }

  return apks;
}

async function handleFile(file) {
  resetUI();

  if (!file) return;

  const fileName = file.name.toLowerCase();
  setStatus(`Analyse du fichier : ${file.name}`, 'loading');

  try {
    let apks = [];

    if (fileName.endsWith('.apk')) {
      apks = [buildApkFromFile(file)];
    } else if (fileName.endsWith('.zip')) {
      apks = await buildApksFromZip(file);
    } else {
      setStatus('Format non reconnu. Utilise un fichier .apk ou .zip.', 'error');
      return;
    }

    if (apks.length === 0) {
      setStatus('Aucune APK trouvée dans ce fichier.', 'error');
      return;
    }

    renderApks(apks);
    saveLastAction(file.name, apks.length);
    setStatus(`${apks.length} APK prête${apks.length > 1 ? 's' : ''}. Appuie sur Télécharger / ouvrir, puis valide l’installation dans Android.`, 'success');
  } catch (error) {
    console.error(error);
    setStatus(error.message || 'Erreur pendant l’analyse du fichier.', 'error');
  }
}

fileInput.addEventListener('change', (event) => {
  const file = event.target.files?.[0];
  handleFile(file);
});

resetButton.addEventListener('click', resetUI);

window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  deferredInstallPrompt = event;
  installPwaButton.hidden = false;
});

installPwaButton.addEventListener('click', async () => {
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
  installPwaButton.hidden = true;
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {
      // L'application continue sans service worker si le navigateur bloque l'enregistrement.
    });
  });
}
