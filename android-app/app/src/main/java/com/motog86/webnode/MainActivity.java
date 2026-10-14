package com.motog86.webnode;

import android.Manifest;
import android.content.BroadcastReceiver;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.os.BatteryManager;
import android.os.Build;
import android.os.Bundle;
import android.widget.ImageView;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import androidx.appcompat.app.AppCompatActivity;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import com.google.android.material.button.MaterialButton;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileReader;

public class MainActivity extends AppCompatActivity {

    private TextView tvStatus;
    private MaterialButton btnToggleServer;
    private TextView tvLocalUrl;
    private MaterialButton btnCopyLocal;
    private TextView tvOnionUrl;
    private MaterialButton btnCopyOnion;
    private TextView tvCloudflareUrl;
    private MaterialButton btnCopyCloudflare;
    private ImageView ivQrCode;
    private TextView tvQrLabel;
    private TextView tvRamUsage;
    private TextView tvBattery;
    private TextView tvLogs;
    private ScrollView scrollLogs;

    private final StringBuilder logBuilder = new StringBuilder();

    private final BroadcastReceiver statusReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            if (ServerService.BROADCAST_STATUS.equals(intent.getAction())) {
                String type = intent.getStringExtra("type");
                if ("STATUS".equals(type)) {
                    boolean isRunning = intent.getBooleanExtra("isRunning", false);
                    String onion = intent.getStringExtra("onionAddress");
                    String local = intent.getStringExtra("localAddress");
                    String cloudflare = intent.getStringExtra("cloudflareAddress");
                    updateUI(isRunning, onion, local, cloudflare);
                } else if ("LOG".equals(type)) {
                    String msg = intent.getStringExtra("message");
                    appendLog(msg);
                }
            }
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        initViews();
        checkPermissions();
        updateBatteryAndRam();

