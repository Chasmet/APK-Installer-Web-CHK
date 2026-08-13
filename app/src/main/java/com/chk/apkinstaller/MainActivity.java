package com.chk.apkinstaller;

import android.app.Activity;
import android.app.DownloadManager;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
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
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import androidx.core.content.FileProvider;

import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.security.MessageDigest;
import java.util.Locale;

public final class MainActivity extends Activity {
    private static final String URL =
            "https://github.com/Chasmet/Modeliseur-3d/releases/download/v9.2-thin/Modeliseur-3D-V9.2-Thin.apk";
    private static final String FILE_NAME = "Modeliseur-3D-V9.2-Thin.apk";
    private static final long EXPECTED_SIZE = 11_995_051L;
    private static final String EXPECTED_SHA256 =
            "af0f7ed5a01ab822958426ec16422121e2e674350677af9c0f3135e409fae10c";

    private final Handler handler = new Handler(Looper.getMainLooper());
    private ProgressBar progress;
    private TextView status;
    private Button action;
    private long downloadId = -1L;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        buildUi();
    }

    @Override
    protected void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        super.onDestroy();
    }

    private void buildUi() {
        ScrollView scroll = new ScrollView(this);
        scroll.setBackgroundColor(Color.rgb(7, 11, 20));
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(dp(22), dp(30), dp(22), dp(28));
        scroll.addView(root);

        root.addView(text("CHK TOOLS • INSTALLATEUR V3", 13, Color.rgb(56, 189, 248), true));
        TextView title = text("Installer Modeliseur 3D V9.2", 30, Color.WHITE, true);
        title.setPadding(0, dp(16), 0, dp(8));
        root.addView(title);

        root.addView(text(
                "Cette version évite le fichier bloqué de 936 Mo. L'APK principale ne fait qu'environ 12 Mo. Une fois installée, elle télécharge séparément ses moteurs IA avec reprise automatique, puis fonctionne hors ligne.",
                16, Color.rgb(203, 213, 225), false));

        TextView tech = text(
                "V9.2 Thin • SAM XL0 1024 • DA3 392 • grille dense • quadrupède 4 appuis",
                14, Color.rgb(148, 163, 184), false);
        tech.setPadding(0, dp(14), 0, dp(18));
        root.addView(tech);

        progress = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        progress.setMax(1000);
        root.addView(progress, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, dp(18)));

        status = text("Prêt à télécharger les 12 Mo.", 15, Color.rgb(186, 230, 253), false);
        status.setPadding(0, dp(14), 0, dp(16));
        root.addView(status);

        action = new Button(this);
        action.setText("Télécharger et installer V9.2");
        action.setTextSize(16);
        action.setAllCaps(false);
        action.setGravity(Gravity.CENTER);
        action.setTextColor(Color.rgb(3, 17, 29));
        action.setBackgroundColor(Color.rgb(56, 189, 248));
        action.setPadding(dp(12), dp(12), dp(12), dp(12));
        action.setOnClickListener(v -> startDownload());
        root.addView(action);

        TextView instructions = text(
                "Après installation : ouvre Modeliseur 3D, choisis le mode 3D, puis appuie sur « Télécharger / reprendre les IA ». Les gros modèles sont vérifiés par SHA-256 et les données déjà reçues restent conservées en cas de coupure.",
                15, Color.rgb(203, 213, 225), false);
        instructions.setPadding(dp(14), dp(18), dp(14), dp(14));
        root.addView(instructions);
        setContentView(scroll);
    }

    private void startDownload() {
        if (downloadId >= 0L) {
            Toast.makeText(this, "Téléchargement déjà en cours.", Toast.LENGTH_SHORT).show();
            return;
        }
        File directory = getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
        if (directory == null) {
            setStatus("Stockage Android indisponible.");
            return;
        }
        File target = new File(directory, FILE_NAME);
        if (target.isFile() && target.length() == EXPECTED_SIZE) {
            action.setEnabled(false);
            setStatus("APK déjà reçue. Vérification SHA-256…");
            verifyAndInstall(target);
            return;
        }
        if (target.exists()) target.delete();

        DownloadManager manager = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
        if (manager == null) {
            setStatus("Gestionnaire de téléchargement Android indisponible.");
            return;
        }
        try {
            DownloadManager.Request request = new DownloadManager.Request(Uri.parse(URL));
            request.setTitle("Modeliseur 3D V9.2 Thin");
            request.setDescription("APK légère — environ 12 Mo");
            request.setMimeType("application/vnd.android.package-archive");
            request.setAllowedOverMetered(true);
            request.setAllowedOverRoaming(true);
            request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            request.setDestinationInExternalFilesDir(this, Environment.DIRECTORY_DOWNLOADS, FILE_NAME);
            downloadId = manager.enqueue(request);
            action.setEnabled(false);
            progress.setProgress(0);
            setStatus("Téléchargement lancé…");
            poll(manager, target, downloadId);
        } catch (Exception error) {
            downloadId = -1L;
            action.setEnabled(true);
            setStatus("Impossible de lancer le téléchargement : " + shortMessage(error));
        }
    }

    private void poll(DownloadManager manager, File target, long id) {
        handler.postDelayed(() -> {
            if (downloadId != id) return;
            DownloadManager.Query query = new DownloadManager.Query().setFilterById(id);
            try (Cursor cursor = manager.query(query)) {
                if (cursor == null || !cursor.moveToFirst()) {
                    fail("Téléchargement introuvable.");
                    return;
                }
                int state = cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS));
                long done = cursor.getLong(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR));
                long total = cursor.getLong(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_TOTAL_SIZE_BYTES));
                if (state == DownloadManager.STATUS_SUCCESSFUL) {
                    downloadId = -1L;
                    progress.setProgress(1000);
                    setStatus("12 Mo reçus. Vérification SHA-256…");
                    verifyAndInstall(target);
                    return;
                }
                if (state == DownloadManager.STATUS_FAILED) {
                    int reason = cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_REASON));
                    fail("Échec Android DownloadManager (code " + reason + ").");
                    return;
                }
                int value = total > 0L ? (int) Math.min(1000L, done * 1000L / total) : 0;
                progress.setProgress(value);
                setStatus("Téléchargement : " + Math.round(value / 10.0f) + " % • " + formatBytes(done));
                poll(manager, target, id);
            } catch (Exception error) {
                fail("Erreur de suivi : " + shortMessage(error));
            }
        }, 700L);
    }

    private void fail(String message) {
        downloadId = -1L;
        action.setEnabled(true);
        action.setText("Réessayer");
        setStatus(message);
    }

    private void verifyAndInstall(File apk) {
        new Thread(() -> {
            try {
                if (!apk.isFile() || apk.length() != EXPECTED_SIZE) {
                    throw new IllegalStateException("taille APK incorrecte");
                }
                String digest = sha256(apk);
                if (!EXPECTED_SHA256.equalsIgnoreCase(digest)) {
                    apk.delete();
                    throw new IllegalStateException("SHA-256 incorrect, fichier supprimé");
                }
                runOnUiThread(() -> {
                    action.setEnabled(true);
                    setStatus("APK V9.2 vérifiée. Ouverture de l'installation Android…");
                    installApk(apk);
                });
            } catch (Exception error) {
                runOnUiThread(() -> {
                    action.setEnabled(true);
                    action.setText("Retélécharger");
                    setStatus("Vérification échouée : " + shortMessage(error));
                });
            }
        }, "v92-apk-verification").start();
    }

    private void installApk(File apk) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                && !getPackageManager().canRequestPackageInstalls()) {
            Toast.makeText(this, "Autorise APK Installer CHK à installer des applications.", Toast.LENGTH_LONG).show();
            Intent settings = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES);
            settings.setData(Uri.parse("package:" + getPackageName()));
            startActivity(settings);
            return;
        }
        try {
            Uri uri = FileProvider.getUriForFile(this, getPackageName() + ".fileprovider", apk);
            Intent install = new Intent(Intent.ACTION_VIEW);
            install.setDataAndType(uri, "application/vnd.android.package-archive");
            install.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(install);
        } catch (ActivityNotFoundException error) {
            setStatus("Aucun installateur APK Android trouvé.");
        } catch (Exception error) {
            setStatus("Installation impossible : " + shortMessage(error));
        }
    }

    private static String sha256(File file) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        try (InputStream input = new FileInputStream(file)) {
            byte[] buffer = new byte[1024 * 1024];
            int read;
            while ((read = input.read(buffer)) != -1) digest.update(buffer, 0, read);
        }
        StringBuilder value = new StringBuilder(64);
        for (byte b : digest.digest()) value.append(String.format(Locale.US, "%02x", b & 0xff));
        return value.toString();
    }

    private void setStatus(String value) {
        status.setText(value);
    }

    private TextView text(String value, int sp, int color, boolean bold) {
        TextView view = new TextView(this);
        view.setText(value);
        view.setTextSize(sp);
        view.setTextColor(color);
        view.setLineSpacing(0, 1.12f);
        if (bold) view.setTypeface(view.getTypeface(), android.graphics.Typeface.BOLD);
        return view;
    }

    private int dp(int value) {
        return (int) (value * getResources().getDisplayMetrics().density + 0.5f);
    }

    private static String formatBytes(long bytes) {
        return String.format(Locale.FRANCE, "%.1f Mo", bytes / (1024.0 * 1024.0));
    }

    private static String shortMessage(Throwable error) {
        String value = error.getMessage();
        if (value == null || value.trim().isEmpty()) return error.getClass().getSimpleName();
        return value.length() > 140 ? value.substring(0, 137) + "…" : value;
    }
}
