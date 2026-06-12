package com.chk.testapk;

import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.graphics.Color;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

public class MainActivity extends Activity {
    private LinearLayout root;
    private TextView output;
    private int counter = 0;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        buildUi();
    }

    private void buildUi() {
        ScrollView scroll = new ScrollView(this);
        scroll.setBackgroundColor(Color.rgb(7, 11, 20));

        root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(dp(18), dp(24), dp(18), dp(24));
        scroll.addView(root);

        TextView badge = text("APK de test", 13, Color.rgb(186, 230, 253), true);
        root.addView(badge);

        TextView title = text("Bot Test CHK", 34, Color.WHITE, true);
        title.setPadding(0, dp(16), 0, dp(8));
        root.addView(title);

        TextView intro = text("Petit bot local pour tester ton installateur APK. Il ne se connecte à aucun serveur et fonctionne uniquement sur ton téléphone.", 16, Color.rgb(203, 213, 225), false);
        root.addView(intro);

        addSpace(18);

        Button responseButton = mainButton("Générer réponse bot");
        responseButton.setOnClickListener(v -> generateBotResponse());
        root.addView(responseButton);

        Button metaButton = secondaryButton("Créer métadonnées TikTok test");
        metaButton.setOnClickListener(v -> generateMetadata());
        root.addView(metaButton);

        Button copyButton = secondaryButton("Copier le résultat");
        copyButton.setOnClickListener(v -> copyOutput());
        root.addView(copyButton);

        output = text("Résultat du bot ici.", 16, Color.rgb(226, 232, 240), false);
        output.setPadding(dp(14), dp(14), dp(14), dp(14));
        output.setBackgroundColor(Color.rgb(17, 24, 39));
        root.addView(output);

        addSpace(14);

        TextView note = text("Test réussi si cette application s’installe via APK Installer CHK et s’ouvre normalement.", 14, Color.rgb(148, 163, 184), false);
        root.addView(note);

        setContentView(scroll);
    }

    private void generateBotResponse() {
        counter++;
        String time = new SimpleDateFormat("HH:mm:ss", Locale.FRANCE).format(new Date());
        String text = "Bot CHK actif\n\nTest numéro : " + counter + "\nHeure : " + time + "\n\nRéponse : l’installation APK fonctionne. Ton téléphone a bien lancé une application créée depuis GitHub.";
        output.setText(text);
    }

    private void generateMetadata() {
        String text = "Bot Test CHK - installation réussie\nTest rapide de mon installateur APK personnel. L’application s’ouvre, génère du texte et confirme que le système fonctionne.\n#APK #Android #CHK";
        output.setText(text);
    }

    private void copyOutput() {
        ClipboardManager clipboard = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
        clipboard.setPrimaryClip(ClipData.newPlainText("Bot Test CHK", output.getText().toString()));
        Toast.makeText(this, "Résultat copié", Toast.LENGTH_SHORT).show();
    }

    private TextView text(String value, int sp, int color, boolean bold) {
        TextView tv = new TextView(this);
        tv.setText(value);
        tv.setTextSize(sp);
        tv.setTextColor(color);
        tv.setLineSpacing(0, 1.15f);
        if (bold) tv.setTypeface(tv.getTypeface(), android.graphics.Typeface.BOLD);
        return tv;
    }

    private Button mainButton(String label) {
        Button button = new Button(this);
        button.setText(label);
        button.setTextSize(15);
        button.setAllCaps(false);
        button.setGravity(Gravity.CENTER);
        button.setTextColor(Color.rgb(3, 17, 29));
        button.setTypeface(button.getTypeface(), android.graphics.Typeface.BOLD);
        button.setBackgroundColor(Color.rgb(14, 165, 233));
        button.setPadding(dp(10), dp(10), dp(10), dp(10));
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        params.setMargins(0, 0, 0, dp(10));
        button.setLayoutParams(params);
        return button;
    }

    private Button secondaryButton(String label) {
        Button button = mainButton(label);
        button.setTextColor(Color.WHITE);
        button.setBackgroundColor(Color.rgb(31, 41, 55));
        return button;
    }

    private void addSpace(int value) {
        View space = new View(this);
        root.addView(space, new LinearLayout.LayoutParams(1, dp(value)));
    }

    private int dp(int value) {
        return (int) (value * getResources().getDisplayMetrics().density + 0.5f);
    }
}
