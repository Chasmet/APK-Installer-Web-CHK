package com.chk.binanceportfolio;

import android.app.Activity;
import android.graphics.Color;
import android.os.Bundle;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.text.InputType;
import android.util.Base64;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.text.NumberFormat;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.Mac;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

public class MainActivity extends Activity {
    private static final String BASE = "https://api.binance.com";
    private static final String PREFS = "chk_binance_secure";
    private static final String KEY_ALIAS = "chk_binance_local_aes";

    private EditText apiKeyInput;
    private EditText secretInput;
    private TextView totalView;
    private TextView statusView;
    private TextView infoView;
    private LinearLayout assetsBox;
    private LinearLayout credentialsBox;
    private Button connectButton;
    private Button editButton;
    private Button deleteButton;

    private int dp(float v) {
        return (int) (v * getResources().getDisplayMetrics().density + 0.5f);
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        buildUi();
        if (hasCredentials()) {
            showCredentials(false);
            loadPortfolio();
        } else {
            showCredentials(true);
            status("Colle l’API Key et la Secret Key Binance. Elles seront chiffrées uniquement sur ce téléphone.", false);
        }
    }

    private TextView text(String value, float sp, int color) {
        TextView t = new TextView(this);
        t.setText(value);
        t.setTextSize(sp);
        t.setTextColor(color);
        return t;
    }

    private void buildUi() {
        getWindow().setStatusBarColor(Color.rgb(11, 14, 17));
        getWindow().setNavigationBarColor(Color.rgb(11, 14, 17));

        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        scroll.setBackgroundColor(Color.rgb(11, 14, 17));

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(dp(20), dp(22), dp(20), dp(30));
        scroll.addView(root, new ScrollView.LayoutParams(-1, -1));

        LinearLayout top = new LinearLayout(this);
        top.setOrientation(LinearLayout.HORIZONTAL);
        top.setGravity(Gravity.CENTER_VERTICAL);
        TextView brand = text("CHK • Binance", 26, Color.WHITE);
        brand.setTypeface(null, 1);
        top.addView(brand, new LinearLayout.LayoutParams(0, -2, 1));
        TextView pill = text("LECTURE SEULE", 12, Color.rgb(183, 189, 198));
        pill.setPadding(dp(12), dp(8), dp(12), dp(8));
        pill.setBackground(roundRect(Color.rgb(30, 35, 41), Color.rgb(43, 49, 57), 999));
        top.addView(pill);
        root.addView(top);

        LinearLayout hero = new LinearLayout(this);
        hero.setOrientation(LinearLayout.VERTICAL);
        hero.setPadding(dp(22), dp(22), dp(22), dp(22));
        hero.setBackground(roundRect(Color.rgb(24, 26, 32), Color.rgb(43, 49, 57), 24));
        LinearLayout.LayoutParams heroLp = new LinearLayout.LayoutParams(-1, -2);
        heroLp.topMargin = dp(28);
        root.addView(hero, heroLp);

        TextView label = text("Valeur estimée du portefeuille", 14, Color.rgb(132, 142, 156));
        hero.addView(label);
        totalView = text("— €", 42, Color.WHITE);
        totalView.setTypeface(null, 1);
        LinearLayout.LayoutParams totalLp = new LinearLayout.LayoutParams(-1, -2);
        totalLp.topMargin = dp(8);
        hero.addView(totalView, totalLp);

        infoView = text("Connexion directe depuis ton téléphone", 14, Color.rgb(132, 142, 156));
        hero.addView(infoView);

        credentialsBox = new LinearLayout(this);
        credentialsBox.setOrientation(LinearLayout.VERTICAL);
        LinearLayout.LayoutParams credsLp = new LinearLayout.LayoutParams(-1, -2);
        credsLp.topMargin = dp(20);
        hero.addView(credentialsBox, credsLp);

        apiKeyInput = new EditText(this);
        apiKeyInput.setHint("API Key Binance");
        apiKeyInput.setHintTextColor(Color.rgb(115, 124, 136));
        apiKeyInput.setTextColor(Color.WHITE);
        apiKeyInput.setSingleLine(true);
        apiKeyInput.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD);
        apiKeyInput.setPadding(dp(14), dp(13), dp(14), dp(13));
        apiKeyInput.setBackground(roundRect(Color.rgb(11, 14, 17), Color.rgb(54, 60, 69), 14));
        credentialsBox.addView(apiKeyInput, new LinearLayout.LayoutParams(-1, -2));