        IntentFilter filter = new IntentFilter(ServerService.BROADCAST_STATUS);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(statusReceiver, filter, Context.RECEIVER_NOT_EXPORTED);
        } else {
            registerReceiver(statusReceiver, filter);
        }

        // Start server service
        startServerService();
    }

    @Override
    protected void onResume() {
        super.onResume();
        refreshCurrentState();
    }

    private void refreshCurrentState() {
        // Read onion address from file if available
        if (ServerService.onionAddress.isEmpty()) {
            File hsFile = new File(getFilesDir(), "tor_data/hs/hostname");
            if (hsFile.exists()) {
                try (BufferedReader reader = new BufferedReader(new FileReader(hsFile))) {
                    String line = reader.readLine();
                    if (line != null && !line.trim().isEmpty()) {
                        ServerService.onionAddress = line.trim();
                    }
                } catch (Exception ignored) {}
            }
        }
        if (ServerService.localAddress.isEmpty()) {
            ServerService.localAddress = ServerService.getLocalIpAddress();
        }

        updateUI(ServerService.isRunning, ServerService.onionAddress, ServerService.localAddress, ServerService.cloudflareAddress);
        updateBatteryAndRam();
    }

    private void initViews() {
        tvStatus = findViewById(R.id.tvStatus);
        btnToggleServer = findViewById(R.id.btnToggleServer);
        tvLocalUrl = findViewById(R.id.tvLocalUrl);
        btnCopyLocal = findViewById(R.id.btnCopyLocal);
        tvOnionUrl = findViewById(R.id.tvOnionUrl);
        btnCopyOnion = findViewById(R.id.btnCopyOnion);
        tvCloudflareUrl = findViewById(R.id.tvCloudflareUrl);
        btnCopyCloudflare = findViewById(R.id.btnCopyCloudflare);
        ivQrCode = findViewById(R.id.ivQrCode);
        tvQrLabel = findViewById(R.id.tvQrLabel);
        tvRamUsage = findViewById(R.id.tvRamUsage);
        tvBattery = findViewById(R.id.tvBattery);
        tvLogs = findViewById(R.id.tvLogs);
        scrollLogs = findViewById(R.id.scrollLogs);

        btnToggleServer.setOnClickListener(v -> {
            if (ServerService.isRunning) {
                stopServerService();
            } else {
                startServerService();
            }
        });

        btnCopyLocal.setOnClickListener(v -> {
            copyToClipboard("Adresă Rețea Locală", tvLocalUrl.getText().toString());
        });

        btnCopyOnion.setOnClickListener(v -> {
            String onion = tvOnionUrl.getText().toString();
            if (onion.contains(".onion")) {
                copyToClipboard("Adresă Tor Onion", "http://" + onion);
            } else {
                Toast.makeText(this, "Adresa Tor nu este gata încă!", Toast.LENGTH_SHORT).show();
            }
        });

        btnCopyCloudflare.setOnClickListener(v -> {
            String cf = tvCloudflareUrl.getText().toString();
            if (cf.contains("trycloudflare.com")) {
                copyToClipboard("Adresă Cloudflare HTTPS", cf);
            } else {
                Toast.makeText(this, "Tunelul Cloudflare nu este gata încă!", Toast.LENGTH_SHORT).show();
            }
        });

        ivQrCode.setOnClickListener(v -> {
            String cf = ServerService.cloudflareAddress;
            String onion = ServerService.onionAddress;
            String local = ServerService.localAddress;
            if (!cf.isEmpty() && tvQrLabel.getText().toString().contains("local")) {
                showQrCode(cf, "QR pentru Cloudflare HTTPS");
            } else if (!onion.isEmpty() && tvQrLabel.getText().toString().contains("Cloudflare")) {
                showQrCode("http://" + onion, "QR pentru Tor (.onion)");
            } else if (!local.isEmpty()) {
                showQrCode(local, "QR pentru rețeaua locală");
            }
        });
    }

    private void startServerService() {
        appendLog("[UI] Trimitere comandă pornire server...");
        Intent intent = new Intent(this, ServerService.class);
        intent.setAction(ServerService.ACTION_START);
        ContextCompat.startForegroundService(this, intent);
    }

    private void stopServerService() {
        appendLog("[UI] Trimitere comandă oprire server...");
        Intent intent = new Intent(this, ServerService.class);
        intent.setAction(ServerService.ACTION_STOP);
        startService(intent);
    }

    private void updateUI(boolean isRunning, String onion, String local, String cloudflare) {
        if (isRunning) {
            tvStatus.setText("Status: ACTIV (Permanent / 24/7)");
            tvStatus.setTextColor(ContextCompat.getColor(this, R.color.accent_emerald));
            btnToggleServer.setText("Oprește");
            btnToggleServer.setBackgroundColor(ContextCompat.getColor(this, android.R.color.holo_red_dark));
        } else {
            tvStatus.setText("Status: OPRIT");
            tvStatus.setTextColor(ContextCompat.getColor(this, R.color.text_secondary));
            btnToggleServer.setText("Pornește");
            btnToggleServer.setBackgroundColor(ContextCompat.getColor(this, R.color.accent_emerald));
        }

        if (local != null && !local.isEmpty()) {
            tvLocalUrl.setText(local);
        }

        if (onion != null && !onion.isEmpty()) {
            tvOnionUrl.setText(onion);
        }

        if (cloudflare != null && !cloudflare.isEmpty()) {
            tvCloudflareUrl.setText(cloudflare);
            showQrCode(cloudflare, "QR pentru Cloudflare HTTPS");
        } else if (isRunning) {
            tvCloudflareUrl.setText("Se conectează la Cloudflare...");
            if (onion != null && !onion.isEmpty()) {
                showQrCode("http://" + onion, "QR pentru Tor (.onion)");
            } else if (local != null && !local.isEmpty()) {
                showQrCode(local, "QR pentru rețeaua locală");
            }
        } else {
            tvCloudflareUrl.setText("Oprit");
        }
    }

    private void showQrCode(String content, String label) {
        tvQrLabel.setText(label);
        new Thread(() -> {
            Bitmap qr = QRCodeHelper.generateQRCode(content, 350, 350);
            if (qr != null) {
                runOnUiThread(() -> ivQrCode.setImageBitmap(qr));
            }
        }).start();
    }

    private void appendLog(String log) {
        runOnUiThread(() -> {
            logBuilder.append(log).append("\n");
            tvLogs.setText(logBuilder.toString());
            scrollLogs.post(() -> scrollLogs.fullScroll(ScrollView.FOCUS_DOWN));
        });
    }

    private void updateBatteryAndRam() {
        try {
            BatteryManager bm = (BatteryManager) getSystemService(BATTERY_SERVICE);
            if (bm != null) {
                int level = bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY);
                tvBattery.setText(level + "%");
            }
            tvRamUsage.setText("12 GB (Disponibil)");
        } catch (Exception ignored) {}
    }

    private void copyToClipboard(String label, String text) {
        ClipboardManager clipboard = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
        ClipData clip = ClipData.newPlainText(label, text);
        if (clipboard != null) {
            clipboard.setPrimaryClip(clip);
            Toast.makeText(this, label + " copiat în clipboard!", Toast.LENGTH_SHORT).show();
        }
    }

    private void checkPermissions() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
                    != PackageManager.PERMISSION_GRANTED) {
                ActivityCompat.requestPermissions(this,
                        new String[]{Manifest.permission.POST_NOTIFICATIONS}, 101);
            }
        }
    }

    @Override
    protected void onDestroy() {
        try {
            unregisterReceiver(statusReceiver);
        } catch (Exception ignored) {}
        super.onDestroy();
    }
}