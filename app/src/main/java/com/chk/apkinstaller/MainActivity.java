package com.chk.apkinstaller;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.Settings;
import android.view.Gravity;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import androidx.core.content.FileProvider;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.util.Locale;

public final class MainActivity extends Activity {
    private static final String URL =
            "https://github.com/Chasmet/Modeliseur-3d/releases/download/v9.2-thin/Modeliseur-3D-V9.2-Thin.apk";
    private static final String FILE_NAME = "Modeliseur-3D-V9.4-Memory-Safe-Thin.apk";
    private static final long EXPECTED_SIZE = 11_999_147L;
    private static final String EXPECTED_SHA256 =
            "83a72a7fdf7e26c698c80fbd06d5e334b42c209eb1333e2f5576f1aabeb36de7";
    private static final int BUFFER_SIZE = 256 * 1024;

    private ProgressBar progress;
    private TextView status;
    private Button action;
    private volatile boolean downloading;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        buildUi();
    }

    private void buildUi() {
        ScrollView scroll = new ScrollView(this);
        scroll.setBackgroundColor(Color.rgb(7, 11, 20));
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(dp(22), dp(30), dp(22), dp(28));
        scroll.addView(root);

        root.addView(text("CHK TOOLS • INSTALLATEUR V3.3", 13, Color.rgb(56, 189, 248), true));
        TextView title = text("Installer Modeliseur 3D V9.4", 30, Color.WHITE, true);
        title.setPadding(0, dp(16), 0, dp(8));
        root.addView(title);

        root.addView(text(
                "Téléchargement HTTPS direct intégré : plus de dépendance au DownloadManager Android. Reprise automatique, progression réelle et contrôle SHA-256.",
                16, Color.rgb(203, 213, 225), false));

        TextView tech = text(
                "V9.4 Memory-Safe • SAM XL0 1024 • 1 encodage lourd par vue • DA3 392 • grille dense",
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
        action.setText("Télécharger et installer V9.4");
        action.setTextSize(16);
        action.setAllCaps(false);
        action.setGravity(Gravity.CENTER);
        action.setTextColor(Color.rgb(3, 17, 29));
        action.setBackgroundColor(Color.rgb(56, 189, 248));
        action.setPadding(dp(12), dp(12), dp(12), dp(12));
        action.setOnClickListener(v -> startDownload());
        root.addView(action);

        TextView instructions = text(
                "Après installation, ouvre Modeliseur 3D. Comme tu as désinstallé l'ancienne version, les gros modèles IA devront être téléchargés de nouveau dans Modeliseur. Ensuite teste « Personnage + véhicule / objet composé ».",
                15, Color.rgb(203, 213, 225), false);
        instructions.setPadding(dp(14), dp(18), dp(14), dp(14));
        root.addView(instructions);
        setContentView(scroll);
    }

    private void startDownload() {
        if (downloading) {
            Toast.makeText(this, "Téléchargement déjà en cours.", Toast.LENGTH_SHORT).show();
            return;
        }
        File directory = getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
        if (directory == null) {
            setStatus("Stockage Android indisponible.");
            return;
        }
        if (!directory.exists() && !directory.mkdirs() && !directory.isDirectory()) {
            setStatus("Impossible de créer le dossier de téléchargement.");
            return;
        }

        File target = new File(directory, FILE_NAME);
        File partial = new File(directory, FILE_NAME + ".part");
        if (target.isFile() && target.length() == EXPECTED_SIZE) {
            action.setEnabled(false);
            setStatus("APK déjà reçue. Vérification SHA-256…");
            verifyAndInstall(target);
            return;
        }
        if (target.exists()) {
            target.delete();
        }

        downloading = true;
        action.setEnabled(false);
        progress.setProgress(partial.isFile() && EXPECTED_SIZE > 0
                ? (int) Math.min(1000L, partial.length() * 1000L / EXPECTED_SIZE)
                : 0);
        setStatus(partial.isFile() && partial.length() > 0
                ? "Reprise du téléchargement depuis " + formatBytes(partial.length()) + "…"
                : "Connexion sécurisée à GitHub…");

        new Thread(() -> downloadInternal(partial, target), "v94-direct-download").start();
    }

    private void downloadInternal(File partial, File target) {
        HttpURLConnection connection = null;
        try {
            long existing = partial.isFile() ? partial.length() : 0L;
            if (existing < 0L || existing >= EXPECTED_SIZE) {
                partial.delete();
                existing = 0L;
            }

            connection = openConnection(existing);
            int response = connection.getResponseCode();

            if (existing > 0L && response != HttpURLConnection.HTTP_PARTIAL) {
                connection.disconnect();
                connection = null;
                partial.delete();
                existing = 0L;
                connection = openConnection(0L);
                response = connection.getResponseCode();
            }

            if (response != HttpURLConnection.HTTP_OK
                    && response != HttpURLConnection.HTTP_PARTIAL) {
                throw new IllegalStateException("GitHub HTTP " + response);
            }

            long contentLength = connection.getContentLengthLong();
            long expectedTotal = response == HttpURLConnection.HTTP_PARTIAL
                    ? existing + Math.max(0L, contentLength)
                    : Math.max(0L, contentLength);
            if (expectedTotal > 0L && expectedTotal != EXPECTED_SIZE) {
                throw new IllegalStateException(
                        "taille distante inattendue : " + expectedTotal + " octets"
                );
            }

            final long start = existing;
            runOnUiThread(() -> setStatus(
                    start > 0L
                            ? "Connexion GitHub OK • reprise à " + formatBytes(start)
                            : "Connexion GitHub OK • téléchargement en cours…"
            ));

            long done = existing;
            long lastUi = 0L;
            try (InputStream input = new BufferedInputStream(connection.getInputStream(), BUFFER_SIZE);
                 BufferedOutputStream output = new BufferedOutputStream(
                         new FileOutputStream(partial, existing > 0L), BUFFER_SIZE)) {
                byte[] buffer = new byte[BUFFER_SIZE];
                int read;
                while ((read = input.read(buffer)) != -1) {
                    output.write(buffer, 0, read);
                    done += read;
                    long now = android.os.SystemClock.elapsedRealtime();
                    if (now - lastUi >= 180L || done == EXPECTED_SIZE) {
                        lastUi = now;
                        final long current = done;
                        runOnUiThread(() -> updateProgress(current));
                    }
                    if (done > EXPECTED_SIZE) {
                        throw new IllegalStateException("le serveur a envoyé trop de données");
                    }
                }
                output.flush();
            }

            if (done != EXPECTED_SIZE || partial.length() != EXPECTED_SIZE) {
                throw new IllegalStateException(
                        "téléchargement incomplet : " + done + "/" + EXPECTED_SIZE + " octets"
                );
            }
            if (target.exists() && !target.delete()) {
                throw new IllegalStateException("ancien APK verrouillé");
            }
            if (!partial.renameTo(target)) {
                copyFile(partial, target);
                if (!partial.delete()) {
                    partial.deleteOnExit();
                }
            }

            downloading = false;
            runOnUiThread(() -> {
                progress.setProgress(1000);
                setStatus("12 Mo reçus. Vérification SHA-256…");
                verifyAndInstall(target);
            });
        } catch (Exception error) {
            downloading = false;
            final String message = shortMessage(error);
            runOnUiThread(() -> {
                action.setEnabled(true);
                action.setText("Reprendre le téléchargement");
                setStatus("Téléchargement interrompu : " + message
                        + ". Les octets déjà reçus sont conservés.");
            });
        } finally {
            if (connection != null) {
                connection.disconnect();
            }
        }
    }

    private static HttpURLConnection openConnection(long offset) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(URL).openConnection();
        connection.setInstanceFollowRedirects(true);
        connection.setConnectTimeout(20_000);
        connection.setReadTimeout(45_000);
        connection.setRequestMethod("GET");
        connection.setRequestProperty("User-Agent", "CHK-APK-Installer/3.3 Android");
        connection.setRequestProperty("Accept", "application/octet-stream,*/*");
        connection.setRequestProperty("Accept-Encoding", "identity");
        if (offset > 0L) {
            connection.setRequestProperty("Range", "bytes=" + offset + "-");
        }
        connection.connect();
        return connection;
    }

    private void updateProgress(long done) {
        int value = (int) Math.min(1000L, done * 1000L / EXPECTED_SIZE);
        progress.setProgress(value);
        setStatus("Téléchargement : " + Math.round(value / 10.0f)
                + " % • " + formatBytes(done) + " / " + formatBytes(EXPECTED_SIZE));
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
                    action.setText("Installer V9.4 vérifiée");
                    setStatus("APK V9.4 vérifiée. Ouverture de l'installation Android…");
                    installApk(apk);
                });
            } catch (Exception error) {
                runOnUiThread(() -> {
                    action.setEnabled(true);
                    action.setText("Retélécharger");
                    setStatus("Vérification échouée : " + shortMessage(error));
                });
            }
        }, "v94-apk-verification").start();
    }

    private void installApk(File apk) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                && !getPackageManager().canRequestPackageInstalls()) {
            Toast.makeText(this,
                    "Autorise APK Installer CHK à installer des applications.",
                    Toast.LENGTH_LONG).show();
            Intent settings = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES);
            settings.setData(Uri.parse("package:" + getPackageName()));
            startActivity(settings);
            return;
        }
        try {
            Uri uri = FileProvider.getUriForFile(
                    this, getPackageName() + ".fileprovider", apk);
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

    private static void copyFile(File source, File destination) throws Exception {
        try (InputStream input = new BufferedInputStream(new FileInputStream(source), BUFFER_SIZE);
             BufferedOutputStream output = new BufferedOutputStream(
                     new FileOutputStream(destination), BUFFER_SIZE)) {
            byte[] buffer = new byte[BUFFER_SIZE];
            int read;
            while ((read = input.read(buffer)) != -1) {
                output.write(buffer, 0, read);
            }
            output.flush();
        }
    }

    private static String sha256(File file) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        try (InputStream input = new BufferedInputStream(new FileInputStream(file), BUFFER_SIZE)) {
            byte[] buffer = new byte[BUFFER_SIZE];
            int read;
            while ((read = input.read(buffer)) != -1) {
                digest.update(buffer, 0, read);
            }
        }
        StringBuilder value = new StringBuilder(64);
        for (byte b : digest.digest()) {
            value.append(String.format(Locale.US, "%02x", b & 0xff));
        }
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
        if (bold) {
            view.setTypeface(view.getTypeface(), android.graphics.Typeface.BOLD);
        }
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
        if (value == null || value.trim().isEmpty()) {
            return error.getClass().getSimpleName();
        }
        return value.length() > 160 ? value.substring(0, 157) + "…" : value;
    }
}