        secretInput = new EditText(this);
        secretInput.setHint("Secret Key Binance");
        secretInput.setHintTextColor(Color.rgb(115, 124, 136));
        secretInput.setTextColor(Color.WHITE);
        secretInput.setSingleLine(true);
        secretInput.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        secretInput.setPadding(dp(14), dp(13), dp(14), dp(13));
        secretInput.setBackground(roundRect(Color.rgb(11, 14, 17), Color.rgb(54, 60, 69), 14));
        LinearLayout.LayoutParams secretLp = new LinearLayout.LayoutParams(-1, -2);
        secretLp.topMargin = dp(10);
        credentialsBox.addView(secretInput, secretLp);

        connectButton = new Button(this);
        connectButton.setText("Enregistrer et connecter");
        connectButton.setTextColor(Color.rgb(17, 17, 17));
        connectButton.setTypeface(null, 1);
        connectButton.setAllCaps(false);
        connectButton.setBackground(roundRect(Color.rgb(240, 185, 11), Color.TRANSPARENT, 14));
        LinearLayout.LayoutParams connectLp = new LinearLayout.LayoutParams(-1, dp(54));
        connectLp.topMargin = dp(12);
        credentialsBox.addView(connectButton, connectLp);

        statusView = text("", 14, Color.rgb(170, 178, 189));
        LinearLayout.LayoutParams statusLp = new LinearLayout.LayoutParams(-1, -2);
        statusLp.topMargin = dp(14);
        hero.addView(statusView, statusLp);

        Button refreshButton = new Button(this);
        refreshButton.setText("Actualiser");
        refreshButton.setAllCaps(false);
        refreshButton.setTypeface(null, 1);
        refreshButton.setTextColor(Color.rgb(17, 17, 17));
        refreshButton.setBackground(roundRect(Color.rgb(240, 185, 11), Color.TRANSPARENT, 14));
        LinearLayout.LayoutParams refreshLp = new LinearLayout.LayoutParams(-1, dp(52));
        refreshLp.topMargin = dp(14);
        hero.addView(refreshButton, refreshLp);

        LinearLayout actions = new LinearLayout(this);
        actions.setOrientation(LinearLayout.HORIZONTAL);
        LinearLayout.LayoutParams actionsLp = new LinearLayout.LayoutParams(-1, -2);
        actionsLp.topMargin = dp(10);
        hero.addView(actions, actionsLp);

        editButton = secondaryButton("Modifier les clés");
        deleteButton = secondaryButton("Effacer les clés");
        actions.addView(editButton, new LinearLayout.LayoutParams(0, dp(48), 1));
        LinearLayout.LayoutParams delLp = new LinearLayout.LayoutParams(0, dp(48), 1);
        delLp.leftMargin = dp(8);
        actions.addView(deleteButton, delLp);

        assetsBox = new LinearLayout(this);
        assetsBox.setOrientation(LinearLayout.VERTICAL);
        LinearLayout.LayoutParams assetsLp = new LinearLayout.LayoutParams(-1, -2);
        assetsLp.topMargin = dp(18);
        root.addView(assetsBox, assetsLp);

        TextView notice = text("Connexion directe : Binance voit l’adresse IP de ton téléphone en France, pas celle d’un serveur Vercel. La Secret Key est chiffrée avec Android Keystore et ne quitte pas l’appareil. Garde l’API Binance en lecture seule, sans trading ni retrait.", 12, Color.rgb(115, 124, 136));
        notice.setLineSpacing(0, 1.3f);
        LinearLayout.LayoutParams noticeLp = new LinearLayout.LayoutParams(-1, -2);
        noticeLp.topMargin = dp(20);
        root.addView(notice, noticeLp);

