package com.chk.binanceportfolio;

import android.app.AlarmManager;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Notification;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import android.os.SystemClock;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

import javax.crypto.Cipher;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

public class AlertCheckReceiver extends BroadcastReceiver {
    static final String PREFS = "chk_binance_secure";
    static final String ALIAS = "chk_binance_local_aes";
    static final String ALERTS_URL = "https://gflnvlolwqnvzxyqsrir.supabase.co/functions/v1/chk-binance-alerts";
    static final String BINANCE = "https://api.binance.com";
    static final String CHANNEL_ID = "chk_binance_price_alerts";
    static final long INTERVAL_MS = 15L * 60L * 1000L;

    @Override
    public void onReceive(Context context, Intent intent) {
        final PendingResult pending = goAsync();
        new Thread(() -> {
            try { checkAlerts(context.getApplicationContext()); }
            catch (Exception ignored) {}
            finally { pending.finish(); }
        }).start();
    }

    public static void schedule(Context context) {
        createChannel(context);
        AlarmManager am = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        Intent i = new Intent(context, AlertCheckReceiver.class).setAction("com.chk.binanceportfolio.CHECK_ALERTS");
        PendingIntent pi = PendingIntent.getBroadcast(context, 4101, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        if (am != null) {
            am.setInexactRepeating(
                    AlarmManager.ELAPSED_REALTIME_WAKEUP,
                    SystemClock.elapsedRealtime() + 60_000L,
                    INTERVAL_MS,
                    pi
            );
        }
    }

    public static void checkNow(Context context) {
        Intent i = new Intent(context, AlertCheckReceiver.class).setAction("com.chk.binanceportfolio.CHECK_ALERTS_NOW");
        context.sendBroadcast(i);
    }

    public static void createChannel(Context context) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationManager nm = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null) {
                NotificationChannel ch = new NotificationChannel(
                        CHANNEL_ID,
                        "Alertes prix CHK Binance",
                        NotificationManager.IMPORTANCE_HIGH
                );
                ch.setDescription("Avertit quand une crypto atteint un seuil défini par toi ou ChatGPT.");
                ch.enableVibration(true);
                nm.createNotificationChannel(ch);
            }
        }
    }

    static void checkAlerts(Context context) throws Exception {
        SharedPreferences p = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String deviceId = p.getString("sync_id", null);
        String deviceSecret = decrypt(context, "sync_secret");
        if (deviceId == null || deviceSecret == null) return;

        JSONObject req = new JSONObject();
        req.put("action", "list");
        req.put("deviceId", deviceId);
        req.put("deviceSecret", deviceSecret);
        JSONObject response = new JSONObject(postJson(ALERTS_URL, req));
        JSONArray alerts = response.optJSONArray("alerts");
        if (alerts == null || alerts.length() == 0) return;

        Map<String, Double> prices = new HashMap<>();
        for (int i = 0; i < alerts.length(); i++) {
            JSONObject a = alerts.optJSONObject(i);
            if (a == null || !a.optBoolean("enabled", false)) continue;
            String pair = a.optString("pair", "").trim().toUpperCase(Locale.US);
            if (pair.isEmpty()) continue;
            if (!prices.containsKey(pair)) {
                try {
                    JSONObject ticker = new JSONObject(getJson(BINANCE + "/api/v3/ticker/price?symbol=" + pair));
                    double px = ticker.optDouble("price", 0);
                    if (px > 0) prices.put(pair, px);
                } catch (Exception ignored) {}
            }
        }

        for (int i = 0; i < alerts.length(); i++) {
            JSONObject a = alerts.optJSONObject(i);
            if (a == null || !a.optBoolean("enabled", false)) continue;
            String pair = a.optString("pair", "").trim().toUpperCase(Locale.US);
            Double price = prices.get(pair);
            if (price == null || price <= 0) continue;
            double target = a.optDouble("target_price", 0);
            String condition = a.optString("condition", "");
            boolean hit = ("above".equals(condition) && price >= target) || ("below".equals(condition) && price <= target);
            if (!hit) continue;

            notifyAlert(context, a, price, target);
            JSONObject trigger = new JSONObject();
            trigger.put("action", "trigger");
            trigger.put("deviceId", deviceId);
            trigger.put("deviceSecret", deviceSecret);
            trigger.put("id", a.optString("id"));
            trigger.put("lastPrice", price);
            try { postJson(ALERTS_URL, trigger); } catch (Exception ignored) {}
        }
    }

    private static void notifyAlert(Context context, JSONObject a, double price, double target) {
        createChannel(context);
        NotificationManager nm = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;

        Intent open = new Intent(context, MainActivityV5.class);
        open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent content = PendingIntent.getActivity(context, 5101, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        String symbol = a.optString("symbol", "Crypto");
        String condition = a.optString("condition", "above");
        String label = a.optString("label", symbol + " • alerte prix");
        String text = symbol + " = " + fmt(price) + " USDT • seuil " + ("above".equals(condition) ? "≥ " : "≤ ") + fmt(target);

        Notification.Builder b = new Notification.Builder(context, CHANNEL_ID)
                .setSmallIcon(com.chk.binanceportfolio.R.drawable.ic_price_alert)
                .setContentTitle(label)
                .setContentText(text)
                .setStyle(new Notification.BigTextStyle().bigText(text + "\nOuvre CHK Binance pour revoir la situation avant de décider."))
                .setContentIntent(content)
                .setAutoCancel(true)
                .setCategory(Notification.CATEGORY_ALARM)
                .setPriority(Notification.PRIORITY_HIGH);

        int id = Math.abs(a.optString("id", symbol).hashCode());
        nm.notify(id, b.build());
    }

    private static String fmt(double v) {
        if (v >= 1000) return String.format(Locale.US, "%.0f", v);
        if (v >= 100) return String.format(Locale.US, "%.1f", v);
        if (v >= 10) return String.format(Locale.US, "%.2f", v);
        if (v >= 1) return String.format(Locale.US, "%.3f", v);
        if (v >= .01) return String.format(Locale.US, "%.5f", v);
        return String.format(Locale.US, "%.8f", v).replaceAll("0+$", "").replaceAll("\\.$", "");
    }

    private static String decrypt(Context context, String name) throws Exception {
        SharedPreferences p = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String iv = p.getString(name + "_iv", null);
        String ct = p.getString(name + "_ct", null);
        if (iv == null || ct == null) return null;
        KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
        ks.load(null);
        if (!ks.containsAlias(ALIAS)) return null;
        SecretKey key = ((KeyStore.SecretKeyEntry) ks.getEntry(ALIAS, null)).getSecretKey();
        Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
        c.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(128, Base64.decode(iv, Base64.NO_WRAP)));
        return new String(c.doFinal(Base64.decode(ct, Base64.NO_WRAP)), StandardCharsets.UTF_8);
    }

    static String postJson(String urlText, JSONObject body) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(urlText).openConnection();
        c.setRequestMethod("POST");
        c.setDoOutput(true);
        c.setConnectTimeout(10_000);
        c.setReadTimeout(12_000);
        c.setRequestProperty("Content-Type", "application/json");
        c.setRequestProperty("Accept", "application/json");
        byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
        c.setFixedLengthStreamingMode(bytes.length);
        try (OutputStream out = c.getOutputStream()) { out.write(bytes); }
        int code = c.getResponseCode();
        String text = read(code >= 200 && code < 300 ? c.getInputStream() : c.getErrorStream());
        c.disconnect();
        if (code < 200 || code >= 300) throw new Exception("HTTP " + code + " " + text);
        return text;
    }

    static String getJson(String urlText) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(urlText).openConnection();
        c.setConnectTimeout(8_000);
        c.setReadTimeout(10_000);
        c.setRequestProperty("Accept", "application/json");
        int code = c.getResponseCode();
        String text = read(code >= 200 && code < 300 ? c.getInputStream() : c.getErrorStream());
        c.disconnect();
        if (code < 200 || code >= 300) throw new Exception("HTTP " + code + " " + text);
        return text;
    }

    static String read(InputStream in) throws Exception {
        if (in == null) return "";
        StringBuilder sb = new StringBuilder();
        try (BufferedReader r = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8))) {
            String line;
            while ((line = r.readLine()) != null) sb.append(line);
        }
        return sb.toString();
    }
}
