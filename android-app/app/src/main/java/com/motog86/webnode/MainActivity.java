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
import android.view.View;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import androidx.appcompat.app.AppCompatActivity;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;

import com.google.android.material.button.MaterialButton;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileReader;
import java.util.List;

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
    private LinearLayout layoutAddressesHeader;
    private LinearLayout layoutAddressesContent;
    private TextView tvAddressesArrow;

    private LinearLayout layoutConnectionsHeader;
    private LinearLayout layoutConnectionsContent;
    private TextView tvConnectionsTitle;
    private TextView tvConnectionsArrow;
    private LinearLayout layoutConnectionsList;
    private TextView tvEmptyConnections;
    private boolean isMonitoringConnections = false;

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

        ViewCompat.setOnApplyWindowInsetsListener(findViewById(R.id.coordinatorLayout), (v, windowInsets) -> {
            Insets insets = windowInsets.getInsets(
                    WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout()
            );
            v.setPadding(insets.left, insets.top, insets.right, insets.bottom);
            return windowInsets;
        });

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
        startConnectionsMonitoring();
    }

    @Override
    protected void onPause() {
        super.onPause();
        stopConnectionsMonitoring();
    }

    private void refreshCurrentState() {
        // Read onion address from file if available
        if (ServerService.onionAddress.isEmpty()) {
            File hsFile = new File(ProcessHelper.getG86StorageDir(this), "tor_data/hs/hostname");
            if (!hsFile.exists()) {
                hsFile = new File(getFilesDir(), "tor_data/hs/hostname");
            }
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
        layoutAddressesHeader = findViewById(R.id.layoutAddressesHeader);
        layoutAddressesContent = findViewById(R.id.layoutAddressesContent);
        tvAddressesArrow = findViewById(R.id.tvAddressesArrow);

        layoutAddressesHeader.setOnClickListener(v -> {
            if (layoutAddressesContent.getVisibility() == View.VISIBLE) {
                layoutAddressesContent.setVisibility(View.GONE);
                tvAddressesArrow.setText("▼");
            } else {
                layoutAddressesContent.setVisibility(View.VISIBLE);
                tvAddressesArrow.setText("▲");
            }
        });

        layoutConnectionsHeader = findViewById(R.id.layoutConnectionsHeader);
        layoutConnectionsContent = findViewById(R.id.layoutConnectionsContent);
        tvConnectionsTitle = findViewById(R.id.tvConnectionsTitle);
        tvConnectionsArrow = findViewById(R.id.tvConnectionsArrow);
        layoutConnectionsList = findViewById(R.id.layoutConnectionsList);
        tvEmptyConnections = findViewById(R.id.tvEmptyConnections);

        layoutConnectionsHeader.setOnClickListener(v -> {
            if (layoutConnectionsContent.getVisibility() == View.VISIBLE) {
                layoutConnectionsContent.setVisibility(View.GONE);
                tvConnectionsArrow.setText("▼");
            } else {
                layoutConnectionsContent.setVisibility(View.VISIBLE);
                tvConnectionsArrow.setText("▲");
                refreshActiveConnections();
            }
        });

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
            tvStatus.setText("Online");
            tvStatus.setTextColor(ContextCompat.getColor(this, R.color.accent_emerald));
            btnToggleServer.setText("Oprește");
            btnToggleServer.setBackgroundColor(ContextCompat.getColor(this, android.R.color.holo_red_dark));
        } else {
            tvStatus.setText("Offline");
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

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            if (!android.os.Environment.isExternalStorageManager()) {
                try {
                    Intent intent = new Intent(android.provider.Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION);
                    intent.setData(android.net.Uri.parse("package:" + getPackageName()));
                    startActivity(intent);
                } catch (Exception e) {
                    try {
                        Intent intent = new Intent(android.provider.Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION);
                        startActivity(intent);
                    } catch (Exception ignored) {}
                }
            }
        }
    }

    private void startConnectionsMonitoring() {
        if (isMonitoringConnections) return;
        isMonitoringConnections = true;
        new Thread(() -> {
            while (isMonitoringConnections) {
                refreshActiveConnections();
                try {
                    Thread.sleep(3000);
                } catch (InterruptedException ignored) {}
            }
        }).start();
    }

    private void stopConnectionsMonitoring() {
        isMonitoringConnections = false;
    }

    private void refreshActiveConnections() {
        List<ProcessHelper.ActiveClient> clients = ProcessHelper.getActiveClients(this);
        runOnUiThread(() -> updateConnectionsUI(clients));
    }

    private void updateConnectionsUI(List<ProcessHelper.ActiveClient> clients) {
        if (tvConnectionsTitle == null || layoutConnectionsList == null) return;
        tvConnectionsTitle.setText("Conexiuni active (" + clients.size() + ")");
        if (clients.isEmpty()) {
            tvEmptyConnections.setVisibility(View.VISIBLE);
            layoutConnectionsList.removeAllViews();
            return;
        }

        tvEmptyConnections.setVisibility(View.GONE);
        layoutConnectionsList.removeAllViews();

        for (int i = 0; i < clients.size(); i++) {
            ProcessHelper.ActiveClient client = clients.get(i);
            LinearLayout item = new LinearLayout(this);
            item.setOrientation(LinearLayout.VERTICAL);
            item.setPadding(0, 10, 0, 10);

            TextView tvMain = new TextView(this);
            boolean isAuth = (client.email != null && !client.email.isEmpty());
            String displayUser = isAuth ? client.email : "Vizitator (Nelogat)";
            tvMain.setText(displayUser + "  •  " + client.type + "  •  " + client.ip);
            tvMain.setTextColor(isAuth ? 0xFF10B981 : 0xFFA0AEC0);
            tvMain.setTextSize(13);
            tvMain.setTypeface(null, android.graphics.Typeface.BOLD);
            item.addView(tvMain);

            TextView tvSub = new TextView(this);
            tvSub.setText(isAuth ? "Stare: Autentificat & Activ" : "Stare: Conectat (Neautentificat)");
            tvSub.setTextColor(isAuth ? 0xFF34D399 : 0xFF718096);
            tvSub.setTextSize(11);
            item.addView(tvSub);

            if (i < clients.size() - 1) {
                View div = new View(this);
                LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                        LinearLayout.LayoutParams.MATCH_PARENT, 1
                );
                lp.setMargins(0, 8, 0, 0);
                div.setLayoutParams(lp);
                div.setBackgroundColor(0xFF2D3748);
                item.addView(div);
            }

            layoutConnectionsList.addView(item);
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