        connectButton.setOnClickListener(v -> saveAndLoad());
        refreshButton.setOnClickListener(v -> loadPortfolio());
        editButton.setOnClickListener(v -> {
            showCredentials(true);
            apiKeyInput.setText("");
            secretInput.setText("");
            status("Colle les nouvelles clés puis appuie sur Enregistrer et connecter.", false);
        });
        deleteButton.setOnClickListener(v -> {
            clearCredentials();
            assetsBox.removeAllViews();
            totalView.setText("— €");
            infoView.setText("Aucune clé enregistrée");
            showCredentials(true);
            status("Clés locales effacées.", false);
        });

        setContentView(scroll);
    }

    private Button secondaryButton(String label) {
        Button b = new Button(this);
        b.setText(label);
        b.setAllCaps(false);
        b.setTextColor(Color.WHITE);
        b.setTextSize(12);
        b.setBackground(roundRect(Color.rgb(30, 35, 41), Color.rgb(54, 60, 69), 12));
        return b;
    }

    private android.graphics.drawable.GradientDrawable roundRect(int fill, int stroke, int radiusDp) {
        android.graphics.drawable.GradientDrawable d = new android.graphics.drawable.GradientDrawable();
        d.setColor(fill);
        d.setCornerRadius(dp(radiusDp));
        if (stroke != Color.TRANSPARENT) d.setStroke(dp(1), stroke);
        return d;
    }

    private void showCredentials(boolean show) {
        credentialsBox.setVisibility(show ? View.VISIBLE : View.GONE);
        editButton.setVisibility(hasCredentials() ? View.VISIBLE : View.GONE);
        deleteButton.setVisibility(hasCredentials() ? View.VISIBLE : View.GONE);
    }

    private void saveAndLoad() {
        String api = apiKeyInput.getText().toString().trim();
        String secret = secretInput.getText().toString().trim();
        if (api.isEmpty() || secret.isEmpty()) {
            status("API Key et Secret Key obligatoires.", true);
            return;
        }
        try {
            putEncrypted("api", api);
            putEncrypted("secret", secret);
            apiKeyInput.setText("");
            secretInput.setText("");
            showCredentials(false);
            status("Clés chiffrées sur le téléphone. Connexion…", false);
            loadPortfolio();
        } catch (Exception e) {
            status("Impossible de chiffrer les clés : " + e.getMessage(), true);
        }
    }

    private boolean hasCredentials() {
        return getPreferences().contains("api_ct") && getPreferences().contains("secret_ct");
    }

    private android.content.SharedPreferences getPreferences() {
        return getSharedPreferences(PREFS, MODE_PRIVATE);
    }

    private SecretKey localKey() throws Exception {
        KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
        ks.load(null);
        if (ks.containsAlias(KEY_ALIAS)) {
            return ((KeyStore.SecretKeyEntry) ks.getEntry(KEY_ALIAS, null)).getSecretKey();
        }
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build());
        return generator.generateKey();
    }

    private void putEncrypted(String name, String value) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, localKey());
        byte[] ciphertext = cipher.doFinal(value.getBytes(StandardCharsets.UTF_8));
        getPreferences().edit()
                .putString(name + "_iv", Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP))
                .putString(name + "_ct", Base64.encodeToString(ciphertext, Base64.NO_WRAP))
                .apply();
    }

    private String getEncrypted(String name) throws Exception {
        String ivText = getPreferences().getString(name + "_iv", null);
        String ctText = getPreferences().getString(name + "_ct", null);
        if (ivText == null || ctText == null) return null;
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        GCMParameterSpec spec = new GCMParameterSpec(128, Base64.decode(ivText, Base64.NO_WRAP));
        cipher.init(Cipher.DECRYPT_MODE, localKey(), spec);
        byte[] plain = cipher.doFinal(Base64.decode(ctText, Base64.NO_WRAP));
        return new String(plain, StandardCharsets.UTF_8);
    }

    private void clearCredentials() {
        getPreferences().edit().clear().apply();
        try {
            KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
            ks.load(null);
            if (ks.containsAlias(KEY_ALIAS)) ks.deleteEntry(KEY_ALIAS);
        } catch (Exception ignored) {}
        showCredentials(true);
    }

    private void loadPortfolio() {
        if (!hasCredentials()) {
            showCredentials(true);
            status("Ajoute d’abord les clés Binance.", true);
            return;
        }
        status("Connexion directe à Binance…", false);
        connectButton.setEnabled(false);
        new Thread(() -> {
            try {
                String apiKey = getEncrypted("api");
                String secret = getEncrypted("secret");
                if (apiKey == null || secret == null) throw new Exception("Clés locales introuvables");

                long serverTime = new JSONObject(publicGet("/api/v3/time")).getLong("serverTime");
                String query = "omitZeroBalances=true&recvWindow=5000&timestamp=" + serverTime;
                String signature = hmacSha256(secret, query);
                JSONObject account = new JSONObject(authGet("/api/v3/account?" + query + "&signature=" + signature, apiKey));
                JSONArray priceArray = new JSONArray(publicGet("/api/v3/ticker/price"));

                Map<String, Double> prices = new HashMap<>();
                for (int i = 0; i < priceArray.length(); i++) {
                    JSONObject p = priceArray.getJSONObject(i);
                    prices.put(p.getString("symbol"), p.optDouble("price", 0));
                }

                double eurUsdt = prices.containsKey("EURUSDT") ? prices.get("EURUSDT") : 0;
                JSONArray balances = account.optJSONArray("balances");
                ArrayList<AssetRow> rows = new ArrayList<>();
                double totalUsdt = 0;

                if (balances != null) {
                    for (int i = 0; i < balances.length(); i++) {
                        JSONObject b = balances.getJSONObject(i);
                        String asset = b.getString("asset");
                        double free = num(b.optString("free", "0"));
                        double locked = num(b.optString("locked", "0"));
                        double amount = free + locked;
                        if (amount <= 0) continue;

                        double usdtPrice;
                        if (asset.equals("USDT") || asset.equals("USDC") || asset.equals("FDUSD")) usdtPrice = 1;
                        else if (asset.equals("EUR") && eurUsdt > 0) usdtPrice = eurUsdt;
                        else usdtPrice = prices.containsKey(asset + "USDT") ? prices.get(asset + "USDT") : 0;

                        double valueUsdt = amount * usdtPrice;
                        double valueEur = eurUsdt > 0 ? valueUsdt / eurUsdt : 0;
                        totalUsdt += valueUsdt;
                        rows.add(new AssetRow(asset, amount, locked, valueUsdt, valueEur));
                    }
                }

                Collections.sort(rows, (a, b) -> Double.compare(b.valueUsdt, a.valueUsdt));
                double totalEur = eurUsdt > 0 ? totalUsdt / eurUsdt : 0;
                final double fTotalUsdt = totalUsdt;
                final double fTotalEur = totalEur;
                final ArrayList<AssetRow> fRows = rows;

                runOnUiThread(() -> render(fTotalEur, fTotalUsdt, fRows));
            } catch (Exception e) {
                runOnUiThread(() -> {
                    String msg = e.getMessage() == null ? e.toString() : e.getMessage();
                    if (msg.contains("restricted location")) {
                        msg = "Binance refuse aussi la connexion directe de ce téléphone. Vérifie le VPN/réseau et la résidence du compte Binance.";
                    } else if (msg.contains("Invalid API-key") || msg.contains("API-key format")) {
                        msg = "API Key Binance invalide. Appuie sur Modifier les clés.";
                    } else if (msg.contains("Signature for this request is not valid")) {
                        msg = "Secret Key incorrecte. Appuie sur Modifier les clés.";
                    }
                    status(msg, true);
                    connectButton.setEnabled(true);
                });
            }
        }).start();
    }

    private void render(double totalEur, double totalUsdt, ArrayList<AssetRow> rows) {
        NumberFormat money = NumberFormat.getCurrencyInstance(Locale.FRANCE);
        money.setCurrency(java.util.Currency.getInstance("EUR"));
        totalView.setText(money.format(totalEur));
        infoView.setText(String.format(Locale.FRANCE, "≈ %.2f USDT • connexion directe active", totalUsdt));
        status("Connexion Binance réussie depuis le téléphone.", false);
        assetsBox.removeAllViews();

        for (AssetRow row : rows) {
            LinearLayout card = new LinearLayout(this);
            card.setOrientation(LinearLayout.HORIZONTAL);
            card.setGravity(Gravity.CENTER_VERTICAL);
            card.setPadding(dp(16), dp(15), dp(16), dp(15));
            card.setBackground(roundRect(Color.rgb(24, 26, 32), Color.rgb(43, 49, 57), 18));

            LinearLayout left = new LinearLayout(this);
            left.setOrientation(LinearLayout.VERTICAL);
            TextView symbol = text(row.asset, 18, Color.WHITE);
            symbol.setTypeface(null, 1);
            left.addView(symbol);
            TextView qty = text(formatQty(row.amount) + " " + row.asset + (row.locked > 0 ? " • bloqué " + formatQty(row.locked) : ""), 12, Color.rgb(132, 142, 156));
            left.addView(qty);
            card.addView(left, new LinearLayout.LayoutParams(0, -2, 1));

            LinearLayout right = new LinearLayout(this);
            right.setGravity(Gravity.END);
            right.setOrientation(LinearLayout.VERTICAL);
            TextView eur = text(money.format(row.valueEur), 17, Color.WHITE);
            eur.setTypeface(null, 1);
            eur.setGravity(Gravity.END);
            right.addView(eur);
            TextView usdt = text(String.format(Locale.FRANCE, "≈ %.2f USDT", row.valueUsdt), 12, Color.rgb(132, 142, 156));
            usdt.setGravity(Gravity.END);
            right.addView(usdt);
            card.addView(right);

            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(-1, -2);
            lp.bottomMargin = dp(10);
            assetsBox.addView(card, lp);
        }
        connectButton.setEnabled(true);
    }

    private void status(String message, boolean error) {
        statusView.setText(message);
        statusView.setTextColor(error ? Color.rgb(246, 70, 93) : Color.rgb(14, 203, 129));
    }

    private static double num(String s) {
        try { return Double.parseDouble(s); } catch (Exception e) { return 0; }
    }

    private static String formatQty(double v) {
        NumberFormat n = NumberFormat.getNumberInstance(Locale.FRANCE);
        n.setMaximumFractionDigits(8);
        return n.format(v);
    }

    private static String hmacSha256(String secret, String message) throws Exception {
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
        byte[] bytes = mac.doFinal(message.getBytes(StandardCharsets.UTF_8));
        StringBuilder hex = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) hex.append(String.format(Locale.US, "%02x", b & 0xff));
        return hex.toString();
    }

    private static String publicGet(String path) throws Exception {
        return request(BASE + path, null);
    }

    private static String authGet(String path, String apiKey) throws Exception {
        return request(BASE + path, apiKey);
    }

    private static String request(String urlText, String apiKey) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(urlText).openConnection();
        c.setRequestMethod("GET");
        c.setConnectTimeout(15000);
        c.setReadTimeout(20000);
        c.setRequestProperty("Accept", "application/json");
        if (apiKey != null) c.setRequestProperty("X-MBX-APIKEY", apiKey);
        int code = c.getResponseCode();
        InputStream stream = code >= 200 && code < 300 ? c.getInputStream() : c.getErrorStream();
        String body = readAll(stream);
        c.disconnect();
        if (code < 200 || code >= 300) {
            try {
                JSONObject err = new JSONObject(body);
                throw new Exception(err.optString("msg", "Binance HTTP " + code));
            } catch (org.json.JSONException ignored) {
                throw new Exception("Binance HTTP " + code + " : " + body);
            }
        }
        return body;
    }

    private static String readAll(InputStream in) throws Exception {
        if (in == null) return "";
        BufferedReader r = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8));
        StringBuilder sb = new StringBuilder();
        String line;
        while ((line = r.readLine()) != null) sb.append(line);
        r.close();
        return sb.toString();
    }

    private static class AssetRow {
        final String asset;
        final double amount;
        final double locked;
        final double valueUsdt;
        final double valueEur;

        AssetRow(String asset, double amount, double locked, double valueUsdt, double valueEur) {
            this.asset = asset;
            this.amount = amount;
            this.locked = locked;
            this.valueUsdt = valueUsdt;
            this.valueEur = valueEur;
        }
    }
}
