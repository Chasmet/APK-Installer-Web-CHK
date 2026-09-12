package com.chk.binanceportfolio;

import android.app.Activity;
import android.graphics.Color;
import android.os.Bundle;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.text.InputType;
import android.util.Base64;
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
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.security.SecureRandom;
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

public class MainActivityV3 extends Activity {
    private static final String BINANCE = "https://api.binance.com";
    private static final String SYNC = "https://gflnvlolwqnvzxyqsrir.supabase.co/functions/v1/chk-binance-sync";
    private static final String PREFS = "chk_binance_secure";
    private static final String ALIAS = "chk_binance_local_aes";
    private EditText api, secret;
    private TextView total, status, syncStatus, assets;
    private LinearLayout creds;

    private int dp(int v) { return (int)(v * getResources().getDisplayMetrics().density + .5f); }

    @Override public void onCreate(Bundle b) {
        super.onCreate(b);
        buildUi();
        ensureSyncIdentity();
        if (hasKeys()) { creds.setVisibility(View.GONE); refresh(); }
        else message("Colle tes clés Binance. Elles restent chiffrées uniquement sur ce téléphone.", false);
    }

    private TextView tv(String s, int size, int color) {
        TextView t = new TextView(this); t.setText(s); t.setTextSize(size); t.setTextColor(color); return t;
    }

    private Button btn(String s) {
        Button b = new Button(this); b.setText(s); b.setAllCaps(false); return b;
    }

    private void buildUi() {
        getWindow().setStatusBarColor(Color.rgb(11,14,17));
        getWindow().setNavigationBarColor(Color.rgb(11,14,17));
        ScrollView scroll = new ScrollView(this); scroll.setBackgroundColor(Color.rgb(11,14,17));
        LinearLayout root = new LinearLayout(this); root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(dp(20),dp(24),dp(20),dp(32)); scroll.addView(root);

        TextView title = tv("CHK • Binance", 27, Color.WHITE); title.setTypeface(null,1); root.addView(title);
        TextView mode = tv("LECTURE SEULE • SYNCHRO PRIVÉE", 12, Color.rgb(180,186,196)); root.addView(mode);

        total = tv("— €", 44, Color.WHITE); total.setTypeface(null,1);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(-1,-2); lp.topMargin=dp(28); root.addView(total,lp);

        status = tv("",14,Color.rgb(170,178,189)); root.addView(status);
        syncStatus = tv("Synchronisation privée : en attente",13,Color.rgb(132,142,156)); root.addView(syncStatus);

        creds = new LinearLayout(this); creds.setOrientation(LinearLayout.VERTICAL);
        lp = new LinearLayout.LayoutParams(-1,-2); lp.topMargin=dp(20); root.addView(creds,lp);

        api = new EditText(this); api.setHint("API Key Binance"); api.setTextColor(Color.WHITE); api.setHintTextColor(Color.GRAY);
        api.setSingleLine(); api.setInputType(InputType.TYPE_CLASS_TEXT|InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD); creds.addView(api);
        secret = new EditText(this); secret.setHint("Secret Key Binance"); secret.setTextColor(Color.WHITE); secret.setHintTextColor(Color.GRAY);
        secret.setSingleLine(); secret.setInputType(InputType.TYPE_CLASS_TEXT|InputType.TYPE_TEXT_VARIATION_PASSWORD); creds.addView(secret);

        Button save = btn("Enregistrer et connecter"); creds.addView(save);
        Button refresh = btn("Actualiser"); root.addView(refresh);
        Button edit = btn("Modifier les clés"); root.addView(edit);

        assets = tv("",15,Color.WHITE); assets.setLineSpacing(0,1.25f);
        lp = new LinearLayout.LayoutParams(-1,-2); lp.topMargin=dp(20); root.addView(assets,lp);

        TextView notice = tv("La Secret Key Binance ne quitte jamais le téléphone. Après actualisation, seules les données du portefeuille (actifs, quantités et valeurs) sont envoyées vers un stockage privé accessible à ChatGPT. Aucune clé Binance n’est synchronisée.",12,Color.rgb(115,124,136));
        lp = new LinearLayout.LayoutParams(-1,-2); lp.topMargin=dp(24); root.addView(notice,lp);

        save.setOnClickListener(v -> {
            String a=api.getText().toString().trim(), s=secret.getText().toString().trim();
            if(a.isEmpty()||s.isEmpty()){ message("API Key et Secret Key obligatoires.",true); return; }
            try { encPut("api",a); encPut("secret",s); api.setText(""); secret.setText(""); creds.setVisibility(View.GONE); refresh(); }
            catch(Exception e){ message("Erreur de chiffrement : "+safe(e),true); }
        });
        refresh.setOnClickListener(v -> refresh());
        edit.setOnClickListener(v -> { creds.setVisibility(View.VISIBLE); message("Colle les nouvelles clés puis enregistre.",false); });
        setContentView(scroll);
    }

