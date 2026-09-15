package com.chk.binanceportfolio;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        AlertCheckReceiver.schedule(context.getApplicationContext());
    }
}
