package com.chk.apkinstaller;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
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
import java.io.FileOutputStream;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

public class MainActivity extends Activity {
    private static final int REQUEST_PICK_FILE = 1001;

    private LinearLayout root;
    private LinearLayout listContainer;
    private TextView statusView;
    private final List<File> preparedApks = new ArrayList<>();

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        buildUi();
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

        TextView title = text("APK Installer CHK", 32, Color.WHITE, true);
        title.setPadding(0, dp(16), 0, dp(6));
        root.addView(title);

        TextView intro = text(
                "Choisis une APK ou un ZIP contenant plusieurs APK. L'application prépare les fichiers, puis Android te demandera de valider l'installation manuellement.",
                16,
                Color.rgb(203, 213, 225),
                false
        );
        root.addView(intro);

        addSpace(16);

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

    private void addInfoBlock() {
        addSpace(14);
        TextView info = text(
                "Mode d'emploi :\n\n1. Appuie sur Choisir APK ou ZIP.\n2. Sélectionne ton fichier.\n3. Appuie sur Installer pour l'APK détectée.\n4. Si Android bloque, autorise cette application comme source.\n5. Valide Installer dans Android.",
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
        if (requestCode == REQUEST_PICK_FILE && resultCode == RESULT_OK && data != null && data.getData() != null) {
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
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !getPackageManager().canRequestPackageInstalls()) {
            Toast.makeText(this, "Autorise d'abord cette application à installer des APK.", Toast.LENGTH_LONG).show();
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
            Toast.makeText(this, "Impossible de lancer l'installation : " + e.getMessage(), Toast.LENGTH_LONG).show();
        }
    }

    private void openInstallPermissionSettings() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Intent intent = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES);
            intent.setData(Uri.parse("package:" + getPackageName()));
            startActivity(intent);
        } else {
            Toast.makeText(this, "Sur cette version Android, l'autorisation se règle dans Sécurité.", Toast.LENGTH_LONG).show();
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

        try (ZipInputStream zipInput = new ZipInputStream(new java.io.FileInputStream(zipFile))) {
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
        return String.format(Locale.FRANCE, "%.1f Go", gb);
    }
}