    private android.content.SharedPreferences prefs(){ return getSharedPreferences(PREFS,MODE_PRIVATE); }
    private boolean hasKeys(){ return prefs().contains("api_ct")&&prefs().contains("secret_ct"); }

    private SecretKey key() throws Exception {
        KeyStore ks=KeyStore.getInstance("AndroidKeyStore"); ks.load(null);
        if(ks.containsAlias(ALIAS)) return ((KeyStore.SecretKeyEntry)ks.getEntry(ALIAS,null)).getSecretKey();
        KeyGenerator g=KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES,"AndroidKeyStore");
        g.init(new KeyGenParameterSpec.Builder(ALIAS,KeyProperties.PURPOSE_ENCRYPT|KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).setKeySize(256).build());
        return g.generateKey();
    }

    private void encPut(String n,String v) throws Exception {
        Cipher c=Cipher.getInstance("AES/GCM/NoPadding"); c.init(Cipher.ENCRYPT_MODE,key());
        byte[] ct=c.doFinal(v.getBytes(StandardCharsets.UTF_8));
        prefs().edit().putString(n+"_iv",Base64.encodeToString(c.getIV(),Base64.NO_WRAP))
                .putString(n+"_ct",Base64.encodeToString(ct,Base64.NO_WRAP)).apply();
    }

    private String encGet(String n) throws Exception {
        String iv=prefs().getString(n+"_iv",null), ct=prefs().getString(n+"_ct",null); if(iv==null||ct==null)return null;
        Cipher c=Cipher.getInstance("AES/GCM/NoPadding");
        c.init(Cipher.DECRYPT_MODE,key(),new GCMParameterSpec(128,Base64.decode(iv,Base64.NO_WRAP)));
        return new String(c.doFinal(Base64.decode(ct,Base64.NO_WRAP)),StandardCharsets.UTF_8);
    }

    private void ensureSyncIdentity() {
        try {
            String id=prefs().getString("sync_id",null), s=encGet("sync_secret");
            if(id==null||s==null){
                id=hexRandom(16)+"-"+hexRandom(8); s=hexRandom(32);
                prefs().edit().putString("sync_id",id).apply(); encPut("sync_secret",s);
            }
        } catch(Exception ignored){}
    }

    private void refresh() {
        if(!hasKeys()){ creds.setVisibility(View.VISIBLE); message("Ajoute d’abord les clés Binance.",true); return; }
        message("Connexion directe à Binance…",false); syncStatus.setText("Synchronisation privée : préparation");
        new Thread(() -> {
            try {
                String k=encGet("api"), s=encGet("secret"); if(k==null||s==null)throw new Exception("Clés locales introuvables");
                long serverTime=new JSONObject(get(BINANCE+"/api/v3/time",null)).getLong("serverTime");
                String q="omitZeroBalances=true&recvWindow=5000&timestamp="+serverTime;
                JSONObject account=new JSONObject(get(BINANCE+"/api/v3/account?"+q+"&signature="+hmac(s,q),k));
                JSONArray tickers=new JSONArray(get(BINANCE+"/api/v3/ticker/price",null));
                Map<String,Double> p=new HashMap<>();
                for(int i=0;i<tickers.length();i++){ JSONObject x=tickers.getJSONObject(i); p.put(x.getString("symbol"),x.optDouble("price",0)); }
                double eurUsdt=p.containsKey("EURUSDT")?p.get("EURUSDT"):0, totalUsdt=0;
                JSONArray bals=account.optJSONArray("balances"); ArrayList<Row> rows=new ArrayList<>();
                if(bals!=null) for(int i=0;i<bals.length();i++){
                    JSONObject x=bals.getJSONObject(i); String a=x.getString("asset");
                    double free=d(x.optString("free","0")), locked=d(x.optString("locked","0")), qty=free+locked;
                    if(qty<=0)continue; double price=price(a,p,eurUsdt), vu=qty*price, ve=eurUsdt>0?vu/eurUsdt:0;
                    rows.add(new Row(a,qty,free,locked,price,vu,ve)); totalUsdt+=vu;
                }
                Collections.sort(rows,new Comparator<Row>(){public int compare(Row a,Row b){return Double.compare(b.vu,a.vu);}});
                double totalEur=eurUsdt>0?totalUsdt/eurUsdt:0;
                JSONObject snap=new JSONObject(); snap.put("capturedAt",System.currentTimeMillis()); snap.put("binanceServerTime",serverTime);
                snap.put("totalUsdt",totalUsdt); snap.put("totalEur",totalEur); snap.put("eurUsdt",eurUsdt); snap.put("source","android_direct_read_only");
                JSONArray arr=new JSONArray(); for(Row r:rows){ JSONObject o=new JSONObject(); o.put("asset",r.a); o.put("amount",r.q); o.put("free",r.f); o.put("locked",r.l); o.put("priceUsdt",r.p); o.put("valueUsdt",r.vu); o.put("valueEur",r.ve); arr.put(o); } snap.put("assets",arr);
                String sync="OK"; try{ sync(k,snap); }catch(Exception e){ sync="Échec temporaire : "+safe(e); }
                final double te=totalEur,tu=totalUsdt; final ArrayList<Row> rr=rows; final String ss=sync;
                runOnUiThread(() -> {
                    total.setText(te>0?money(te):String.format(Locale.FRANCE,"%.2f USDT",tu));
                    assets.setText(assetText(rr));
                    message("Portefeuille Binance actualisé.",false);
                    syncStatus.setText(ss.equals("OK")?"Synchronisation privée : OK • accessible à ChatGPT":"Synchronisation privée : "+ss);
                    syncStatus.setTextColor(ss.equals("OK")?Color.rgb(46,204,113):Color.rgb(240,185,11));
                });
            }catch(Exception e){ runOnUiThread(() -> { message(binanceError(e),true); syncStatus.setText("Synchronisation privée : non effectuée"); }); }
        }).start();
    }

    private double price(String a,Map<String,Double> p,double eur){
        if(a.equals("USDT")||a.equals("USDC")||a.equals("FDUSD")||a.equals("TUSD"))return 1;
        if(a.equals("EUR")&&eur>0)return eur;
        Double x=p.get(a+"USDT"); if(x!=null&&x>0)return x;
        Double btc=p.get("BTCUSDT"), ab=p.get(a+"BTC"); if(btc!=null&&ab!=null&&btc>0&&ab>0)return btc*ab;
        Double eth=p.get("ETHUSDT"), ae=p.get(a+"ETH"); if(eth!=null&&ae!=null&&eth>0&&ae>0)return eth*ae;
        return 0;
    }

    private void sync(String apiKey,JSONObject snap) throws Exception {
        ensureSyncIdentity(); String id=prefs().getString("sync_id",null), ds=encGet("sync_secret");
        if(id==null||ds==null)throw new Exception("identité sync absente");
        JSONObject b=new JSONObject(); b.put("deviceId",id); b.put("deviceSecret",ds); b.put("accountFingerprint",sha(apiKey)); b.put("appVersion","v3"); b.put("snapshot",snap);
        HttpURLConnection c=(HttpURLConnection)new URL(SYNC).openConnection(); c.setRequestMethod("POST"); c.setDoOutput(true);
        c.setConnectTimeout(10000); c.setReadTimeout(10000); c.setRequestProperty("Content-Type","application/json");
        byte[] data=b.toString().getBytes(StandardCharsets.UTF_8); c.setFixedLengthStreamingMode(data.length);
        try(OutputStream o=c.getOutputStream()){o.write(data);}
        int code=c.getResponseCode(); String body=read(code<300?c.getInputStream():c.getErrorStream()); c.disconnect();
        if(code<200||code>=300)throw new Exception("sync "+code+" "+body);
    }

    private String get(String u,String apiKey) throws Exception {
        HttpURLConnection c=(HttpURLConnection)new URL(u).openConnection(); c.setConnectTimeout(10000); c.setReadTimeout(15000);
        c.setRequestProperty("Accept","application/json"); if(apiKey!=null)c.setRequestProperty("X-MBX-APIKEY",apiKey);
        int code=c.getResponseCode(); String body=read(code<300?c.getInputStream():c.getErrorStream()); c.disconnect();
        if(code<200||code>=300)throw new Exception("Binance "+code+" • "+body); return body;
    }

    private String read(InputStream in)throws Exception{
        if(in==null)return ""; StringBuilder s=new StringBuilder(); try(BufferedReader r=new BufferedReader(new InputStreamReader(in,StandardCharsets.UTF_8))){String l;while((l=r.readLine())!=null)s.append(l);} return s.toString();
    }

    private String hmac(String secret,String data)throws Exception{
        Mac m=Mac.getInstance("HmacSHA256"); m.init(new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8),"HmacSHA256")); return hex(m.doFinal(data.getBytes(StandardCharsets.UTF_8)));
    }
    private String sha(String s)throws Exception{return hex(MessageDigest.getInstance("SHA-256").digest(s.getBytes(StandardCharsets.UTF_8)));}
    private String hexRandom(int n){byte[] b=new byte[n];new SecureRandom().nextBytes(b);return hex(b);}
    private String hex(byte[] b){StringBuilder s=new StringBuilder();for(byte x:b)s.append(String.format(Locale.US,"%02x",x&255));return s.toString();}
    private double d(String s){try{return Double.parseDouble(s);}catch(Exception e){return 0;}}
    private String money(double v){NumberFormat n=NumberFormat.getCurrencyInstance(Locale.FRANCE);n.setMaximumFractionDigits(2);return n.format(v);}
    private String safe(Exception e){String s=e.getMessage();return s==null?e.getClass().getSimpleName():(s.length()>300?s.substring(0,300):s);}
    private String binanceError(Exception e){String s=safe(e);if(s.contains("-2015")||s.contains("Invalid API-key"))return "Binance refuse la clé API. Vérifie qu’elle est active et en lecture seule.";if(s.contains("-1021"))return "Active la date et l’heure automatiques du téléphone puis réessaie.";return s;}

    private String assetText(ArrayList<Row> rows){
        StringBuilder s=new StringBuilder("ACTIFS\n\n"); for(Row r:rows){s.append(r.a).append("   ").append(qty(r.q)).append("\n");if(r.ve>0)s.append("≈ ").append(money(r.ve));else if(r.vu>0)s.append(String.format(Locale.FRANCE,"≈ %.2f USDT",r.vu));else s.append("prix indisponible");s.append("\n\n");}return s.toString();
    }
    private String qty(double v){if(v>=1)return String.format(Locale.US,"%.6f",v).replaceAll("0+$","").replaceAll("\\.$","");return String.format(Locale.US,"%.10f",v).replaceAll("0+$","").replaceAll("\\.$","");}
    private void message(String s,boolean err){status.setText(s);status.setTextColor(err?Color.rgb(255,90,95):Color.rgb(170,178,189));}

    private static class Row {
        String a; double q,f,l,p,vu,ve;
        Row(String a,double q,double f,double l,double p,double vu,double ve){this.a=a;this.q=q;this.f=f;this.l=l;this.p=p;this.vu=vu;this.ve=ve;}
    }
}
