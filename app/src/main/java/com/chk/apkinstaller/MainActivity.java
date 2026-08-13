package com.chk.apkinstaller;

import android.app.Activity;
import android.app.DownloadManager;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import androidx.core.content.FileProvider;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

public class MainActivity extends Activity {
    private static final int REQUEST_PICK_FILE = 1001;

    private static final String MODELISEUR_URL =
            "https://github.com/Chasmet/Modeliseur-3d/releases/download/v9.1-risk/Modeliseur-3D-V9.1-Risk-SAM-XL0-DA3-392.apk";
    private static final String MODELISEUR_FILE =
            "Modeliseur-3D-V9.1-Risk-SAM-XL0-DA3-392.apk";
    private static final long MODELISEUR_SIZE = 936057609L;
    private static final String MODELISEUR_SHA256 =
            "9f9d2b3c40b000ddadd5d632259ab0e3ffee2390cf48ff8072961b5329b5fe81";

    private LinearLayout root;
    private LinearLayout listContainer;
    private TextView statusView;
    private TextView modelerProgressView;
    private Button modelerButton;
    private final List<File> preparedApks = new ArrayList<>();
    private final Handler handler = new Handler(Looper.getMainLooper());
    private long activeDownloadId = -1L;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        buildUi();
    }

    @Override
    protected void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        super.onDestroy();
    }

    private void buildUi() {
        ScrollView scrollView = new ScrollView(this);
        scrollView.setBackgroundColor(Color.rgb(7, 11, 20));

        root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(dp(18), dp(22), dp(18), dp(22));
        scrollView.addView(root);

        TextView badge = text("CHK Tools", 13, Color.rgb(186, 230, 253), true);
        badge.setPadding(dp(12), dp(7), dp(12), dp(7));
        root.addView(badge);

        TextView title = text("APK Installer CHK v2", 32, Color.WHITE, true);
        title.setPadding(0, dp(16), 0, dp(6));
        root.addView(title);

        TextView intro = text(
                "Télécharge et installe les grosses APK sans passer par Chrome. Le téléchargement continue via Android, puis le fichier est vérifié avant installation.",
                16,
                Color.rgb(203, 213, 225),
                false
        );
        root.addView(intro);

        addSpace(18);
        addModelerBlock();
        addSpace(22);

        TextView manualTitle = text("Installation manuelle", 20, Color.WHITE, true);
        manualTitle.setPadding(0, 0, 0, dp(8));
        root.addView(manualTitle);

        Button chooseButton = mainButton("Choisir APK ou ZIP");
        chooseButton.setOnClickListener(v -> openFilePicker());
        root.addView(chooseButton);

        Button permissionButton = secondaryButton("Autoriser installation depuis cette application");
        permissionButton.setOnClickListener(v -> openInstallPermissionSettings());
        root.addView(permissionButton);

        statusView = text("Aucun fichier sélectionné.", 15, Color.rgb(148, 163, 184), false);
        statusView.setPadding(0, dp(14), 0, dp(14));
        root.addView(statusView);

        listContainer = new LinearLayout(this);
        listContainer.setOrientation(LinearLayout.VERTICAL);
        root.addView(listContainer);

        addInfoBlock();
        setContentView(scrollView);
    }

    private void addModelerBlock() {
        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setPadding(dp(16), dp(16), dp(16), dp(16));
        card.setBackgroundColor(Color.rgb(17, 24, 39));

        TextView title = text("Modeliseur 3D V9.1 Risk", 21, Color.WHITE, true);
        card.addView(title);

        TextView meta = text(
                "936 Mo • SAM XL0 1024 • DA3 392 • grille 3D dense • quadrupède 4 appuis",
                14,
                Color.rgb(148, 163, 184),
                false
        );
        meta.setPadding(0, dp(6), 0, dp(12));
        card.addView(meta);

        modelerButton = mainButton("Télécharger et installer Modeliseur V9.1");
        modelerButton.setOnClickListener(v -> startModelerDownload());
        card.addView(modelerButton);

        modelerProgressView = text(
                "Prêt. Le téléchargement utilisera le gestionnaire Android natif.",
                14,
                Color.rgb(186, 230, 253),
                false
        );
        modelerProgressView.setPadding(0, dp(12), 0, 0);
        card.addView(modelerProgressView);

        root.addView(card);
    }

    private void startModelerDownload() {
        if (activeDownloadId >= 0L) {
            Toast.makeText(this, "Un téléchargement est déjà en cours.", Toast.LENGTH_SHORT).show();
            return;
        }

        File directory = getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
        if (directory == null) {
            setModelerStatus("Stockage Android indisponible.");
            return;
        }
        File target = new File(directory, MODELISEUR_FILE);

        if (target.isFile() && target.length() == MODELISEUR_SIZE) {
            modelerButton.setEnabled(false);
            setModelerStatus("APK déjà présente. Vérification SHA-256…");
            verifyModelerAndInstall(target);
            return;
        }

        if (target.exists() && !target.delete()) {
            setModelerStatus("Impossible de supprimer l'ancien téléchargement incomplet.");
            return;
        }

        try {
            DownloadManager manager = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
            if (manager == null) {
                setModelerStatus("Gestionnaire de téléchargement Android indisponible.");
                return;
            }

            DownloadManager.Request request = new DownloadManager.Request(Uri.parse(MODELISEUR_URL));
            request.setTitle("Modeliseur 3D V9.1");
            request.setDescription("Téléchargement de l'APK complète — 936 Mo");
            request.setMimeType("application/vnd.android.package-archive");
            request.setAllowedOverMetered(true);
            request.setAllowedOverRoaming(true);
            request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            request.setDestinationInExternalFilesDir(
                    this,
                    Environment.DIRECTORY_DOWNLOADS,
                    MODELISEUR_FILE
            );

            activeDownloadId = manager.enqueue(request);
            modelerButton.setEnabled(false);
            setModelerStatus("Téléchargement lancé… 0 %");
            pollDownload(manager, activeDownloadId, target);
        } catch (Exception error) {
            activeDownloadId = -1L;
            modelerButton.setEnabled(true);
            setModelerStatus("Impossible de lancer le téléchargement : " + shortMessage(error));
        }
    }

    private void pollDownload(DownloadManager manager, long downloadId, File target) {
        handler.postDelayed(() -> {
            if (activeDownloadId != downloadId) {
                return;
            }

            DownloadManager.Query query = new DownloadManager.Query();
            query.setFilterById(downloadId);
            try (Cursor cursor = manager.query(query)) {
                if (cursor == null || !cursor.moveToFirst()) {
                    failModelerDownload("Téléchargement introuvable.");
                    return;
                }

                int status = cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS));
                long done = cursor.getLong(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR));
                long total = cursor.getLong(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_TOTAL_SIZE_BYTES));

                if (status == DownloadManager.STATUS_SUCCESSFUL) {
                    activeDownloadId = -1L;
                    setModelerStatus("936 Mo reçus. Vérification SHA-256 en cours…");
                    verifyModelerAndInstall(target);
                    return;
                }

                if (status == DownloadManager.STATUS_FAILED) {
                    int reason = cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_REASON));
                    failModelerDownload("Échec du téléchargement Android (code " + reason + ").");
                    return;
                }

                int percent = total > 0L
                        ? (int) Math.min(100L, (done * 100L) / total)
                        : 0;
                setModelerStatus(
                        "Téléchargement : " + percent + " % • "
                                + formatBytes(done) + " / "
                                + (total > 0L ? formatBytes(total) : "936 Mo")
                );
                pollDownload(manager, downloadId, target);
            } catch (Exception error) {
                failModelerDownload("Erreur de suivi : " + shortMessage(error));
            }
        }, 900L);
    }

    private void failModelerDownload(String message) {
        activeDownloadId = -1L;
        modelerButton.setEnabled(true);
        setModelerStatus(message + " Tu peux relancer sans passer par Chrome.");
    }

    private void verifyModelerAndInstall(File apk) {
        new Thread(() -> {
            try {
                if (!apk.isFile()) {
                    throw new Exception("APK absente après téléchargement");
                }
                if (apk.length() != MODELISEUR_SIZE) {
                    throw new Exception(
                            "taille incorrecte : " + apk.length() + " au lieu de " + MODELISEUR_SIZE
                    );
                }

                String digest = sha256(apk);
                if (!MODELISEUR_SHA256.equalsIgnoreCase(digest)) {
                    apk.delete();
                    throw new Exception("SHA-256 incorrect : fichier supprimé");
                }

                runOnUiThread(() -> {
                    modelerButton.setEnabled(true);
                    setModelerStatus("APK vérifiée à 100 %. Ouverture de l'installation Android…");
                    installApk(apk);
                });
            } catch (Exception error) {
                runOnUiThread(() -> {
                    modelerButton.setEnabled(true);
                    setModelerStatus("Vérification échouée : " + shortMessage(error));
                });
            }
        }, "modeliseur-sha256").start();
    }

    private String sha256(File file) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        try (InputStream input = new FileInputStream(file)) {
            byte[] buffer = new byte[1024 * 1024];
            int read;
            while ((read = input.read(buffer)) != -1) {
                digest.update(buffer, 0, read);
            }
        }
        StringBuilder result = new StringBuilder(64);
        for (byte value : digest.digest()) {
            result.append(String.format(Locale.US, "%02x", value & 0xff));
        }
        return result.toString();
    }

    private void setModelerStatus(String message) {
        modelerProgressView.setText(message);
    }

    private void addInfoBlock() {
        addSpace(14);
        TextView info = text(
                "Mode d'emploi :\n\n1. Pour Modeliseur V9.1, utilise le gros bouton en haut.\n2. Laisse Android télécharger les 936 Mo.\n3. L'application vérifie automatiquement la taille et le SHA-256.\n4. Android ouvre ensuite son écran officiel d'installation.\n5. Si demandé, autorise APK Installer CHK comme source d'installation.",
                15,
                Color.rgb(203, 213, 225),
                false
        );
        info.setBackgroundColor(Color.rgb(17, 24, 39));
        info.setPadding(dp(14), dp(14), dp(14), dp(14));
        root.addView(info);
    }

    private void openFilePicker() {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("*/*");
        intent.putExtra(Intent.EXTRA_MIME_TYPES, new String[]{
                "application/vnd.android.package-archive",
                "application/zip",
                "application/octet-stream"
        });
        startActivityForResult(intent, REQUEST_PICK_FILE);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQUEST_PICK_FILE
                && resultCode == RESULT_OK
                && data != null
                && data.getData() != null) {
            handleSelectedUri(data.getData());
        }
    }

    private void handleSelectedUri(Uri uri) {
        clearPreparedFiles();
        listContainer.removeAllViews();
        setStatus("Analyse du fichier en cours...");

        try {
            String fileName = getFileName(uri);
            File source = copyUriToCache(uri, fileName);
            String lower = source.getName().toLowerCase(Locale.FRANCE);

            if (lower.endsWith(".apk")) {
                preparedApks.add(source);
            } else if (lower.endsWith(".zip")) {
                preparedApks.addAll(extractApksFromZip(source));
            } else {
                setStatus("Format non reconnu. Choisis un fichier .apk ou .zip.");
                return;
            }

            if (preparedApks.isEmpty()) {
                setStatus("Aucune APK trouvée dans ce fichier.");
                return;
            }

            setStatus(preparedApks.size() + " APK prête(s). Appuie sur Installer, puis valide dans Android.");
            renderApkList();
        } catch (Exception e) {
            setStatus("Erreur : " + e.getMessage());
            Toast.makeText(this, "Erreur pendant l'analyse", Toast.LENGTH_LONG).show();
        }
    }

    private void renderApkList() {
        listContainer.removeAllViews();
        for (int i = 0; i < preparedApks.size(); i++) {
            File apk = preparedApks.get(i);
            LinearLayout card = new LinearLayout(this);
            card.setOrientation(LinearLayout.VERTICAL);
            card.setPadding(dp(14), dp(14), dp(14), dp(14));
            card.setBackgroundColor(Color.rgb(17, 24, 39));

            TextView name = text((i + 1) + ". " + apk.getName(), 17, Color.WHITE, true);
            card.addView(name);

            TextView meta = text(formatBytes(apk.length()), 14, Color.rgb(148, 163, 184), false);
            meta.setPadding(0, dp(6), 0, dp(10));
            card.addView(meta);

            Button installButton = mainButton("Installer cette APK");
            installButton.setOnClickListener(v -> installApk(apk));
            card.addView(installButton);

            LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT,
                    LinearLayout.LayoutParams.WRAP_CONTENT
            );
            params.setMargins(0, 0, 0, dp(12));
            listContainer.addView(card, params);
        }
    }

    private void installApk(File apk) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                && !getPackageManager().canRequestPackageInstalls()) {
            Toast.makeText(
                    this,
                    "Autorise d'abord APK Installer CHK à installer des APK.",
                    Toast.LENGTH_LONG
            ).show();
            openInstallPermissionSettings();
            return;
        }

        try {
            Uri apkUri = FileProvider.getUriForFile(
                    this,
                    getPackageName() + ".fileprovider",
                    apk
            );

            Intent intent = new Intent(Intent.ACTION_VIEW);
            intent.setDataAndType(apkUri, "application/vnd.android.package-archive");
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(intent);
        } catch (ActivityNotFoundException e) {
            Toast.makeText(this, "Aucun installateur APK trouvé sur ce téléphone.", Toast.LENGTH_LONG).show();
        } catch (Exception e) {
            Toast.makeText(
                    this,
                    "Impossible de lancer l'installation : " + e.getMessage(),
                    Toast.LENGTH_LONG
            ).show();
        }
    }

    private void openInstallPermissionSettings() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Intent intent = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES);
            intent.setData(Uri.parse("package:" + getPackageName()));
            startActivity(intent);
        } else {
            Toast.makeText(
                    this,
                    "Sur cette version Android, l'autorisation se règle dans Sécurité.",
                    Toast.LENGTH_LONG
            ).show();
        }
    }

    private File copyUriToCache(Uri uri, String fileName) throws Exception {
        File target = new File(getCacheDir(), safeName(fileName));
        try (InputStream input = getContentResolver().openInputStream(uri);
             FileOutputStream output = new FileOutputStream(target)) {
            if (input == null) throw new Exception("Fichier impossible à ouvrir");
            byte[] buffer = new byte[8192];
            int read;
            while ((read = input.read(buffer)) != -1) {
                output.write(buffer, 0, read);
            }
        }
        return target;
    }

    private List<File> extractApksFromZip(File zipFile) throws Exception {
        List<File> result = new ArrayList<>();
        File outputDir = new File(getCacheDir(), "extracted_apks");
        if (!outputDir.exists() && !outputDir.mkdirs()) {
            throw new Exception("Impossible de créer le dossier temporaire");
        }

        try (ZipInputStream zipInput = new ZipInputStream(new FileInputStream(zipFile))) {
            ZipEntry entry;
            byte[] buffer = new byte[8192];

            while ((entry = zipInput.getNextEntry()) != null) {
                if (entry.isDirectory()) continue;
                String name = safeName(new File(entry.getName()).getName());
                if (!name.toLowerCase(Locale.FRANCE).endsWith(".apk")) continue;

                File out = new File(outputDir, name);
                try (FileOutputStream output = new FileOutputStream(out)) {
                    int read;
                    while ((read = zipInput.read(buffer)) != -1) {
                        output.write(buffer, 0, read);
                    }
                }
                result.add(out);
                zipInput.closeEntry();
            }
        }
        return result;
    }

    private String getFileName(Uri uri) {
        String last = uri.getLastPathSegment();
        if (last == null || last.trim().isEmpty()) return "fichier.apk";
        int slash = last.lastIndexOf('/');
        if (slash >= 0 && slash < last.length() - 1) last = last.substring(slash + 1);
        int colon = last.lastIndexOf(':');
        if (colon >= 0 && colon < last.length() - 1) last = last.substring(colon + 1);
        return safeName(last);
    }

    private String safeName(String name) {
        if (name == null || name.trim().isEmpty()) return "fichier.apk";
        return name.replaceAll("[^a-zA-Z0-9._-]", "_");
    }

    private void clearPreparedFiles() {
        preparedApks.clear();
        deleteRecursive(new File(getCacheDir(), "extracted_apks"));
    }

    private void deleteRecursive(File file) {
        if (file == null || !file.exists()) return;
        if (file.isDirectory()) {
            File[] children = file.listFiles();
            if (children != null) {
                for (File child : children) deleteRecursive(child);
            }
        }
        file.delete();
    }

    private void setStatus(String message) {
        statusView.setText(message);
    }

    private TextView text(String value, int sp, int color, boolean bold) {
        TextView tv = new TextView(this);
        tv.setText(value);
        tv.setTextSize(sp);
        tv.setTextColor(color);
        tv.setLineSpacing(0, 1.12f);
        if (bold) tv.setTypeface(tv.getTypeface(), android.graphics.Typeface.BOLD);
        return tv;
    }

    private Button mainButton(String label) {
        Button button = new Button(this);
        button.setText(label);
        button.setTextColor(Color.rgb(3, 17, 29));
        button.setTextSize(15);
        button.setTypeface(button.getTypeface(), android.graphics.Typeface.BOLD);
        button.setAllCaps(false);
        button.setGravity(Gravity.CENTER);
        button.setBackgroundColor(Color.rgb(14, 165, 233));
        button.setPadding(dp(10), dp(10), dp(10), dp(10));
        return button;
    }

    private Button secondaryButton(String label) {
        Button button = mainButton(label);
        button.setTextColor(Color.WHITE);
        button.setBackgroundColor(Color.rgb(31, 41, 55));
        return button;
    }

    private void addSpace(int dpValue) {
        View view = new View(this);
        root.addView(view, new LinearLayout.LayoutParams(1, dp(dpValue)));
    }

    private int dp(int value) {
        return (int) (value * getResources().getDisplayMetrics().density + 0.5f);
    }

    private String formatBytes(long bytes) {
        if (bytes < 1024) return bytes + " o";
        double kb = bytes / 1024.0;
        if (kb < 1024) return String.format(Locale.FRANCE, "%.1f Ko", kb);
        double mb = kb / 1024.0;
        if (mb < 1024) return String.format(Locale.FRANCE, "%.1f Mo", mb);
        double gb = mb / 1024.0;
        return String.format(Locale.FRANCE, "%.2f Go", gb);
    }

    private String shortMessage(Throwable error) {
        String message = error.getMessage();
        if (message == null || message.trim().isEmpty()) {
            return error.getClass().getSimpleName();
        }
        return message.length() > 160 ? message.substring(0, 157) + "…" : message;
    }
}
